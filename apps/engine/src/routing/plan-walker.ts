import { createEntityId } from "@optimiq-voice/identifiers";
import { evaluateTimeCondition, matchPattern } from "@optimiq-voice/routing";
import { RETRYABLE_HANGUP_CAUSES } from "@optimiq-voice/telephony";
import { QueueSession } from "../queue/queue-session";
import { legSignalKey, recordingSignalKey } from "./call-signals";
import { DEFAULT_MEDIA_REF_SETTINGS, resolveMediaRef, translateMediaRef } from "./media-refs";
import { planDestinationOf } from "./plan-destination";
import { verifyPinDigest, verifyVoicemailPin } from "./voicemail-pin";
import type { MediaPort } from "../media/media-port";
import type {
	QueueCallPort,
	QueueDialAttempt,
	QueueDialOutcome,
	QueueServices,
	QueueSessionSettings,
} from "../queue/queue-session";
import type { CallSignalBus, LegSignal } from "./call-signals";
import type { ConferenceRegistry } from "./conference-registry";
import type { MediaRefSettings } from "./media-refs";
import type { PlanDestination } from "./plan-destination";
import type { CallEvent } from "@optimiq-voice/events";
import type {
	CompiledTimeCondition,
	ConferencePlanNode,
	ExecutionPlan,
	ExtensionPlanNode,
	FollowMeDestination,
	FollowMePlan,
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
 * Real: `extension` (including its follow-me ladder — both strategies, on-net and off-net hops, the
 * ladder's own timeouts, and the extension's own no-answer branch behind it), `ring-group` (both
 * strategies, with lose-race), `ivr-menu` (retries, invalid
 * and timeout branches, submenu recursion), `time-condition`, `trunk-dial` (failover honouring
 * `continueOnCauses`), `external`, `playback`, `hangup`, and `queue` — music on hold, position
 * announcements, all six distribution strategies with tier rules, agent state and wrap-up, delegated
 * to `../queue/queue-session.ts` (which needs {@link PlanWalkerDependencies.queue}; without it the
 * node falls back to the announcement below).
 *
 * Also real, and deliberately minimal: `conference` — a PIN-gated join to a shared ARI mixing
 * bridge, moderator entry, `waitForModerator`, `maxMembers`, and a join/leave event pair
 * (needs {@link PlanWalkerDependencies.conferences}; without it the node falls back to the
 * announcement below). What a conference here does NOT do, and none of it is hidden: no recording
 * (`ConferencePlanNode.recordEnabled` is read by nothing), no in-conference DTMF controls, no
 * mute, no kick, no lock, no entry/exit tones, no participant list, and no room state shared
 * between engine processes.
 *
 * Also real: `park` — both directions of it. A call routed to a lot is put in an orbit slot with
 * music and left there for somebody to collect; a call that DIALLED a slot in that lot's range
 * collects whoever is in it. Which of the two happens is decided by the digits, because the compiler
 * points both at one node. `feature-code` now serves directed (`**<ext>`) and group (`*8`) pickup
 * for real, through the same call-control runtime.
 *
 * Placeholder, and honest about it: `voicemail` records but has no mailbox, no MWI and no email;
 * `feature-code` serves `*97` as that placeholder and answers everything else with an announcement;
 * `application` announces and hangs up. Every one of them adds a line to {@link WalkOutcome.notes},
 * so a call that hit a gap says so in the log rather than looking like a routing bug.
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
	/**
	 * Whether a call-control feature has taken this leg over.
	 *
	 * Set by a directed or group pickup, and read at every step boundary and inside every dial loop.
	 * Without it the walk that is ringing an extension sees its B-leg die with `PICKED_OFF`, takes
	 * the no-answer branch, and sends a caller who is by then talking to somebody to voicemail. A
	 * detached walk stops where it is and leaves the leg alone.
	 */
	readonly isDetached: boolean;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
	/** Guarded state move. Returns whether the machine actually moved. */
	moveTo(state: ChannelState): boolean;
	setBridge(bridgeId: string | undefined): void;
}

/**
 * The call-control operations a plan node can reach.
 *
 * A narrow, walker-shaped port rather than the whole {@link
 * import("../calls/call-control").CallControlPort}: the walker acts on ONE leg — the A-leg it is
 * routing — so every method here is already bound to it, and the walker never has to hold a
 * `ControlledLeg` or know that such a thing exists. It also keeps the walker's specs to four
 * closures and a fake, which is the standard every other collaborator here holds to.
 *
 * Absent means the park lot and the pickup codes announce and hang up exactly as they did before
 * this wave, and say so in the notes.
 */
