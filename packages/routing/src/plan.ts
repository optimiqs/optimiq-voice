/**
 * The execution plan: what the engine walks once a route has matched.
 *
 * # Node table, not a tree
 *
 * The obvious shape — inline each destination into its parent — cannot represent this domain. An
 * IVR menu's option may point back at its parent menu; a ring group's timeout may point at a queue
 * whose own timeout points back at the ring group. Those are legitimate configurations (a caller
 * pressing `*` to go back is the canonical example), and inlining them produces an infinite tree.
 *
 * So the artifact holds a flat, id-keyed **node table**, and every branch is a `PlanNodeId`
 * reference into it. The table is closed under reference by construction, which makes "every
 * reference resolves" a property the compiler guarantees and the tests can assert cheaply. It also
 * means one extension referenced by forty routes is one node, so the artifact grows with the
 * tenant's configuration rather than with the number of paths through it.
 *
 * # Everything here is plain JSON
 *
 * The artifact is cached in a NATS KV bucket. No `RegExp`, no `Date`, no `Map`, no class instance
 * may appear in any node — `canonicalJson` enforces that at hash time, and the enforcement is the
 * point: a node that cannot survive `JSON.parse(JSON.stringify(x))` would work in the process that
 * compiled it and break in every process that read it back.
 *
 * # Terminal vocabulary
 *
 * Hangup causes are `@optimiq-voice/telephony`'s taxonomy verbatim. The engine keys failover off
 * them, the CDR writer stores them, and a routing decision that invented its own cause names would
 * be invisible to both.
 *
 * # Row ids versus the names a media server speaks
 *
 * Five node kinds carry both a `mohClassId` and a `mohClass`. The first is the `moh_class` row id,
 * which is what the tenant's configuration stores and what a call-flow inspector needs in order to
 * link back to the row. The second is that class's **name**, which is the only thing a media
 * server will accept — Asterisk's `POST /channels/{id}/moh` takes `mohClass=<name>`, and handing it
 * a UUID selects the server's default class and reports no error at all.
 *
 * Both are present rather than the name replacing the id: the id is the fact, the name is derived
 * from a row that may have been renamed since, and an artifact compiled before this resolution
 * existed carries only the id. Every reader therefore treats the name as optional and falls back to
 * the media server's default class — which is what an unresolved UUID was silently producing.
 */

import type { CompiledPattern } from "./patterns";
import type {
	FeatureCodeAction,
	FeatureCodeParams,
	QueueStrategy,
	RecordPolicy,
	RingGroupStrategy,
	SipTransport,
	TollClass,
	TrunkKind,
	VoicemailGreetingKind,
} from "./snapshot";
import type { HangupCause } from "@optimiq-voice/telephony";

/**
 * A node id. Derived from the entity it was compiled from (`extension:<uuid>`,
 * `hangup:USER_BUSY`), never generated: two compiles of the same snapshot must produce the same
 * ids, or the artifact is not byte-stable and the cache thrashes on every recompile.
 */
export type PlanNodeId = string;

export const PLAN_NODE_KINDS = [
	"extension",
	"ring-group",
	"ivr-menu",
	"queue",
	"voicemail",
	"conference",
	"park",
	"external",
	"trunk-dial",
	"application",
	"playback",
	"feature-code",
	"time-condition",
	"hangup",
] as const;

export type PlanNodeKind = (typeof PLAN_NODE_KINDS)[number];

interface PlanNodeBase {
	readonly id: PlanNodeId;
	readonly kind: PlanNodeKind;
	/** Human label for logs and the call-flow inspector. Never used for matching. */
	readonly label?: string;
}

/**
 * Dial one extension.
 *
 * The three failure branches mirror the extension's own forwarding flags and are resolved at
 * compile time into concrete nodes, so the engine never has to know that "forward on busy" and
 * "voicemail on busy" are different features — both are just `busyNodeId`.
 *
 * `doNotDisturb` stays a flag rather than being folded into the entry, because it is the one field
 * here a user toggles from their phone: the engine short-circuits on it immediately, and the
 * recompile that follows the `*78` press only has to agree eventually.
 */
