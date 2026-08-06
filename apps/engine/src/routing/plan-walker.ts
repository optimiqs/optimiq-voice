import { createEntityId } from "@optimiq-voice/identifiers";
import { evaluateTimeCondition, matchPattern } from "@optimiq-voice/routing";
import { RETRYABLE_HANGUP_CAUSES } from "@optimiq-voice/telephony";
import { QueueSession } from "../queue/queue-session";
import { legSignalKey, recordingSignalKey } from "./call-signals";
import { DEFAULT_MEDIA_REF_SETTINGS, resolveMediaRef } from "./media-refs";
import { planDestinationOf } from "./plan-destination";
import type { MediaPort } from "../ari/media-port";
import type {
	QueueCallPort,
	QueueDialAttempt,
	QueueDialOutcome,
	QueueServices,
	QueueSessionSettings,
} from "../queue/queue-session";
import type { CallSignalBus, LegSignal } from "./call-signals";
import type { MediaRefSettings } from "./media-refs";
import type { PlanDestination } from "./plan-destination";
import type { CallEvent } from "@optimiq-voice/events";
import type {
	CompiledTimeCondition,
	ExecutionPlan,
	ExtensionPlanNode,
	IvrMenuPlanNode,
	MailboxEntry,
	PlanNode,
	PlanNodeId,
	QueuePlanNode,
	RingGroupPlanNode,
	TrunkDialPlanNode,
	VoicemailPlanNode,
} from "@optimiq-voice/routing";
import type {
	ChannelState,
	DtmfCollection,
	HangupCause,
	Verb,
	VerbResult,
} from "@optimiq-voice/telephony";

/**
 * The plan walker — the routing artifact, executed.
 *
 * ## What it is
 *
 * `packages/routing` resolves a call to an {@link ExecutionPlan}: an entry node id plus a flat,
 * id-keyed node table that is closed under reference. This class walks that table, turning each
 * node into verbs on the A-leg and originates/bridges on the media server, and stops when the call
 * has a destination (bridged), a terminal (hangup) or nothing left to do.
 *
 * ## Why a loop and not recursion
 *
 * The node table is a GRAPH, not a tree: an IVR option may point back at its parent menu and a ring
 * group's timeout may point at a queue whose timeout points back at the group. Those are legitimate
 * configurations, so the walk is an explicit loop with a step budget
 * ({@link PlanWalkerSettings.maxPlanSteps}). A recursive walker would express the same thing as a
 * stack overflow, on a live call, in production.
 *
 * ## Every channel move is guarded
 *
 * The walker never assigns a channel state; it calls {@link WalkerChannel.moveTo}, which runs
 * `assertChannelTransition` first (via `ChannelAggregate`). A node that wants a state the machine
 * says is unreachable gets `false` and carries on rather than corrupting the snapshot other engine
 * instances read out of KV.
 *
 * ## What is real and what is a placeholder
 *
 * Real: `extension`, `ring-group` (both strategies, with lose-race), `ivr-menu` (retries, invalid
 * and timeout branches, submenu recursion), `time-condition`, `trunk-dial` (failover honouring
 * `continueOnCauses`), `external`, `playback`, `hangup`, and `queue` — music on hold, position
 * announcements, all six distribution strategies with tier rules, agent state and wrap-up, delegated
 * to `../queue/queue-session.ts` (which needs {@link PlanWalkerDependencies.queue}; without it the
 * node falls back to the announcement below).
 *
 * Placeholder, and honest about it: `voicemail` records but has no mailbox, no MWI and no email;
 * `feature-code` serves `*97` as that placeholder and answers everything else with an
 * announcement; `conference`, `park` and `application` announce and hang up. Every one of them adds
 * a line to {@link WalkOutcome.notes}, so a call that hit a gap says so in the log rather than
 * looking like a routing bug.
 */

/** The A-leg, as the walker sees it. Every member is live: the orchestrator owns the state. */
export interface WalkerChannel {
	/** The media server's id for the leg. */
	readonly mediaChannelId: string;
	/** The domain leg id. */
	readonly channelId: string;
	readonly callId: string;
	readonly organizationId: string;
	readonly isTearingDown: boolean;
	readonly isAnswered: boolean;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	/** Guarded state move. Returns whether the machine actually moved. */
	moveTo(state: ChannelState): boolean;
	setBridge(bridgeId: string | undefined): void;
}

/** Deployment-shaped knobs. All of them have defaults; none of them is a routing decision. */
export interface PlanWalkerSettings {
	/** The Stasis application originated legs are handed to. Must match the engine's `ARI_APP`. */
	readonly application: string;
	/** How an extension NUMBER becomes an endpoint. `{number}` is substituted. */
	readonly extensionDialTemplate: string;
	/** How a trunk attempt becomes an endpoint. `{number}` and `{trunk}` are substituted. */
	readonly trunkDialTemplate: string;
	/** Ring time when neither the node nor the member specifies one. */
	readonly defaultRingTimeoutSeconds: number;
	/** How long to wait for the A-leg's `Up` after issuing `answer`. */
	readonly answerTimeoutMs: number;
	/** Hard budget on nodes visited in one walk. A cycle hits it instead of running forever. */
	readonly maxPlanSteps: number;
	readonly recordingFormat: string;
	/** Played before a voicemail recording starts. */
	readonly voicemailGreeting: string;
	/** Played for the node kinds this slice does not implement. */
	readonly unavailableAnnouncement: string;
	readonly mediaRefs: MediaRefSettings;
}

export const DEFAULT_PLAN_WALKER_SETTINGS: PlanWalkerSettings = {
	application: "optimiq-engine",
	extensionDialTemplate: "PJSIP/{number}",
	trunkDialTemplate: "PJSIP/{number}@{trunk}",
	defaultRingTimeoutSeconds: 30,
	answerTimeoutMs: 10_000,
	maxPlanSteps: 64,
	recordingFormat: "wav",
	voicemailGreeting: "sound:unavailable",
	unavailableAnnouncement: "sound:unavailable",
	mediaRefs: DEFAULT_MEDIA_REF_SETTINGS,
};

/** Everything the walker talks to. All ports, so a spec supplies four closures and a fake. */
export interface PlanWalkerDependencies {
	readonly media: MediaPort;
	readonly signals: CallSignalBus;
	readonly channel: WalkerChannel;
	/** Runs one verb. `undefined` means the verb failed — the walk treats that as fatal. */
	readonly execute: (verb: Verb) => Promise<VerbResult | undefined>;
	readonly publish: (type: CallEvent, data: Record<string, unknown>) => Promise<void>;
	readonly settings?: Partial<PlanWalkerSettings>;
	/**
	 * The domain leg id for a media channel id.
	 *
	 * A hook rather than a direct import of `legIdForAriChannel`, so a spec can assert the
	 * `peerLegId` a bridge event carries. Production passes the real deterministic derivation.
	 */
	readonly peerLegId?: (mediaChannelId: string) => string;
	/**
	 * Told about every leg this walk creates, ends or bridges — so the orchestrator can give each
	 * one a `ChannelAggregate` and therefore its own CDR.
	 *
	 * A callback bundle rather than a return value, because the facts arrive at three different
	 * moments and only one of them is the walker's own result: a leg exists the instant it is
	 * originated (before it rings), its cause is decided when the WALKER hangs it up (a ring-all
	 * loser's `LOSE_RACE` is known here and nowhere else — ARI will report a generic code for it),
	 * and its bridge peer is known only after the race is over.
	 *
	 * Optional, so the walker stays testable with four closures and a fake port. When it is absent
	 * the walk behaves exactly as it did before B-leg CDRs existed.
	 */
	readonly legs?: OriginatedLegHooks;
	/**
	 * Where a recorded message is filed. Absent means the walk records but cannot file, which it
	 * reports in its notes rather than pretending the message landed somewhere.
	 */
	readonly voicemail?: VoicemailPort;
	/**
	 * The ACD plane: the roster source, the agent state machine, the queue event publisher and the
	 * per-process line and cursor.
	 *
	 * Optional for the same reason `legs` and `voicemail` are — a walker spec supplies four closures
	 * and a fake, and should not have to stand up a queue runtime to test an IVR. When it is absent a
	 * `queue` node announces and hangs up exactly as it did before this wave, and says so in the
	 * notes rather than looking like a routing bug.
	 */
	readonly queue?: QueueServices;
	/** Deployment knobs for the queue runtime: poll interval, agent ring timeout, RNG. */
	readonly queueSettings?: Partial<QueueSessionSettings>;
	/** Injected so ids are deterministic in a spec. */
	readonly newId?: () => string;
	readonly now?: () => number;
	/** Injected so a spec asserts a ring-group delay without waiting for it. */
	readonly delay?: (ms: number) => Promise<void>;
	readonly log?: (message: string, detail?: Record<string, unknown>) => void;
}