export interface WalkerCallControl {
	/** Parks the A-leg. `orbit` is what the caller dialled after the code, when they dialled one. */
	park(request: {
		readonly parkLotId: string;
		readonly orbit?: string;
		readonly timeoutMs?: number;
		readonly mohClass?: string;
	}): Promise<{ readonly ok: boolean; readonly slot?: number; readonly reason?: string }>;
	/** Collects the call sitting in `orbit` onto the A-leg. */
	unpark(request: {
		readonly parkLotId: string;
		readonly orbit: string;
	}): Promise<{ readonly ok: boolean; readonly reason?: string }>;
	/** Answers somebody else's ringing call on the A-leg. */
	pickup(request: {
		readonly kind: "directed" | "group";
		readonly extension: string;
	}): Promise<{ readonly ok: boolean; readonly reason?: string }>;
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
	/** Played before a voicemail recording starts, when the box has no greeting of its own. */
	readonly voicemailGreeting: string;
	/** Played for the node kinds this slice does not implement. */
	readonly unavailableAnnouncement: string;
	/** Asked for before a mailbox with a PIN is opened. */
	readonly voicemailPinPrompt: string;
	/** Played after a wrong PIN, before the next attempt. */
	readonly voicemailPinInvalidPrompt: string;
	/** Attempts before the call is refused. A four-digit secret needs a lockout. */
	readonly voicemailPinAttempts: number;
	readonly voicemailPinMaxDigits: number;
	readonly voicemailPinTimeoutMs: number;
	readonly voicemailPinInterDigitTimeoutMs: number;
	/** How long to wait for a control digit after a message finishes playing. */
	readonly voicemailMenuTimeoutMs: number;
	/** Replays of one message before `2` stops being honoured. */
	readonly voicemailMaxReplays: number;
	/** Asked for before a room with a PIN is opened. */
	readonly conferencePinPrompt: string;
	/** Played after a wrong room PIN, before the next attempt. */
	readonly conferencePinInvalidPrompt: string;
	/** Attempts before the call is refused. Same budget, same reasoning, as the mailbox. */
	readonly conferencePinAttempts: number;
	readonly conferencePinMaxDigits: number;
	readonly conferencePinTimeoutMs: number;
	readonly conferencePinInterDigitTimeoutMs: number;
	/** Played when a room is at `maxMembers`. */
	readonly conferenceFullAnnouncement: string;
	/** How long a participant holds for a moderator before the call is given up on. */
	readonly conferenceModeratorWaitMs: number;
	/**
	 * How often a held participant re-reads the room's shared claim.
	 *
	 * Only used while a moderator gate is actually closed, and only when claims are shared: a
	 * moderator who joins on ANOTHER engine instance cannot fire a local waiter, and the alternative
	 * to this poll is a participant holding for the full wait budget beside a meeting that started
	 * ten minutes ago. Two seconds is below the threshold at which somebody on hold notices a delay
	 * and far above the rate at which a KV point read costs anything.
	 */
	readonly conferenceClaimPollMs: number;
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
	// `vm-password` and `vm-incorrect` are in Asterisk's core sound package, so a PIN challenge
	// works on a stock install with no prompt pack — the same standard the digit readback holds to.
	voicemailPinPrompt: "sound:vm-password",
	voicemailPinInvalidPrompt: "sound:vm-incorrect",
	voicemailPinAttempts: 3,
	voicemailPinMaxDigits: 10,
	voicemailPinTimeoutMs: 10_000,
	voicemailPinInterDigitTimeoutMs: 3_000,
	voicemailMenuTimeoutMs: 5_000,
	voicemailMaxReplays: 3,
	// `conf-getpin`, `conf-invalidpin` and `conf-locked` are all in Asterisk's core sound package,
	// so a PIN-gated room works on a stock install with no prompt pack — the same standard the
	// mailbox challenge holds to.
	conferencePinPrompt: "sound:conf-getpin",
	conferencePinInvalidPrompt: "sound:conf-invalidpin",
	conferencePinAttempts: 3,
	conferencePinMaxDigits: 10,
	conferencePinTimeoutMs: 10_000,
	conferencePinInterDigitTimeoutMs: 3_000,
	conferenceFullAnnouncement: "sound:conf-locked",
	// Ten minutes. Long enough that a moderator who is late still finds their meeting, short
	// enough that a forgotten leg does not hold a channel until the process restarts.
	conferenceModeratorWaitMs: 600_000,
	conferenceClaimPollMs: 2_000,
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
	 * Where the `*97` menu reads a mailbox from. Absent means a check authenticates and then
	 * announces the mailbox as unavailable — never as empty.
	 */
	readonly mailbox?: VoicemailMailboxSource;
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
	/**
	 * The rooms this process is hosting.
	 *
	 * Optional for the same reason `queue` is, and with the same honest fallback: without it a
	 * `conference` node announces and hangs up, which is exactly what it did before this wave. It
	 * is a registry rather than anything richer because a conference is the one destination whose
	 * state outlives a single walk — see `conference-registry.ts`.
	 */
	readonly conferences?: ConferenceRegistry;
	/**
	 * Park lots and call pickup, bound to the A-leg.
	 *
	 * Optional for the same reason `queue` and `conferences` are: a spec about an IVR should not have
	 * to stand up a park registry, and without it a `park` node or a pickup code announces and hangs
	 * up exactly as it did before this wave.
	 */
	readonly control?: WalkerCallControl;
	/**
	 * Run just before the A-leg is joined to whatever the walk found.
	 *
	 * Exists for one caller and one reason: a transferred leg is held with music for the whole time
	 * the target rings, and the music has to stop at the INSTANT of bridging. Stopping it before the
	 * walk starts would give the transferee silence for the entire ring; stopping it afterwards would
	 * play music over the conversation.
	 */
	readonly beforeBridge?: (bridgeId: string) => Promise<void>;
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

/** What the `*97` menu asks for. */
export interface VoicemailListingRequest {
	readonly organizationId: string;
	readonly voicemailBoxId: string;
	/** The mailbox the walk authenticated, for the responder to check the box id against. */
	readonly mailboxNumber: string;
	readonly callId?: string;
}

/** One message, as the menu needs it. `media` is a domain `MediaRef`, already rendered. */
export interface VoicemailListingMessage {
	readonly messageId: string;
	readonly media: string;
	readonly durationMs: number;
	readonly receivedAt: string;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
}

/**
 * A mailbox's contents.
 *
 * `found` is separate from an empty `messages` and the separation is the whole point: "you have no
 * messages" told to somebody who has nine is worse than any error, so a source that could not read
 * the mailbox says so rather than returning nothing and letting the caller draw a conclusion.
 */
export interface VoicemailListing {
	readonly found: boolean;
	/** Newest first. */
	readonly messages: readonly VoicemailListingMessage[];
	readonly reason?: string;
}

/**
 * Where the `*97` menu gets a mailbox's messages.
 *
 * A port rather than a direct RPC call for the usual reason — a spec should not need a broker — and
 * for one specific to this feature: "no responder" is a state the menu has to handle correctly and
 * will keep having to handle until the API side lands, so it must be as easy to write a test for as
 * a successful listing is.
 */
export interface VoicemailMailboxSource {
	/**
	 * @throws when the source could not be reached at all. The walk catches it and treats it exactly
	 * as `found: false` — a broker timeout and a responder saying "no" are the same fact to a caller.
	 */
	list(request: VoicemailListingRequest): Promise<VoicemailListing>;
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
	/**
	 * The digits the caller actually pressed, before any digit manipulation.
	 *
	 * Only the emergency notification reads it, and it reads it because "the caller dialled 9911"
	 * and "the switch sent 911" are different facts, and the person reading the Kari's Law alert
	 * wants the first one.
	 */
	readonly originalDialedNumber?: string;
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
			if (this.abandoned) {
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
				return await this.featureCodeNode(node, input);
			}
			case "queue": {
				return await this.queueNode(node);
			}
			case "conference": {
				return await this.conferenceNode(node);
			}
			case "park": {
				return await this.parkNode(node, input);
			}
			default: {
				// `application`: a real destination with a real runtime that does not exist yet.
				// Announcing and hanging up is a worse product than the real thing and a better one
				// than silence.
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
		input: WalkInput,
	): Promise<StepResult> {
		if (node.targetNodeId !== undefined) {
			return { kind: "goto", nodeId: node.targetNodeId };
		}
		if (node.action === "call-pickup" || node.action === "group-pickup") {
			return await this.pickupCode(node, input);
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

	/**
	 * `**<extension>` and `*8` — answering somebody else's ringing phone.
	 *
	 * The call-control runtime does the work; this method's job is to turn "nothing was ringing" into
	 * something the caller can hear. `NO_PICKUP` (Q.850 812) is the cause, not `NO_ANSWER`: the
	 * caller reached the feature and the feature had nothing to give them, which is a different fact
	 * from a phone nobody picked up and is the one a support ticket needs.
	 *
	 * The A-leg is deliberately NOT answered first. `pickup` answers it itself, at the moment it has
	 * a call to connect — answering earlier would start billing somebody for a feature code that
	 * then found nothing.
	 */
	private async pickupCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const control = this.deps.control;
		if (control === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has no call-control runtime`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const kind = node.action === "group-pickup" ? "group" : "directed";
		const extension = input.featureArgument?.trim() ?? "";
		if (kind === "directed" && extension === "") {
			this.note(`feature code ${node.code} needs the extension whose call is being picked up`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		const outcome = await control.pickup({ kind, extension });
		if (outcome.ok) {
			this.note(
				kind === "group"
					? "picked up a call ringing in the caller's pickup group"
					: `picked up the call ringing at extension ${extension}`,
			);
			return { kind: "bridged" };
		}

		this.note(`pickup refused: ${outcome.reason ?? "nothing was ringing"}`);
		return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NO_PICKUP");
	}

	// -------------------------------------------------------------------------------------------
	// Park lots
	// -------------------------------------------------------------------------------------------

	/**
	 * A park lot, in both of its directions.
	 *
	 * ## One node, two operations, and the dialled digits decide
	 *
	 * `packages/routing` compiles a lot's orbit range into the internal number table pointing at THIS
	 * node, and the `call-park` feature code at the same node. So a call arrives here either because
	 * somebody dialled `401` — which means "collect whoever is on 401" — or because it was sent to
	 * the lot itself, which means "put this call in a slot". The digits are the only thing that tells
	 * the two apart, and getting it backwards would park the person who came to collect a call.
	 *
	 * ## Parking ends the walk with the call still up
	 *
	 * The outcome is `bridged` rather than `hangup` because the leg lives on: it is in an orbit,
	 * hearing music, waiting for somebody. `bridged` is the walk status that means "the walk is over
	 * and the call is up", which is exactly true here even though there is nobody on the other side
	 * yet — and it is what stops the orchestrator from tearing the leg down when the walk returns.
	 *
	 * ## No slot announcement
	 *
	 * A caller who reaches a lot has been PUT there — transferred, or routed by a plan — so the
	 * person who needs to hear "this call is on 401" is not on this leg. Reading the slot out to the
	 * parked caller would announce it to the one party it is useless to, and then leave them
	 * listening to music wondering what the number was for. The slot goes out on `call.parked`, which
	 * is what a wallboard and the parker's own screen pop read.
	 */
	private async parkNode(
		node: Extract<PlanNode, { kind: "park" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const control = this.deps.control;
		if (control === undefined) {
			this.note(
				`park lot "${node.parkLotId}" was reached but this walk has no call-control runtime; announced and hung up`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		const orbit = this.orbitDialedFor(node, input);
		return orbit === undefined
			? await this.parkIntoLot(node, control, input)
			: await this.retrieveFromLot(node, control, orbit);
	}

	/**
	 * Which orbit the caller dialled, when they dialled one.
	 *
	 * Only the digits that are IN the lot's range count. `*5` with no argument, and an internal
	 * number that happens to look like a slot in a different lot, both mean "park this call" —
	 * because a retrieval of a slot this lot does not have is not a retrieval at all.
	 */
	private orbitDialedFor(
		node: Extract<PlanNode, { kind: "park" }>,
		input: WalkInput,
	): string | undefined {
		for (const candidate of [input.featureArgument, input.originalDialedNumber]) {
			const digits = candidate?.trim();
			if (digits === undefined || digits === "") {
				continue;
			}
			const slot = Number.parseInt(digits, 10);
			if (String(slot) === digits && slot >= node.slotStart && slot <= node.slotEnd) {
				return digits;
			}
		}
		return undefined;
	}

	private async parkIntoLot(
		node: Extract<PlanNode, { kind: "park" }>,
		control: WalkerCallControl,
		input: WalkInput,
	): Promise<StepResult> {
		const requested = input.featureArgument?.trim();
		const outcome = await control.park({
			parkLotId: node.parkLotId,
			...(requested === undefined || requested === "" ? {} : { orbit: requested }),
			...(node.timeoutSeconds > 0 ? { timeoutMs: node.timeoutSeconds * MILLIS_PER_SECOND } : {}),
			...(node.mohClass === undefined ? {} : { mohClass: node.mohClass }),
		});

		if (outcome.ok) {
			this.note(`parked on orbit ${String(outcome.slot ?? "?")} of lot ${node.parkLotId}`);
			return { kind: "bridged" };
		}

		// A lot that cannot take the call is a routing failure with a branch of its own — the same
		// `timeoutNodeId` a forgotten call takes — because "the lot is full" and "nobody collected it"
		// both end with the call needing somewhere else to go.
		this.note(`the call could not be parked: ${outcome.reason ?? "the lot refused it"}`);
		if (node.timeoutNodeId !== undefined) {
			return { kind: "goto", nodeId: node.timeoutNodeId };
		}
		return await this.announceAndHangup(this.settings.unavailableAnnouncement, "USER_BUSY");
	}

	private async retrieveFromLot(
		node: Extract<PlanNode, { kind: "park" }>,
		control: WalkerCallControl,
		orbit: string,
	): Promise<StepResult> {
		const outcome = await control.unpark({ parkLotId: node.parkLotId, orbit });
		if (outcome.ok) {
			this.note(`retrieved the call parked on orbit ${orbit}`);
			return { kind: "bridged" };
		}
		this.note(`orbit ${orbit} could not be retrieved: ${outcome.reason ?? "nothing is parked"}`);
		return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NO_PICKUP");
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
		// After forward-all and DND, before the endpoint: a ladder REPLACES the plain dial. Both of
		// the checks above outrank it — a user who has switched everything through to a colleague
		// or gone on do-not-disturb has said something more specific than "find me".
		if (node.followMe !== undefined) {
			return await this.followMeNode(node, node.followMe, input);
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
	 * An extension's follow-me ladder.
	 *
	 * ## The two strategies are the ring group's two strategies
	 *
	 * Deliberately: a ladder IS a per-user ring group, and giving it a second dialling idiom would
	 * mean two places to fix the next race condition. `sequential` walks the hops in `ordinal`
	 * order, honouring each hop's own delay and timeout and stopping on `USER_BUSY` unless the
	 * ladder says to ignore it. `simultaneous` originates every hop at once and the first answer
	 * wins; every loser is hung up with `LOSE_RACE` before the winner is bridged, so a mobile that
	 * picks up a moment late hears the call end rather than being joined to a bridge it did not win.
	 *
	 * ## Which strategy is a COMPILER decision
	 *
	 * `pbx-db` has no strategy column, so `packages/routing` derives one from the delays and writes
	 * it into the artifact. The walker reads the field; it does not re-derive it. A second copy of
	 * that rule here would be a silent divergence the first time either side changed.
	 *
	 * ## Off-net hops are ordinary outbound legs
	 *
	 * A hop to a mobile carries the `trunk-dial` node its own organization's outbound rules chose
	 * for it, with the number already through that route's digit manipulation. The toll-class gate,
	 * the outbound kill switch and the call-block screen were all applied when that node was chosen
	 * — a hop the compiler refused arrives with no `targetNodeId` and is skipped loudly here. This
	 * walker never invents a trunk for a follow-me number, which is the whole toll-fraud boundary.
	 *
	 * ## Running out of hops is not a new outcome
	 *
	 * Every ending — busy, unregistered, nobody home — goes through the extension's OWN three
	 * branches, so a ladder that finds nobody lands in the same mailbox the unanswered desk phone
	 * would have.
	 */
	private async followMeNode(
		node: ExtensionPlanNode,
		followMe: FollowMePlan,
		input: WalkInput,
	): Promise<StepResult> {
		const attempts: DialAttempt[] = [];
		for (const hop of [...followMe.destinations].sort((a, b) => a.ordinal - b.ordinal)) {
			const attempt = this.followMeAttempt(node, hop, input);
			if (attempt !== undefined) {
				attempts.push(attempt);
			}
		}

		if (attempts.length === 0) {
			this.note(
				`follow-me for extension ${node.number} has no dialable hop; the extension's no-answer branch was taken`,
			);
			return this.branch(node.noAnswerNodeId, "NO_ANSWER");
		}
		if (this.abandoned) {
			return { kind: "aborted" };
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome =
			followMe.strategy === "sequential"
				? await this.dialSequential(attempts, followMe.ignoreBusy ? [] : ["USER_BUSY"])
				: await this.dialSimultaneous(attempts, followMeOverallTimeout(attempts));

		return await this.settleDial(outcome, {
			busyNodeId: node.busyNodeId,
			noAnswerNodeId: node.noAnswerNodeId,
			notRegisteredNodeId: node.notRegisteredNodeId,
		});
	}

	/** One hop as a leg to originate, or `undefined` when there is nothing dialable behind it. */
	private followMeAttempt(
		node: ExtensionPlanNode,
		hop: FollowMeDestination,
		input: WalkInput,
	): DialAttempt | undefined {
		if (hop.targetNodeId === undefined) {
			this.note(
				`follow-me hop "${hop.destination}" of extension ${node.number} was refused by the compiler (no route, no trunk, or the number is barred); it was not rung`,
			);
			return undefined;
		}
		const target = input.plan.nodes[hop.targetNodeId];
		if (target === undefined) {
			this.note(
				`follow-me hop "${hop.destination}" of extension ${node.number} points at missing node "${hop.targetNodeId}"; it was not rung`,
			);
			return undefined;
		}
		if (hop.confirmRequired) {
			this.note(
				`follow-me hop "${hop.destination}" of extension ${node.number} asks for answer confirmation, which is not implemented yet; the hop was dialled without it`,
			);
		}

		const timeoutSeconds =
			hop.timeoutSeconds || node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds;

		if (target.kind === "extension") {
			return {
				endpoint: this.endpointForExtension(target.number),
				label: `extension ${target.number}`,
				destinationNumber: target.number,
				timeoutSeconds,
				delaySeconds: hop.delaySeconds,
				callerId: this.callerIdFor(input),
			};
		}

		if (target.kind !== "trunk-dial") {
			this.note(
				`follow-me hop "${hop.destination}" of extension ${node.number} resolves to a ${target.kind} node, which cannot be dialled as a leg; it was skipped`,
			);
			return undefined;
		}

		// The route's own chain, lowest order first — the same ordering `trunkDialNode` walks. A
		// racing leg takes the first trunk only: failing over inside one hop of a ladder would
		// stretch that hop past its own timeout and past the hop behind it.
		const trunk = [...target.attempts].sort((a, b) => a.order - b.order)[0];
		if (trunk === undefined) {
			this.note(
				`follow-me hop "${hop.destination}" of extension ${node.number} has no usable trunk on route "${target.outboundRouteId}"; it was not rung`,
			);
			return undefined;
		}
		const number = hop.dialedNumber ?? hop.destination;
		return {
			endpoint: this.settings.trunkDialTemplate
				.replaceAll("{number}", number)
				.replaceAll("{trunk}", trunk.name),
			label: `follow-me ${hop.destination}`,
			destinationNumber: number,
			timeoutSeconds,
			delaySeconds: hop.delaySeconds,
			// The trunk-dial precedence, unchanged: a carrier that will only accept its own ANI wins
			// over the route's override, which wins over showing the caller who is calling.
			callerId: composeCallerId(
				input.callerIdName ?? this.deps.channel.callerIdName,
				trunk.callerIdNumberOverride ??
					target.callerIdNumberOverride ??
					input.callerIdNumber ??
					this.deps.channel.callerIdNumber,
			),
		};
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
	 * amplification a compromised extension is looking for. An emergency node ships a much wider
	 * list, from `packages/routing`, and this walker does not need to know that — it reads the
	 * field either way.
	 *
	 * ## What `emergency` changes here
	 *
	 * Two things, and only two:
	 *
	 * 1. **The caller id is the ELIN and nothing may override it.** The ordinary precedence is
	 *    trunk override → route override → the caller's number, and both overrides are the tenant's
	 *    main line. Presenting that on a `911` call sends a dispatcher to the head office for a
	 *    call from the warehouse, so the emergency path takes the number the resolver worked out
	 *    (the extension's own `emergencyCallerIdNumber`, else the organization's ELIN) and ignores
	 *    both.
	 * 2. **It publishes `call.emergency.dialed`**, once, BEFORE the first attempt. That is the
	 *    Kari's Law notification seam: the statute is about the attempt, and a call that failed
	 *    over three carriers before it reached a PSAP is exactly the one the front desk needs to
	 *    hear about immediately rather than afterwards.
	 *
	 * Everything that could refuse the call was bypassed in the resolver, not here: there is no
	 * call-block check on this path and the emergency node carries no time gate and no failover.
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

		const emergency = node.emergency === true;
		// The ELIN wins outright on the emergency path. See the note above for why both overrides
		// are ignored rather than merely ranked below it.
		const presentedNumber = emergency ? (input.callerIdNumber ?? node.elin) : undefined;
		if (emergency) {
			await this.notifyEmergency(node, input, number, attempts[0]?.name, presentedNumber);
		}

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
						emergency
							? presentedNumber
							: (attempt.callerIdNumberOverride ??
									node.callerIdNumberOverride ??
									input.callerIdNumber),
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
	 * The Kari's Law notification, as an event.
	 *
	 * Fire-and-forget and never fatal: an emergency call must not fail because a broker was slow,
	 * and a notification that could hang up the call it is notifying about would be worse than no
	 * notification at all. A publish that fails is a `note` on the walk, which is what the support
	 * ticket reads.
	 *
	 * Delivery — the email, the webhook, the screen pop at the front desk — is a consumer's job.
	 * The engine holds no tenant configuration and no SMTP handle, and a notification that lives
	 * inside one process is a notification one restart loses.
	 */
	private async notifyEmergency(
		node: TrunkDialPlanNode,
		input: WalkInput,
		number: string,
		trunkName: string | undefined,
		elin: string | undefined,
	): Promise<void> {
		const callerNumber = this.deps.channel.callerIdNumber;
		const callerName = input.callerIdName ?? this.deps.channel.callerIdName;
		this.note(
			`emergency call to ${number} presenting ${elin ?? "no caller id"}${
				node.emergencyAddressId === undefined ? "" : ` for address ${node.emergencyAddressId}`
			}`,
		);
		try {
			await this.deps.publish("call.emergency.dialed", {
				legId: this.deps.channel.channelId,
				// What the caller actually pressed, which may carry the outside-line 9.
				dialed: input.originalDialedNumber ?? number,
				number,
				...(callerNumber === undefined ? {} : { callerNumber }),
				...(callerName === undefined ? {} : { callerName }),
				...(elin === undefined ? {} : { elin }),
				...(node.emergencyAddressId === undefined
					? {}
					: { emergencyAddressId: node.emergencyAddressId }),
				...(trunkName === undefined ? {} : { trunkName }),
			});
		} catch (error) {
			this.log("failed to publish the emergency notification", { err: String(error) });
			this.note(`the emergency notification for ${number} could not be published`);
		}
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
	// Conference
	// -------------------------------------------------------------------------------------------

	/**
	 * Joining a conference room.
	 *
	 * ## The order is the security property
	 *
	 * PIN first, registry second, bridge third. A caller who fails the challenge never appears in
	 * the room's member list and never touches the bridge, so "how many people are in this room"
	 * counts admitted callers rather than attempts, and a wrong PIN cannot be used to probe whether
	 * a meeting is running.
	 *
	 * ## Fail closed, twice
	 *
	 * `requiresPin` with no `pinHash` means the compiler refused a digest it could not read, or the
	 * artifact predates the field. Either way the room is REFUSED — see the note on
	 * `ConferencePlanNode`. This is the one place the conference gate deliberately differs from the
	 * mailbox gate, which degrades to "authenticated by the calling extension"; the classic default
	 * for a bridge is "anyone who knows the number", and restoring that silently would turn a
	 * formatting change into an open conference.
	 *
	 * ## `waitForModerator` holds OUTSIDE the bridge
	 *
	 * A participant waiting for a moderator hears music on hold and is not in the mixing bridge at
	 * all, so early arrivals cannot hear each other before the meeting starts. They are in the
	 * registry — which is what makes `maxMembers` and "has a moderator arrived?" correct across
	 * walks — but the media join is deferred until the gate opens.
	 */
	private async conferenceNode(node: ConferencePlanNode): Promise<StepResult> {
		const registry = this.deps.conferences;
		if (registry === undefined) {
			this.note(
				`conference room ${node.roomNumber} was reached but this walk has no conference registry; announced and hung up`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		const admission = await this.challengeConferencePin(node);
		if (admission.kind !== "admitted") {
			return admission.result;
		}

		const joinedAtMs = (this.deps.now ?? Date.now)();
		const joined = await registry.join(
			node.conferenceId,
			{
				mediaChannelId: this.deps.channel.mediaChannelId,
				legId: this.deps.channel.channelId,
				moderator: admission.moderator,
				joinedAtMs,
			},
			{
				newBridgeId: this.newId(),
				maxMembers: node.maxMembers,
				organizationId: this.deps.channel.organizationId,
			},
		);
		if (joined.kind === "full") {
			this.note(
				`conference room ${node.roomNumber} is at its limit of ${node.maxMembers} members; the caller was refused`,
			);
			return await this.announceAndHangup(this.settings.conferenceFullAnnouncement, "USER_BUSY");
		}
		if (joined.kind === "claims-unavailable") {
			// The room's claim could not be taken. Joining anyway would put this caller in a bridge no
			// other instance agrees on, which is the split the claim exists to prevent — and a caller
			// alone in a room they think is a meeting is worse than a caller told it is unavailable.
			this.note(
				`conference room ${node.roomNumber} could not be claimed: ${joined.reason}; the caller was refused`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		if (
			node.waitForModerator &&
			!admission.moderator &&
			!joined.room.moderatorPresent &&
			!(await this.holdForModerator(node, registry))
		) {
			await registry.leave(node.conferenceId, this.deps.channel.mediaChannelId);
			return { kind: "aborted" };
		}

		const bridgeId = joined.room.bridgeId;
		try {
			// Unconditional, and safe: the media server's bridge creation takes a CLIENT-assigned id
			// and is an upsert on it. Calling it only for the member the registry called `created`
			// would be wrong the moment that member is one held outside the bridge for a moderator.
			await this.deps.media.createBridge({
				bridgeId,
				name: `conference-${node.conferenceId}`,
			});
			await this.deps.media.addToBridge(bridgeId, [this.deps.channel.mediaChannelId]);
		} catch (error) {
			await registry.leave(node.conferenceId, this.deps.channel.mediaChannelId);
			this.log("failed to join a conference bridge", { bridgeId, err: String(error) });
			this.note(`joining conference room ${node.roomNumber} failed: ${String(error)}`);
			return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
		}

		this.deps.channel.setBridge(bridgeId);
		this.deps.channel.moveTo("exchanging-media");

		const room = registry.room(node.conferenceId);
		await this.deps.publish("conference.joined", {
			legId: this.deps.channel.channelId,
			conferenceId: node.conferenceId,
			roomNumber: node.roomNumber,
			bridgeId,
			moderator: admission.moderator,
			// Cluster-wide when claims are shared: a wallboard showing "2 in the room" for a meeting of
			// six because four of them landed on another instance is a report nobody can act on.
			memberCount: room?.memberCount ?? joined.room.memberCount,
		});

		if (node.recordEnabled) {
			// Said out loud rather than silently ignored: a tenant who ticked "record this room" and
			// finds no recording has a compliance problem, and a note in the call log is the
			// difference between finding out now and finding out at the hearing.
			this.note(
				`conference room ${node.roomNumber} is configured to record, which this release does not implement`,
			);
		}

		// The leg's own death is what removes it from the room. Nothing else is watching it: the
		// walk returns `bridged` and the orchestrator takes over from here.
		const unwatch = this.deps.signals.watch(
			legSignalKey(this.deps.channel.mediaChannelId),
			(signal) => {
				if ((signal as LegSignal).kind !== "ended") {
					return;
				}
				unwatch();
				void this.leaveConference(node, bridgeId, joinedAtMs, admission.moderator);
			},
		);

		return { kind: "bridged" };
	}

	/**
	 * The room's PIN gate.
	 *
	 * One challenge serves both credentials: the digits are checked against the moderator digest
	 * FIRST and then against the participant digest, so a moderator dials one number and is
	 * recognised rather than having to announce themselves. The caller is never told which of the
	 * two they matched — or that there are two — because the difference is information an attacker
	 * can use and a legitimate participant does not need.
	 *
	 * An empty entry is admitted as a participant when the room has no participant PIN. That is
	 * what makes a moderator PIN usable on its own: without it, a room whose only credential is the
	 * moderator's would challenge every participant for a PIN they were never given.
	 */
	private async challengeConferencePin(
		node: ConferencePlanNode,
	): Promise<
		| { readonly kind: "admitted"; readonly moderator: boolean }
		| { readonly kind: "denied"; readonly result: StepResult }
	> {
		// Fails closed. See the node's own documentation for why this differs from a mailbox.
		if (node.requiresPin && node.pinHash === undefined) {
			this.note(
				`conference room ${node.roomNumber} requires a PIN this release cannot verify; the room was refused rather than opened`,
			);
			return {
				kind: "denied",
				result: await this.announceAndHangup(
					this.settings.unavailableAnnouncement,
					"NORMAL_TEMPORARY_FAILURE",
				),
			};
		}

		const wantsChallenge = node.pinHash !== undefined || node.moderatorPinHash !== undefined;
		if (!wantsChallenge) {
			return { kind: "admitted", moderator: false };
		}

		for (let attempt = 0; attempt < this.settings.conferencePinAttempts; attempt += 1) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "denied", result: { kind: "aborted" } };
			}

			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: this.settings.conferencePinMaxDigits,
				terminators: ["#"],
				timeoutMs: this.settings.conferencePinTimeoutMs,
				interDigitTimeoutMs: this.settings.conferencePinInterDigitTimeoutMs,
				media: this.settings.conferencePinPrompt,
			});
			if (result === undefined) {
				return { kind: "denied", result: { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" } };
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "denied", result: { kind: "aborted" } };
			}
			const digits = collection?.digits.join("") ?? "";

			// Nothing entered, and nothing to enter: a room whose only credential is the moderator's
			// admits everyone else as a participant.
			if (digits.trim() === "" && node.pinHash === undefined) {
				return { kind: "admitted", moderator: false };
			}

			// Moderator first, so a moderator whose PIN happens to also be the participant PIN is
			// still a moderator.
			if (node.moderatorPinHash !== undefined) {
				const asModerator = await verifyPinDigest(digits, node.moderatorPinHash);
				if (asModerator.ok) {
					return { kind: "admitted", moderator: true };
				}
				if (asModerator.failure === "malformed-hash" || asModerator.failure === "kdf-error") {
					return {
						kind: "denied",
						result: await this.refuseConference(node, asModerator.failure),
					};
				}
			}

			if (node.pinHash !== undefined) {
				const asParticipant = await verifyPinDigest(digits, node.pinHash);
				if (asParticipant.ok) {
					return { kind: "admitted", moderator: false };
				}
				if (asParticipant.failure === "malformed-hash" || asParticipant.failure === "kdf-error") {
					return {
						kind: "denied",
						result: await this.refuseConference(node, asParticipant.failure),
					};
				}
			}

			await this.deps.execute({ verb: "play", media: this.settings.conferencePinInvalidPrompt });
		}

		this.note(
			`conference room ${node.roomNumber} refused after ${this.settings.conferencePinAttempts} PIN attempts`,
		);
		return { kind: "denied", result: { kind: "hangup", cause: "CALL_REJECTED" } };
	}

	/**
	 * A digest this release cannot verify, found at call time.
	 *
	 * A defect rather than a wrong guess — the compiler refuses to embed one — so it ends the call
	 * instead of burning the caller's remaining attempts on a check that can never succeed.
	 */
	private async refuseConference(node: ConferencePlanNode, failure: string): Promise<StepResult> {
		this.note(
			`conference room ${node.roomNumber} carries a PIN digest this release cannot verify (${failure}); the room was refused`,
		);
		return await this.announceAndHangup(
			this.settings.unavailableAnnouncement,
			"NORMAL_TEMPORARY_FAILURE",
		);
	}

	/**
	 * Music on hold until a moderator arrives.
	 *
	 * Returns whether the caller is still there and may now join. Three ways out: a moderator
	 * joined, the caller hung up, or the wait budget expired — and the budget exists because a
	 * meeting whose moderator never dials in would otherwise hold a channel until the process
	 * restarts.
	 */
	private async holdForModerator(
		node: ConferencePlanNode,
		registry: ConferenceRegistry,
	): Promise<boolean> {
		this.note(`held in conference room ${node.roomNumber} until a moderator joins`);
		await this.deps.media.startMusicOnHold(this.deps.channel.mediaChannelId, node.mohClass);

		const waiter = registry.awaitModerator(node.conferenceId);
		let hungUp = false;
		// A moderator who joins on ANOTHER instance cannot fire a local waiter, so the claim is
		// re-read while the gate is closed. One poll per HELD caller, only while a gate is actually
		// closed — which is why it is here and not a background sweep over every room.
		let polling = registry.isShared;
		const poll = async (): Promise<void> => {
			while (polling) {
				await this.delay(this.settings.conferenceClaimPollMs);
				if (!polling) {
					return;
				}
				if (await registry.refresh(node.conferenceId)) {
					return;
				}
			}
		};
		void poll();
		const unwatch = this.deps.signals.watch(
			legSignalKey(this.deps.channel.mediaChannelId),
			(signal) => {
				if ((signal as LegSignal).kind === "ended") {
					hungUp = true;
					waiter.cancel();
				}
			},
		);
		const expiry = this.delay(this.settings.conferenceModeratorWaitMs).then(() => {
			waiter.cancel();
		});

		await Promise.race([waiter.arrived, expiry]);
		polling = false;
		unwatch();
		waiter.cancel();

		try {
			await this.deps.media.stopMusicOnHold(this.deps.channel.mediaChannelId);
		} catch (error) {
			this.log("failed to stop conference hold music", { err: String(error) });
		}

		if (hungUp || this.deps.channel.isTearingDown) {
			return false;
		}
		if (registry.room(node.conferenceId)?.moderatorPresent !== true) {
			// One last read before giving up: the moderator may have arrived on another instance
			// between the last poll and the budget expiring.
			if (await registry.refresh(node.conferenceId)) {
				return true;
			}
			this.note(`no moderator joined conference room ${node.roomNumber} within the wait budget`);
			return false;
		}
		return true;
	}

	/** Removes this leg from the room, publishes the pair's second half, and tidies the bridge. */
	private async leaveConference(
		node: ConferencePlanNode,
		bridgeId: string,
		joinedAtMs: number,
		moderator: boolean,
	): Promise<void> {
		const registry = this.deps.conferences;
		if (registry === undefined) {
			return;
		}
		const departure = await registry.leave(node.conferenceId, this.deps.channel.mediaChannelId);
		try {
			await this.deps.publish("conference.left", {
				legId: this.deps.channel.channelId,
				conferenceId: node.conferenceId,
				roomNumber: node.roomNumber,
				bridgeId,
				moderator,
				memberCount: departure.memberCount,
				durationMs: Math.max(0, (this.deps.now ?? Date.now)() - joinedAtMs),
			});
			this.deps.channel.setBridge(undefined);
			if (departure.emptied) {
				await this.deps.media.destroyBridge(bridgeId);
			}
		} catch (error) {
			this.log("failed to leave a conference cleanly", { bridgeId, err: String(error) });
		}
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
	 * **The greeting is the box's own** when the compiler embedded one: `VoicemailPlanNode` now
	 * carries `greetingMedia` (the active `voicemail_greeting`, as an `object://` ref) and the
	 * walker plays it. Two things can make it fall back to the deployment-wide announcement, and
	 * both are legitimate rather than failures: the box has no active greeting (most do not), or the
	 * deployment has not mounted its object store inside the media server, in which case
	 * `resolveMediaRef` cannot render the ref — see the header of `media-refs.ts` for why there is
	 * no HTTP alternative. Either way the fallback is noted, not silent.
	 *
	 * ## What is not, and why
	 *
	 * **The busy greeting is unreachable.** An extension's busy and no-answer branches compile to
	 * the same `voicemail:<id>:leave` node, so nothing here can tell a caller who got a busy signal
	 * from one who got no answer. Splitting that node is a `packages/routing` change and is recorded
	 * as a follow-up rather than guessed at.
	 *
	 * **Email delivery is not wired.** `voicemail_box.email_mode` is not in the artifact, and
	 * delivery belongs to the control plane, which is where the `voicemail.message.left` consumer
	 * already is.
	 */
	private async voicemailNode(node: VoicemailPlanNode, input: WalkInput): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		if (node.mode === "check") {
			return await this.voicemailCheck(node, input);
		}

		await this.deps.execute({ verb: "play", media: this.leaveGreetingFor(node) });

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
	 * The greeting a caller about to record hears.
	 *
	 * Which greeting is a routing decision the compiler already made (`temporary` beats
	 * `unavailable`); all that is left here is rendering it, and deciding what to do when it cannot
	 * be rendered. The deployment-wide announcement is that answer, and the note says which of the
	 * two reasons it was taken for — "this box has no greeting" and "this deployment cannot reach
	 * the one it has" look identical to a caller and are very different to an operator.
	 */
	private leaveGreetingFor(node: VoicemailPlanNode): string {
		if (node.greetingMedia === undefined) {
			return this.settings.voicemailGreeting;
		}
		const media = translateMediaRef(node.greetingMedia, this.settings.mediaRefs);
		if (media === undefined) {
			this.note(
				`voicemail box ${node.mailboxNumber} has a ${node.greetingKind ?? "recorded"} greeting (${node.greetingMedia}) this deployment cannot play; falling back to the default announcement. Mount the object store into the media server and set ENGINE_MEDIA_OBJECT_ROOT.`,
			);
			return this.settings.voicemailGreeting;
		}
		return media;
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
	 * **There is a PIN challenge** when the box has one. `VoicemailPlanNode.pinHash` carries the
	 * digest (format and rationale: `packages/routing`'s `voicemail-pin.ts`), and a box that has one
	 * must pass it before anything is read out. A box with no digest keeps the classic PBX default —
	 * "the call came from this extension", which is exactly as strong as the phone on the desk.
	 *
	 * **There is message playback** when a responder answers `rpc.voicemail.v1.list`.
	 *
	 * ## What is stubbed, precisely
	 *
	 * **Nothing answers that RPC yet.** `voicemail_message` rows live in `pbx-db` behind the control
	 * plane and the engine holds no database handle, so the contract exists and the client is wired,
	 * but the API-side responder is a named follow-up. Until it lands, a check authenticates, then
	 * announces the mailbox as unavailable and ends — deliberately NOT "you have no messages", which
	 * is a far more damaging thing to tell somebody who has nine.
	 *
	 * **There is no delete and no save.** Both mutate `voicemail_message` state the engine cannot
	 * write; offering a `7` that silently did nothing would be worse than not offering it. The menu
	 * is next / replay / exit, and it says so.
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

		const authenticated = await this.challengeVoicemailPin(node, mailbox);
		if (authenticated.kind !== "granted") {
			return authenticated.result;
		}

		for (const media of this.spellNumber(mailbox)) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			await this.deps.execute({ verb: "play", media });
		}

		return await this.voicemailMenu(node, mailbox);
	}

	/**
	 * The PIN gate.
	 *
	 * Three attempts, then the call ends — the same budget an IVR gives a caller who keeps pressing
	 * the wrong key, and for the same reason: a mailbox with an unlimited retry budget over a phone
	 * line is a four-digit secret with no lockout.
	 *
	 * A box with no digest is NOT challenged. That is a deliberate product decision rather than an
	 * oversight: `*97` from the owner's own extension is authenticated by the extension, which is
	 * the classic PBX default, and challenging a PIN nobody has set would lock every existing user
	 * out of their mailbox on the deploy that shipped this.
	 *
	 * The caller is never told *why* an attempt failed. "Incorrect PIN" covers a mismatch, an empty
	 * entry and a digest this release cannot read, because the difference between those is
	 * information an attacker can use and the owner cannot.
	 */
	private async challengeVoicemailPin(
		node: VoicemailPlanNode,
		mailbox: string,
	): Promise<
		{ readonly kind: "granted" } | { readonly kind: "denied"; readonly result: StepResult }
	> {
		if (node.pinHash === undefined) {
			return { kind: "granted" };
		}

		for (let attempt = 0; attempt < this.settings.voicemailPinAttempts; attempt += 1) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "denied", result: { kind: "aborted" } };
			}

			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: this.settings.voicemailPinMaxDigits,
				terminators: ["#"],
				timeoutMs: this.settings.voicemailPinTimeoutMs,
				interDigitTimeoutMs: this.settings.voicemailPinInterDigitTimeoutMs,
				media: this.settings.voicemailPinPrompt,
			});
			if (result === undefined) {
				return { kind: "denied", result: { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" } };
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "denied", result: { kind: "aborted" } };
			}

			const verified = await verifyVoicemailPin(collection?.digits.join("") ?? "", node.pinHash);
			if (verified.ok) {
				return { kind: "granted" };
			}
			if (verified.failure === "malformed-hash" || verified.failure === "kdf-error") {
				// Fails closed, and is a defect rather than a wrong guess: the compiler refuses to embed
				// a digest it cannot read, so reaching here means the artifact came from something that
				// skipped that check. Retrying would only burn the caller's remaining attempts.
				this.note(
					`voicemail box ${mailbox} carries a PIN digest this release cannot verify (${verified.failure}); the check was refused`,
				);
				return {
					kind: "denied",
					result: await this.announceAndHangup(
						this.settings.unavailableAnnouncement,
						"NORMAL_TEMPORARY_FAILURE",
					),
				};
			}
			await this.deps.execute({ verb: "play", media: this.settings.voicemailPinInvalidPrompt });
		}

		this.note(
			`voicemail check for box ${mailbox} failed ${this.settings.voicemailPinAttempts} PIN attempts`,
		);
		return {
			kind: "denied",
			result: { kind: "hangup", cause: "CALL_REJECTED" },
		};
	}