export interface ExtensionPlanNode extends PlanNodeBase {
	readonly kind: "extension";
	readonly extensionId: string;
	readonly number: string;
	readonly callerIdName?: string;
	readonly callerIdNumber?: string;
	readonly tollClass: TollClass;
	readonly recordPolicy: RecordPolicy;
	readonly timeoutSeconds: number;
	readonly doNotDisturb: boolean;
	readonly mohClassId?: string;
	/** The class's NAME, resolved from `mohClassId`. Absent means "the media server's default". */
	readonly mohClass?: string;
	/** Taken before ringing when "forward all" is on. */
	readonly forwardAllNodeId?: PlanNodeId;
	readonly busyNodeId?: PlanNodeId;
	readonly noAnswerNodeId?: PlanNodeId;
	readonly notRegisteredNodeId?: PlanNodeId;
	/**
	 * The follow-me ladder, when the extension has one and it is switched on.
	 *
	 * Present means "ring THESE instead of the endpoint" — the ladder REPLACES the plain dial, it
	 * does not run alongside it. That is the upstream behaviour and the only one that can be
	 * expressed without inventing a column: a user who wants their desk phone to ring first puts
	 * their own extension number at the top of the list, which is exactly what the admin UI shows
	 * them. Absent (the overwhelmingly common case) means the extension rings and nothing else
	 * changes.
	 *
	 * Optional rather than always-present so an old reader ignores it and dials the endpoint, which
	 * is what every release before this one did.
	 */
	readonly followMe?: FollowMePlan;
}

/**
 * One hop of a compiled follow-me ladder.
 *
 * The dial facts are resolved here rather than at call time because the engine holds no database
 * handle and no outbound match table: `targetNodeId` names either the `extension` node whose
 * endpoint to ring, or the `trunk-dial` node whose trunk chain carries the call off-net.
 *
 * `targetNodeId` is ABSENT when the compiler could not resolve the hop — no outbound route matched
 * it, the extension's toll class does not cover the route that did, outbound calling is switched
 * off for the organization, or a call-block rule refuses the number. A reader skips such a hop; it
 * is kept in the artifact so the call-flow inspector can show the tenant *which* hop is dead and
 * the walk's notes can say why it was not rung. Dropping it would make a misconfigured ladder look
 * like a shorter one.
 */
export interface FollowMeDestination {
	/** Position in the ladder, lowest first. The stored array's index. */
	readonly ordinal: number;
	/** The dial string as the tenant configured it. For the log and the inspector, never for matching. */
	readonly destination: string;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	/** Ask the answering party to press a digit before bridging. Not implemented by the engine yet. */
	readonly confirmRequired: boolean;
	/** `extension:<id>` or `trunk-dial:<outboundRouteId>`. Absent means "unresolvable, skip it". */
	readonly targetNodeId?: PlanNodeId;
	/**
	 * External hops only: the number after the matched outbound route's digit manipulation — what
	 * actually goes on the wire. Internal hops dial the extension node's own `number`.
	 */
	readonly dialedNumber?: string;
}

/**
 * An extension's follow-me ladder, compiled.
 *
 * # `strategy` is derived, not stored
 *
 * `pbx-db`'s `follow_me` JSON has no strategy field (`ring_group` does). The compiler reads the
 * delays as the strategy: every hop at delay zero is `simultaneous` — a ring-all across the
 * ladder, first answer wins — and any hop with a positive delay is `sequential`, a find-me ladder
 * walked in order. That is FreeSWITCH's own reading of the same two numbers, and it is the only
 * one available without a column that does not exist. The derived value is written into the
 * artifact rather than re-derived by every reader, so the engine executes a decision it can see.
 */
export interface FollowMePlan {
	readonly strategy: RingGroupStrategy;
	/** A busy hop does not end a sequential ladder. Ignored by `simultaneous`, which races. */
	readonly ignoreBusy: boolean;
	/** In `ordinal` order. Never empty in a compiled artifact — an empty ladder is not compiled. */
	readonly destinations: readonly FollowMeDestination[];
}