/** One recorded message, on its way to a mailbox. */
export interface VoicemailMessage {
	readonly voicemailBoxId: string;
	readonly mailboxNumber: string;
	/** Minted by the walker, so a redelivered publish inserts one row rather than two. */
	readonly messageId: string;
	readonly recordingId: string;
	readonly objectKey: string;
	readonly durationMs: number;
	/** Whether the box wants a lamp lit. Carried so the consumer does not have to re-read the box. */
	readonly mwiEnabled: boolean;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
}

/** The seam between the walk and the backbone, for voicemail specifically. */
export interface VoicemailPort {
	messageLeft(message: VoicemailMessage): Promise<void>;
}

/** One leg the walk is about to create, as the orchestrator needs to file it. */
export interface OriginatedLeg {
	/** The media-server channel id the walker chose. Deterministic within the walk. */
	readonly mediaChannelId: string;
	/** The endpoint string handed to the media server, for the log. */
	readonly endpoint: string;
	/** What is being reached: the extension number, the trunk's dialled number, the external one. */
	readonly destinationNumber: string;
	/** Human label the notes use (`extension 1001`, `trunk carrier-a`). */
	readonly label: string;
	/** The plan node this leg serves, in the compiler's kebab-case vocabulary. */
	readonly destinationType?: string;
	/** The row that node names, when it has one. */
	readonly destinationRef?: string;
	/** The caller identity presented on this leg, as composed for the media server. */
	readonly callerId?: string;
}

/** Everything the orchestrator needs to know about the legs a walk owns. */
export interface OriginatedLegHooks {
	/** A leg is about to be created. Called BEFORE the originate, so no event can outrun it. */
	originated(leg: OriginatedLeg): void;
	/**
	 * The WALKER is ending this leg, with this cause.
	 *
	 * Called before the media server is told, for the same reason the orchestrator fixes the A-leg's
	 * cause before its own hangup: Asterisk answers a local `DELETE /channels` with a generic
	 * `ChannelHangupRequest`, and the cause is first-wins. Without this a ring-all loser's CDR says
	 * `NORMAL_UNSPECIFIED` — indistinguishable from a callee who declined — instead of `LOSE_RACE`.
	 */
	hangingUp(mediaChannelId: string, cause: HangupCause): void;
	/** The A-leg and this leg are now in `bridgeId`. Both CDRs gain the other's leg id. */
	bridged(mediaChannelId: string, bridgeId: string): void;
}

/** One call's facts, alongside the plan the resolver produced for them. */
export interface WalkInput {
	readonly plan: ExecutionPlan;
	/** The artifact's compiled time conditions; needed for `time-condition` DESTINATION nodes. */
	readonly timeConditions?: Readonly<Record<string, CompiledTimeCondition>>;
	readonly now?: Date;
	/** The number to dial, after digit manipulation. Outbound only. */
	readonly dialedNumber?: string;
	/** Caller identity to present on originated legs. */
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	/** Digits dialled after a feature code. Internal only. */
	readonly featureArgument?: string;
	/**
	 * The artifact's mailbox table, keyed by mailbox number.
	 *
	 * Supplied alongside the plan for the same reason `timeConditions` is: a `check` has to answer
	 * "does the extension this call came from have a mailbox?", which is a fact about the artifact
	 * rather than about the plan the resolver produced, and a walker that could not see it would
	 * have to either refuse every check or open whatever box the node happened to name.
	 */
	readonly mailboxes?: Readonly<Record<string, MailboxEntry>>;
}

export type WalkStatus =
	/** The A-leg is in a bridge with an answered party. The walk is over and the call is up. */
	| "bridged"
	/** The walk reached a terminal and the leg was hung up with {@link WalkOutcome.hangupCause}. */
	| "hangup"
	/** The leg went away underneath the walk. Nothing further was attempted. */
	| "aborted"
	/** The step budget ran out — the plan contains a cycle with no terminal. */
	| "exhausted";

export interface WalkOutcome {
	readonly status: WalkStatus;
	readonly hangupCause?: HangupCause;
	/** Where the call ended up, for the CDR. The LAST destination-bearing node the walk entered. */
	readonly destination?: PlanDestination;
	readonly visited: readonly PlanNodeId[];
	/** Gaps this walk hit: unimplemented node kinds, unresolvable media, skipped members. */
	readonly notes: readonly string[];
}

/** Where a single node's execution leaves the walk. */
type StepResult =
	| { readonly kind: "goto"; readonly nodeId: PlanNodeId }
	| { readonly kind: "hangup"; readonly cause: HangupCause }
	| { readonly kind: "bridged" }
	| { readonly kind: "aborted" };

/** One leg the walker may originate. */
interface DialAttempt {
	readonly endpoint: string;
	readonly label: string;
	/** The number being reached, for the B-leg's `toNumber`. */
	readonly destinationNumber: string;
	readonly timeoutSeconds: number;
	readonly delaySeconds: number;
	readonly callerId?: string;
	readonly variables?: Readonly<Record<string, string>>;
}

type DialOutcome =
	| { readonly kind: "answered"; readonly mediaChannelId: string; readonly index: number }
	| { readonly kind: "failed"; readonly cause: HangupCause; readonly index: number }
	| { readonly kind: "timeout" }
	| { readonly kind: "aborted" };

const MILLIS_PER_SECOND = 1_000;

export class PlanWalker {
	private readonly settings: PlanWalkerSettings;
	private readonly newId: () => string;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly log: (message: string, detail?: Record<string, unknown>) => void;
	private readonly notes: string[] = [];
	private readonly visited: PlanNodeId[] = [];
	private destination: PlanDestination | undefined;