	/**
	 * Reading a mailbox out, newest first.
	 *
	 * The message list is an RPC because the rows are the control plane's. Everything about the
	 * failure path here follows from one rule: **a mailbox the engine could not read must never be
	 * announced as empty.** `found: false` and `messages: []` are separate states in the contract for
	 * exactly that reason, and no responder at all is the first of the two.
	 *
	 * The controls are `1` next, `2` replay, `*` exit; a timeout advances, because a caller who
	 * presses nothing has finished with that message. Delete and save are absent rather than
	 * present-and-inert — both write `voicemail_message` state the engine cannot write, and a `7`
	 * that appeared to delete a message that is still there is the worst outcome available.
	 */
	private async voicemailMenu(node: VoicemailPlanNode, mailbox: string): Promise<StepResult> {
		const source = this.deps.mailbox;
		if (source === undefined) {
			this.note(`voicemail check opened box ${mailbox}; this walk has no mailbox source`);
			return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NORMAL_CLEARING");
		}

		let listing: VoicemailListing | undefined;
		try {
			listing = await source.list({
				organizationId: this.deps.channel.organizationId,
				voicemailBoxId: node.voicemailBoxId,
				mailboxNumber: mailbox,
				callId: this.deps.channel.callId,
			});
		} catch (error) {
			this.note(`voicemail listing for box ${mailbox} failed: ${String(error)}`);
			listing = undefined;
		}

		if (listing === undefined || !listing.found) {
			// NOT "you have no messages". See the method note.
			this.note(
				`voicemail box ${mailbox} could not be read (${listing?.reason ?? "no responder"}); announced as unavailable rather than as empty`,
			);
			return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NORMAL_CLEARING");
		}

		for (const media of this.spellNumber(String(listing.messages.length))) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			await this.deps.execute({ verb: "play", media });
		}