export interface RingGroupMember {
	readonly ordinal: number;
	readonly delaySeconds: number;
	readonly timeoutSeconds: number;
	readonly confirmRequired: boolean;
	readonly targetNodeId: PlanNodeId;
}

export interface RingGroupPlanNode extends PlanNodeBase {
	readonly kind: "ring-group";
	readonly ringGroupId: string;
	readonly strategy: RingGroupStrategy;
	readonly ringTimeoutSeconds: number;
	readonly ignoreBusy: boolean;
	readonly confirmEnabled: boolean;
	readonly confirmPromptId?: string;
	readonly callerIdNamePrefix?: string;
	readonly mohClassId?: string;
	/** The class's NAME, resolved from `mohClassId`. Absent means "the media server's default". */
	readonly mohClass?: string;
	readonly ringbackPromptId?: string;
	/** In `ordinal` order. Never empty in a compiled artifact — an empty group is a hard error. */
	readonly members: readonly RingGroupMember[];
	readonly timeoutNodeId?: PlanNodeId;
}

export interface IvrOption {
	readonly ordinal: number;
	/** `digit` options compile to an `exact` pattern; `regex` options to a `regex` one. */
	readonly pattern: CompiledPattern;
	readonly matchValue: string;
	readonly label?: string;
	readonly targetNodeId: PlanNodeId;
}

export interface IvrMenuPlanNode extends PlanNodeBase {
	readonly kind: "ivr-menu";
	readonly ivrMenuId: string;
	readonly greetingPromptId?: string;
	readonly shortGreetingPromptId?: string;
	readonly invalidPromptId?: string;
	readonly timeoutPromptId?: string;
	readonly digitTimeoutMs: number;
	readonly interDigitTimeoutMs: number;
	readonly maxDigits: number;
	readonly maxFailures: number;
	readonly maxTimeouts: number;
	/** Lets a caller dial an internal number that is not an explicit option. */
	readonly directDialEnabled: boolean;
	readonly options: readonly IvrOption[];
	readonly timeoutNodeId?: PlanNodeId;
	readonly invalidNodeId?: PlanNodeId;
}

export interface QueuePlanNode extends PlanNodeBase {
	readonly kind: "queue";
	readonly queueId: string;
	readonly strategy: QueueStrategy;
	readonly mohClassId?: string;
	/** The class's NAME, resolved from `mohClassId`. Absent means "the media server's default". */
	readonly mohClass?: string;
	readonly greetingPromptId?: string;
	readonly announcePromptId?: string;
	readonly maxWaitSeconds: number;
	readonly maxWaitNoAgentSeconds: number;
	readonly announcePositionEnabled: boolean;
	readonly announceFrequencySeconds: number;
	readonly recordEnabled: boolean;
	readonly timeoutNodeId?: PlanNodeId;
}

/** `leave` plays the greeting and records; `check` authenticates and opens the mailbox. */
export const VOICEMAIL_MODES = ["leave", "check"] as const;

export type VoicemailMode = (typeof VOICEMAIL_MODES)[number];

/**
 * A mailbox, in one of its two modes.
 *
 * # Why the greeting and the PIN are here
 *
 * Both are read at exactly one moment — the instant a call reaches the mailbox — by a process that
 * holds no database handle. Everything else about a box (its email address, its transcription
 * flag, its message retention) is read by the control plane at its leisure and has no business in
 * an artifact. The line is "does call-time behaviour change if this field changes?", and it puts
 * precisely two fields on this side of it.
 *
 * `greetingMedia` is a domain `MediaRef`, not a media-server URI: which greeting to play is a
 * routing decision (the compiler applies `VOICEMAIL_LEAVE_GREETING_PRECEDENCE` over the box's
 * active rows), while turning `object://…` into something Asterisk will accept is a protocol
 * detail the engine's media layer owns. A reader that cannot resolve the ref falls back to its
 * deployment-wide announcement rather than playing silence at a caller.
 *
 * `pinHash` is a digest in the format `voicemail-pin.ts` defines, never a PIN. A reader with no
 * digest must not invent an authentication step, and a reader with one must not accept a call
 * without it: absent means "this box has no PIN", which is the classic PBX default for `*97` from
 * the owner's own extension.
 */