	constructor(private readonly deps: PlanWalkerDependencies) {
		this.settings = { ...DEFAULT_PLAN_WALKER_SETTINGS, ...deps.settings };
		this.newId = deps.newId ?? createEntityId;
		this.delay =
			deps.delay ??
			((ms: number) =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, ms);
					timer.unref?.();
				}));
		this.log = deps.log ?? (() => undefined);
	}

	/**
	 * Walks the plan to a terminal.
	 *
	 * Never throws. A media-server failure mid-walk ends the call with a cause the carrier
	 * understands, because the alternative — an exception out of an ARI event callback — takes
	 * every other live call down with it.
	 */
	async walk(input: WalkInput): Promise<WalkOutcome> {
		let nodeId: PlanNodeId | undefined = input.plan.entryNodeId;

		for (let step = 0; step < this.settings.maxPlanSteps; step += 1) {
			if (this.deps.channel.isTearingDown) {
				return this.outcome("aborted");
			}
			if (nodeId === undefined) {
				return await this.terminate("NORMAL_CLEARING");
			}

			const node: PlanNode | undefined = input.plan.nodes[nodeId];
			if (node === undefined) {
				// The compiler guarantees closure, so this is an artifact that was written by one
				// release and read by another. Refusing the call is the only honest answer.
				this.note(`plan node "${nodeId}" is missing from the artifact`);
				return await this.terminate("NORMAL_TEMPORARY_FAILURE");
			}

			this.visited.push(nodeId);
			const destination = planDestinationOf(node);
			if (destination !== undefined) {
				this.destination = destination;
			}

			let result: StepResult;
			try {
				result = await this.step(node, input);
			} catch (error) {
				this.log("plan node execution failed", { nodeId, err: String(error) });
				this.note(`node "${nodeId}" (${node.kind}) failed: ${String(error)}`);
				return await this.terminate("NORMAL_TEMPORARY_FAILURE");
			}

			switch (result.kind) {
				case "goto": {
					nodeId = result.nodeId;
					continue;
				}
				case "hangup": {
					return await this.terminate(result.cause);
				}
				case "bridged": {
					return this.outcome("bridged");
				}
				default: {
					return this.outcome("aborted");
				}
			}
		}

		this.note(
			`the walk exceeded ${String(this.settings.maxPlanSteps)} steps; the plan contains a cycle with no terminal`,
		);
		return await this.terminate("EXCHANGE_ROUTING_ERROR", "exhausted");
	}

	// -------------------------------------------------------------------------------------------
	// Node dispatch
	// -------------------------------------------------------------------------------------------

	private async step(node: PlanNode, input: WalkInput): Promise<StepResult> {
		switch (node.kind) {
			case "hangup": {
				return { kind: "hangup", cause: node.cause };
			}
			case "playback": {
				return await this.playbackNode(node);
			}
			case "time-condition": {
				return this.timeConditionNode(node, input);
			}
			case "extension": {
				return await this.extensionNode(node, input);
			}
			case "ring-group": {
				return await this.ringGroupNode(node, input);
			}
			case "ivr-menu": {
				return await this.ivrMenuNode(node);
			}
			case "voicemail": {
				return await this.voicemailNode(node, input);
			}
			case "trunk-dial": {
				return await this.trunkDialNode(node, input);
			}
			case "external": {
				return await this.externalNode(node, input);
			}
			case "feature-code": {
				return await this.featureCodeNode(node);
			}
			case "queue": {
				return await this.queueNode(node);
			}
			default: {
				// `conference`, `park`, `application`: real destinations with real runtimes, none of
				// which exist yet. Announcing and hanging up is a worse product than the real thing
				// and a better one than silence.
				this.note(`node kind "${node.kind}" is not implemented yet; announced and hung up`);
				return await this.announceAndHangup(
					this.settings.unavailableAnnouncement,
					"FACILITY_NOT_IMPLEMENTED",
				);
			}
		}
	}

	// -------------------------------------------------------------------------------------------
	// Simple nodes
	// -------------------------------------------------------------------------------------------

	private async playbackNode(node: Extract<PlanNode, { kind: "playback" }>): Promise<StepResult> {
		const media = resolveMediaRef(node, this.settings.mediaRefs);
		if (media === undefined) {
			// A playback node with nothing to play is a pass-through, not a failure: the compiler
			// allows one so a route can be re-pointed without deleting the node.
			this.note(`playback node "${node.id}" names no playable media`);
		} else {
			if (!(await this.ensureAnswered())) {
				return { kind: "aborted" };
			}
			const played = await this.deps.execute({ verb: "play", media });
			if (played === undefined) {
				return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
			}
		}
		return node.thenNodeId === undefined
			? { kind: "hangup", cause: "NORMAL_CLEARING" }
			: { kind: "goto", nodeId: node.thenNodeId };
	}

	/**
	 * A time condition in its DESTINATION role.
	 *
	 * The resolver already followed the gates it could see at resolve time, so reaching one here
	 * means a branch pointed at it — an IVR option that goes to "night service", say. Evaluating it
	 * against the walk's own instant rather than the resolve instant is deliberate: a caller who
	 * sat in an IVR across 17:00 should get the after-hours branch.
	 */
	private timeConditionNode(
		node: Extract<PlanNode, { kind: "time-condition" }>,
		input: WalkInput,
	): StepResult {
		const condition = input.timeConditions?.[node.timeConditionId];
		if (condition === undefined) {
			this.note(
				`time condition "${node.timeConditionId}" is missing from the artifact; the gate was treated as open`,
			);
			return { kind: "goto", nodeId: node.matchNodeId };
		}
		const at = input.now ?? new Date(this.deps.now?.() ?? Date.now());
		const evaluation = evaluateTimeCondition(condition, at);
		const next = evaluation.matched ? node.matchNodeId : node.noMatchNodeId;
		if (next === undefined) {
			return { kind: "hangup", cause: "NORMAL_CLEARING" };
		}
		return { kind: "goto", nodeId: next };
	}

	/**
	 * Star codes.
	 *
	 * `voicemail-check` is served by the voicemail placeholder for whatever the code's own target
	 * says; everything else announces and hangs up. That is not laziness — a `*78` that silently
	 * did nothing would leave a user believing DND is on, and a caller who then rings them would be
	 * the one who finds out.
	 */
	private async featureCodeNode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
	): Promise<StepResult> {
		if (node.targetNodeId !== undefined) {
			return { kind: "goto", nodeId: node.targetNodeId };
		}
		if (node.action === "voicemail-check" || node.action === "voicemail-direct") {
			// A feature code with no target compiled to nothing to go to: the tenant has the code but
			// no mailbox behind it. Announcing that is the honest answer — the alternative is a `*97`
			// that plays a greeting and hangs up, which a user reads as "my voicemail is broken".
			this.note(
				`feature code ${node.code} (${node.action}) resolved to no mailbox node; nothing to open`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}
		this.note(`feature code ${node.code} (${node.action}) is not implemented yet`);
		return await this.announceAndHangup(
			this.settings.unavailableAnnouncement,
			"FACILITY_NOT_IMPLEMENTED",
		);
	}

	// -------------------------------------------------------------------------------------------
	// IVR
	// -------------------------------------------------------------------------------------------

	/**
	 * An IVR menu.
	 *
	 * The two counters are separate because the failures are separate: a caller who presses nothing
	 * three times is on a phone in a pocket, and a caller who presses `9` three times wants an
	 * option that does not exist. `maxTimeouts` and `maxFailures` therefore have their own budgets
	 * and their own branches, exactly as the compiler models them.
	 *
	 * The greeting is played by the `gather` verb itself, so barge-in works: the prompt stops on the
	 * first digit rather than talking over the caller's second one.
	 */
	private async ivrMenuNode(node: IvrMenuPlanNode): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		let failures = 0;
		let timeouts = 0;
		let attempt = 0;

		while (failures <= node.maxFailures && timeouts <= node.maxTimeouts) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}

			const greeting =
				attempt === 0
					? resolveMediaRef({ promptId: node.greetingPromptId }, this.settings.mediaRefs)
					: resolveMediaRef(
							{ promptId: node.shortGreetingPromptId ?? node.greetingPromptId },
							this.settings.mediaRefs,
						);
			attempt += 1;

			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: node.maxDigits,
				// `#` ends a variable-length entry. It is not configurable per menu in the artifact,
				// and inventing a per-menu terminator would be a product decision made here.
				terminators: ["#"],
				timeoutMs: node.digitTimeoutMs,
				interDigitTimeoutMs: node.interDigitTimeoutMs,
				...(greeting === undefined ? {} : { media: greeting }),
			});

			if (result === undefined) {
				return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "aborted" };
			}

			const digits = collection?.digits.join("") ?? "";
			if (digits === "") {
				timeouts += 1;
				if (timeouts > node.maxTimeouts) {
					break;
				}
				await this.playPrompt(node.timeoutPromptId);
				continue;
			}

			const option = node.options.find(
				(candidate) => matchPattern(candidate.pattern, digits) !== null,
			);
			if (option !== undefined) {
				return { kind: "goto", nodeId: option.targetNodeId };
			}

			if (node.directDialEnabled) {
				// Direct dial means "resolve these digits in the INTERNAL context", which is a second
				// resolver call the walker has no artifact to make. Reported rather than guessed: an
				// IVR that silently dialled the wrong extension is worse than one that says invalid.
				this.note(
					`IVR "${node.ivrMenuId}" has direct dial enabled, which needs an internal resolve the walker cannot make yet; ${digits} was treated as invalid`,
				);
			}

			failures += 1;
			if (failures > node.maxFailures) {
				break;
			}
			await this.playPrompt(node.invalidPromptId);
		}

		// Which budget ran out decides the branch. Both fall back to a terminal that says what
		// happened rather than to `NORMAL_CLEARING`, which reads as "the caller hung up".
		if (timeouts > node.maxTimeouts) {
			return node.timeoutNodeId === undefined
				? { kind: "hangup", cause: "NO_USER_RESPONSE" }
				: { kind: "goto", nodeId: node.timeoutNodeId };
		}
		return node.invalidNodeId === undefined
			? { kind: "hangup", cause: "INVALID_NUMBER_FORMAT" }
			: { kind: "goto", nodeId: node.invalidNodeId };
	}

	private async playPrompt(promptId: string | undefined): Promise<void> {
		const media = resolveMediaRef({ promptId }, this.settings.mediaRefs);
		if (media === undefined) {
			return;
		}
		await this.deps.execute({ verb: "play", media });
	}

	// -------------------------------------------------------------------------------------------
	// Extensions and ring groups
	// -------------------------------------------------------------------------------------------

	private async extensionNode(node: ExtensionPlanNode, input: WalkInput): Promise<StepResult> {
		if (node.forwardAllNodeId !== undefined) {
			// Forward-all is taken BEFORE ringing: the whole point is that the phone never rings.
			return { kind: "goto", nodeId: node.forwardAllNodeId };
		}
		if (node.doNotDisturb) {
			return this.branch(node.busyNodeId, "USER_BUSY");
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome = await this.dialSequential(
			[
				{
					endpoint: this.endpointForExtension(node.number),
					label: `extension ${node.number}`,
					destinationNumber: node.number,
					timeoutSeconds: node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds,
					delaySeconds: 0,
					callerId: this.callerIdFor(input),
				},
			],
			[],
		);

		return await this.settleDial(outcome, {
			busyNodeId: node.busyNodeId,
			noAnswerNodeId: node.noAnswerNodeId,
			notRegisteredNodeId: node.notRegisteredNodeId,
		});
	}

	/**
	 * A ring group.
	 *
	 * `simultaneous` originates every member (honouring each member's own ring delay) and the first
	 * answer wins; every other leg is hung up with `LOSE_RACE` — Q.850 26, "non-selected user
	 * clearing" — and not with `NORMAL_CLEARING`, because a losing leg that reports normal clearing
	 * is indistinguishable from a caller who hung up, and that difference shows up in billing
	 * disputes.
	 *
	 * `sequential` walks the members in `ordinal` order with a per-member timeout.
	 */
	private async ringGroupNode(node: RingGroupPlanNode, input: WalkInput): Promise<StepResult> {
		const attempts: DialAttempt[] = [];
		for (const member of [...node.members].sort((a, b) => a.ordinal - b.ordinal)) {
			const target = input.plan.nodes[member.targetNodeId];
			if (target === undefined || target.kind !== "extension") {
				// A group whose member is another group, an external number or a voicemail box is a
				// real configuration this slice cannot originate for. Skipping it loudly beats
				// dialling something else.
				this.note(
					`ring group "${node.ringGroupId}" member "${member.targetNodeId}" is not an extension (${target?.kind ?? "missing"}); skipped`,
				);
				continue;
			}
			if (member.confirmRequired || node.confirmEnabled) {
				this.note(
					`ring group "${node.ringGroupId}" asks for answer confirmation, which is not implemented yet; the member was dialled without it`,
				);
			}
			attempts.push({
				endpoint: this.endpointForExtension(target.number),
				label: `extension ${target.number}`,
				destinationNumber: target.number,
				timeoutSeconds:
					member.timeoutSeconds ||
					node.ringTimeoutSeconds ||
					this.settings.defaultRingTimeoutSeconds,
				delaySeconds: member.delaySeconds,
				callerId: this.callerIdFor(input, node.callerIdNamePrefix),
			});
		}

		if (attempts.length === 0) {
			this.note(`ring group "${node.ringGroupId}" has no dialable members`);
			return this.branch(node.timeoutNodeId, "NO_ANSWER");
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome =
			node.strategy === "sequential"
				? await this.dialSequential(attempts, node.ignoreBusy ? [] : ["USER_BUSY"])
				: await this.dialSimultaneous(
						attempts,
						node.ringTimeoutSeconds || this.settings.defaultRingTimeoutSeconds,
					);

		return await this.settleDial(outcome, { noAnswerNodeId: node.timeoutNodeId });
	}

	/** Turns a dial outcome into the next step, honouring an extension's three failure branches. */
	private async settleDial(
		outcome: DialOutcome,
		branches: {
			readonly busyNodeId?: PlanNodeId;
			readonly noAnswerNodeId?: PlanNodeId;
			readonly notRegisteredNodeId?: PlanNodeId;
		},
	): Promise<StepResult> {
		switch (outcome.kind) {
			case "answered": {
				return await this.bridgeWith(outcome.mediaChannelId);
			}
			case "aborted": {
				return { kind: "aborted" };
			}
			case "timeout": {
				return this.branch(branches.noAnswerNodeId, "NO_ANSWER");
			}
			default: {
				if (outcome.cause === "USER_BUSY") {
					return this.branch(branches.busyNodeId ?? branches.noAnswerNodeId, "USER_BUSY");
				}
				if (outcome.cause === "USER_NOT_REGISTERED" || outcome.cause === "SUBSCRIBER_ABSENT") {
					return this.branch(
						branches.notRegisteredNodeId ?? branches.noAnswerNodeId,
						outcome.cause,
					);
				}
				return this.branch(branches.noAnswerNodeId, outcome.cause);
			}
		}
	}

	private branch(nodeId: PlanNodeId | undefined, cause: HangupCause): StepResult {
		return nodeId === undefined ? { kind: "hangup", cause } : { kind: "goto", nodeId };
	}

	// -------------------------------------------------------------------------------------------
	// Trunks
	// -------------------------------------------------------------------------------------------

	/**
	 * An outbound trunk chain.
	 *
	 * `continueOnCauses` is a CLOSED allow-list, defaulting to telephony's retryable set, and the
	 * walker honours it literally: walking a whole trunk list after a `CALL_REJECTED` multiplies one
	 * fraudulent attempt by the number of carriers a tenant has, which is precisely the
	 * amplification a compromised extension is looking for.
	 */
	private async trunkDialNode(node: TrunkDialPlanNode, input: WalkInput): Promise<StepResult> {
		// Only the RESOLVED number. There is no sensible fallback: the caller's own number is the
		// one thing that must never be dialled, and the destination the leg arrived on has not been
		// through the route's digit manipulation.
		const number = input.dialedNumber;
		if (number === undefined || number === "") {
			this.note(`trunk-dial node "${node.id}" has no number to dial`);
			return this.branch(node.failoverNodeId, "INVALID_NUMBER_FORMAT");
		}

		const continueOn = new Set<string>(
			node.continueOnCauses.length > 0 ? node.continueOnCauses : RETRYABLE_HANGUP_CAUSES,
		);
		const attempts = [...node.attempts].sort((a, b) => a.order - b.order);
		if (attempts.length === 0) {
			this.note(`trunk-dial node "${node.id}" has no trunks configured`);
			return this.branch(node.failoverNodeId, "NETWORK_OUT_OF_ORDER");
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		let lastCause: HangupCause = "NORMAL_TEMPORARY_FAILURE";
		for (const attempt of attempts) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			const outcome = await this.dialOne(
				{
					endpoint: this.settings.trunkDialTemplate
						.replaceAll("{number}", number)
						.replaceAll("{trunk}", attempt.name),
					label: `trunk ${attempt.name}`,
					destinationNumber: number,
					timeoutSeconds: this.settings.defaultRingTimeoutSeconds,
					delaySeconds: 0,
					callerId: composeCallerId(
						input.callerIdName,
						attempt.callerIdNumberOverride ?? node.callerIdNumberOverride ?? input.callerIdNumber,
					),
				},
				0,
			);

			if (outcome.kind === "answered") {
				return await this.bridgeWith(outcome.mediaChannelId);
			}
			if (outcome.kind === "aborted") {
				return { kind: "aborted" };
			}
			lastCause = outcome.kind === "timeout" ? "NO_ANSWER" : outcome.cause;
			if (!continueOn.has(lastCause)) {
				this.log("trunk failover stopped: the cause is not retryable", {
					trunk: attempt.name,
					cause: lastCause,
				});
				break;
			}
		}

		return this.branch(node.failoverNodeId, lastCause);
	}

	/**
	 * A literal number outside the organization.
	 *
	 * `viaOutboundRouting` means "go back through the outbound tables so this picks up a trunk, a
	 * toll class and a caller id" — skipping that is how a PBX ends up with an inbound route that
	 * can dial anywhere on someone else's account. The walker has no outbound resolver of its own,
	 * so when the flag is set and nothing supplied one, it REFUSES rather than dialling direct.
	 */
	private async externalNode(
		node: Extract<PlanNode, { kind: "external" }>,
		input: WalkInput,
	): Promise<StepResult> {
		if (node.viaOutboundRouting) {
			this.note(
				`external node "${node.id}" requires outbound routing, which the walker cannot resolve yet; the call was refused rather than dialled direct`,
			);
			return { kind: "hangup", cause: "OUTGOING_CALL_BARRED" };
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome = await this.dialOne(
			{
				endpoint: this.settings.trunkDialTemplate
					.replaceAll("{number}", node.destination)
					.replaceAll("{trunk}", "external"),
				label: `external ${node.destination}`,
				destinationNumber: node.destination,
				timeoutSeconds: this.settings.defaultRingTimeoutSeconds,
				delaySeconds: 0,
				callerId: composeCallerId(
					node.callerIdName ?? input.callerIdName,
					node.callerIdNumber ?? input.callerIdNumber,
				),
			},
			0,
		);

		return await this.settleDial(outcome, {});
	}

	// -------------------------------------------------------------------------------------------
	// Voicemail
	// -------------------------------------------------------------------------------------------

	/**
	 * Leaving a message in a mailbox.
	 *
	 * ## What is real
	 *
	 * The caller hears a greeting, hears a beep, records, and the message is FILED: a
	 * `voicemail.message.left` carrying the box id, the object key, the duration, the caller's
	 * identity and the leg it was left on is published on the VOICEMAIL stream, which the control
	 * plane consumes into a `voicemail_message` row and answers with `voicemail.mwi.updated`. The
	 * `channel.record.*` pair still goes out on the call stream for the object-store uploader, which
	 * is a different consumer with a different retention and must not have to join across streams.
	 *
	 * The publish carries the message id the engine mints, so the consumer's insert is idempotent
	 * over a redelivery rather than producing two copies of one message.
	 *
	 * ## What is not, and why
	 *
	 * **The greeting is still the deployment-wide one.** `VoicemailPlanNode` carries the box's id,
	 * number, `maxMessageSeconds` and `mwiEnabled` — but not the object key of its active greeting,
	 * which lives in `voicemail_greeting` and is never compiled into the artifact. Reading it here
	 * would mean a database round trip on the call path from a process that holds no database
	 * handle, so the honest fix is one the compiler owns: embed the active greeting's key at compile
	 * time, exactly as it embeds every other routing input. That is a `packages/routing` change and
	 * is recorded as a follow-up rather than worked around here.
	 *
	 * **Email delivery is not wired.** `voicemail_box.email_mode` is likewise not in the artifact,
	 * and delivery belongs to the control plane, which is where the `voicemail.message.left`
	 * consumer already is.
	 */
	private async voicemailNode(node: VoicemailPlanNode, input: WalkInput): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		if (node.mode === "check") {
			return await this.voicemailCheck(node, input);
		}

		await this.deps.execute({ verb: "play", media: this.settings.voicemailGreeting });

		const recordingId = this.newId();
		const format = this.settings.recordingFormat;
		const objectKey = `${this.deps.channel.organizationId}/${this.deps.channel.callId}/${recordingId}.${format}`;
		const maxSeconds = node.maxMessageSeconds || 120;

		// Subscribed BEFORE the record call: a zero-length recording can finish before the HTTP
		// response arrives, and a waiter registered afterwards would wait for a signal already sent.
		const finished = this.waitForRecording(recordingId, (maxSeconds + 5) * MILLIS_PER_SECOND);

		try {
			await this.deps.media.record(this.deps.channel.mediaChannelId, {
				name: recordingId,
				format,
				maxDurationSeconds: maxSeconds,
				maxSilenceSeconds: 5,
				beep: true,
				terminateOn: "#",
			});
		} catch (error) {
			finished.cancel();
			this.note(`voicemail recording failed to start: ${String(error)}`);
			return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
		}

		await this.deps.publish("channel.record.started", {
			legId: this.deps.channel.channelId,
			recordingId,
			objectKey,
			kind: "voicemail",
		});

		const result = await finished.promise;

		await this.deps.publish("channel.record.stopped", {
			legId: this.deps.channel.channelId,
			recordingId,
			objectKey,
			durationMs: result.durationMs,
			reason: result.reason,
		});

		if (result.reason === "failed" || result.durationMs <= 0) {
			// A failed or empty recording must NOT become a mailbox row. A message a user opens to
			// find silence in is worse than no message: it costs them the trip and tells them nothing,
			// and it lights an MWI lamp that has nothing behind it.
			this.note(
				`voicemail recording ${recordingId} produced no audio (${result.reason}); no message was filed`,
			);
			return { kind: "hangup", cause: "NORMAL_CLEARING" };
		}

		await this.fileVoicemailMessage(node, recordingId, objectKey, result.durationMs);
		return { kind: "hangup", cause: "NORMAL_CLEARING" };
	}

	/**
	 * Publishes the message so the control plane can file it.
	 *
	 * Failures are noted, not fatal. The caller has already recorded and hung up by the time this
	 * runs, so there is no call left to fail — but the object IS in the store and the row is not,
	 * which is a divergence an operator has to be able to see. It is a `note` (and therefore a log
	 * line on the walk) rather than a silent catch for exactly that reason.
	 */
	private async fileVoicemailMessage(
		node: VoicemailPlanNode,
		recordingId: string,
		objectKey: string,
		durationMs: number,
	): Promise<void> {
		const port = this.deps.voicemail;
		if (port === undefined) {
			this.note(
				`voicemail message ${recordingId} was recorded but not filed: this walk has no voicemail port`,
			);
			return;
		}
		try {
			await port.messageLeft({
				voicemailBoxId: node.voicemailBoxId,
				mailboxNumber: node.mailboxNumber,
				messageId: this.newId(),
				recordingId,
				objectKey,
				durationMs,
				mwiEnabled: node.mwiEnabled,
				...(this.deps.channel.callerIdNumber === undefined
					? {}
					: { callerIdNumber: this.deps.channel.callerIdNumber }),
				...(this.deps.channel.callerIdName === undefined
					? {}
					: { callerIdName: this.deps.channel.callerIdName }),
			});
		} catch (error) {
			this.note(
				`voicemail message ${recordingId} was recorded into ${objectKey} but could NOT be filed: ${String(error)}`,
			);
		}
	}

	/**
	 * Opening a mailbox — `*97`, and any `voicemail` node in `check` mode.
	 *
	 * ## What is real
	 *
	 * The caller is identified by the extension they are calling from, their mailbox is found in the
	 * artifact's mailbox table, and the box's number is read back to them one digit at a time using
	 * the `digits/*` sounds every Asterisk install ships — no TTS, no per-deployment prompt pack. A
	 * caller who dials `*97` from a phone with no mailbox is told so instead of hearing silence.
	 *
	 * ## What is stubbed, precisely
	 *
	 * **There is no PIN check.** `voicemail_box.pin_hash` is not compiled into the artifact, so the
	 * only authentication available here is "the call came from this extension" — which is exactly
	 * as strong as the phone on the desk and no stronger. That is the classic PBX default and it is
	 * ACCEPTABLE for `*97` from an internal extension; it is NOT acceptable for the from-anywhere
	 * check a `voicemail` node in `check` mode can be reached by, so that path is refused rather
	 * than silently opened. Closing it needs the compiler to embed the hash.
	 *
	 * **There is no message count and no playback.** Both need the `voicemail_message` rows, which
	 * live in `pbx-db` behind the control plane; the engine holds no database handle and there is no
	 * read model on the backbone that carries them. The `voicemail.mwi.updated` event added in this
	 * wave is the contract that read model will be built on. Until it exists this announces the
	 * mailbox and stops, and says so in the notes rather than playing "you have no messages" at
	 * somebody who has nine.
	 */
	private async voicemailCheck(node: VoicemailPlanNode, input: WalkInput): Promise<StepResult> {
		const caller = input.callerIdNumber ?? this.deps.channel.callerIdNumber;
		const mailbox = this.mailboxFor(node, caller, input);

		if (mailbox === undefined) {
			this.note(
				`voicemail check from ${caller ?? "an unknown caller"} matched no mailbox; refusing rather than opening box ${node.mailboxNumber}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		for (const media of this.spellNumber(mailbox)) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			await this.deps.execute({ verb: "play", media });
		}

		this.note(
			`voicemail check opened box ${mailbox}; message counts and playback need the voicemail read model (voicemail.evt.v1) and are not implemented yet`,
		);
		return { kind: "hangup", cause: "NORMAL_CLEARING" };
	}

	/**
	 * Which mailbox a check may open.
	 *
	 * The node's own `mailboxNumber` is only honoured when it IS the caller's — a feature code
	 * compiles to a node with the dialling extension's box, so in the `*97` case the two agree, and
	 * in every other case they disagreeing means somebody is being handed a mailbox that is not
	 * theirs. The artifact's mailbox table is the second source: it is keyed by mailbox number and
	 * is what makes "does this extension have a box at all?" answerable without a database.
	 */
	private mailboxFor(
		node: VoicemailPlanNode,
		caller: string | undefined,
		input: WalkInput,
	): string | undefined {
		const callerNumber = caller?.trim();
		if (callerNumber === undefined || callerNumber === "") {
			return undefined;
		}
		if (node.mailboxNumber === callerNumber) {
			return node.mailboxNumber;
		}
		const known = input.mailboxes?.[callerNumber];
		return known === undefined ? undefined : known.mailboxNumber;
	}

	/**
	 * A number as a sequence of playable digit sounds.
	 *
	 * `digits/0` … `digits/9` are in Asterisk's core sound package, so this works on a stock install
	 * with no prompt pack and no TTS. Anything that is not a digit is dropped rather than guessed
	 * at: there is no core sound for `#`, and playing nothing is better than playing the wrong word.
	 */
	private spellNumber(value: string): readonly string[] {
		const prefix = this.settings.mediaRefs.promptPrefix;
		return [...value]
			.filter((character) => character >= "0" && character <= "9")
			.map((digit) => `${prefix}digits/${digit}`);
	}

	private waitForRecording(
		name: string,
		timeoutMs: number,
	): {
		readonly promise: Promise<{ durationMs: number; reason: "completed" | "cancelled" | "failed" }>;
		readonly cancel: () => void;
	} {
		let unwatch = (): void => undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let settle: (value: {
			durationMs: number;
			reason: "completed" | "cancelled" | "failed";
		}) => void = () => undefined;

		const promise = new Promise<{
			durationMs: number;
			reason: "completed" | "cancelled" | "failed";
		}>((resolve) => {
			const done = (value: {
				durationMs: number;
				reason: "completed" | "cancelled" | "failed";
			}): void => {
				if (timer !== undefined) {
					clearTimeout(timer);
					timer = undefined;
				}
				unwatch();
				resolve(value);
			};
			settle = done;

			unwatch = this.deps.signals.watch(recordingSignalKey(name), (signal) => {
				if (signal.kind === "recording-finished") {
					done({ durationMs: signal.durationMs, reason: "completed" });
					return;
				}
				if (signal.kind === "recording-failed") {
					this.note(`voicemail recording ${name} failed: ${signal.reason}`);
					done({ durationMs: 0, reason: "failed" });
				}
			});

			// The backstop matters: ARI drops `RecordingFinished` when the channel dies mid-record,
			// and a voicemail that never publishes `record.stopped` is an object nobody uploads.
			timer = setTimeout(() => {
				done({ durationMs: timeoutMs, reason: "cancelled" });
			}, timeoutMs);
			timer.unref?.();
		});

		return {
			promise,
			cancel: () => {
				settle({ durationMs: 0, reason: "cancelled" });
			},
		};
	}

	// -------------------------------------------------------------------------------------------
	// Queues
	// -------------------------------------------------------------------------------------------

	/**
	 * An ACD queue.
	 *
	 * The whole runtime lives in `../queue/queue-session.ts`; this method's job is to hand it the
	 * media primitives the walker already owns and to turn its outcome into a step.
	 *
	 * That split is deliberate. Everything a queued caller needs — answer-and-wait, originate a leg
	 * through the CDR-correct leg hooks, bridge with the right causes, resolve a prompt id — exists
	 * here already, and duplicating it inside the queue module would produce a second, subtly
	 * different way to originate a B-leg. Everything a queue needs that the walker knows nothing
	 * about — tier rules, six distribution strategies, agent state, wrap-up — lives there, where it
	 * can be tested against fakes without a channel.
	 *
	 * ## The outcomes
	 *
	 * - `answered` — the caller is bridged to an agent; the walk is over and the call is up.
	 * - `timeout` — a wait deadline expired. The queue's `timeoutNodeId` is taken when it has one,
	 *   and `ALLOTTED_TIMEOUT` (Q.850 802) when it does not. NOT `NO_ANSWER`: a queue that ran out of
	 *   patience is a different fact from a phone nobody picked up, and it is the fact an SLA report
	 *   is built on.
	 * - `abandoned` — the caller hung up. Nothing is left to route.
	 * - `failed` — the roster could not be read. `NORMAL_TEMPORARY_FAILURE`, and a note that names
	 *   the bucket, because this is an infrastructure fault and must not be reported as an empty
	 *   queue.
	 */
	private async queueNode(node: QueuePlanNode): Promise<StepResult> {
		const services = this.deps.queue;
		if (services === undefined) {
			this.note(
				`queue "${node.queueId}" cannot be served: this walk has no ACD services; announced and hung up`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const session = new QueueSession(node, this.queueCallPort(), services, {
			agentRingTimeoutSeconds: this.settings.defaultRingTimeoutSeconds,
			...this.deps.queueSettings,
		});

		const outcome = await session.run();

		switch (outcome.kind) {
			case "answered": {
				return { kind: "bridged" };
			}
			case "timeout": {
				return this.branch(node.timeoutNodeId, "ALLOTTED_TIMEOUT");
			}
			case "abandoned":
			case "aborted": {
				return { kind: "aborted" };
			}
			default: {
				return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
			}
		}
	}

	/**
	 * The walker's media primitives, as the queue session consumes them.
	 *
	 * `channel` is destructured out because {@link WalkerChannel.isTearingDown} is a LIVE getter on
	 * the orchestrator's aggregate: the port has to re-read it on every access, so the value cannot
	 * be captured and the object needs a getter of its own. Everything else is an arrow function,
	 * which closes over the walker's `this` lexically.
	 */
	private queueCallPort(): QueueCallPort {
		const { channel, media, execute } = this.deps;
		return {
			get isTearingDown(): boolean {
				return channel.isTearingDown;
			},
			callerLegId: channel.channelId,
			callId: channel.callId,
			organizationId: channel.organizationId,
			...(channel.callerIdNumber === undefined ? {} : { callerNumber: channel.callerIdNumber }),
			ensureAnswered: async () => await this.ensureAnswered(),
			play: async (playable: string) =>
				(await execute({ verb: "play", media: playable })) !== undefined,
			startMusicOnHold: async (mohClass?: string) => {
				try {
					await media.startMusicOnHold(channel.mediaChannelId, mohClass);
				} catch (error) {
					// A missing music class must not end a call. The caller hears silence, which is
					// worse than music and much better than a hangup, and the note says which it was.
					this.note(`music on hold could not be started: ${String(error)}`);
				}
			},
			stopMusicOnHold: async () => {
				try {
					await media.stopMusicOnHold(channel.mediaChannelId);
				} catch {
					// Stopping music that is not playing is a no-op everywhere it matters.
				}
			},
			dial: async (attempts, fanOut, ringTimeoutSeconds) =>
				await this.dialQueueAgents(attempts, fanOut, ringTimeoutSeconds),
			bridge: async (mediaChannelId, onEnded) =>
				(await this.bridgeWith(mediaChannelId, onEnded)).kind === "bridged",
			resolvePrompt: (promptId) => resolveMediaRef({ promptId }, this.settings.mediaRefs),
			spellNumber: (value) => this.spellNumber(value),
			note: (message) => {
				this.note(message);
			},
			delay: async (ms) => {
				await this.delay(ms);
			},
			now: () => this.deps.now?.() ?? Date.now(),
		};
	}

	/**
	 * Rings queue agents, translating between the session's vocabulary and the walker's.
	 *
	 * The one behaviour that is queue-specific is `abortOnCallerHangup`: a queued caller who gives up
	 * while an agent's phone is ringing must not leave that phone ringing. An extension or a ring
	 * group does not need it — the caller's hangup tears the whole call down within the same event
	 * — but a queue has already answered the caller, so their leg's death arrives as a signal the
	 * dial has to be watching for.
	 */
	private async dialQueueAgents(
		attempts: readonly QueueDialAttempt[],
		fanOut: "one" | "all",
		ringTimeoutSeconds: number,
	): Promise<QueueDialOutcome> {
		if (attempts.length === 0) {
			return { kind: "timeout" };
		}

		const dialAttempts: DialAttempt[] = attempts.map((attempt) => ({
			endpoint: attempt.endpoint,
			label: attempt.label,
			destinationNumber: attempt.destinationNumber,
			timeoutSeconds: attempt.timeoutSeconds || ringTimeoutSeconds,
			delaySeconds: 0,
			...(this.callerIdForQueue() === undefined ? {} : { callerId: this.callerIdForQueue() }),
		}));

		const outcome =
			fanOut === "all"
				? await this.dialSimultaneous(dialAttempts, ringTimeoutSeconds, true)
				: await this.dialOne(dialAttempts[0] as DialAttempt, 0, true);

		switch (outcome.kind) {
			case "answered": {
				const agent = attempts[outcome.index] ?? attempts[0];
				return {
					kind: "answered",
					agentId: (agent as QueueDialAttempt).agentId,
					mediaChannelId: outcome.mediaChannelId,
				};
			}
			case "failed": {
				const agent = attempts[outcome.index] ?? attempts[0];
				return {
					kind: "failed",
					agentId: (agent as QueueDialAttempt).agentId,
					cause: outcome.cause,
				};
			}
			case "aborted": {
				return { kind: "aborted" };
			}
			default: {
				return { kind: "timeout" };
			}
		}
	}

	/**
	 * The identity a queue agent's phone shows.
	 *
	 * The CALLER's, not the queue's — an agent has to see who is on the line before they answer, and
	 * a queue name in the caller id field is a name they already know from the fact their queue
	 * phone rang. The queue is carried on the B-leg's `destinationType` for the CDR instead.
	 */
	private callerIdForQueue(): string | undefined {
		return composeCallerId(this.deps.channel.callerIdName, this.deps.channel.callerIdNumber);
	}

	// -------------------------------------------------------------------------------------------
	// Dialling
	// -------------------------------------------------------------------------------------------

	/** Rings the attempts one at a time, stopping on an answer or on a cause that is not allowed. */
	private async dialSequential(
		attempts: readonly DialAttempt[],
		stopOnCauses: readonly HangupCause[],
	): Promise<DialOutcome> {
		const stop = new Set<string>(stopOnCauses);
		let last: DialOutcome = { kind: "timeout" };

		for (const [index, attempt] of attempts.entries()) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			if (attempt.delaySeconds > 0) {
				await this.delay(attempt.delaySeconds * MILLIS_PER_SECOND);
			}
			const outcome = await this.dialOne(attempt, index);
			if (outcome.kind === "answered" || outcome.kind === "aborted") {
				return outcome;
			}
			last = outcome;
			if (outcome.kind === "failed" && stop.has(outcome.cause)) {
				return outcome;
			}
		}
		return last;
	}

	/**
	 * Rings every attempt at once. First answer wins; every other leg gets `LOSE_RACE`.
	 *
	 * The losers are hung up BEFORE the winner is bridged, not after. A member who picks up a
	 * millisecond after the race is decided must hear the call end rather than be joined to a bridge
	 * they were not selected for.
	 */
	private async dialSimultaneous(
		attempts: readonly DialAttempt[],
		overallTimeoutSeconds: number,
		abortOnCallerHangup = false,
	): Promise<DialOutcome> {
		const channelIds = attempts.map(() => this.newId());
		const unwatchers: (() => void)[] = [];
		const ended = new Set<number>();
		let settled = false;
		let resolveOutcome: (outcome: DialOutcome) => void = () => undefined;
		let lastCause: HangupCause | undefined;

		const outcomePromise = new Promise<DialOutcome>((resolve) => {
			resolveOutcome = (outcome) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(outcome);
			};
		});

		const overall = setTimeout(
			() => {
				resolveOutcome({ kind: "timeout" });
			},
			Math.max(1, overallTimeoutSeconds) * MILLIS_PER_SECOND,
		);
		overall.unref?.();

		if (abortOnCallerHangup) {
			unwatchers.push(this.watchCallerHangup(resolveOutcome));
		}

		for (const index of attempts.keys()) {
			const channelId = channelIds[index] as string;
			unwatchers.push(
				this.deps.signals.watch(legSignalKey(channelId), (signal) => {
					const leg = signal as LegSignal;
					if (leg.kind === "answered" || leg.kind === "entered") {
						resolveOutcome({ kind: "answered", mediaChannelId: channelId, index });
						return;
					}
					if (leg.kind === "ended") {
						lastCause = leg.cause;
						ended.add(index);
						if (ended.size === attempts.length) {
							resolveOutcome({ kind: "failed", cause: leg.cause, index });
						}
					}
				}),
			);
		}

		// Started after every watcher is in place, so no leg's answer can outrun its subscription.
		await Promise.all(
			attempts.map(async (attempt, index) => {
				if (attempt.delaySeconds > 0) {
					await this.delay(attempt.delaySeconds * MILLIS_PER_SECOND);
				}
				if (settled) {
					return;
				}
				await this.originate(attempt, channelIds[index] as string, index, (cause) => {
					lastCause = cause;
					ended.add(index);
					if (ended.size === attempts.length) {
						resolveOutcome({ kind: "failed", cause, index });
					}
				});
			}),
		);

		const outcome = await outcomePromise;
		clearTimeout(overall);
		for (const unwatch of unwatchers) {
			unwatch();
		}

		const winner = outcome.kind === "answered" ? outcome.mediaChannelId : undefined;
		for (const [index, channelId] of channelIds.entries()) {
			if (channelId === winner || ended.has(index)) {
				continue;
			}
			await this.hangupQuietly(channelId, winner === undefined ? "ORIGINATOR_CANCEL" : "LOSE_RACE");
		}

		if (outcome.kind === "timeout" && lastCause !== undefined && ended.size === attempts.length) {
			return { kind: "failed", cause: lastCause, index: 0 };
		}
		return outcome;
	}

	/** Rings exactly one attempt and waits for it to answer, fail or time out. */
	private async dialOne(
		attempt: DialAttempt,
		index: number,
		abortOnCallerHangup = false,
	): Promise<DialOutcome> {
		const channelId = this.newId();
		let settled = false;
		let resolveOutcome: (outcome: DialOutcome) => void = () => undefined;

		const outcomePromise = new Promise<DialOutcome>((resolve) => {
			resolveOutcome = (outcome) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(outcome);
			};
		});

		const unwatch = this.deps.signals.watch(legSignalKey(channelId), (signal) => {
			const leg = signal as LegSignal;
			if (leg.kind === "answered" || leg.kind === "entered") {
				resolveOutcome({ kind: "answered", mediaChannelId: channelId, index });
				return;
			}
			if (leg.kind === "ended") {
				resolveOutcome({ kind: "failed", cause: leg.cause, index });
			}
		});

		const unwatchCaller = abortOnCallerHangup
			? this.watchCallerHangup(resolveOutcome)
			: (): void => undefined;

		const timer = setTimeout(
			() => {
				resolveOutcome({ kind: "timeout" });
			},
			Math.max(1, attempt.timeoutSeconds) * MILLIS_PER_SECOND,
		);
		timer.unref?.();

		await this.originate(attempt, channelId, index, (cause) => {
			resolveOutcome({ kind: "failed", cause, index });
		});

		const outcome = await outcomePromise;
		clearTimeout(timer);
		unwatch();
		unwatchCaller();

		if (outcome.kind !== "answered") {
			await this.hangupQuietly(channelId, "ORIGINATOR_CANCEL");
		}
		return outcome;
	}

	/**
	 * Ends a dial the moment the CALLER goes away.
	 *
	 * Only queue dials install this, and the reason is that a queue has already ANSWERED the caller.
	 * For an unanswered inbound call the caller's hangup tears the whole call down in one event and
	 * the walk aborts anyway; for a queued caller the A-leg's death is just a signal, and without
	 * this the agent's phone would keep ringing for the full timeout on behalf of somebody who has
	 * gone. The dial's existing cleanup then hangs the agent legs up with `ORIGINATOR_CANCEL`, which
	 * is exactly what happened.
	 */
	private watchCallerHangup(resolve: (outcome: DialOutcome) => void): () => void {
		return this.deps.signals.watch(legSignalKey(this.deps.channel.mediaChannelId), (signal) => {
			if ((signal as LegSignal).kind === "ended") {
				resolve({ kind: "aborted" });
			}
		});
	}

	/**
	 * Creates one leg.
	 *
	 * A media-server refusal is reported as `USER_NOT_REGISTERED`, which is the only thing it can
	 * honestly mean here: the endpoint is configured (the compiler resolved it) but there is no
	 * contact to send an INVITE to. Reporting a generic failure instead would send the call down the
	 * no-answer branch after a full ring timeout the caller has to sit through.
	 */
	private async originate(
		attempt: DialAttempt,
		channelId: string,
		index: number,
		onFailure: (cause: HangupCause) => void,
	): Promise<void> {
		// BEFORE the media server is asked. A leg that answers instantly would otherwise deliver its
		// `StasisStart` to an orchestrator that has never heard of it, and be filed as a new inbound
		// call — the exact failure the `OPTIMIQ_LEG` check exists to prevent, one layer earlier.
		this.deps.legs?.originated({
			mediaChannelId: channelId,
			endpoint: attempt.endpoint,
			destinationNumber: attempt.destinationNumber,
			label: attempt.label,
			...(this.destination?.destinationType === undefined
				? {}
				: { destinationType: this.destination.destinationType }),
			...(this.destination?.destinationRef === undefined
				? {}
				: { destinationRef: this.destination.destinationRef }),
			...(attempt.callerId === undefined ? {} : { callerId: attempt.callerId }),
		});

		try {
			await this.deps.media.originate({
				endpoint: attempt.endpoint,
				application: this.settings.application,
				channelId,
				callerId: attempt.callerId,
				timeoutSeconds: attempt.timeoutSeconds,
				originatorChannelId: this.deps.channel.mediaChannelId,
				variables: {
					OPTIMIQ_ORG_ID: this.deps.channel.organizationId,
					OPTIMIQ_LEG: "b",
					OPTIMIQ_ORIGINATING_LEG_ID: this.deps.channel.channelId,
					...attempt.variables,
				},
			});
		} catch (error) {
			this.log("originate refused", {
				endpoint: attempt.endpoint,
				index,
				err: String(error),
			});
			this.note(`${attempt.label} could not be reached: ${String(error)}`);
			onFailure("USER_NOT_REGISTERED");
		}
	}

	// -------------------------------------------------------------------------------------------
	// Bridging
	// -------------------------------------------------------------------------------------------

	/**
	 * Joins the A-leg to an answered B-leg.
	 *
	 * The A-leg is answered FIRST, and only once the far end has: answering earlier would start
	 * billing a caller for a call nobody picked up.
	 */
	private async bridgeWith(
		peerMediaChannelId: string,
		onPeerEnded?: () => void,
	): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			await this.hangupQuietly(peerMediaChannelId, "ORIGINATOR_CANCEL");
			return { kind: "aborted" };
		}

		const bridgeId = this.newId();
		try {
			await this.deps.media.createBridge({ bridgeId, name: `call-${this.deps.channel.callId}` });
			await this.deps.media.addToBridge(bridgeId, [
				this.deps.channel.mediaChannelId,
				peerMediaChannelId,
			]);
		} catch (error) {
			this.log("failed to bridge the call", { bridgeId, err: String(error) });
			this.note(`bridging failed: ${String(error)}`);
			await this.hangupQuietly(peerMediaChannelId, "NORMAL_TEMPORARY_FAILURE");
			return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
		}

		this.deps.channel.setBridge(bridgeId);
		this.deps.channel.moveTo("exchanging-media");
		this.deps.legs?.bridged(peerMediaChannelId, bridgeId);

		await this.deps.publish("channel.bridged", {
			legId: this.deps.channel.channelId,
			peerLegId: this.peerLegIdOf(peerMediaChannelId),
			bridgeId,
			mode: "full",
		});

		// Once bridged, the B-leg's death is what ends the call. Nothing else is watching it: the
		// dial helper unsubscribed when it won the race.
		const unwatch = this.deps.signals.watch(legSignalKey(peerMediaChannelId), (signal) => {
			if ((signal as LegSignal).kind !== "ended") {
				return;
			}
			unwatch();
			// The queue's wrap-up hook, when there is one. Called BEFORE the teardown so an agent's
			// after-call timer starts at the moment their call ended rather than after two awaited
			// media-server round trips.
			onPeerEnded?.();
			void this.onPeerEnded(bridgeId, peerMediaChannelId);
		});

		return { kind: "bridged" };
	}

	private async onPeerEnded(bridgeId: string, peerMediaChannelId: string): Promise<void> {
		try {
			await this.deps.publish("channel.unbridged", {
				legId: this.deps.channel.channelId,
				peerLegId: this.peerLegIdOf(peerMediaChannelId),
				bridgeId,
				reason: "peer-hangup",
			});
			this.deps.channel.setBridge(undefined);
			await this.deps.media.destroyBridge(bridgeId);
			if (!this.deps.channel.isTearingDown) {
				await this.hangupQuietly(this.deps.channel.mediaChannelId, "NORMAL_CLEARING");
			}
		} catch (error) {
			this.log("failed to tear the bridge down after the peer hung up", { err: String(error) });
		}
	}

	// -------------------------------------------------------------------------------------------
	// Helpers
	// -------------------------------------------------------------------------------------------

	/**
	 * Answers the A-leg if it is not answered already, and waits for the media path.
	 *
	 * `answer` is a REQUEST, not a state: ARI returns as soon as Asterisk accepts it, and the leg
	 * only gains a media path when the far end's `200 OK` has been exchanged. Playing audio in
	 * between is playing it at a leg that has not answered, which the verb guard correctly refuses.
	 */
	private async ensureAnswered(): Promise<boolean> {
		if (this.deps.channel.isAnswered) {
			return true;
		}
		if (this.deps.channel.isTearingDown) {
			return false;
		}

		const key = legSignalKey(this.deps.channel.mediaChannelId);
		let resolveAnswered: (value: boolean) => void = () => undefined;
		const answered = new Promise<boolean>((resolve) => {
			resolveAnswered = resolve;
		});

		const unwatch = this.deps.signals.watch(key, (signal) => {
			const leg = signal as LegSignal;
			if (leg.kind === "answered") {
				resolveAnswered(true);
			} else if (leg.kind === "ended") {
				resolveAnswered(false);
			}
		});
		const timer = setTimeout(() => {
			resolveAnswered(this.deps.channel.isAnswered);
		}, this.settings.answerTimeoutMs);
		timer.unref?.();

		const result = await this.deps.execute({ verb: "answer" });
		if (result === undefined) {
			clearTimeout(timer);
			unwatch();
			return false;
		}

		const ok = await answered;
		clearTimeout(timer);
		unwatch();
		return ok && !this.deps.channel.isTearingDown;
	}

	private async announceAndHangup(media: string, cause: HangupCause): Promise<StepResult> {
		if (await this.ensureAnswered()) {
			await this.deps.execute({ verb: "play", media });
		}
		return { kind: "hangup", cause };
	}

	private async terminate(cause: HangupCause, status: WalkStatus = "hangup"): Promise<WalkOutcome> {
		if (!this.deps.channel.isTearingDown) {
			await this.deps.execute({ verb: "hangup", cause });
		}
		return this.outcome(status, cause);
	}

	private outcome(status: WalkStatus, hangupCause?: HangupCause): WalkOutcome {
		return {
			status,
			...(hangupCause === undefined ? {} : { hangupCause }),
			...(this.destination === undefined ? {} : { destination: this.destination }),
			visited: [...this.visited],
			notes: [...this.notes],
		};
	}

	private async hangupQuietly(mediaChannelId: string, cause: HangupCause): Promise<void> {
		// Fix the cause before the media server is told; see `OriginatedLegHooks.hangingUp`.
		this.deps.legs?.hangingUp(mediaChannelId, cause);
		try {
			await this.deps.media.hangup(mediaChannelId, cause);
		} catch (error) {
			this.log("failed to hang a leg up", { mediaChannelId, cause, err: String(error) });
		}
	}

	private endpointForExtension(number: string): string {
		return this.settings.extensionDialTemplate.replaceAll("{number}", number);
	}

	/**
	 * The caller identity an originated leg presents.
	 *
	 * The INBOUND caller's identity, not the callee's: a member of a sales ring group must see who
	 * is calling the company, and a group's `callerIdNamePrefix` ("Sales: ") is what tells them
	 * which group rang. Presenting the extension's own caller id here would show every member their
	 * own name.
	 */
	private callerIdFor(input: WalkInput, namePrefix?: string): string | undefined {
		const name = input.callerIdName ?? this.deps.channel.callerIdName;
		const number = input.callerIdNumber ?? this.deps.channel.callerIdNumber;
		return composeCallerId(namePrefix === undefined ? name : `${namePrefix}${name ?? ""}`, number);
	}

	private peerLegIdOf(mediaChannelId: string): string {
		return this.deps.peerLegId?.(mediaChannelId) ?? this.newId();
	}

	private note(message: string): void {
		this.notes.push(message);
		this.log(message);
	}
}

function collectionOf(result: VerbResult): DtmfCollection | undefined {
	return result.verb === "gather" ? result.collection : undefined;
}

/** `"Name" <number>` — the format every SIP stack, and ARI's `callerId`, expects. */
export function composeCallerId(
	name: string | undefined,
	number: string | undefined,
): string | undefined {
	const trimmedName = name?.trim();
	const trimmedNumber = number?.trim();
	if (trimmedNumber === undefined || trimmedNumber === "") {
		return trimmedName === undefined || trimmedName === "" ? undefined : `"${trimmedName}"`;
	}
	return trimmedName === undefined || trimmedName === ""
		? trimmedNumber
		: `"${trimmedName}" <${trimmedNumber}>`;
}
