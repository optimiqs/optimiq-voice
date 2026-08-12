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
	CallFlowMode,
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
	"paging",
	"external",
	"trunk-dial",
	"application",
	"playback",
	"feature-code",
	"time-condition",
	"call-flow",
	"stream",
	"dial-by-name",
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
	/**
	 * The pickup group this extension belongs to, when it has one.
	 *
	 * Present means a `*8` from a phone in the SAME group may answer this extension's ringing calls
	 * and a `*8` from anywhere else may not. Absent means the extension is in no group, and the
	 * engine falls back to the organization-wide behaviour it has always had — see
	 * `ExtensionInput.pickupGroup` for why the fallback is that way round and not a refusal.
	 *
	 * Carried on the NODE as well as on the index because the two answer different questions: the
	 * index answers "what group is the caller in?" from a number, and the node is what a call-flow
	 * inspector renders when somebody asks why their pickup code did nothing.
	 */
	readonly pickupGroup?: string;
	/**
	 * Ask an EXTERNAL caller to record their name, and let this extension accept or reject the call
	 * after hearing it.
	 *
	 * Present and `true` means the engine inserts the screen before the endpoint is rung: the caller
	 * records, the callee hears "call from <recording>" and presses 1 to take it or 2 to refuse it, and
	 * a refusal takes the same branch a busy leg would (`busyNodeId`) so the caller reaches voicemail
	 * rather than silence. Absent means no screen, which is what every extension did before the flag
	 * existed and is why it is optional rather than a required boolean — an old reader that ignores it
	 * rings the endpoint, which is the safe half of the behaviour.
	 *
	 * INTERNAL callers are never screened, and that is not expressible here because it is not
	 * configurable: a colleague already arrives with a name on the display, and screening them would
	 * put ten seconds on the front of every internal call. The engine applies the rule; the artifact
	 * only says whether the tenant asked for the feature.
	 */
	readonly callScreening?: boolean;
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
	/**
	 * Played to the ANSWERING AGENT alone, before the caller is bridged in.
	 *
	 * A bare prompt id, like the two above it and unlike `mohClass`: a prompt is addressed by its row
	 * id all the way down to the media layer, whereas a music-on-hold class has to become a NAME
	 * before a media server will take it, which is the only reason that one is resolved here.
	 *
	 * The opposite side of the bridge from its two siblings, and that is the entire point — the
	 * caller hears the greeting and the position announcements, the agent hears this, and a reader
	 * that played it to both would be reading the agent their cue sheet out loud. Absent means the
	 * agent is bridged straight through.
	 */
	readonly agentWhisperPromptId?: string;
	readonly maxWaitSeconds: number;
	readonly maxWaitNoAgentSeconds: number;
	readonly announcePositionEnabled: boolean;
	readonly announceFrequencySeconds: number;
	/**
	 * When the engine records a call this queue distributed.
	 *
	 * The same {@link RecordPolicy} `extension` and `trunk` nodes carry, replacing a `recordEnabled`
	 * boolean that no runtime ever honoured — the queue session read it only to write a note saying
	 * it had not. One vocabulary, so an operator asking "why was this call recorded?" gets one
	 * answer from one kind of field wherever they look.
	 *
	 * A queued call is INBOUND from the queue's point of view, so `inbound` and `all` both record.
	 * The recording starts at the ANSWER, not at the join: hold music is not evidence, and recording
	 * it would file every abandoned call under the tenant's retention policy.
	 */
	readonly recordPolicy: RecordPolicy;
	/**
	 * The single DTMF digit a WAITING caller may press to leave the line for {@link exitNodeId}.
	 *
	 * Absent means the queue has no exit key, which is what every queue had before. Present without
	 * an `exitNodeId` is possible and means the digit is accepted and the caller is hung up — the
	 * compiler warns about it rather than dropping the key, because "press 9 and the call ends" is a
	 * configuration somebody might mean and a silently ignored key is one nobody can debug.
	 */
	readonly exitKey?: string;
	readonly exitNodeId?: PlanNodeId;
	/**
	 * The priority a caller entering THROUGH THIS NODE starts with. Higher dequeues first.
	 *
	 * On the node rather than only on the queue because the same queue can be entered at different
	 * priorities — an IVR option for platinum customers is exactly that — and the compiler mints a
	 * separate node per distinct override so the two entrances are different nodes over one queue id.
	 * Everything downstream (the roster, the waiting line, the events) keys on `queueId`, so the two
	 * nodes share one line, which is the whole point: a priority that produced a second queue would
	 * not be a priority.
	 */
	readonly priority: number;
	/** Whether a caller who hung up may reclaim their place on a call-back. */
	readonly abandonedResumeAllowed: boolean;
	/** How long that place is held. Also the resume tombstone's TTL. */
	readonly discardAbandonedAfterSeconds: number;
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
 * Announce to a set of handsets at once.
 *
 * # Why members are NUMBERS and not endpoints
 *
 * The obvious alternative is to compile each member down to the dial string the engine will hand
 * its media server — `PJSIP/1001` or whatever the deployment speaks. That would bake an
 * Asterisk-ism into an artifact that outlives the engine release which wrote it. The engine already
 * owns the dial template (`endpointForExtension` in plan-walker), it is the only component that
 * knows what its channel driver is called, and it applies that template to every other kind of leg
 * it originates. A page is not the place to invent a second answer.
 *
 * So the artifact carries the internal numbers, in order, and the engine turns them into endpoints
 * the same way it always does. `extensionsByNumber` on the artifact is the index that makes the
 * number a complete reference: everything else the engine needs about a member is one lookup away.
 *
 * # Why a disabled member is dropped at compile time
 *
 * A page's member list is a DELIVERY PROMISE — these handsets and no others will hear this. If the
 * list carried disabled members the engine would have to re-derive who is really in it, on the call
 * path, and two components would then be answering "who hears this page?" independently. Dropping
 * them here means the compiled list is the answer, the call-flow inspector shows exactly what will
 * happen, and a page that reaches fewer people than the operator expected is visible in the
 * artifact instead of only in the room.
 *
 * A member whose extension is missing entirely is dropped too, but loudly — it earns a diagnostic
 * naming the group, because a page silently reaching fewer people is the failure mode this whole
 * design is arranged against.
 *
 * # There are no references, and no continuation
 *
 * A page does not go anywhere afterwards: the pager speaks and hangs up, and that is the end of the
 * call. Hence no `timeoutNodeId`, no `thenNodeId`, and `planNodeReferences` returning nothing.
 *
 * # Multicast is out of scope
 *
 * The other way to page — one RTP stream to a group address, handsets subscribed to it — is NOT
 * expressible here and is deliberately left for a later wave. It needs a multicast-capable network
 * the tenant controls and per-model handset provisioning, neither of which is a routing fact, and
 * half-expressing it (a flag with no address, an address with no provisioning) would be a field
 * readers would have to guess the meaning of. This node is unicast fan-out and says so by having no
 * way to say anything else.
 */