export interface VoicemailPlanNode extends PlanNodeBase {
	readonly kind: "voicemail";
	readonly voicemailBoxId: string;
	readonly mailboxNumber: string;
	readonly mode: VoicemailMode;
	readonly maxMessageSeconds: number;
	readonly mwiEnabled: boolean;
	/** The box's active greeting for this mode, as a domain `MediaRef`. `leave` only. */
	readonly greetingMedia?: string;
	/** Which kind `greetingMedia` came from, for the log and the call-flow inspector. */
	readonly greetingKind?: VoicemailGreetingKind;
	/** Digest of the mailbox PIN. Absent means the box has no PIN and no challenge is issued. */
	readonly pinHash?: string;
}

/**
 * A conference room.
 *
 * # Why the digests are here
 *
 * The same rule that put `VoicemailPlanNode.pinHash` here: the gate is applied at the instant a
 * caller reaches the room, by a process holding no database handle, so the digest travels in the
 * artifact or the room cannot be gated at all. The format is `voicemail-pin.ts`'s, verbatim —
 * the compiler parses it, refuses to embed one it cannot read, and the engine verifies it with
 * the same constant-time check it uses for `*97`.
 *
 * # `requiresPin` and `pinHash` are separate facts, and a reader must not conflate them
 *
 * `requiresPin` means "the room's row has a PIN set". `pinHash` means "and this release can
 * verify it". They come apart in exactly two situations and both must fail CLOSED:
 *
 * - the digest is in a format this release cannot parse (the compiler raises `invalid-pin-hash`
 *   and embeds nothing);
 * - the artifact was compiled by a release that predated this field.
 *
 * In both, `requiresPin === true && pinHash === undefined`, and the only honest answer is to
 * refuse the room. Admitting the caller would turn a formatting change into an open conference
 * bridge, which is the failure mode this whole design exists to avoid.
 *
 * `requiresModeratorPin` is optional and absent means `false`: a reader compiled before moderator
 * support simply has no moderators, which is what it did anyway.
 */
export interface ConferencePlanNode extends PlanNodeBase {
	readonly kind: "conference";
	readonly conferenceId: string;
	readonly roomNumber: string;
	readonly requiresPin: boolean;
	readonly maxMembers: number;
	readonly waitForModerator: boolean;
	readonly recordEnabled: boolean;
	readonly mohClassId?: string;
	/** The class's NAME, resolved from `mohClassId`. Absent means "the media server's default". */
	readonly mohClass?: string;
	/** Digest of the participant PIN. Absent with `requiresPin` set means "refuse the room". */
	readonly pinHash?: string;
	/** Digest of the moderator PIN. Entering it admits the caller AND releases `waitForModerator`. */
	readonly moderatorPinHash?: string;
	/** Whether the room's row has a moderator PIN. Absent means `false`. */
	readonly requiresModeratorPin?: boolean;
}

export interface ParkPlanNode extends PlanNodeBase {
	readonly kind: "park";
	readonly parkLotId: string;
	readonly slotStart: number;
	readonly slotEnd: number;
	readonly timeoutSeconds: number;
	readonly mohClassId?: string;
	/** The class's NAME, resolved from `mohClassId`. Absent means "the media server's default". */
	readonly mohClass?: string;
	readonly timeoutNodeId?: PlanNodeId;
}

/**
 * A literal number outside the organization.
 *
 * `viaOutboundRouting` is the important field: a DID that forwards to a mobile must go back through
 * the outbound tables so it picks up a trunk, a toll class and a caller id. Skipping that is how a
 * PBX ends up with an inbound route that can dial anywhere on someone else's account.
 */
export interface ExternalPlanNode extends PlanNodeBase {
	readonly kind: "external";
	readonly destination: string;
	readonly viaOutboundRouting: boolean;
	readonly callerIdNumber?: string;
	readonly callerIdName?: string;
}