		if (listing.messages.length === 0) {
			this.note(`voicemail box ${mailbox} is empty`);
			return { kind: "hangup", cause: "NORMAL_CLEARING" };
		}

		return await this.playVoicemailMessages(mailbox, listing.messages);
	}

	private async playVoicemailMessages(
		mailbox: string,
		messages: readonly VoicemailListingMessage[],
	): Promise<StepResult> {
		let index = 0;
		let replays = 0;

		while (index < messages.length) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			const message = messages[index] as VoicemailListingMessage;
			const media = translateMediaRef(message.media, this.settings.mediaRefs);
			if (media === undefined) {
				// The row exists and its audio does not reach this deployment. Skipping is right — the
				// caller still gets their other messages — and the note is what tells an operator that
				// the object store is not mounted rather than that the message was lost.
				this.note(
					`voicemail message ${message.messageId} in box ${mailbox} names audio this deployment cannot play (${message.media}); it was skipped`,
				);
				index += 1;
				continue;
			}

			const control = await this.deps.execute({
				verb: "gather",
				maxDigits: 1,
				terminators: ["#"],
				// The prompt IS the message: `gather` plays it and stops on the first digit, so a caller
				// who has heard enough presses `1` and moves on rather than waiting out a two-minute
				// recording. That barge-in is the difference between a usable mailbox and one people
				// check from their email instead.
				timeoutMs: this.settings.voicemailMenuTimeoutMs,
				interDigitTimeoutMs: this.settings.voicemailMenuTimeoutMs,
				media,
			});
			if (control === undefined) {
				return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
			}
			const collection = collectionOf(control);
			if (collection?.endReason === "hangup") {
				return { kind: "aborted" };
			}

			const digit = collection?.digits.join("") ?? "";
			if (digit === "*") {
				return { kind: "hangup", cause: "NORMAL_CLEARING" };
			}
			if (digit === "2" && replays < this.settings.voicemailMaxReplays) {
				replays += 1;
				continue;
			}
			// `1`, anything unrecognised, and a timeout all advance: a caller who pressed nothing has
			// finished with this message, and one who pressed `9` meant *something* other than "again".
			replays = 0;
			index += 1;
		}