export interface PagingPlanNode extends PlanNodeBase {
	readonly kind: "paging";
	readonly pagingGroupId: string;
	/** Member extension NUMBERS in ordinal order, already filtered to enabled members of enabled extensions. */
	readonly members: readonly string[];
	/** False is a one-way announcement: members hear the pager and cannot be heard. */
	readonly duplex: boolean;
	/** How long a member's auto-answered leg may take to come up before it is given up on. */
	readonly timeoutSeconds: number;
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
	/**
	 * The authorisation codes a caller must satisfy before the FIRST attempt is offered.
	 *
	 * On the node rather than on `OutboundRule` because the node is what the engine walks: a resolver
	 * hands over an `ExecutionPlan`, not the rule it matched, and a gate the walker cannot see is a
	 * gate that does not exist. Optional, so an artifact compiled before PIN sets existed — and every
	 * route that has no set — dials as it always did.
	 *
	 * The emergency node NEVER carries one. Kari's Law says `911` is dialable from any station with
	 * no prefix and no permission, and an authorisation code is a permission; the compiler builds the
	 * emergency node from no route at all, so this falls out rather than being enforced.
	 */
	readonly pinSet?: CompiledPinSet;
}

/**
 * A compiled authorisation-code list.
 *
 * The digests travel in the artifact for exactly the reason `VoicemailPlanNode.pinHash` and
 * `ConferencePlanNode.pinHash` do: the challenge happens on the call path, in a process holding no
 * database handle. Same format, same parser, same constant-time verifier.
 *
 * An entry the compiler could not read is DROPPED rather than embedded, and a set whose entries are
 * all unreadable compiles to no gate at all with a warning — the same fail-open-with-a-warning the
 * mailbox PIN takes, and for the same reason: refusing every outbound call over a formatting change
 * takes the tenant's phones down to protect a route they already decided to gate.
 */
export interface CompiledPinSet {
	readonly pinSetId: string;
	readonly name: string;
	readonly maxAttempts: number;
	readonly digitTimeoutMs: number;
	readonly promptId?: string;
	readonly failurePromptId?: string;
	/** In `ordinal` order. Never empty — a set with no usable code compiles to no gate. */
	readonly entries: readonly CompiledPinEntry[];
}

/**
 * One authorisation code.
 *
 * `ordinal` and `label` are what the CDR records — "entry 3, the night desk" — and the digits never
 * are. That is the whole of what upstream's plaintext column was needed for, and it is answerable
 * without the secret because an entry has an identity of its own.
 */