/** One trunk attempt in an outbound failover chain. */
export interface TrunkAttempt {
	readonly trunkId: string;
	readonly name: string;
	readonly kind: TrunkKind;
	readonly sipDomain: string;
	readonly sipProxy: string;
	readonly outboundProxy?: string;
	readonly transport: SipTransport;
	readonly codecPrefs?: string;
	readonly maxChannels?: number;
	readonly callerIdNumberOverride?: string;
	/** Position in the failover order, lowest first. */
	readonly order: number;
	/** Relative share among attempts sharing an `order`. Absent means "no weighting". */
	readonly weight?: number;
}

/**
 * Dial out over an ordered list of trunks.
 *
 * `continueOnCauses` is a closed allow-list, defaulting to telephony's
 * `RETRYABLE_HANGUP_CAUSES`. It is deliberately not "every cause": walking an entire trunk list
 * after a `CALL_REJECTED` multiplies one fraudulent call attempt by the number of carriers a
 * tenant has, which is precisely the amplification a compromised extension is looking for.
 *
 * # The emergency variant
 *
 * `emergency` marks the ONE node in an artifact that was not compiled from an `outbound_route`
 * row (`outboundRouteId` is the literal `"emergency"`). It exists as a flag on this node rather
 * than as a fourteenth node kind for a deliberate reason: a new kind is a
 * `ROUTING_ARTIFACT_VERSION` bump — an old reader hits a node it cannot execute and refuses the
 * call — whereas three optional fields leave an old reader dialing the trunk chain with the
 * tenant's ordinary caller id. For an emergency call, "dialed with the wrong ANI" is a far better
 * failure than "refused", and it is what every release before this one would have done anyway.
 *
 * `elin` is the Emergency Location Identification Number: the callback number a PSAP dials and
 * the key it looks the dispatchable location up by. It is the ORGANIZATION's fallback — the
 * calling extension's own `emergencyCallerIdNumber` wins over it, and the resolver applies that
 * precedence because only the resolver knows who is calling.
 */
export interface TrunkDialPlanNode extends PlanNodeBase {
	readonly kind: "trunk-dial";
	readonly outboundRouteId: string;
	readonly tollClass: TollClass;
	readonly attempts: readonly TrunkAttempt[];
	readonly continueOnCauses: readonly HangupCause[];
	readonly recordEnabled: boolean;
	readonly callerIdNumberOverride?: string;
	/** Taken when every attempt has failed. */
	readonly failoverNodeId?: PlanNodeId;
	/** Marks the emergency dial node. A reader that does not know the field dials normally. */
	readonly emergency?: boolean;
	/** `emergency_address.id` the ELIN is registered against, for the notification event. */
	readonly emergencyAddressId?: string;
	/** Organization-level ELIN. The caller's own emergency caller id wins over it. */
	readonly elin?: string;
}

/** Hand the leg to a named engine application (the `application` destination type). */
export interface ApplicationPlanNode extends PlanNodeBase {
	readonly kind: "application";
	readonly application: string;
	readonly args?: Readonly<Record<string, string | number | boolean>>;
}

/** Play a prompt, then continue (or hang up if there is nothing after it). */
export interface PlaybackPlanNode extends PlanNodeBase {
	readonly kind: "playback";
	readonly promptId?: string;
	/** A `MediaRef` URI when the audio is not a prompt-library entry. */
	readonly media?: string;
	readonly thenNodeId?: PlanNodeId;
}

/**
 * A star code. The engine's feature runtimes own the behaviour; the artifact supplies the code,
 * the action and whatever argument the caller dialed after it.
 */
export interface FeatureCodePlanNode extends PlanNodeBase {
	readonly kind: "feature-code";
	readonly featureCodeId: string;
	readonly code: string;
	readonly action: FeatureCodeAction;
	readonly params?: FeatureCodeParams;
	/** Node to run when the feature resolves to a destination (e.g. a park lot). */
	readonly targetNodeId?: PlanNodeId;
}

/**
 * A gate evaluated against the clock.
 *
 * Kept as a node rather than being flattened at compile time for the obvious reason: the answer
 * depends on when the call arrives. The resolver walks through these eagerly using the instant it
 * was given, so the plan the engine receives already has the gate applied — but the node stays in
 * the table so a call-flow inspector can show *why*.
 */