		this.note(`voicemail box ${mailbox} played ${messages.length} message(s) to the end`);
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
			// `abandoned`, not just `isTearingDown`: a pickup takes the caller away while this loop is
			// between two members of a ring group, and the leg it takes is still very much alive.
			if (this.abandoned) {
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
		// The last moment before audio starts flowing, which is exactly where a transferred leg's
		// hold music has to stop. Never fatal: silence is a worse call, a failed bridge is no call.
		try {
			await this.deps.beforeBridge?.(bridgeId);
		} catch (error) {
			this.log("a pre-bridge hook failed", { bridgeId, err: String(error) });
		}
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

	/**
	 * Whether there is any point continuing.
	 *
	 * Two ways a walk stops mattering, and they are not the same fact. The leg is TEARING DOWN — it
	 * is going away, and nothing may be done to it. Or the leg has been DETACHED — it is alive and
	 * well and belongs to somebody else now, because a pickup took the caller over. The second one is
	 * the dangerous one: everything the walk would do next still succeeds, and every bit of it is
	 * wrong.
	 */
	private get abandoned(): boolean {
		return this.deps.channel.isTearingDown || this.deps.channel.isDetached;
	}

	private note(message: string): void {
		this.notes.push(message);
		this.log(message);
	}
}

/**
 * How long a simultaneous ladder rings before nobody answered.
 *
 * The longest hop's own deadline — its delay plus its timeout — rather than a single figure for
 * the ladder: a hop that starts ten seconds late and rings for twenty has to be allowed its twenty
 * seconds, and an overall budget shorter than that would cancel the one leg most likely to be a
 * mobile still waking up.
 */
function followMeOverallTimeout(attempts: readonly DialAttempt[]): number {
	return attempts.reduce(
		(longest, attempt) => Math.max(longest, attempt.delaySeconds + attempt.timeoutSeconds),
		1,
	);
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