export interface CompiledPinEntry {
	readonly pinSetEntryId: string;
	readonly ordinal: number;
	readonly label?: string;
	/** A digest in the `voicemail-pin.ts` format. Never a PIN. */
	readonly pinHash: string;
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

/**
 * A day/night switch, resolved.
 *
 * # Why it is a node and not a flattened branch
 *
 * The compiler knows the mode — it is a column, and it is compiled in — so it could emit only the
 * live branch and drop the other. It deliberately does not, for the reason `time-condition` is also
 * a node the resolver walks through eagerly: a call-flow inspector has to be able to show WHY a
 * call went where it went, and "the flow was in night mode and the night branch is voicemail" is
 * only answerable if both branches survive into the artifact.
 *
 * The resolver follows it in `followGates` alongside time conditions, so the plan the engine
 * receives already has the switch applied. The engine's walker also handles it, for the same reason
 * it re-evaluates a time condition at the walk's instant: a caller can reach one part-way through a
 * walk rather than only at the entry.
 *
 * `presenceKey` is the dialable string a BLF lamp is subscribed to — the flow's own feature code, or
 * its number when it has no code. Carried so whichever process flips the mode can light the lamp
 * without a second lookup, and absent when the flow has neither, which is a flow nothing can watch.
 */
export interface CallFlowPlanNode extends PlanNodeBase {
	readonly kind: "call-flow";
	readonly callFlowId: string;
	readonly mode: CallFlowMode;
	readonly dayNodeId: PlanNodeId;
	readonly nightNodeId: PlanNodeId;
	/** The feature code that toggles it, for the inspector and for the engine's runtime. */
	readonly featureCode?: string;
	/** The `presence` KV key a BLF lamp watches. Absent when the flow has no dialable identity. */
	readonly presenceKey?: string;
}

/**
 * Play a remote audio stream, then go somewhere.
 *
 * # `fallbackNodeId` is not optional, and that is the whole design
 *
 * Remote-URL playback is the one thing in this artifact whose availability depends on the media
 * driver rather than on the configuration: ARI's `POST /channels/{id}/play` accepts `sound:`,
 * `recording:`, `number:`, `digits:`, `characters:` and `tone:`, and an arbitrary `https://` is not
 * among them — `apps/engine`'s `translateMediaRef` returns `undefined` for one and every runtime
 * treats that as "announce the fallback". A stream node therefore always carries somewhere to go,
 * and the compiler refuses one that does not, so a driver that cannot play the source produces a
 * routed call rather than silence.
 *
 * The same branch covers the far more common failure: the URL is simply unreachable, because a
 * remote source is somebody else's uptime.
 */
export interface StreamPlanNode extends PlanNodeBase {
	readonly kind: "stream";
	readonly audioStreamId: string;
	/** `http(s)` only — validated at write time, because it decides what a media server opens. */
	readonly url: string;
	readonly answerFirst: boolean;
	/** Zero means "until the caller hangs up". */
	readonly maxSeconds: number;
	/** Taken when the stream ends, times out, or cannot be played at all. Never absent. */
	readonly fallbackNodeId: PlanNodeId;
}

/** One person a caller can reach by spelling their name. */
export interface DirectoryEntry {
	/** The name, mapped through the ITU keypad. What the caller's digits are matched against. */
	readonly digits: string;
	readonly extensionNumber: string;
	/** The `extension` node to dial on selection. */
	readonly targetNodeId: PlanNodeId;
	/**
	 * The mailbox's recorded-name greeting, as a domain `MediaRef`.
	 *
	 * Never absent, and that is what makes the list offerable: this platform has no text-to-speech,
	 * so an entry whose name cannot be SPOKEN cannot be offered, and the compiler drops such
	 * extensions with a warning rather than producing "for … press one".
	 */
	readonly nameMedia: string;
	/** For the inspector and for a spoken position, never for matching. */
	readonly label?: string;
}

/**
 * Answer, ask for name digits, offer the matches, connect.
 *
 * The entries are COMPILED rather than searched at call time, for the reason every index in this
 * artifact is: the engine holds no database handle. Compiling them also produces the one diagnostic
 * that has no runtime symptom — two people whose names collide on the keypad.
 */
export interface DialByNamePlanNode extends PlanNodeBase {
	readonly kind: "dial-by-name";
	readonly directoryId: string;
	/** How many digits the caller must enter before matching starts. */
	readonly minDigits: number;
	readonly maxFailures: number;
	readonly greetingPromptId?: string;
	readonly invalidPromptId?: string;
	/** Sorted by `digits` then `extensionNumber`, so a prefix scan is a linear walk. */
	readonly entries: readonly DirectoryEntry[];
	/** Taken when the caller gives up, times out, or exhausts their attempts. */
	readonly timeoutNodeId?: PlanNodeId;
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
	| PagingPlanNode
	| ExternalPlanNode
	| TrunkDialPlanNode
	| ApplicationPlanNode
	| PlaybackPlanNode
	| FeatureCodePlanNode
	| TimeConditionPlanNode
	| CallFlowPlanNode
	| StreamPlanNode
	| DialByNamePlanNode
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
		case "paging": {
			// Nothing. A page has no continuation — the members' legs are numbers rather than node
			// references, and the call ends when the pager hangs up, so there is no branch to reach.
			return [];
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