export interface TimeConditionPlanNode extends PlanNodeBase {
	readonly kind: "time-condition";
	readonly timeConditionId: string;
	readonly matchNodeId: PlanNodeId;
	readonly noMatchNodeId?: PlanNodeId;
}

/** The end of a chain. Every path in a compiled artifact terminates in one of these. */
export interface HangupPlanNode extends PlanNodeBase {
	readonly kind: "hangup";
	readonly cause: HangupCause;
}

export type PlanNode =
	| ExtensionPlanNode
	| RingGroupPlanNode
	| IvrMenuPlanNode
	| QueuePlanNode
	| VoicemailPlanNode
	| ConferencePlanNode
	| ParkPlanNode
	| ExternalPlanNode
	| TrunkDialPlanNode
	| ApplicationPlanNode
	| PlaybackPlanNode
	| FeatureCodePlanNode
	| TimeConditionPlanNode
	| HangupPlanNode;

export type PlanNodeOf<TKind extends PlanNodeKind> = Extract<PlanNode, { kind: TKind }>;

/** The artifact's node table. */
export type PlanNodeTable = Readonly<Record<PlanNodeId, PlanNode>>;

/**
 * What a resolver hands the engine: an entry point plus the table to walk from it.
 *
 * `nodes` is the artifact's own table by reference, not a copy — resolving a route is on the call
 * path and must not allocate a subgraph. The engine treats it as read-only, which every type here
 * already says.
 */
export interface ExecutionPlan {
	readonly entryNodeId: PlanNodeId;
	readonly nodes: PlanNodeTable;
}

/**
 * Every node id a node points at, in a stable order.
 *
 * One place, so "did I remember the new branch field?" is a question with a single answer. The
 * validation pass, the reachability walk and the closure property test all read from here.
 */
export function planNodeReferences(node: PlanNode): readonly PlanNodeId[] {
	switch (node.kind) {
		case "extension": {
			return compact([
				node.forwardAllNodeId,
				node.busyNodeId,
				node.noAnswerNodeId,
				node.notRegisteredNodeId,
				// The ladder's hops are references like any other branch: closure has to hold over
				// them, and the reachability walk has to reach the trunk-dial node a follow-me hop
				// is the only path to.
				...(node.followMe?.destinations ?? []).map((hop) => hop.targetNodeId),
			]);
		}
		case "ring-group": {
			return compact([...node.members.map((member) => member.targetNodeId), node.timeoutNodeId]);
		}
		case "ivr-menu": {
			return compact([
				...node.options.map((option) => option.targetNodeId),
				node.timeoutNodeId,
				node.invalidNodeId,
			]);
		}
		case "queue": {
			return compact([node.timeoutNodeId]);
		}
		case "park": {
			return compact([node.timeoutNodeId]);
		}
		case "trunk-dial": {
			return compact([node.failoverNodeId]);
		}
		case "playback": {
			return compact([node.thenNodeId]);
		}
		case "feature-code": {
			return compact([node.targetNodeId]);
		}
		case "time-condition": {
			return compact([node.matchNodeId, node.noMatchNodeId]);
		}
		default: {
			return [];
		}
	}
}

function compact(values: readonly (PlanNodeId | undefined)[]): readonly PlanNodeId[] {
	return values.filter((value): value is PlanNodeId => value !== undefined);
}

/** Node ids reachable from `entryNodeId`, including it. Cycle-safe. */
export function reachableNodeIds(
	nodes: PlanNodeTable,
	entryNodeId: PlanNodeId,
): ReadonlySet<PlanNodeId> {
	const seen = new Set<PlanNodeId>();
	const pending: PlanNodeId[] = [entryNodeId];
	while (pending.length > 0) {
		const id = pending.pop() as PlanNodeId;
		if (seen.has(id)) {
			continue;
		}
		seen.add(id);
		const node = nodes[id];
		if (node === undefined) {
			continue;
		}
		pending.push(...planNodeReferences(node));
	}
	return seen;
}

/** Stable, sorted node ids. Used wherever a deterministic walk over the table is needed. */
export function planNodeIds(nodes: PlanNodeTable): readonly PlanNodeId[] {
	return Object.keys(nodes).sort();
}
