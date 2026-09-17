import { createEntityId } from "@optimiq-voice/identifiers";
import { evaluateTimeCondition, matchPattern } from "@optimiq-voice/routing";
import { RETRYABLE_HANGUP_CAUSES } from "@optimiq-voice/telephony";
import { CLIR_VARIABLE } from "../media/split-plane.port";
import { QueueSession } from "../queue/queue-session";
import { AUTO_ANSWER_VARIABLES } from "./auto-answer";
import { legSignalKey, recordingSignalKey } from "./call-signals";
import {
	DEFAULT_MEDIA_REF_SETTINGS,
	resolveMediaRef,
	resolveMediaRefOrExplain,
	translateMediaRef,
} from "./media-refs";
import { planDestinationOf, sameDestination } from "./plan-destination";
import { TOLL_FRAUD_REFUSAL_CAUSE } from "./toll-fraud-guard";
import { orderTrunkAttempts } from "./trunk-selection";
import { verifyPinDigest, verifyVoicemailPin } from "./voicemail-pin";
import type { DialTarget, MediaPort } from "../media/media-port";
import type {
	QueueCallPort,
	QueueDialAttempt,
	QueueDialOutcome,
	QueueServices,
	QueueOutcome,
	QueueSessionSettings,
} from "../queue/queue-session";
import type { CallSignalBus, LegSignal } from "./call-signals";
import type { ConferenceRegistry } from "./conference-registry";
import type { MediaRefSettings } from "./media-refs";
import type { PlanDestination } from "./plan-destination";
import type { TollFraudGuardPort } from "./toll-fraud-guard";
import type { TrunkCapacityPort } from "./trunk-capacity";
import type { CallEvent, ExtensionFeature } from "@optimiq-voice/events";
import type {
	ApplicationPlanNode,
	CompiledTimeCondition,
	CompiledPinEntry,
	CompiledPinSet,
	ConferencePlanNode,
	DialByNamePlanNode,
	DirectoryEntry,
	ExecutionPlan,
	ExtensionPlanNode,
	FollowMeDestination,
	FollowMePlan,
	IvrMenuPlanNode,
	MailboxEntry,
	PagingPlanNode,
	PlanNode,
	PlanNodeId,
	QueuePlanNode,
	RingGroupPlanNode,
	SharedLineAppearance,
	SharedLinePlanNode,
	StreamPlanNode,
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
 * strategies, with lose-race). Both honour `confirmRequired`: a leg marked for it has to press the
 * accept digit before it counts as answered at all, which is what keeps a mobile's own voicemail
 * from winning a hop — see {@link PlanWalker.confirmAnswer}. Also real: `ivr-menu` (retries, invalid
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
 * Also real, and the reason this class grew a second half: the SELF-SERVICE star codes.
 * `*72`/`*74`/`*76` (forward all / busy / no answer), `*78` (do not disturb) and `*21` (follow me)
 * send `rpc.pbx.v1.extension-feature` and confirm or refuse audibly; `*69` reads the call ledger
 * over `rpc.pbx.v1.last-caller` and dials the result back through the same routing the caller would
 * have got by hand; `*43` hands the leg to the media plane's echo; `*99` records a mailbox greeting
 * behind the same PIN gate `*97` uses. `*97` and `*98` are now reachable from the star-code
 * CATALOGUE rather than only from the `voicemailPrefix` settings — see
 * {@link PlanWalker.voicemailCode} for the gap that closed. Every one of them needs its port
 * ({@link PlanWalkerDependencies.features}, `lastCaller`, `greetings`, `control`, `application`);
 * without one the code or destination announces and says so, which is exactly what it did before
 * this wave.
 *
 Supervision and intercom joined them in this wave: `*0` authorizes against
 * {@link PlanWalkerDependencies.supervision} and hands the tap to `control.monitor`, `*80` dials an
 * extension with the auto-answer headers, and a `paging` node fans out to a whole group.
 *
 * Placeholder, and honest about it: `voicemail` records but has no MWI and no email; the remaining
 * feature codes (`record-toggle`, `transfer`, `queue-toggle`, `agent-status`, and `paging` as a
 * CODE rather than a node) answer with an announcement; call
 * screening is implemented behind a default-off setting whose remaining seams
 * {@link PlanWalker.screenCall} names one by one. Every one of them adds a line to
 * {@link WalkOutcome.notes}, so a call that hit a gap says so in the log rather than looking like a
 * routing bug.
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
	/**
	 * The registered device this leg authenticated as, when the SIP edge named one.
	 *
	 * Read only by the Kari's Law notification, which is the one consumer for whom "which handset"
	 * is a dispatch address rather than an inventory detail. Absent on a trunk leg, an
	 * API-originated one, and an edge that predates the field.
	 */
	readonly deviceId?: string;
	/**
	 * The bridge this leg is in, or `undefined` once something has taken it out of one.
	 *
	 * Read by the peer-hangup watcher and nowhere else, and it has to be read there: park and a
	 * shared-line recall move this leg out of its bridge and then end the leg on the other side, and
	 * a watcher that acted on the second half without checking the first hung up a caller a feature
	 * had already taken over.
	 */
	readonly bridgeId: string | undefined;
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
/**
 * Hands the A-leg to a named external application — the `application` destination.
 *
 * ## Why a seam, and why it is the ONLY one shaped like this
 *
 * Every other port here answers a question and returns. This one takes the call away: from the
 * moment it is entered until the promise settles, something outside this process is deciding what
 * the caller hears. That is the destination's whole meaning, and it is why the node awaits rather
 * than dispatching — a walk that carried on would run the plan's failover path underneath a live
 * conversation.
 *
 * The runtime is `apps/engine/src/session/application-sessions.ts`. It is a PORT here, and optional,
 * for the reason every optional dependency on this interface is: a spec about an IVR should not have
 * to stand up a broker, and an engine with no control plane reachable should announce rather than
 * hang, which is exactly what its absence produces.
 */
export interface WalkerApplicationPort {
	run(request: {
		readonly application: string;
		readonly arguments?: Readonly<Record<string, string>>;
	}): Promise<
		| { readonly kind: "unavailable"; readonly reason: string }
		| { readonly kind: "hangup"; readonly cause: HangupCause }
		| { readonly kind: "aborted" }
	>;
}

/** What a queued caller's stay produced, as the CDR records it. */
export interface WalkerQueueOutcome {
	readonly queueId: string;
	readonly waitMs: number;
	readonly outcome:
		| "answered"
		| "caller-hangup"
		| "timeout"
		| "overflow"
		| "no-agents"
		| "exit-key"
		| "callback";
	/** The `queue_agent` who took the call. Only ever set on `answered`. */
	readonly agentId?: string;
}

/**
 * Which authorisation code opened an outbound route, as the CDR records it.
 *
 * Never the digits — see {@link PlanWalkerDependencies.onPinAuthorization}. The `ordinal` is the
 * identity a tenant chose in a form ("code 3, the night desk"), which is why it is a value and not
 * a row position, and the `label` is the same fact in words for a report that has no set to join
 * against.
 */
export interface PinAuthorization {
	readonly pinSetId: string;
	readonly pinSetEntryId: string;
	readonly ordinal: number;
	readonly label?: string;
}

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
	/**
	 * Re-enters routing for a number this walk decided to dial on the caller's behalf — `*69`.
	 *
	 * The walker holds the artifact's whole node table, so it can find an EXTENSION by number
	 * without help; what it cannot do is resolve an arbitrary string, because that needs the number
	 * index and the outbound match table, neither of which travels with a plan. `*69` returning a
	 * mobile is exactly that case, and the alternative to this seam would be the walker inventing a
	 * trunk for a number it read out of a CDR — the toll-fraud boundary, given away by a feature.
	 *
	 * The orchestrator answers it by resolving the digits as if the CALLER had dialled them:
	 * internal first, then outbound, where the toll-class gate, the outbound kill switch and the
	 * call-block screen all apply. So `*69` can never reach somewhere the same handset could not.
	 *
	 * The outcome mirrors a walk's, because that is what happens on the other side: `unresolved`
	 * means nothing matched and the leg is untouched; every other value means a walk ran on this leg
	 * and has already left it wherever it left it.
	 */
	dial(request: { readonly destination: string }): Promise<{
		readonly status: WalkStatus | "unresolved";
		readonly cause?: HangupCause;
		readonly reason?: string;
	}>;
	/**
	 * Joins the A-leg to a conversation somebody else is having — `*0`, and the DTMF escalation
	 * that follows it.
	 *
	 * ## Why this is a seam and not something the walker does itself
	 *
	 * For the same reason `pickup` is. The walker holds a PLAN — one call's node table — and a
	 * supervision request is about a call it has never heard of: finding the live legs of extension
	 * `1001` means scanning the engine's channel registry, which is instance state the walker
	 * deliberately has no handle on. The orchestrator owns that index (it is the same scan
	 * `ringingCandidates` does for `*8`), so it owns this.
	 *
	 * The walker's remaining job is the part that IS routing: reading the argument, refusing without
	 * one, and — before any of this is called — asking whether the caller is allowed. Authorization
	 * happens on the walker's side of the seam on purpose, so that a future caller of `monitor`
	 * cannot reach a tap by skipping the gate.
	 *
	 * ## The outcome is `bridged` or a reason
	 *
	 * `ok` means the supervisor's leg is in a bridge with a tap and the walk is over, exactly as it
	 * is over after a queue answer. Everything else is a string the walk turns into an announcement:
	 * nobody is on a call, the media plane cannot tap, the target hung up during setup. None of them
	 * may end in silence.
	 */
	monitor(request: {
		/** The extension whose conversation is being joined. */
		readonly extension: string;
		/** Where the supervisor starts. Always `eavesdrop` from `*0`; DTMF moves it afterwards. */
		readonly mode: SupervisionMode;
	}): Promise<{ readonly ok: boolean; readonly reason?: string }>;
	/**
	 * Starts recording the conversation the A-leg is in — the seam a queue's record policy reaches.
	 *
	 * Optional on this interface, unlike its siblings, because it arrived with the contact-centre
	 * wave and a walk built against an older control port must keep working: its absence is a queue
	 * that connects the call and notes that it could not record, which is exactly the degradation
	 * every other missing port here produces.
	 *
	 * The same operation the record-toggle feature code performs, deliberately, so that a queue
	 * recording is indistinguishable downstream from an on-demand one — one `channel.record.started`,
	 * one object key, one retention rule, one signed-URL endpoint.
	 */
	startRecording?(request?: {
		/**
		 * PCI's DTMF auto-pause, when the node asking for the recording has its own answer.
		 *
		 * `undefined` is not `false`: it means "this node has no opinion", and the orchestrator falls
		 * back to the destination extension's flag and then to the organization default, which is what
		 * every caller of this port did before the argument existed. A queue has its own column and is
		 * not an extension, so without this its flag was compiled and then read by nothing.
		 */
		readonly autoPauseOnDtmf?: boolean;
		/**
		 * Which way this recording's call is TRAVELLING, when the node asking knows better than the
		 * leg does.
		 *
		 * A handset dialling out has an A-leg the engine labels `internal` — it arrived from a phone,
		 * not from a carrier — so the leg alone cannot tell an internal call from an outbound one, and
		 * the consent policy's outbound rule (announce to the party being CALLED) never fired on the
		 * calls it was written for. A `trunk-dial` node has no such doubt: reaching it is what makes a
		 * call outbound.
		 *
		 * Absent keeps the orchestrator's own reading of the leg, which is what every caller written
		 * before this field asks for.
		 */
		readonly direction?: "inbound" | "outbound";
	}): Promise<{ readonly ok: boolean; readonly reason?: string }>;
}

/**
 * What a supervisor is doing to a call they did not place.
 *
 * Mirrors `TAP_MODES` in `packages/events` rather than importing it, on the same terms the rest of
 * this file mirrors domain vocabularies: the walker's contract is with its own callers, and a type
 * alias here that happened to be structurally identical is exactly what the parity specs are for.
 */
export type SupervisionMode = "eavesdrop" | "whisper" | "barge";

/** What the walker asks the control plane before it lets anybody listen. */
export interface SupervisorAuthzRequest {
	readonly organizationId: string;
	/** The handset that dialled `*0`, as the SIP edge authenticated it. A claim — see the port. */
	readonly extensionNumber: string;
	/** The extension it asked to monitor. Carried so a denial can name what was refused. */
	readonly targetExtension: string;
	/** The supervisor's own call, for correlation in the responder's audit line. */
	readonly callId?: string;
}

export interface SupervisorDecision {
	readonly allowed: boolean;
	/** Why not. For the LOG and the support ticket; never played to the handset. */
	readonly reason?: string;
}

/**
 * The gate in front of `*0`.
 *
 * A port rather than a compiled flag because the answer belongs to the permission model, not to
 * telephony — see `supervisor-authz.source.ts` for the whole argument. Optional on
 * {@link PlanWalkerDependencies} in the sense that a walk built without one REFUSES: there is no
 * "no port, therefore allowed" branch anywhere in this file, and there must never be one.
 */
export interface SupervisorAuthzPort {
	/**
	 * @returns a decision. Implementations do not throw — a failure is a DENIAL, because the
	 * alternative is a broker outage during which anyone may listen to anything.
	 */
	authorize(request: SupervisorAuthzRequest): Promise<SupervisorDecision>;
}

/** Deployment-shaped knobs. All of them have defaults; none of them is a routing decision. */
export interface PlanWalkerSettings {
	/** The Stasis application originated legs are handed to. Must match the engine's `ARI_APP`. */
	readonly application: string;
	/** How an extension NUMBER becomes an endpoint. `{number}` is substituted. */
	readonly extensionDialTemplate: string;
	/** How a trunk attempt becomes an endpoint. `{number}` and `{trunk}` are substituted. */
	readonly trunkDialTemplate: string;
	/**
	 * The tenant's SIP realm, used to build an extension `{kind:"aor"}` {@link DialTarget} — `apps/sipd`
	 * resolves `sip:{number}@{realm}` against the `registrations` it owns. Absent on the Asterisk plane
	 * (`endpoint` alone dials there) and — until a per-org realm is threaded from the tenant's `sip`
	 * settings — absent on the `sipd` plane too, in which case an extension B-leg carries no `target` and
	 * the composite refuses `originate` by name rather than dialling a URI it cannot resolve.
	 */
	readonly sipRealm?: string;
	/** Ring time when neither the node nor the member specifies one. */
	readonly defaultRingTimeoutSeconds: number;
	/**
	 * How long an originated leg has to show PROGRESS before it is given up on (`progress_timeout`).
	 *
	 * Progress is 180/183 — the far end acknowledging that something is ringing. It is a different
	 * fact from an answer, and a much earlier one: a carrier that has accepted the INVITE and then
	 * gone silent will sit there for the whole ring timeout and hand a sequential ladder its
	 * `NO_ANSWER` thirty seconds late, by which point the caller has hung up. A trunk that is
	 * black-holing calls is exactly this shape, and it is the case failover exists for.
	 *
	 * `0` disables it, which is the default: a deployment whose media server does not republish
	 * ringing for originated legs would otherwise cancel every call it makes. Turn it on with
	 * `ENGINE_PROGRESS_TIMEOUT_SECONDS` once ringing is known to arrive.
	 */
	readonly progressTimeoutSeconds: number;
	/** How long to wait for the A-leg's `Up` after issuing `answer`. */
	readonly answerTimeoutMs: number;
	/** Hard budget on nodes visited in one walk. A cycle hits it instead of running forever. */
	readonly maxPlanSteps: number;
	readonly recordingFormat: string;
	/** Played before a voicemail recording starts, when the box has no greeting of its own. */
	readonly voicemailGreeting: string;
	/** Played for the node kinds this slice does not implement. */
	readonly unavailableAnnouncement: string;
	/**
	 * Played when a feature code SWITCHED SOMETHING ON, and its opposite when it switched it off.
	 *
	 * Two announcements rather than one confirmation tone, because a bare `*72` is a TOGGLE and the
	 * caller pressed the same digits either way: a single beep would leave them with no idea whether
	 * their calls now go to their mobile or back to their desk, which is precisely the question they
	 * dialled the code to settle. `activated` and `de-activated` are in Asterisk's core sound
	 * package — the same standard the PIN prompts hold to — so this works on a stock install with no
	 * prompt pack.
	 */
	readonly featureActivatedAnnouncement: string;
	readonly featureDeactivatedAnnouncement: string;
	/**
	 * Played to a caller who dialled `*43`, before the echo starts.
	 *
	 * A prompt rather than dropping straight into echo, because an echo test with no preamble is
	 * indistinguishable from a broken call: the caller hears themselves a beat later and assumes the
	 * line is faulty. `demo-echotest` is Asterisk's own wording for exactly this and ships with the
	 * core sounds; a deployment with no such file gets a failed playback, which is noted and does not
	 * stop the echo.
	 */
	readonly echoTestPrompt: string;
	/** Longest greeting `*99` will record. Beyond it the recording is closed and filed as it stands. */
	readonly greetingMaxSeconds: number;
	/** Played after `*99` has filed a greeting, so the user knows it took. */
	readonly greetingRecordedAnnouncement: string;
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
	/**
	 * Asked for before a pin-gated OUTBOUND route is dialled.
	 *
	 * `agent-pass` is Asterisk's own "please enter your password" and is in the core sound package,
	 * so an authorisation-code gate works on a stock install with no prompt pack — the same standard
	 * the mailbox and room PIN prompts hold to. A PIN set that carries its own `promptId` overrides
	 * it, which is what a tenant who recorded "please enter your international calling code" gets.
	 */
	readonly outboundPinPrompt: string;
	/** Played after a wrong authorisation code, before the next attempt. */
	readonly outboundPinInvalidPrompt: string;
	/** Played when the attempts are exhausted, before the call is refused. */
	readonly outboundPinFailurePrompt: string;
	/**
	 * Longest authorisation code that will be collected.
	 *
	 * The ATTEMPT budget is not here: it is `CompiledPinSet.maxAttempts`, per set, because how many
	 * guesses an international-calling code is worth is a tenant's decision and they made it in a
	 * form. The digit timeout is per set too (`digitTimeoutMs`). Only the ceiling on how many digits
	 * a code may be is a platform fact, and it exists so a caller leaning on a key cannot make the
	 * gather run forever.
	 */
	readonly outboundPinMaxDigits: number;
	readonly outboundPinInterDigitTimeoutMs: number;
	/**
	 * Attempts at a hot-desk PIN before the code is refused, and how long each one may take.
	 *
	 * Its own budget rather than a PIN set's, and that is the difference from the outbound gate: the
	 * set that gates a login is chosen by the ADMINISTRATOR who configured the extension, not by the
	 * agent standing at the desk, and the walk does not know which set it will be until the
	 * responder has looked at the extension. So the budget is the platform's — three tries, the
	 * universal telephone answer — and the set's own `maxAttempts` governs the route it was made for.
	 */
	readonly hotDeskPinAttempts: number;
	readonly hotDeskPinTimeoutMs: number;
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
	/**
	 * Played when a moderator has LOCKED the room.
	 *
	 * A different prompt from {@link conferenceFullAnnouncement}, and a different sound file, because
	 * they ask the caller to do opposite things: a full room admits them the moment somebody leaves,
	 * and a locked one does not admit them until the meeting is over. `conf-locked` is Asterisk's own
	 * word for exactly this state, which is why the FULL announcement is the one that had to move —
	 * it was borrowing this prompt while there was nothing to lock.
	 */
	readonly conferenceLockedAnnouncement: string;
	/**
	 * Beeped INTO the room when a participant joins, and its partner when one leaves.
	 *
	 * `tone:` and not `sound:`, and that is the whole reason these can be defaulted at all: a tone is
	 * GENERATED, so a stock deployment with no prompt pack still beeps. `mediad` synthesises it and
	 * Asterisk has a tone zone; neither needs a file mounted.
	 */
	readonly conferenceEntryTone: string;
	readonly conferenceExitTone: string;
	/**
	 * Played to the room around a name announcement, when `announceJoinLeave` is on.
	 *
	 * The NAME itself is not here, and its absence is the honest half of this feature: announcing who
	 * joined needs a recording of the participant saying their name, which needs a record-and-hold
	 * step at the gate and a place to keep the clip for the life of the room. This release plays the
	 * generic form — "someone has joined the conference" — which is what every stock prompt package
	 * ships and what an operator can act on. The per-participant recording is named as the seam in
	 * `conferenceNode`.
	 */
	readonly conferenceJoinAnnouncement: string;
	readonly conferenceLeaveAnnouncement: string;
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
	/**
	 * Asked of a leg that has to CONFIRM before it may be bridged.
	 *
	 * `screen-callee-options` is Asterisk's own call-screening prompt and is in the core sound
	 * package — it opens with "dial 1 if you wish this call to be answered", which is the question
	 * being asked, so a stock install confirms without a prompt pack. A deployment with a recorded
	 * "press 1 to accept this call" points `ENGINE_CONFIRM_PROMPT` at it; a ring group with a
	 * `confirmPromptId` of its own overrides both.
	 */
	readonly confirmPrompt: string;
	/** The one digit that accepts. Anything else is a decline. */
	readonly confirmAcceptDigit: string;
	/** Prompts a confirming leg hears before it is given up on. */
	readonly confirmAttempts: number;
	/** How long one prompt waits for a digit. Long: a mobile's speaker has to reach an ear first. */
	readonly confirmTimeoutMs: number;
	/**
	 * How long an intercom's auto-answered leg has to come up before the code gives up.
	 *
	 * Much shorter than an ordinary ring timeout, and that is the point: an intercom that has not
	 * auto-answered within a few seconds is a handset that is NOT configured to auto-answer, and what
	 * the caller wants then is to be told so, not to stand there listening to a phone ring across the
	 * office. Five seconds is roughly two rings — long enough to cover a slow re-registration, short
	 * enough that the failure is obviously a failure.
	 */
	readonly intercomTimeoutSeconds: number;
	/**
	 * Whether the CALL SCREENING runtime runs at all. Default `false`, deliberately.
	 *
	 * The plumbing is complete — `ExtensionPlanNode.callScreening` is compiled, read, and honoured in
	 * the documented precedence chain — and the runtime behind this flag is honest but partial; the
	 * remaining seams are named on {@link PlanWalker.screenCall}. Shipping it default-ON would put
	 * fifteen seconds of "record your name" on the front of every external call to every extension a
	 * tenant happened to have ticked the box for, and the first person to find out would be a
	 * customer. Default-OFF means a tenant who ticked the box gets what they got before (the phone
	 * rings), which is the safe half of the difference, and a deployment that wants to try the
	 * feature turns it on knowing what is missing.
	 */
	readonly callScreeningEnabled: boolean;
	/**
	 * Asked of an external caller before their name is recorded.
	 *
	 * `vm-rec-name` is Asterisk's own "record your name after the tone" prompt and is in the core
	 * sound package, so screening works on a stock install with no prompt pack — the same standard
	 * the PIN and confirmation prompts hold to.
	 */
	readonly screeningRecordPrompt: string;
	/** Longest name a screened caller may record before the recording is closed as it stands. */
	readonly screeningRecordSeconds: number;
	/**
	 * Played to the CALLEE immediately before the recorded name.
	 *
	 * `priv-callerintros` is Asterisk's own "call from" fragment, which is exactly the sentence being
	 * assembled: this prompt, then the caller's own voice, then the accept/reject question.
	 */
	readonly screeningIntroPrompt: string;

	// --- dial by name ----------------------------------------------------------------------------
	/**
	 * The directory's opening prompt, when the node names none of its own.
	 *
	 * Every default in this block is one of `app_directory`'s own sounds, for the reason every other
	 * default in this file is a core sound: a tenant who switched dial-by-name on and recorded
	 * nothing still gets a working directory rather than silence with a gather behind it.
	 */
	readonly directoryGreeting: string;
	/** Played before each RETRY. `dir-instr` is "enter the first letters of the name". */
	readonly directoryInstructions: string;
	/** Played when the digits match nobody, when the node names no prompt of its own. */
	readonly directoryNoMatchPrompt: string;
	/**
	 * The two halves of "please press 1 to select this person", and the digit between them.
	 *
	 * Three settings for one sentence because the verb surface plays ONE media per `play`, and
	 * Asterisk assembles this sentence from `dir-multi1` + the spoken digit + `dir-multi2`. Building
	 * it the same way means the accept digit can be changed without re-recording anything: the
	 * spoken digit is rendered as `digits:<n>`, which is a GENERATED media the media server
	 * synthesises, so there is no file to be missing.
	 */
	readonly directorySelectPrefix: string;
	readonly directorySelectSuffix: string;
	/** The one digit that connects. Anything else moves on to the next match. */
	readonly directorySelectDigit: string;
	/** Longest name-spelling a caller may enter before the gather closes. */
	readonly directoryMaxDigits: number;
	readonly directoryTimeoutMs: number;
	readonly directoryInterDigitTimeoutMs: number;
	/** How long one offered name waits for its accept digit. Short: the caller is listening for it. */
	readonly directorySelectTimeoutMs: number;
	/**
	 * How many matching people are offered before the caller is asked to spell more.
	 *
	 * A bound rather than the whole list, because a caller who typed `S` in a company of four
	 * hundred should be asked for more letters, not read four hundred names. The compiler cannot
	 * make this decision — it does not know how long the audience will listen — so it compiles every
	 * entry and this decides how many of them one round offers.
	 */
	readonly directoryMaxOffers: number;

	readonly mediaRefs: MediaRefSettings;
}

export const DEFAULT_PLAN_WALKER_SETTINGS: PlanWalkerSettings = {
	application: "optimiq-engine",
	extensionDialTemplate: "PJSIP/{number}",
	trunkDialTemplate: "PJSIP/{number}@{trunk}",
	defaultRingTimeoutSeconds: 30,
	progressTimeoutSeconds: 0,
	answerTimeoutMs: 10_000,
	maxPlanSteps: 64,
	recordingFormat: "wav",
	voicemailGreeting: "sound:unavailable",
	unavailableAnnouncement: "sound:unavailable",
	// `activated`, `de-activated` and `demo-echotest` are all in Asterisk's core sound package, so
	// the feature codes confirm themselves on a stock install with no prompt pack — the same
	// standard the PIN and confirmation prompts hold to.
	featureActivatedAnnouncement: "sound:activated",
	featureDeactivatedAnnouncement: "sound:de-activated",
	echoTestPrompt: "sound:demo-echotest",
	// A minute. A greeting people actually listen to is fifteen seconds; the cap is there to stop a
	// forgotten handset writing an hour of room noise into the media store, not to shape the message.
	greetingMaxSeconds: 60,
	greetingRecordedAnnouncement: "sound:activated",
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
	outboundPinPrompt: "sound:agent-pass",
	outboundPinInvalidPrompt: "sound:auth-incorrect",
	outboundPinFailurePrompt: "sound:auth-thankyou",
	outboundPinMaxDigits: 12,
	outboundPinInterDigitTimeoutMs: 3_000,
	hotDeskPinAttempts: 3,
	hotDeskPinTimeoutMs: 10_000,
	conferencePinPrompt: "sound:conf-getpin",
	conferencePinInvalidPrompt: "sound:conf-invalidpin",
	conferencePinAttempts: 3,
	conferencePinMaxDigits: 10,
	conferencePinTimeoutMs: 10_000,
	conferencePinInterDigitTimeoutMs: 3_000,
	// `conf-full` and `conf-locked` are both in Asterisk's core sound package, and they were one
	// prompt until there was something to lock: the FULL announcement used to borrow `conf-locked`,
	// which told a caller the meeting was closed when it was merely busy.
	conferenceFullAnnouncement: "sound:conf-full",
	conferenceLockedAnnouncement: "sound:conf-locked",
	// GENERATED, not files. See the fields: a tone needs no prompt pack, so the beeps work on a
	// stock install of either media plane.
	conferenceEntryTone: "tone:beep",
	conferenceExitTone: "tone:beep",
	// `conf-hasjoin` and `conf-hasleft` are the stock generic forms. See the fields for why the
	// per-participant recording is not in this release.
	conferenceJoinAnnouncement: "sound:conf-hasjoin",
	conferenceLeaveAnnouncement: "sound:conf-hasleft",
	// Ten minutes. Long enough that a moderator who is late still finds their meeting, short
	// enough that a forgotten leg does not hold a channel until the process restarts.
	conferenceModeratorWaitMs: 600_000,
	conferenceClaimPollMs: 2_000,
	confirmPrompt: "sound:screen-callee-options",
	confirmAcceptDigit: "1",
	confirmAttempts: 2,
	confirmTimeoutMs: 15_000,
	intercomTimeoutSeconds: 5,
	// OFF. See the field.
	callScreeningEnabled: false,
	// `vm-rec-name` and `priv-callerintros` are both in Asterisk's core sound package.
	screeningRecordPrompt: "sound:vm-rec-name",
	screeningRecordSeconds: 5,
	screeningIntroPrompt: "sound:priv-callerintros",
	directoryGreeting: "sound:dir-intro",
	directoryInstructions: "sound:dir-instr",
	directoryNoMatchPrompt: "sound:dir-nomatch",
	directorySelectPrefix: "sound:dir-multi1",
	directorySelectSuffix: "sound:dir-multi2",
	directorySelectDigit: "1",
	directoryMaxDigits: 10,
	directoryTimeoutMs: 10_000,
	directoryInterDigitTimeoutMs: 3_000,
	directorySelectTimeoutMs: 5_000,
	directoryMaxOffers: 5,
	mediaRefs: DEFAULT_MEDIA_REF_SETTINGS,
};

/** Everything the walker talks to. All ports, so a spec supplies four closures and a fake. */
export interface PlanWalkerDependencies {
	readonly media: MediaPort;
	readonly signals: CallSignalBus;
	readonly channel: WalkerChannel;
	/** Runs one verb. `undefined` means the verb failed — the walk treats that as fatal. */
	readonly execute: (verb: Verb) => Promise<VerbResult | undefined>;
	/**
	 * Why the most recent {@link execute} answered `undefined`, when the host kept the reason.
	 *
	 * `undefined` is all the walk needs to DECIDE — the verb did not run, the call cannot proceed —
	 * but it is not what an operator needs to READ. The live stack made the difference concrete: a
	 * `mediad refused start-playback … no such prompt: sound:moh/default` produced an IVR that fell
	 * to its timeout branch after forty-eight seconds of silence, and every artefact a human would
	 * look at afterwards — the CDR, the call's notes — said only that the caller pressed nothing.
	 *
	 * Optional because a spec that supplies four closures should not have to supply five, and
	 * because a host with no failure detail is honestly represented by having none.
	 */
	readonly verbFailure?: () => string | undefined;
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
	 * Where `*99` files the greeting it just recorded.
	 *
	 * Absent means `*99` announces "not available" and records NOTHING — deliberately in that order.
	 * A code that answered, played a beep, took thirty seconds of somebody's voice and then had
	 * nowhere to put it would leave the user believing their greeting is live, which is a worse
	 * outcome than the announcement and is discovered by the first caller who reaches the mailbox.
	 */
	readonly greetings?: VoicemailGreetingPort;
	/**
	 * Where `*72`, `*74`, `*76`, `*78` and `*21` send the change they were dialled to make.
	 *
	 * Absent means those codes announce and hang up exactly as they did before this wave. It is a
	 * port rather than a direct RPC call for the reason `mailbox` is: "no responder" is a state these
	 * runtimes have to handle correctly, so it must be as easy to write a test for as a success is.
	 */
	readonly features?: ExtensionFeaturePort;
	/** The organization-wide toggles behind `*65` and `*64`. Absent means both announce. */
	readonly toggles?: ToggleFeaturePort;
	/**
	 * Hot desking, behind `*31` and `*32`. Absent means both announce.
	 *
	 * Absence is a degradation and not a refusal, unlike {@link supervision}: a handset that cannot
	 * log in is a handset that stays on its own extension, which is where it started.
	 */
	readonly hotDesk?: HotDeskPort;
	/** Where `*69` asks who rang. Absent means the code announces, exactly as it did before. */
	readonly lastCaller?: LastCallerSource;
	/**
	 * The gate in front of `*0`.
	 *
	 * Optional in the same shape as its neighbours and NOT in the same spirit. Every other optional
	 * port here degrades to "the feature announces and hangs up"; this one degrades to the same
	 * announcement for the opposite reason. Absent does not mean "supervision is unconfigured, so
	 * allow it" — it means the engine has no way to establish that this handset may listen to
	 * somebody else's conversation, and the only safe reading of that is no.
	 *
	 * Written down here because it is the one place in this file where "port is undefined" must be a
	 * DENIAL rather than a degradation, and the next person adding a supervision path will read this
	 * declaration before they read the runtime.
	 */
	readonly supervision?: SupervisorAuthzPort;
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
	 * Shared-line seizure, bound to the A-leg's walk.
	 *
	 * Optional for the same reason `conferences` is, and with the same fallback: without it a
	 * `shared-line` node announces and hangs up, which is what it did before this wave. Typed as a
	 * PORT rather than as `SharedLineRegistry` so a spec can seize and lose without a KV bucket —
	 * the registry satisfies it structurally.
	 */
	readonly sharedLines?: SharedLinePort;
	/**
	 * Park lots and call pickup, bound to the A-leg.
	 *
	 * Optional for the same reason `queue` and `conferences` are: a spec about an IVR should not have
	 * to stand up a park registry, and without it a `park` node or a pickup code announces and hangs
	 * up exactly as it did before this wave.
	 */
	readonly control?: WalkerCallControl;
	/**
	 * The session protocol, for the `application` destination.
	 *
	 * Absent means an `application` node announces and hangs up with `FACILITY_NOT_IMPLEMENTED`,
	 * which is what it did for every wave before this one and is still the right answer on a
	 * deployment with no broker: the destination exists, nothing can serve it, and the caller is
	 * told rather than left listening.
	 */
	readonly application?: WalkerApplicationPort;
	/**
	 * Told the moment the walk ENTERS a destination-bearing node, rather than once it is over.
	 *
	 * The timing is the whole point, and it is a correctness fix rather than an optimisation. A walk
	 * that ends in a hangup — a queue nobody is staffing, an IVR out of retries, a closed time
	 * condition — hangs the leg up from inside {@link PlanWalker.walk}. The media server's
	 * `ChannelDestroyed` then races the walk's own return: whichever wins, the CDR is written by the
	 * hangup path, and if it wins the record says `destinationType: "unknown"` for a caller who
	 * demonstrably reached a queue. Reporting the destination on ENTRY closes the window, because by
	 * then the leg is still up and no teardown has started.
	 *
	 * It is also what makes the mirrored snapshot true mid-call: a leg sitting in a queue for four
	 * minutes now names the queue in the `channels` bucket, so an instance that picks it up after a
	 * failover writes the same CDR this one would have.
	 *
	 * Called once per destination-bearing node the walk enters, never with the same destination
	 * twice in a row.
	 */
	readonly onDestination?: (destination: PlanDestination) => Promise<void>;
	/**
	 * Run when a queued caller's stay ends, however it ends.
	 *
	 * Symmetric with {@link onDestination} and reported at the same moment for the same reason: the
	 * walk may hang the leg up immediately afterwards (a queue with no timeout branch does exactly
	 * that), and `ChannelDestroyed` races the walk's own return. A caller who demonstrably waited
	 * four minutes and abandoned must not be filed with no wait and no outcome because the teardown
	 * won.
	 *
	 * What it reports is the QUEUE's verdict, not the leg's. A caller the queue timed out into a
	 * voicemail box has a leg that ends `answered` and a queue outcome of `timeout`, and an SLA built
	 * on the disposition would call that a served call.
	 */
	readonly onQueueOutcome?: (outcome: WalkerQueueOutcome) => Promise<void>;
	/**
	 * Run when an authorisation code has opened an outbound route, before the first trunk is offered.
	 *
	 * Reported on SUCCESS only, and reported at the moment of success for exactly the reason
	 * {@link onDestination} is: the call is about to be dialled and may end in any number of ways,
	 * and a CDR written by whichever of teardown and return gets there first must already know which
	 * code paid for it. A refusal is not reported here because a refused call did not spend anything
	 * — it appears in the walk's notes and in the leg's hangup cause, which is where "somebody tried
	 * three wrong codes" belongs.
	 *
	 * The ORDINAL and the LABEL, never the digits. That is the whole point of hashing a PIN in the
	 * first place: the record has to answer "who authorised this call to Paraguay" and must not be a
	 * place to go looking for a code to reuse.
	 */
	readonly onPinAuthorization?: (authorization: PinAuthorization) => Promise<void>;
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
	/**
	 * `[0,1)`, for the one decision in the walk that is deliberately not deterministic: how a
	 * weighted trunk tier is sampled (`trunk-selection.ts`). Injected for the same reason
	 * `queueSettings.random` is — a spec that asserts a share cannot roll dice.
	 */
	readonly random?: () => number;
	readonly log?: (message: string, detail?: Record<string, unknown>) => void;
	/**
	 * The per-trunk concurrent-call ceiling, or absent when this deployment does not enforce one.
	 *
	 * Absent means a trunk's `maxChannels` is read and ignored, which is what every release before
	 * this one did — so a walker spec that is not about capacity does not have to supply one.
	 */
	readonly trunkCapacity?: TrunkCapacityPort;
	/**
	 * The spend, velocity and geo gate on outbound trunk dials, or absent when this deployment does
	 * not enforce one.
	 *
	 * Absent means an organization's `tollFraud` policy is read and ignored, which is what every
	 * release before this one did — so a walker spec that is not about toll fraud does not have to
	 * supply one.
	 */
	readonly tollFraudGuard?: TollFraudGuardPort;
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

/** A greeting a user has just recorded over `*99`, on its way to their mailbox. */
export interface RecordedGreeting {
	/**
	 * The tenant.
	 *
	 * On the request rather than closed over by the port, unlike {@link VoicemailMessage} — the
	 * difference is what the two ports ARE. The voicemail sink is built per call
	 * (`voicemailPortFor(aggregate)`), so it already knows whose call it is; this one is a
	 * process-wide singleton over the shared rpc client, exactly like {@link ExtensionFeaturePort}
	 * and {@link LastCallerSource}, and every one of those carries its tenant in the call.
	 */
	readonly organizationId: string;
	readonly voicemailBoxId: string;
	readonly mailboxNumber: string;
	/** Minted by the walker, so a redelivered publish files one greeting rather than two. */
	readonly greetingId: string;
	readonly recordingId: string;
	readonly objectKey: string;
	readonly durationMs: number;
	/**
	 * Which greeting was recorded.
	 *
	 * `unavailable` and nothing else, because `*99` is one code: which of a box's greetings a code
	 * records is a product decision the CATALOGUE would have to express (a second code, or an
	 * argument), and the catalogue says `voicemail-record-greeting` takes no argument. The field is
	 * here rather than implied so the day a `*99` variant is added, the consumer does not have to
	 * guess what the existing one meant.
	 */
	readonly kind: "unavailable";
	/** The call the greeting was recorded on. Logging correlation only. */
	readonly callId?: string;
}

/**
 * Where `*99` files what it recorded.
 *
 * A port, on the same terms as {@link VoicemailPort}: the greeting has to become a
 * `voicemail_greeting` row and an ACTIVE one, which is a two-row write inside a recompile that only
 * the control plane can make (see `voicemail-greetings.service.ts`). The engine records the audio
 * and says so; it never files a row.
 */
export interface VoicemailGreetingPort {
	/** @throws when the greeting could not be filed. The walk announces rather than confirming. */
	greetingRecorded(greeting: RecordedGreeting): Promise<void>;
}

/** One feature change a handset asked for. `feature` is the contract's own vocabulary. */
export interface ExtensionFeatureChange {
	readonly organizationId: string;
	/** The CALLING extension's number — the same identity `*97` opens a mailbox with. */
	readonly extensionNumber: string;
	readonly feature: ExtensionFeature;
	readonly enabled: boolean;
	/** Where to forward, for the three forwarding features. Ignored by DND and follow-me. */
	readonly destination?: string;
	readonly callId?: string;
}

/**
 * What came back.
 *
 * `applied` is the only field the walk branches on, and the separation from `enabled` is the point:
 * "nothing was written" and "it is now off" are different things to say to somebody, and a runtime
 * that read `enabled` alone would play the de-activation announcement for a refusal.
 */
export interface ExtensionFeatureOutcome {
	readonly applied: boolean;
	/** The state AFTER the write. Only meaningful when `applied`. */
	readonly enabled: boolean;
	readonly destination?: string;
	readonly reason?: string;
}

/**
 * Where a feature code sends the change it was dialled to make.
 *
 * A port for the reason {@link VoicemailMailboxSource} is one: a spec should not need a broker, and
 * "no responder" is a path these runtimes must get right — a caller who is told nothing assumes
 * forwarding is on, and the person who rings them afterwards is the one who finds out it is not.
 */
export interface ExtensionFeaturePort {
	/**
	 * @throws when the port could not be reached at all. The walk catches it and treats it exactly as
	 * `applied: false`.
	 */
	apply(change: ExtensionFeatureChange): Promise<ExtensionFeatureOutcome>;
}

/**
 * Shared-line seizure, as a walk consumes it.
 *
 * Structurally what `SharedLineRegistry` already offers, declared here so the walker depends on the
 * two operations a WALK can perform rather than on the class: a walk seizes the line for whichever
 * appearance answered, and frees it when the seizure it took cannot become a call. Hold, retrieve
 * and recall are MID-CALL — they happen after the bridge, on events the orchestrator owns — and are
 * deliberately absent from this port for that reason.
 */
export interface SharedLinePort {
	seize(
		orgId: string,
		sharedLineId: string,
		seizing: {
			readonly extensionId: string;
			readonly appearanceIndex: number;
			readonly callId: string;
			readonly legId: string;
		},
	): Promise<
		| { readonly won: true; readonly revision: number }
		| {
				readonly won: false;
				readonly heldBy?: { readonly heldByExtensionId?: string };
				readonly reason?: string;
		  }
	>;
	/** Frees a seizure THIS instance took. The registry knows which instance it is; a walk does not. */
	releaseOwn(orgId: string, sharedLineId: string): Promise<boolean>;
	/**
	 * Picks a HELD line up on the leg being walked, continuing the conversation on this phone.
	 *
	 * The one mid-call operation a walk can reach, and it is here rather than in `apps/engine/src/calls`
	 * alone because dialling the line's own number from a second appearance is how a person asks for
	 * it — which arrives as a WALK. Everything it does happens on the other side of this port, in
	 * `CallControl.retrieveSharedLine`.
	 *
	 * Optional, because the port an older deployment (or a spec about the ring-out half) supplies has
	 * no mid-call seam at all. Absent, a held line is refused exactly as a seized one is.
	 */
	retrieve?(
		orgId: string,
		sharedLineId: string,
	): Promise<{ readonly retrieved: boolean; readonly reason?: string }>;
	/** What this instance currently holds on the line, when it holds anything. */
	held(
		orgId: string,
		sharedLineId: string,
	): { readonly state?: string; readonly heldByExtensionId?: string } | undefined;
}

/** Which organization-wide switch `*65` / `*64` was dialled to flip. */
export interface ToggleFeatureChange {
	readonly organizationId: string;
	readonly target: "call-flow" | "time-condition";
	/** Set when `target` is `call-flow`. Compiled into the code's node as `params.callFlowId`. */
	readonly callFlowId?: string;
	/** Set when `target` is `time-condition`. Compiled as `params.timeConditionId`. */
	readonly timeConditionId?: string;
	/** The extension that dialled, when the walk knows it. For the audit trail only. */
	readonly extensionNumber?: string;
	readonly callId?: string;
}

export interface ToggleFeatureOutcome {
	readonly applied: boolean;
	/** The state it landed on — `day`/`night`, or one of the three overrides. For the note. */
	readonly state?: string;
	readonly reason?: string;
}

/**
 * Where a `*65` or `*64` sends the flip it was dialled to make.
 *
 * A second port beside {@link ExtensionFeaturePort} rather than a sixth member of its feature enum,
 * for the reason `RPC_SUBJECTS.pbxToggleFeature` gives: one changes a column on the caller's own
 * extension and the other changes what every caller to the tenant hears, so they are different
 * grants at the broker and a shared port would make them one.
 */
export interface ToggleFeaturePort {
	/**
	 * @throws when the port could not be reached at all. The walk catches it and treats it exactly as
	 * `applied: false`.
	 */
	toggle(change: ToggleFeatureChange): Promise<ToggleFeatureOutcome>;
}

/** Which half of hot desking `*31` / `*32` was dialled, and the credentials for it. */
export interface HotDeskChange {
	readonly organizationId: string;
	readonly action: "login" | "logout";
	/**
	 * The handset, as the SIP edge authenticated it — `WalkerChannel.deviceId`, which the
	 * orchestrator reads off the leg's `OPTIMIQ_DEVICE_ID` variable and sipd sets from the digest
	 * credential it resolved. NOT a claim, and not derivable from the calling number: the whole
	 * premise of hot desking is that the phone is not the caller's.
	 */
	readonly deviceId: string;
	/** The extension being claimed, as dialled after the code. Set for `login`. */
	readonly extensionNumber?: string;
	/** The digits gathered at the challenge. Set for `login`, and never logged. */
	readonly pin?: string;
	readonly callId?: string;
}

export interface HotDeskOutcome {
	readonly applied: boolean;
	/** The extension the line is bound to now, for the note. */
	readonly extensionNumber?: string;
	/** When the session lapses, ISO 8601. Absent on a logout and on a refusal. */
	readonly expiresAt?: string;
	readonly reason?: string;
}

/**
 * Where a `*31` or `*32` sends the rebind it was dialled to make.
 *
 * A third port beside {@link ExtensionFeaturePort} and {@link ToggleFeaturePort}, for the reason
 * `RPC_SUBJECTS.pbxHotDesk` gives: this one carries a PIN, so it has to be grantable — and
 * refusable — at the broker on its own.
 */
export interface HotDeskPort {
	/**
	 * @throws when the port could not be reached at all. The walk catches it and treats it exactly as
	 * `applied: false`.
	 */
	apply(change: HotDeskChange): Promise<HotDeskOutcome>;
}

/** What `*69` asks. */
export interface LastCallerLookup {
	readonly organizationId: string;
	readonly extensionNumber: string;
	readonly callId?: string;
}

/**
 * Who rang last.
 *
 * `found: true` with no `callerNumber` is the WITHHELD caller and is deliberately not a miss: there
 * was a call, and there is nothing to dial. The walk announces both, and the notes tell them apart.
 */
export interface LastCallerResult {
	readonly found: boolean;
	readonly callerNumber?: string;
	readonly callerName?: string;
	/** ISO 8601, for the walk's notes. */
	readonly at?: string;
	readonly reason?: string;
}

export interface LastCallerSource {
	/** @throws when the source could not be reached. The walk treats it as `found: false`. */
	lookup(request: LastCallerLookup): Promise<LastCallerResult>;
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
	originated(leg: OriginatedLeg): void | Promise<void>;
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
	/**
	 * The A-leg has been taken OUT of the bridge and is being kept alive past this peer's end.
	 *
	 * The exact mirror of {@link bridged}, and it exists for one reason: `bridged` stamps each leg
	 * with the other's id, and the orchestrator's own teardown ends whatever that stamp names. A
	 * caller detached for a post-call survey therefore had a BYE sent to them a second later, by the
	 * agent leg's teardown, on the strength of a bridge that no longer existed. Clearing the stamp on
	 * both sides is what park already does through its own path.
	 *
	 * Optional, so a walk built against an older hook set keeps working — such a walk also cannot ask
	 * to keep a leg, so there is never a detached caller for it to strand.
	 */
	unbridged?(mediaChannelId: string): void;
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
	/**
	 * Whether {@link callerIdNumber} is presented to the far end — the extension's standing CLIR
	 * setting, as `ResolvedRoute.callerIdPresentation` carried it.
	 *
	 * Absent means `allowed`. It reaches only TRUNK dials: an on-net leg is inside the tenant, where
	 * withholding the number from a colleague is not what the setting means. A per-call `*67`/`*82`
	 * is NOT here — that override is stamped on the A-leg as {@link CLIR_VARIABLE} and applied by
	 * `SplitPlaneMediaPort`, which is the only layer that sees both the code's leg and the leg the
	 * code went on to dial.
	 */
	readonly callerIdPresentation?: "allowed" | "restricted";
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
	/**
	 * Where this leg is going, in the SIP edge's structured vocabulary — `plans/sipd-invite-design.md`
	 * §5.1. Additive alongside {@link endpoint}, which stays exactly as it is for the ARI adapter: the
	 * `apps/sipd` composite reads `target` and refuses `bad_request` when it is absent, `AriMediaAdapter`
	 * and `MediadMediaPort` ignore it. A `{kind:"trunk"}` is set at the trunk sites where the trunk id is
	 * in hand; an extension `{kind:"aor"}` is derived in {@link PlanWalker.targetFor} from
	 * {@link PlanWalkerSettings.sipRealm} when it is configured AND {@link onNet} says this leg is one.
	 */
	readonly target?: DialTarget;
	/**
	 * Whether this leg reaches a registered handset of THIS tenant, i.e. whether
	 * `sip:{destinationNumber}@{realm}` is a meaningful AOR for it.
	 *
	 * Set only where an extension NUMBER is being dialled. An off-net follow-me hop, an `external`
	 * node and a queue agent whose roster contact is a raw dial string are not AORs: deriving one for
	 * them would send the INVITE at the tenant's registration bucket instead of the trunk the
	 * compiler chose, so they leave this unset and carry an explicit {@link target} or none at all.
	 */
	readonly onNet?: boolean;
	readonly timeoutSeconds: number;
	readonly delaySeconds: number;
	readonly callerId?: string;
	/** CLIR for this leg. Set on trunk attempts only; absent is `allowed` at the SIP edge. */
	readonly callerIdPresentation?: "allowed" | "restricted";
	readonly variables?: Readonly<Record<string, string>>;
	/**
	 * Answer confirmation for this leg. Absent means an answer is an answer.
	 *
	 * Present means the leg has to press a digit before it counts as answered AT ALL — see {@link
	 * PlanWalker.confirmAnswer}. The distinction lives on the attempt rather than on the node so that
	 * one hop of a ladder can confirm and the next one not, which is exactly the configuration the
	 * feature exists for: the desk phone is trusted, the mobile is not.
	 */
	readonly confirm?: ConfirmRequest;
}

/** What one confirming leg is asked, and how long it is given to answer. */
interface ConfirmRequest {
	/**
	 * Media URIs, already translated, played in order as ONE prompt.
	 *
	 * A list rather than a string because call screening asks a question assembled from three pieces
	 * — "call from", the caller's own recorded voice, "press 1 to accept" — and the media server
	 * plays a sequence natively ({@link import("../media/media-port").PlayRequest.media} is already a
	 * list). Concatenating them into one file would mean rendering audio on the call path; issuing
	 * three plays would mean three playback handles, and barge-in would stop one of them.
	 */
	readonly media: readonly string[];
	readonly acceptDigit: string;
	readonly attempts: number;
	readonly timeoutMs: number;
}

/**
 * How a confirmation ended.
 *
 * Only `accepted` may be bridged. Every other value is the leg NOT having answered, and the four of
 * them are kept apart because they land the walk in different places: a declining callee lets the
 * ladder continue, a caller who hung up ends the walk, and a media plane that cannot play the
 * question is a deployment fault somebody has to read in a log.
 */
type ConfirmVerdict =
	/** The accept digit arrived. */
	| "accepted"
	/** Wrong digit or silence, for every attempt. */
	| "declined"
	/** The confirming leg went away mid-question. */
	| "leg-gone"
	/** The CALLER went away. Nothing left to bridge to. */
	| "caller-gone"
	/** The media plane refused to play the question. Fails closed: see {@link PlanWalker.confirmAnswer}. */
	| "unplayable";

/** What ended one round of the question: a digit, silence, or the whole thing being over. */
type ConfirmStep =
	| { readonly kind: "digit"; readonly digit: string }
	| { readonly kind: "timeout" }
	| { readonly kind: "terminal"; readonly verdict: ConfirmVerdict };

type DialOutcome =
	| { readonly kind: "answered"; readonly mediaChannelId: string; readonly index: number }
	| { readonly kind: "failed"; readonly cause: HangupCause; readonly index: number }
	| { readonly kind: "timeout" }
	| { readonly kind: "aborted" };

const MILLIS_PER_SECOND = 1_000;

/**
 * The three tiers of evidence a hangup cause carries about a fan-out, highest first.
 *
 * A race across an extension's contacts produces one cause per contact, and only one of them can be
 * the verdict the caller is told. The ordering is the point:
 *
 * 1. **A decision by the far end.** It rang a phone and a person or their switch said no. This is
 *    the only tier that can honestly end the caller's call, and the one that has to survive a stale
 *    contact failing a moment after it.
 * 2. **The endpoint was reached and the call ran out of time or was withdrawn.** Nobody decided
 *    anything, but something was there.
 * 3. **Everything else** — no registration, no route, a refused originate. The leg never left this
 *    platform, which is the weakest possible evidence about what the callee wanted, and where a dead
 *    contact left behind by a closed browser tab lands.
 */
const FAR_END_DECISION_CAUSES = new Set<HangupCause>([
	"USER_BUSY",
	"CALL_REJECTED",
	"INCOMING_CALL_BARRED",
	"UNALLOCATED_NUMBER",
]);

const FAR_END_REACHED_CAUSES = new Set<HangupCause>([
	"NO_ANSWER",
	"NO_USER_RESPONSE",
	"ALLOTTED_TIMEOUT",
	"PROGRESS_TIMEOUT",
	"ORIGINATOR_CANCEL",
	"LOSE_RACE",
	"NORMAL_CLEARING",
]);

function causeRank(cause: HangupCause): number {
	if (FAR_END_DECISION_CAUSES.has(cause)) {
		return 2;
	}
	return FAR_END_REACHED_CAUSES.has(cause) ? 1 : 0;
}

/**
 * Digits held for a queued caller's exit key before the oldest is dropped.
 *
 * Small on purpose, and much smaller than the leg inbox's 64. This buffer exists for ONE decision —
 * "did they press the exit key?" — which the session asks once a second, so anything past a handful
 * is a caller drumming on the keypad rather than input anybody is going to act on. The leg's own
 * inbox keeps the full history for whatever the caller reaches next; this is a peephole onto it.
 */
const MAX_QUEUE_BUFFERED_DIGITS = 8;

/**
 * The catalogue's action names, mapped onto the contract's feature names.
 *
 * Two vocabularies rather than one, and deliberately: `FeatureCodeAction` is what a TENANT's
 * star-code table can hold (twenty entries, most of which are not extension state at all), and
 * `ExtensionFeature` is the closed set of columns a handset may write. Collapsing them would either
 * put `paging` in a contract that writes extension rows or force the catalogue to be named after
 * the database. The map is where they meet, and a code with no entry here is simply not a feature
 * this RPC can serve.
 */
const FEATURE_FOR_ACTION: Readonly<Record<string, ExtensionFeature | undefined>> = {
	"call-forward-all": "forward-all",
	"call-forward-busy": "forward-busy",
	"call-forward-no-answer": "forward-no-answer",
	"do-not-disturb": "do-not-disturb",
	"follow-me": "follow-me",
};

/**
 * The three codes whose dialled digits are a DESTINATION.
 *
 * `*78` and `*21` take no argument (`FEATURE_CODE_ARGUMENT_MODE` says `none`), so digits after them
 * are not theirs to read — and reading them anyway would make a mis-dialled `*7812` set do-not-
 * disturb "to 12" instead of failing to match anything.
 */
const FORWARD_ACTIONS: ReadonlySet<string> = new Set([
	"call-forward-all",
	"call-forward-busy",
	"call-forward-no-answer",
]);

export class PlanWalker {
	private readonly settings: PlanWalkerSettings;
	private readonly newId: () => string;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly log: (message: string, detail?: Record<string, unknown>) => void;
	private readonly random: () => number;
	private readonly notes: string[] = [];
	private readonly visited: PlanNodeId[] = [];
	private destination: PlanDestination | undefined;
	/**
	 * Closes the queued caller's DTMF watch.
	 *
	 * Set for the life of one queue node, and released by the QUEUE SESSION rather than by the node,
	 * because a post-call survey polls the same source after the caller has been bridged and the
	 * node has returned. See {@link import("../queue/queue-session").QueueCallPort.releaseDigits}.
	 */
	private queueDigitUnwatch: (() => void) | undefined;
	/** `number -> extension node`, built lazily per node table. See {@link extensionNodeFor}. */
	private readonly extensionsByNumber = new WeakMap<
		WalkInput["plan"]["nodes"],
		Map<string, ExtensionPlanNode>
	>();

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
		this.random = deps.random ?? Math.random;
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
			if (destination !== undefined && !sameDestination(this.destination, destination)) {
				this.destination = destination;
				// Awaited: the point of reporting here rather than at the end is that the leg is still
				// up, and a hook that ran after the next node had already hung it up would be back
				// where it started. See `PlanWalkerDependencies.onDestination`.
				await this.deps.onDestination?.(destination);
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
			case "call-flow": {
				return this.callFlowNode(node);
			}
			case "extension": {
				return await this.extensionNode(node, input);
			}
			case "ring-group": {
				return await this.ringGroupNode(node, input);
			}
			case "ivr-menu": {
				return await this.ivrMenuNode(node, input);
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
			case "paging": {
				return await this.pagingNode(node, input);
			}
			case "application": {
				return await this.applicationNode(node);
			}
			case "stream": {
				return await this.streamNode(node);
			}
			case "dial-by-name": {
				return await this.dialByNameNode(node);
			}
			case "shared-line": {
				return await this.sharedLineNode(node, input);
			}
			default: {
				// Unreachable, and now PROVABLY so: `node` is `never` here, and the arm reads its kind
				// back through that type rather than through an `as { kind: string }` cast. The cast was
				// not a formality — it defeated the exhaustiveness check, which is how `shared-line`
				// sat in this arm answering "not implemented yet" for a whole release while its
				// registry was finished (`E2E-routing2.md`). Without the cast, a node kind added to
				// `packages/routing` and not to this switch is a compile error here, which is where it
				// belongs; the arm survives only for an artifact from a NEWER release than this binary,
				// where "announced and hung up, and said so in the notes" is the honest answer.
				this.note(
					`node kind "${(node satisfies never as { readonly kind: string }).kind}" is not implemented yet; announced and hung up`,
				);
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
				this.noteVerbFailure(`playback node "${node.id}" could not play ${media}`);
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
	 * A day/night switch, mid-walk.
	 *
	 * The resolver already applies the switch at the ENTRY point — `followGates` walks call flows
	 * exactly as it walks time conditions — so a plan handed to this walker normally has the gate
	 * behind it. This case is for the other way in: an IVR option, a ring group's timeout or a
	 * call-flow branch that points at another flow, all of which reach one part-way through a walk
	 * where no resolver is left to apply it.
	 *
	 * There is no clock and no state to read: the mode is a COLUMN, compiled into the node, which is
	 * the whole argument `call-flows-schema.ts` makes against keeping it in a live-state bucket. So
	 * this is a branch and nothing more, and a flow flipped after the artifact was compiled is a
	 * recompile away rather than a stale read — the same eventual consistency every other compiled
	 * fact on this walk already has.
	 */
	private callFlowNode(node: Extract<PlanNode, { kind: "call-flow" }>): StepResult {
		this.note(`call flow "${node.label ?? node.callFlowId}" is in ${node.mode} mode`);
		return { kind: "goto", nodeId: node.mode === "day" ? node.dayNodeId : node.nightNodeId };
	}

	/**
	 * Star codes.
	 *
	 * ## What is served here, and what is served by going somewhere else
	 *
	 * A code with a `targetNodeId` has already been resolved by the compiler — a `*5` pinned to one
	 * park lot is the only one today — and is simply followed. Everything else is a RUNTIME, and
	 * they divide into three kinds:
	 *
	 * - **Navigation.** `*97` and `*98` do not need a runtime at all: the artifact's mailbox table
	 *   already names a `check` node and a `leave` node per box, so the code's job is to pick the
	 *   right one and hand the walk over to the voicemail runtime that has served the
	 *   `voicemailCheckPrefix` path since it was written. See {@link voicemailCode}.
	 * - **Call control.** `**<ext>` and `*8` take somebody else's ringing call over.
	 * - **A write, or a read, that only the control plane can make.** The five self-service codes
	 *   (`*72`, `*74`, `*76`, `*78`, `*21`) and `*69` are requests over the broker, because the
	 *   engine holds no database handle. Every one of them announces rather than falling silent when
	 *   nothing answers — a `*78` that quietly did nothing leaves a user believing DND is on, and the
	 *   caller who then rings them is the one who finds out.
	 *
	 * `*43` and `*99` are the two that need the media plane rather than the control plane.
	 *
	 * ## What is still not implemented, and says so
	 *
	 * `record-toggle`, `transfer`, `queue-toggle`, `agent-status` and a `paging` CODE that the
	 * compiler did not point at a `paging` node all announce and add a note. Two of them have
	 * runtimes elsewhere in the engine (mid-call features, the ACD) that this seam is not yet wired
	 * to; the rest have none. Either way the caller is told, which is the whole point of the
	 * announcement.
	 *
	 * `eavesdrop` and `intercom` LEFT this list in this wave — see {@link PlanWalker.eavesdropCode}
	 * and {@link PlanWalker.intercomCode}.
	 */
	private async featureCodeNode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		if (node.targetNodeId !== undefined) {
			return { kind: "goto", nodeId: node.targetNodeId };
		}

		switch (node.action) {
			case "call-pickup":
			case "group-pickup": {
				return await this.pickupCode(node, input);
			}
			case "voicemail-check":
			case "voicemail-direct": {
				return await this.voicemailCode(node, input);
			}
			case "voicemail-record-greeting": {
				return await this.recordGreetingCode(node, input);
			}
			case "call-forward-all":
			case "call-forward-busy":
			case "call-forward-no-answer":
			case "do-not-disturb":
			case "follow-me": {
				return await this.extensionFeatureCode(node, input);
			}
			case "redial": {
				return await this.redialCode(node, input);
			}
			case "echo-test": {
				return await this.echoTestCode(node);
			}
			case "eavesdrop": {
				return await this.eavesdropCode(node, input);
			}
			case "intercom": {
				return await this.intercomCode(node, input);
			}
			case "call-flow-toggle":
			case "time-condition-override": {
				return await this.toggleCode(node, input);
			}
			case "hotdesk-login":
			case "hotdesk-logout": {
				return await this.hotDeskCode(node, input);
			}
			case "caller-id-presentation-restrict":
			case "caller-id-presentation-allow": {
				return await this.callerIdPresentationCode(node, input);
			}
			default: {
				this.note(`feature code ${node.code} (${node.action}) is not implemented yet`);
				return await this.announceAndHangup(
					this.settings.unavailableAnnouncement,
					"FACILITY_NOT_IMPLEMENTED",
				);
			}
		}
	}

	/**
	 * `*97` and `*98` — reaching a mailbox from the CATALOGUE rather than from a prefix setting.
	 *
	 * ## The gap this closes
	 *
	 * `packages/routing` compiles a `voicemail-check` feature code to a `feature-code` node with no
	 * `targetNodeId` — `featureCodeTarget` resolves `call-park`'s pinned lot and nothing else — so
	 * until now the ONLY way to reach a mailbox was `settings.voicemailCheckPrefix`. A tenant on the
	 * default catalogue had `*97` in their star-code table, saw it in the admin UI, dialled it, and
	 * got "not available". The prefix and the code were two doors to one room and only one of them
	 * was fitted.
	 *
	 * ## Why the fix is here rather than in the compiler
	 *
	 * The artifact already carries everything needed: `internal.mailboxes` is keyed by mailbox number
	 * and names both a `leave` and a `check` node per box. Teaching the compiler to point the code at
	 * one of them would mean choosing at COMPILE time which mailbox `*97` opens, and the answer
	 * depends on who dialled it — a fact the compiler does not have. So the code resolves the mailbox
	 * the way `*97` always has (the calling extension's) and hands the walk to the node the compiler
	 * already built.
	 *
	 * `*98` takes the mailbox as its argument, which is what `FEATURE_CODE_ARGUMENT_MODE` says
	 * (`required`), and leaves a message in it — the caller is a colleague dropping a note, not the
	 * owner, so there is no PIN and no menu.
	 */
	/**
	 * `*0<ext>` — a supervisor listening to somebody else's live call.
	 *
	 * ## The order is the security property
	 *
	 * Authorize, THEN resolve, THEN tap. Not because it reads better, but because the two obvious
	 * alternatives both leak. Resolving first and authorizing second turns `*0` into an oracle: a
	 * handset with no grant learns, from which announcement it hears, whether extension 1001 is on
	 * the phone right now — which is exactly the fact supervision exists to control access to.
	 * Tapping first and authorizing second is worse in the way that needs no explanation.
	 *
	 * So the gate runs before anything about the target is looked up, and a denial is
	 * indistinguishable from "nobody is on a call": both play the unavailable announcement, and the
	 * difference lives in the walk's notes and the responder's log, where the person who is allowed
	 * to know can find it.
	 *
	 * ## A missing port DENIES
	 *
	 * See {@link PlanWalkerDependencies.supervision}. Every other optional port here degrades to an
	 * announcement because the feature cannot run; this one refuses because the engine cannot
	 * establish that it may. There is deliberately no branch that reads "no port, therefore allow".
	 *
	 * ## Where it goes next
	 *
	 * The tap and the DTMF escalation live behind {@link WalkerCallControl.monitor}, because both
	 * need the channel registry and the mid-call feature runtime, which are instance state the
	 * walker has no handle on. What stays here is what is genuinely routing: the argument, the
	 * refusals, and the gate.
	 */
	private async eavesdropCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const caller = (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();
		if (caller === undefined || caller === "") {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled by a caller with no number; there is nobody to authorize`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		const target = input.featureArgument?.trim() ?? "";
		if (target === "") {
			this.note(`feature code ${node.code} needs the extension whose call is being monitored`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		if (target === caller) {
			// Monitoring your own call is either a mis-dial or an attempt to hear your own audio path,
			// and the media plane would happily build it: a tap on your own leg bridged to your own
			// leg is a feedback loop. Refused with its own note so the mis-dial is legible.
			this.note(`feature code ${node.code} was dialled against the caller's own extension`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		const gate = this.deps.supervision;
		if (gate === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has no supervision gate; the request is DENIED`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_SUBSCRIBED",
			);
		}

		const decision = await gate.authorize({
			organizationId: this.deps.channel.organizationId,
			extensionNumber: caller,
			targetExtension: target,
			callId: this.deps.channel.callId,
		});
		if (!decision.allowed) {
			this.note(
				`feature code ${node.code}: extension ${caller} may not monitor ${target} (${decision.reason ?? "no reason given"})`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_SUBSCRIBED",
			);
		}

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

		// `*0` always STARTS silent. Whisper and barge are reached by pressing a digit while already
		// listening, which is the FreeSWITCH convention (`4`/`5`/`6`) the escalation implements — a
		// supervisor who dials in should never be audible before they have decided to be.
		const outcome = await control.monitor({ extension: target, mode: "eavesdrop" });
		if (!outcome.ok) {
			this.note(
				`feature code ${node.code}: ${target} could not be monitored (${outcome.reason ?? "no reason given"})`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		this.note(`feature code ${node.code}: extension ${caller} is monitoring ${target}`);
		// The walk is over and the leg is up, exactly as it is after a queue answer or a park: the
		// supervisor stays in the tap bridge until one side goes away.
		return { kind: "bridged" };
	}

	/**
	 * `*80<ext>` — talk into somebody's speakerphone without them picking it up.
	 *
	 * ## It is an ordinary dial with one variable set
	 *
	 * Everything about an intercom is an ordinary extension dial — the same endpoint template, the
	 * same leg hooks and therefore the same B-leg CDR, the same bridge — except that the INVITE
	 * carries {@link import("./auto-answer").AUTO_ANSWER_VARIABLES}, which asks the handset to answer
	 * itself. That is deliberately the whole difference: an intercom implemented as its own dial path
	 * would be a second place for the leg accounting to drift, and a call whose CDR did not say which
	 * extension it reached because it took the "special" route.
	 *
	 * ## The target is resolved from the ARTIFACT, not dialled as digits
	 *
	 * `extensionNodeFor` finds the compiled `extension` node for the number, which is what makes an
	 * unknown or disabled extension a REFUSAL rather than an INVITE to an endpoint the media server
	 * has never heard of. It also means an intercom can only ever reach an internal extension, which
	 * is the correct boundary: `*80` plus a mobile number would be an auto-answer request sent to a
	 * carrier, and there is no such thing.
	 *
	 * The extension's own forwarding, DND and follow-me are deliberately NOT honoured — this dials
	 * the endpoint directly. An intercom that followed a forward would announce into the voicemail of
	 * a colleague who is not at their desk, or into a mobile in somebody's pocket, and the entire
	 * premise of the feature is that there is a speaker in a known room.
	 *
	 * ## A short deadline, and an announcement when it passes
	 *
	 * {@link PlanWalkerSettings.intercomTimeoutSeconds}. A handset that has not auto-answered in a
	 * few seconds is one that was never configured to, and the caller needs to hear that rather than
	 * listen to a phone ring somewhere they cannot see.
	 */
	private async intercomCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const target = input.featureArgument?.trim() ?? "";
		if (target === "") {
			this.note(`feature code ${node.code} needs the extension to talk to`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		const extension = this.extensionNodeFor(target, input);
		if (extension === undefined) {
			// Unknown and DISABLED are the same answer here, and that is not a shortcut: the compiler
			// leaves a disabled extension out of the artifact entirely, so "no node" is the only signal
			// this walk gets and inventing a distinction would mean inventing the fact behind it.
			this.note(`feature code ${node.code}: no extension ${target} in this organization's plan`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome = await this.dialOne(
			{
				endpoint: this.endpointForExtension(extension.number),
				label: `intercom to extension ${extension.number}`,
				destinationNumber: extension.number,
				onNet: true,
				timeoutSeconds: this.settings.intercomTimeoutSeconds,
				delaySeconds: 0,
				callerId: this.callerIdFor(input),
				variables: AUTO_ANSWER_VARIABLES,
			},
			0,
		);

		if (outcome.kind === "answered") {
			this.note(`feature code ${node.code}: intercom to extension ${extension.number} is up`);
			return await this.bridgeWith(outcome.mediaChannelId);
		}
		if (outcome.kind === "aborted") {
			return { kind: "aborted" };
		}

		// Never a branch onto the extension's own no-answer node. A handset that did not auto-answer
		// has not "not answered a call" — the caller asked to speak into a room and the room did not
		// open, and sending them to that extension's voicemail would record an announcement nobody
		// asked to leave.
		this.note(
			`feature code ${node.code}: extension ${extension.number} did not auto-answer the intercom (${outcome.kind === "failed" ? outcome.cause : "no answer"})`,
		);
		return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NO_ANSWER");
	}

	private async voicemailCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const direct = node.action === "voicemail-direct";
		const claimed = direct
			? input.featureArgument?.trim()
			: (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();

		if (claimed === undefined || claimed === "") {
			this.note(
				direct
					? `feature code ${node.code} needs the mailbox to leave a message in`
					: `feature code ${node.code} was dialled by a caller with no number; there is no mailbox to open`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		const entry = input.mailboxes?.[claimed];
		if (entry === undefined) {
			// The honest answer, and NOT "you have no messages": the tenant has the code and this
			// number has no box behind it, which a user reads as a configuration problem rather than as
			// a broken mailbox.
			this.note(
				`feature code ${node.code} (${node.action}) found no mailbox for ${claimed}; nothing to open`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		this.note(
			direct
				? `feature code ${node.code} is leaving a message in mailbox ${entry.mailboxNumber}`
				: `feature code ${node.code} is opening mailbox ${entry.mailboxNumber}`,
		);
		return { kind: "goto", nodeId: direct ? entry.leaveNodeId : entry.checkNodeId };
	}

	/**
	 * `*72`, `*74`, `*76`, `*78` and `*21` — a user changing their own state from their own handset.
	 *
	 * ## The identity is the phone, and it is a CLAIM on the other side
	 *
	 * The caller's number is the same authenticated identity `*97` opens a mailbox with: the call
	 * came from that extension, which is exactly as strong as the phone on the desk and is the
	 * classic PBX default. The responder does not trust it — it resolves the number inside the
	 * tenant's scope before writing anything — which is why this end can send it plainly.
	 *
	 * ## Set versus toggle
	 *
	 * The three forwarding codes take an OPTIONAL argument (`FEATURE_CODE_ARGUMENT_MODE`), and the
	 * two readings are different operations: `*72<number>` SETS, `*72` alone TOGGLES. A toggle needs
	 * to know the current state, and the artifact answers that for three of the five features — see
	 * {@link currentFeatureState} for the two it cannot and what is done about them.
	 *
	 * ## Both outcomes are audible
	 *
	 * `applied: true` plays the activation or de-activation announcement — which one depends on the
	 * state that came BACK, not on what was asked for, so a race with an admin editing the same row
	 * tells the user what is true rather than what they intended. `applied: false`, a timeout and a
	 * missing port all play "not available". Nothing here ends in silence, because a user who hears
	 * nothing assumes it worked.
	 */
	/**
	 * `*65` and `*64` — the two codes that flip something for the WHOLE organization.
	 *
	 * ## Which entity, and why it is in `params`
	 *
	 * Neither code lives in the feature-code catalogue: `*65` is a column on ONE call flow and `*64`
	 * is a column on ONE time condition, so the compiler synthesises a catalogue entry per entity and
	 * pins the id into `params`. Reading it here rather than resolving anything means the walk cannot
	 * flip the wrong flow, and a code whose entity has since been deleted refuses rather than
	 * guessing at the nearest one.
	 *
	 * ## No caller identity is required, and that is deliberate
	 *
	 * Unlike `*72`, which needs to know WHOSE forwarding to change, this acts on an entity the code
	 * itself names. A caller with no number can still press it — a lobby phone with caller id
	 * suppressed is exactly the handset a night-mode key is provisioned on — so refusing over a
	 * missing number would take the feature away from its most common installation. The number is
	 * passed when it is known, for the audit trail alone.
	 *
	 * ## The announcement is the activated/de-activated pair, and it means something here
	 *
	 * `night` and a non-`auto` override are both "somebody has taken the normal behaviour out of the
	 * loop", which is what the activated tone says on every other code. A receptionist pressing the
	 * key twice therefore hears two different tones, which is the only feedback a phone can give
	 * about a state they cannot see.
	 */
	private async toggleCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const port = this.deps.toggles;
		if (port === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has no toggle port`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const target = node.action === "call-flow-toggle" ? "call-flow" : "time-condition";
		const entityId = node.params?.[target === "call-flow" ? "callFlowId" : "timeConditionId"];
		if (typeof entityId !== "string" || entityId === "") {
			this.note(
				`feature code ${node.code} (${node.action}) carries no ${target} id; the artifact was compiled without one`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const caller = (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();
		let outcome: ToggleFeatureOutcome;
		try {
			outcome = await port.toggle({
				organizationId: this.deps.channel.organizationId,
				target,
				...(target === "call-flow" ? { callFlowId: entityId } : { timeConditionId: entityId }),
				...(caller === undefined || caller === "" ? {} : { extensionNumber: caller }),
				callId: this.deps.channel.callId,
			});
		} catch (error) {
			// A thrown port and a refusing one are the same fact to the caller, exactly as they are for
			// `extensionFeatureCode`.
			this.note(
				`feature code ${node.code} (${node.action}) could not be applied: ${String(error)}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		if (!outcome.applied) {
			this.note(
				`feature code ${node.code} (${node.action}) was refused: ${outcome.reason ?? "no reason given"}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		// `night` for a flow, anything but `auto` for a condition: both mean the normal behaviour has
		// been overruled, which is what the activated tone says everywhere else on this switch.
		const overruled =
			outcome.state === "night" || (target === "time-condition" && outcome.state !== "auto");
		this.note(
			`feature code ${node.code} (${node.action}) set ${target} ${entityId} to ${outcome.state ?? "an unreported state"}`,
		);
		return await this.announceAndHangup(
			overruled
				? this.settings.featureActivatedAnnouncement
				: this.settings.featureDeactivatedAnnouncement,
			"NORMAL_CLEARING",
		);
	}

	/**
	 * `*31<ext>` and `*32` — an agent claiming a shared desk phone, and giving it back.
	 *
	 * ## The DEVICE, not the caller, is the subject
	 *
	 * Every other feature code on this walker starts from `callerIdNumber`, because every other one
	 * acts on the caller's own extension. This one cannot: the premise is that the handset is NOT the
	 * agent's, so the calling number names the person whose desk they are standing at, which is
	 * exactly the wrong answer. The subject is `channel.deviceId` — the registered handset the SIP
	 * edge authenticated the INVITE as, carried from `sipInviteRequestSchema.deviceId` onto the leg
	 * as `OPTIMIQ_DEVICE_ID`. A leg with none (a trunk call, an API-originated one, or an edge that
	 * predates the field) is REFUSED rather than falling back to the caller's number: guessing here
	 * would let a call from outside the building rebind a phone inside it.
	 *
	 * ## The PIN gather is `challengeOutboundPin`'s, and the verification is not
	 *
	 * The collection is the same — answer the leg, gather with a terminator and a digit ceiling,
	 * replay the invalid prompt, count attempts down — because a caller should not have to learn two
	 * ways to type a code into a phone. What is deliberately NOT the same is where the digits are
	 * checked: an outbound gate verifies against a digest the artifact carries, and this one hands
	 * the digits to the control plane, because compiling a hot-desk gate would put every agent's PIN
	 * digest on the KV bucket every engine in the deployment watches. See `RPC_SUBJECTS.pbxHotDesk`.
	 *
	 * The consequence is that the walk cannot tell a wrong PIN from an unknown extension, and does
	 * not try to: both come back `applied: false`, both hang up on the unavailable announcement, and
	 * only the responder's log knows which. Over a phone line, telling them apart is an oracle for
	 * enumerating a tenant's extension list from the lobby handset.
	 *
	 * ## A logout gathers nothing
	 *
	 * `*32` is dialled bare and the session it ends is the one THIS handset is holding. There is no
	 * PIN because the agent is standing at the desk they are giving back, and no argument because
	 * letting one name a different session would let anybody log anybody out from any phone.
	 */
	private async hotDeskCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const port = this.deps.hotDesk;
		if (port === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has no hot-desk port`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const deviceId = this.deps.channel.deviceId;
		if (deviceId === undefined || deviceId === "") {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled from a leg with no device identity; there is no handset to rebind`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_SUBSCRIBED",
			);
		}

		const login = node.action === "hotdesk-login";
		const target = input.featureArgument?.trim() ?? "";
		if (login && target === "") {
			this.note(`feature code ${node.code} needs the extension being claimed`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		let pin: string | undefined;
		if (login) {
			const gathered = await this.gatherHotDeskPin(node);
			if (gathered.kind !== "entered") {
				return gathered.result;
			}
			pin = gathered.digits;
		}

		let outcome: HotDeskOutcome;
		try {
			outcome = await port.apply({
				organizationId: this.deps.channel.organizationId,
				action: login ? "login" : "logout",
				deviceId,
				...(login ? { extensionNumber: target, pin } : {}),
				callId: this.deps.channel.callId,
			});
		} catch (error) {
			// A thrown port and a refusing one are the same fact to the caller, exactly as they are for
			// `toggleCode`. The error is stringified WITHOUT the change, which carries the PIN.
			this.note(
				`feature code ${node.code} (${node.action}) could not be applied: ${String(error)}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		if (!outcome.applied) {
			this.note(
				`feature code ${node.code} (${node.action}) was refused: ${outcome.reason ?? "no reason given"}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		this.note(
			`feature code ${node.code} (${node.action}) bound device ${deviceId} to extension ${outcome.extensionNumber ?? "(unreported)"}${
				outcome.expiresAt === undefined ? "" : ` until ${outcome.expiresAt}`
			}`,
		);
		// A login is an activation and a logout is its opposite, which is the same reading every other
		// toggle on this switch gives — so an agent hears the tone they already know means "on".
		return await this.announceAndHangup(
			login
				? this.settings.featureActivatedAnnouncement
				: this.settings.featureDeactivatedAnnouncement,
			"NORMAL_CLEARING",
		);
	}

	/**
	 * The hot-desk challenge: the outbound authorisation gather, with the platform's own budget.
	 *
	 * The leg is answered to ask, for `challengeOutboundPin`'s reason: a gather on an unanswered leg
	 * collects nothing. The cost — a refused login is a connected call in the tenant's CDR — is
	 * correct here too: the agent reached the system and was told no.
	 *
	 * There is no per-attempt verification, so there is no invalid prompt between attempts either:
	 * the digits are checked once, by the responder, after the LAST collection. The attempts loop
	 * exists for the caller who mis-keys and presses `#` on an empty collection, which is the only
	 * failure this side can see.
	 */
	private async gatherHotDeskPin(
		node: Extract<PlanNode, { kind: "feature-code" }>,
	): Promise<
		| { readonly kind: "entered"; readonly digits: string }
		| { readonly kind: "abandoned"; readonly result: StepResult }
	> {
		if (!(await this.ensureAnswered())) {
			return { kind: "abandoned", result: { kind: "aborted" } };
		}

		for (let attempt = 0; attempt < Math.max(1, this.settings.hotDeskPinAttempts); attempt += 1) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "abandoned", result: { kind: "aborted" } };
			}

			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: this.settings.outboundPinMaxDigits,
				terminators: ["#"],
				timeoutMs: this.settings.hotDeskPinTimeoutMs,
				interDigitTimeoutMs: this.settings.outboundPinInterDigitTimeoutMs,
				media: this.settings.outboundPinPrompt,
			});
			if (result === undefined) {
				return {
					kind: "abandoned",
					result: { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" },
				};
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "abandoned", result: { kind: "aborted" } };
			}

			const digits = collection?.digits.join("") ?? "";
			if (digits !== "") {
				return { kind: "entered", digits };
			}
			await this.deps.execute({ verb: "play", media: this.settings.outboundPinInvalidPrompt });
		}

		this.note(
			`feature code ${node.code} collected no PIN in ${String(this.settings.hotDeskPinAttempts)} attempts`,
		);
		return {
			kind: "abandoned",
			result: await this.announceAndHangup(this.settings.outboundPinFailurePrompt, "CALL_REJECTED"),
		};
	}

	private async extensionFeatureCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const port = this.deps.features;
		if (port === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has no feature port`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const caller = (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();
		if (caller === undefined || caller === "") {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled by a caller with no number; there is no extension to change`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		const feature = FEATURE_FOR_ACTION[node.action];
		if (feature === undefined) {
			this.note(`feature code ${node.code} (${node.action}) is not an extension feature`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const destination = FORWARD_ACTIONS.has(node.action)
			? (input.featureArgument?.trim() ?? "")
			: "";
		// Digits after the code mean SET; the code alone means toggle. A destination on a code that
		// has none (`*78`, `*21`) is ignored rather than refused — the contract says the field is
		// meaningless there, and refusing over it would be a refusal the user cannot act on.
		const enabled = destination === "" ? !this.currentFeatureState(feature, caller, input) : true;

		let outcome: ExtensionFeatureOutcome;
		try {
			outcome = await port.apply({
				organizationId: this.deps.channel.organizationId,
				extensionNumber: caller,
				feature,
				enabled,
				...(destination === "" ? {} : { destination }),
				callId: this.deps.channel.callId,
			});
		} catch (error) {
			// A thrown port and a refusing one are the same fact to the caller. Kept as a catch rather
			// than pushed onto every implementation so a port that forgets is still safe here.
			this.note(
				`feature code ${node.code} (${node.action}) could not be applied: ${String(error)}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		if (!outcome.applied) {
			this.note(
				`feature code ${node.code} (${node.action}) was refused: ${outcome.reason ?? "no reason given"}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		this.note(
			`feature code ${node.code} (${node.action}) is now ${outcome.enabled ? "on" : "off"} for extension ${caller}${
				outcome.destination === undefined ? "" : ` (destination ${outcome.destination})`
			}`,
		);
		return await this.announceAndHangup(
			outcome.enabled
				? this.settings.featureActivatedAnnouncement
				: this.settings.featureDeactivatedAnnouncement,
			"NORMAL_CLEARING",
		);
	}

	/**
	 * What the artifact says this feature is currently doing for the caller's extension.
	 *
	 * ## Three of the five are readable, and two are not
	 *
	 * The walk holds the artifact's whole node table (a resolve hands over `artifact.nodes` by
	 * reference), so the caller's own `extension` node is findable by number, and it carries:
	 * `forwardAllNodeId` — present exactly when forward-all is on — `doNotDisturb`, and `followMe`,
	 * present exactly when the ladder is switched on and has hops.
	 *
	 * `busyNodeId` and `noAnswerNodeId` cannot answer the same question, and no amount of care here
	 * would change that: the compiler writes the FORWARD target into those fields when forwarding is
	 * on and the mailbox into them when it is not, so both states produce a populated field. A
	 * reading based on the node's KIND would be a guess that breaks the day somebody forwards to a
	 * colleague whose extension happens to have voicemail.
	 *
	 * So a bare `*74`/`*76` is treated as "currently on", which makes the toggle a CLEAR. That is the
	 * safe direction and it is chosen deliberately: clearing keeps the stored destination (the
	 * responder guarantees it), so the cost of guessing wrong is a user who hears "de-activated" and
	 * presses again with the number — while guessing the other way would silently divert somebody's
	 * calls to a destination they configured months ago. Setting is always unambiguous:
	 * `*74<number>` never consults this.
	 */
	private currentFeatureState(
		feature: ExtensionFeature,
		callerNumber: string,
		input: WalkInput,
	): boolean {
		if (feature === "forward-busy" || feature === "forward-no-answer") {
			return true;
		}
		const node = this.extensionNodeFor(callerNumber, input);
		if (node === undefined) {
			// No extension node for the caller means the walk cannot see their configuration at all —
			// an off-net caller who reached an internal context, or an artifact that does not contain
			// them. Treated as "on" for the same reason the two unreadable features are: the inverse is
			// a clear, and a clear is the harmless half of a wrong guess.
			this.note(
				`extension ${callerNumber} is not in this artifact; the ${feature} toggle assumed it was on`,
			);
			return true;
		}
		if (feature === "forward-all") {
			return node.forwardAllNodeId !== undefined;
		}
		if (feature === "do-not-disturb") {
			return node.doNotDisturb;
		}
		return node.followMe !== undefined;
	}

	/**
	 * The caller's own `extension` node, found by number in the artifact's table.
	 *
	 * Indexed once per node table rather than scanned per call: screening asks for this on every
	 * extension dial, and a large tenant's table is thousands of entries. A duplicate number keeps
	 * the first node, exactly as the scan did.
	 */
	private extensionNodeFor(callerNumber: string, input: WalkInput): ExtensionPlanNode | undefined {
		let index = this.extensionsByNumber.get(input.plan.nodes);
		if (index === undefined) {
			index = new Map<string, ExtensionPlanNode>();
			for (const candidate of Object.values(input.plan.nodes)) {
				if (candidate.kind === "extension" && !index.has(candidate.number)) {
					index.set(candidate.number, candidate);
				}
			}
			this.extensionsByNumber.set(input.plan.nodes, index);
		}
		return index.get(callerNumber);
	}

	/**
	 * `*69` — call back whoever rang this extension last.
	 *
	 * ## Two ways to reach the number, and the order matters
	 *
	 * An INTERNAL caller is already in the artifact: their `extension` node is in the table the walk
	 * is holding, so the return call is a `goto` onto it. That is not a shortcut, it is the better
	 * answer — the walk re-enters the extension runtime and therefore honours the callee's own
	 * forwarding, their follow-me ladder and their no-answer branch, exactly as if the digits had
	 * been dialled by hand.
	 *
	 * An EXTERNAL caller is not, and cannot be: turning `+15551234567` into a trunk needs the number
	 * index and the outbound match table, neither of which travels with a plan. That is what
	 * {@link WalkerCallControl.dial} is for, and the orchestrator answers it by resolving the digits
	 * as if the caller had dialled them — so the toll-class gate, the outbound kill switch and the
	 * call-block screen all apply and `*69` can never reach somewhere the same handset could not.
	 *
	 * ## `found: true` with no number is not a miss
	 *
	 * A withheld caller means there WAS a call and there is nothing to dial. Both it and an empty
	 * window announce, because to the person holding the handset they are the same outcome; the
	 * notes tell them apart for the support ticket.
	 */
	private async redialCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const source = this.deps.lastCaller;
		if (source === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has no last-caller source`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const caller = (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();
		if (caller === undefined || caller === "") {
			this.note(
				`feature code ${node.code} was dialled by a caller with no number; there is no extension to look up`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		let result: LastCallerResult;
		try {
			result = await source.lookup({
				organizationId: this.deps.channel.organizationId,
				extensionNumber: caller,
				callId: this.deps.channel.callId,
			});
		} catch (error) {
			this.note(`feature code ${node.code} could not read the call ledger: ${String(error)}`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		const number = result.callerNumber?.trim();
		if (!result.found || number === undefined || number === "") {
			this.note(
				result.found
					? `feature code ${node.code}: the last caller to ${caller} withheld their number`
					: `feature code ${node.code}: nobody has called ${caller} recently (${result.reason ?? "empty window"})`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NO_ROUTE_DESTINATION",
			);
		}

		const internal = this.extensionNodeFor(number, input);
		if (internal !== undefined) {
			this.note(`feature code ${node.code} is returning the call from extension ${number}`);
			return { kind: "goto", nodeId: internal.id };
		}

		const control = this.deps.control;
		if (control === undefined) {
			this.note(
				`feature code ${node.code} found ${number}, which is not an extension in this artifact, and this walk has no call-control runtime to dial it`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		this.note(`feature code ${node.code} is returning the call to ${number}`);
		return await this.dialThroughControl(control, number, `${number} could not be dialled back`);
	}

	/**
	 * Re-enters routing for `number` and turns the resulting walk into this walk's result.
	 *
	 * Shared by `*69` and the `*67`/`*82` pair because the shape is identical and getting it subtly
	 * different is how one of them ends up hanging a leg up twice: a walk ran on THIS leg and has
	 * already left it wherever it left it, so only `unresolved` is still ours to answer.
	 */
	private async dialThroughControl(
		control: WalkerCallControl,
		number: string,
		unresolvedNote: string,
	): Promise<StepResult> {
		const outcome = await control.dial({ destination: number });
		switch (outcome.status) {
			case "bridged": {
				return { kind: "bridged" };
			}
			case "aborted": {
				return { kind: "aborted" };
			}
			case "unresolved": {
				this.note(`${unresolvedNote}: ${outcome.reason ?? "nothing matched it"}`);
				return await this.announceAndHangup(
					this.settings.unavailableAnnouncement,
					"NO_ROUTE_DESTINATION",
				);
			}
			default: {
				// `terminate` skips the hangup verb on a leg that is tearing down, so returning the cause
				// records it without touching the leg twice.
				return { kind: "hangup", cause: outcome.cause ?? "NORMAL_CLEARING" };
			}
		}
	}

	/**
	 * `*67<destination>` and `*82<destination>` — per-call CLIR.
	 *
	 * ## Why a channel variable and not a walk argument
	 *
	 * The code is dialled by the CALLER, so the resolver never sees it: by the time the digits are
	 * matched, the plan being walked is the feature code's, not the destination's. Reaching the
	 * destination means re-entering routing through {@link WalkerCallControl.dial}, which runs a
	 * FRESH walk with a fresh {@link WalkInput} — nothing on this walker survives into it. What does
	 * survive is the leg, so the override is stamped on the A-leg as {@link CLIR_VARIABLE} and read
	 * back by `SplitPlaneMediaPort` from the ORIGINATING leg when the new walk's trunk dial
	 * originates its B-leg. That is also what makes the override beat the setting: the port ranks
	 * the variable above `OriginateRequest.callerIdPresentation`.
	 *
	 * A failed stamp is fatal on `*67` and not on `*82`. Presenting a number the caller has just
	 * asked to withhold is the harm this feature exists to prevent, and the caller cannot tell it
	 * happened; failing to lift a withhold merely leaves the standing setting in force, which is
	 * what they had before they dialled.
	 */
	private async callerIdPresentationCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const presentation =
			node.action === "caller-id-presentation-restrict" ? "restricted" : "allowed";
		const destination = input.featureArgument?.trim();
		if (destination === undefined || destination === "") {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled with no destination after it`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		try {
			await this.deps.media.setVariable(
				this.deps.channel.mediaChannelId,
				CLIR_VARIABLE,
				presentation,
			);
		} catch (error) {
			this.note(
				`feature code ${node.code} could not set caller-id presentation on this leg: ${String(error)}`,
			);
			if (presentation === "restricted") {
				return await this.announceAndHangup(
					this.settings.unavailableAnnouncement,
					"NORMAL_TEMPORARY_FAILURE",
				);
			}
		}

		const control = this.deps.control;
		if (control === undefined) {
			this.note(
				`feature code ${node.code} was dialled but this walk has no call-control runtime to dial ${destination}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		this.note(
			`feature code ${node.code} is dialling ${destination} with caller id ${presentation}`,
		);
		return await this.dialThroughControl(
			control,
			destination,
			`${destination} could not be dialled`,
		);
	}

	/**
	 * `*43` — the echo test.
	 *
	 * ## Why the walk ENDS here rather than continuing
	 *
	 * There is nothing left to route: the leg is handed to the media plane's echo and stays there
	 * until the caller hangs up. `bridged` is the walk status that means "the walk is over and the
	 * call is up" — the same one a parked call reports, and for the same reason — and it is what
	 * stops the orchestrator from tearing the leg down when the walk returns.
	 *
	 * ## The prompt is played first, and its failure is not fatal
	 *
	 * An echo with no preamble is indistinguishable from a fault: the caller hears themselves a beat
	 * late and hangs up thinking the line is broken. But a deployment missing the sound file is not
	 * a reason to refuse the test, so a failed playback is noted and the echo proceeds.
	 *
	 * A media plane that cannot echo at all (`mediad` refuses by name) announces instead — the caller
	 * is told, and the log names the driver.
	 */
	private async echoTestCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
	): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		const played = await this.deps.execute({ verb: "play", media: this.settings.echoTestPrompt });
		if (played === undefined) {
			this.note(
				`feature code ${node.code}: the echo-test prompt could not be played; the echo was started anyway`,
			);
		}

		try {
			await this.deps.media.echo(this.deps.channel.mediaChannelId);
		} catch (error) {
			this.note(`feature code ${node.code}: this media plane cannot echo (${String(error)})`);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		this.note(`feature code ${node.code} handed the leg to the media plane's echo`);
		return { kind: "bridged" };
	}

	/**
	 * `*99` — recording a mailbox greeting from the handset.
	 *
	 * ## Nothing is recorded that cannot be filed
	 *
	 * The port is checked BEFORE the beep, and that ordering is the whole design. A code that
	 * answered, prompted, took thirty seconds of somebody's voice and then had nowhere to put it
	 * would leave them believing their greeting is live — discovered later by a caller who hears the
	 * deployment's default announcement instead. The same rule governs the end: a greeting that could
	 * not be filed plays "not available", never the confirmation.
	 *
	 * ## The mailbox and the PIN are `*97`'s
	 *
	 * The box is the calling extension's, found in the artifact's mailbox table exactly as a check
	 * finds it, and the PIN gate is the same one — read off the `check` node the mailbox entry names,
	 * so a box with a PIN cannot have its greeting replaced by whoever is standing at the desk. A box
	 * with no digest is not challenged, which is the same deliberate default {@link
	 * challengeVoicemailPin} documents.
	 *
	 * ## An empty recording is not a greeting
	 *
	 * A zero-length or failed recording is discarded with a note rather than filed, on the same rule
	 * the message path holds to: an active greeting containing silence is worse than no greeting,
	 * because the box stops announcing itself and nothing says why.
	 */
	private async recordGreetingCode(
		node: Extract<PlanNode, { kind: "feature-code" }>,
		input: WalkInput,
	): Promise<StepResult> {
		const port = this.deps.greetings;
		if (port === undefined) {
			this.note(
				`feature code ${node.code} (${node.action}) was dialled but this walk has nowhere to file a greeting; nothing was recorded`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const caller = (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();
		const entry = caller === undefined || caller === "" ? undefined : input.mailboxes?.[caller];
		if (entry === undefined) {
			this.note(
				`feature code ${node.code} found no mailbox for ${caller ?? "an unknown caller"}; there is no greeting to record`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"INVALID_NUMBER_FORMAT",
			);
		}

		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		// The `check` node is where the compiler put the box's PIN digest, so the gate `*97` applies is
		// reachable from here without a second source of truth about what a mailbox's secret is.
		const checkNode = input.plan.nodes[entry.checkNodeId];
		if (checkNode !== undefined && checkNode.kind === "voicemail") {
			const authenticated = await this.challengeVoicemailPin(checkNode, entry.mailboxNumber);
			if (authenticated.kind !== "granted") {
				return authenticated.result;
			}
		}

		const recordingId = this.newId();
		const format = this.settings.recordingFormat;
		const objectKey = `${this.deps.channel.organizationId}/${this.deps.channel.callId}/${recordingId}.${format}`;
		const maxSeconds = this.settings.greetingMaxSeconds;
		// Subscribed BEFORE the record call, for the reason the message path documents: a very short
		// recording can finish before the HTTP response arrives.
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
			this.note(
				`feature code ${node.code}: the greeting recording failed to start: ${String(error)}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		await this.deps.publish("channel.record.started", {
			legId: this.deps.channel.channelId,
			recordingId,
			objectKey,
			// The recording taxonomy has no `greeting` member, so this is filed as `voicemail` — which
			// is what it is, media belonging to a mailbox. The GREETING is identified by the port call
			// below rather than by this event, which exists for the recording lifecycle and the CDR.
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
			this.note(
				`feature code ${node.code}: the greeting recording produced no audio (${result.reason}); the mailbox's greeting was left alone`,
			);
			return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NORMAL_CLEARING");
		}

		try {
			await port.greetingRecorded({
				organizationId: this.deps.channel.organizationId,
				voicemailBoxId: entry.voicemailBoxId,
				mailboxNumber: entry.mailboxNumber,
				greetingId: this.newId(),
				recordingId,
				objectKey,
				durationMs: result.durationMs,
				kind: "unavailable",
				callId: this.deps.channel.callId,
			});
		} catch (error) {
			this.note(
				`feature code ${node.code}: the greeting was recorded into ${objectKey} but could NOT be filed: ${String(error)}`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"NORMAL_TEMPORARY_FAILURE",
			);
		}

		this.note(
			`feature code ${node.code} recorded a new greeting for mailbox ${entry.mailboxNumber}`,
		);
		return await this.announceAndHangup(
			this.settings.greetingRecordedAnnouncement,
			"NORMAL_CLEARING",
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
	// Paging
	// -------------------------------------------------------------------------------------------

	/**
	 * `*81` — one voice into every handset in a group.
	 *
	 * ## Why this is NOT `dialSimultaneous`
	 *
	 * It looks like a ring-all and it is the opposite of one. `dialSimultaneous` is a RACE: it
	 * settles on the first answer and hangs every other leg up with `LOSE_RACE`, which is exactly
	 * right for a ring group and exactly what would silence a page — the first handset to auto-answer
	 * would win and the other eleven would be cancelled. A page is a FAN-IN: every leg that comes up
	 * joins the same bridge, and there is no winner.
	 *
	 * So the shared primitive is the one below the race, {@link PlanWalker.originate} — the same leg
	 * hooks, the same CDR-correct B-legs, the same `legSignalKey` subscription established before the
	 * originate so a fast auto-answer cannot outrun it. What is not reused is the settling logic,
	 * because the settling logic is the part that is wrong here.
	 *
	 * ## One-way pages mute the MEMBERS, and why that is the right primitive
	 *
	 * `duplex: false` means the group hears the pager and cannot be heard. There is no "listen only"
	 * bridge membership in this port, and there does not need to be: `mute(channel, "in")` stops
	 * audio coming FROM that party (Asterisk's convention, the same one
	 * {@link import("../media/media-port").TapRequest} documents for `spy`), so a muted member is
	 * present in the mix as a listener only. Doing it the other way round — muting `out` — would
	 * deafen the member, which is the entire content of the page.
	 *
	 * It is applied per member AFTER they join rather than at originate time, because a mute is a
	 * property of a live channel and there is nothing to mute before one exists.
	 *
	 * A real page would not need any of this. Multicast paging (which every vendor template in
	 * `apps/api/src/provisioning/catalog/templates/` supports as a key type) sends one RTP stream to
	 * a multicast group and the handsets play it with no signalling at all — no legs, no bridge, no
	 * mute, and no per-phone channel on the media server. That is a different feature with a
	 * different failure mode (no delivery report at all), and it is why `call.paging.started` carries
	 * `answeredCount`: this implementation can say who actually heard it, and multicast cannot.
	 *
	 * ## Zero answered members is not a failure
	 *
	 * It is a page nobody heard, which the pager must be told about — they are about to speak into a
	 * bridge with nothing in it and believe the warehouse was warned. Announced, hung up, and noted.
	 * The alternative (leaving them talking to an empty bridge) is the exact failure the
	 * `answeredCount` field exists to make visible.
	 */
	private async pagingNode(node: PagingPlanNode, input: WalkInput): Promise<StepResult> {
		const groupName = node.label ?? node.pagingGroupId;
		const members = node.members.filter((number) => number.trim() !== "");
		if (members.length === 0) {
			this.note(`paging group "${groupName}" has no members to page`);
			return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NO_ANSWER");
		}

		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		const bridgeId = this.newId();
		try {
			await this.deps.media.createBridge({ bridgeId, name: `paging-${node.pagingGroupId}` });
			await this.deps.media.addToBridge(bridgeId, [this.deps.channel.mediaChannelId]);
		} catch (error) {
			this.log("failed to open a paging bridge", { bridgeId, err: String(error) });
			this.note(`paging group "${groupName}" could not be opened: ${String(error)}`);
			return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
		}
		this.deps.channel.setBridge(bridgeId);
		this.deps.channel.moveTo("exchanging-media");

		const joined = await this.fanOutPage(node, members, bridgeId, input);

		if (joined.length === 0) {
			this.deps.channel.setBridge(undefined);
			await this.destroyBridgeQuietly(bridgeId);
			this.note(
				`paging group "${groupName}" was opened but none of its ${String(members.length)} members answered`,
			);
			return await this.announceAndHangup(this.settings.unavailableAnnouncement, "NO_ANSWER");
		}

		const startedAtMs = this.deps.now?.() ?? Date.now();
		await this.deps.publish("call.paging.started", {
			legId: this.deps.channel.channelId,
			pagingGroupId: node.pagingGroupId,
			pagingGroupName: groupName,
			...(input.originalDialedNumber === undefined ? {} : { dialed: input.originalDialedNumber }),
			...(this.deps.channel.callerIdNumber === undefined
				? {}
				: { pagerExtension: this.deps.channel.callerIdNumber }),
			memberCount: members.length,
			answeredCount: joined.length,
			oneWay: !node.duplex,
		});

		this.note(
			`paging group "${groupName}": ${String(joined.length)} of ${String(members.length)} members joined${node.duplex ? "" : " (one-way)"}`,
		);

		// The PAGER's own death ends the page. Nothing else is watching this leg: the walk returns
		// `bridged` and the orchestrator takes over — the same handover a conference join makes.
		const unwatch = this.deps.signals.watch(
			legSignalKey(this.deps.channel.mediaChannelId),
			(signal) => {
				if ((signal as LegSignal).kind !== "ended") {
					return;
				}
				unwatch();
				void this.endPage(node, groupName, bridgeId, joined, startedAtMs);
			},
		);

		return { kind: "bridged" };
	}

	/**
	 * Originates to every member at once and returns the ones that came up.
	 *
	 * The whole fan-out settles on ONE deadline — the node's `timeoutSeconds` — rather than per leg,
	 * because a page is a single event in the room: a handset that joins eight seconds after the
	 * pager started talking has missed the message, so there is nothing to be gained by waiting for
	 * it and something to be lost (the pager holding a silent line wondering whether to start).
	 *
	 * Each member is joined to the bridge the instant its own leg arrives, not at the end, so the
	 * phones that ARE quick are already listening while the slow ones are still ringing.
	 */
	private async fanOutPage(
		node: PagingPlanNode,
		members: readonly string[],
		bridgeId: string,
		input: WalkInput,
	): Promise<readonly string[]> {
		const channelIds = members.map(() => this.newId());
		const unwatchers: (() => void)[] = [];
		const joined = new Set<string>();
		const settledLegs = new Set<number>();
		const pending: Promise<void>[] = [];

		let resolveAll: () => void = () => undefined;
		const everyone = new Promise<void>((resolve) => {
			resolveAll = resolve;
		});
		const legIsSettled = (index: number): void => {
			settledLegs.add(index);
			if (settledLegs.size === members.length) {
				resolveAll();
			}
		};

		for (const index of members.keys()) {
			const channelId = channelIds[index] as string;
			const number = members[index] as string;
			unwatchers.push(
				this.deps.signals.watch(legSignalKey(channelId), (signal) => {
					const leg = signal as LegSignal;
					if (leg.kind === "ended") {
						legIsSettled(index);
						return;
					}
					if ((leg.kind !== "answered" && leg.kind !== "entered") || joined.has(channelId)) {
						return;
					}
					// Claimed once: `entered` and `answered` both arrive for one leg, and adding a
					// channel to a bridge twice is a second membership the teardown does not know about.
					joined.add(channelId);
					pending.push(this.joinPagedMember(node, channelId, number, bridgeId));
					legIsSettled(index);
				}),
			);
		}

		// Every watcher is in place before the first INVITE, so no handset's auto-answer can outrun
		// its subscription. The same rule `dialSimultaneous` follows, and the same race.
		await Promise.all(
			members.map(async (number, index) => {
				await this.originate(
					{
						endpoint: this.endpointForExtension(number),
						label: `extension ${number}`,
						destinationNumber: number,
						onNet: true,
						timeoutSeconds: node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds,
						delaySeconds: 0,
						callerId: this.callerIdFor(input),
						variables: AUTO_ANSWER_VARIABLES,
					},
					channelIds[index] as string,
					index,
					() => {
						legIsSettled(index);
					},
				);
			}),
		);

		const deadline = new Promise<void>((resolve) => {
			const timer = setTimeout(
				resolve,
				Math.max(1, node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds) *
					MILLIS_PER_SECOND,
			);
			timer.unref?.();
		});
		await Promise.race([everyone, deadline]);

		for (const unwatch of unwatchers) {
			unwatch();
		}
		// The joins started inside the watchers; awaited here so a member that is still being added
		// when the deadline fires is either in the bridge or reported as failed before the count is
		// published. A page whose `answeredCount` disagreed with the bridge would be a delivery report
		// that lies in the direction that matters.
		await Promise.all(pending);

		// Every leg that never came up is cancelled. `ORIGINATOR_CANCEL` and not `LOSE_RACE`: nobody
		// lost anything, the page simply started without them.
		for (const [index, channelId] of channelIds.entries()) {
			if (joined.has(channelId)) {
				continue;
			}
			settledLegs.add(index);
			await this.hangupQuietly(channelId, "ORIGINATOR_CANCEL");
		}

		return channelIds.filter((channelId) => joined.has(channelId));
	}

	/** Puts one answered member in the bridge, and mutes them when the page is one-way. */
	private async joinPagedMember(
		node: PagingPlanNode,
		channelId: string,
		number: string,
		bridgeId: string,
	): Promise<void> {
		try {
			await this.deps.media.addToBridge(bridgeId, [channelId]);
			this.deps.legs?.bridged(channelId, bridgeId);
		} catch (error) {
			this.note(`extension ${number} answered the page but could not be joined: ${String(error)}`);
			await this.hangupQuietly(channelId, "NORMAL_TEMPORARY_FAILURE");
			return;
		}
		if (node.duplex) {
			return;
		}
		try {
			// `in` — audio coming FROM the member. See the method note on `pagingNode`.
			await this.deps.media.mute(channelId, "in");
		} catch (error) {
			// A member who cannot be muted is a member the room can hear. Noted rather than dropped:
			// the page still reaches them, and a one-way page with one live microphone in it is a far
			// better outcome than one handset fewer.
			this.note(
				`extension ${number} joined a one-way page but could not be muted, so they can be heard: ${String(error)}`,
			);
		}
	}

	/** The pager hung up: members are released, the bridge goes, and the page is bounded. */
	private async endPage(
		node: PagingPlanNode,
		groupName: string,
		bridgeId: string,
		joined: readonly string[],
		startedAtMs: number,
	): Promise<void> {
		let stillConnected = 0;
		for (const channelId of joined) {
			try {
				if (await this.deps.media.channelExists(channelId)) {
					stillConnected += 1;
				}
			} catch {
				// An unanswerable "does it exist" is not worth a branch: the member is counted as gone,
				// and the hangup below tolerates a channel that is already dead either way.
			}
			await this.hangupQuietly(channelId, "NORMAL_CLEARING");
		}

		this.deps.channel.setBridge(undefined);
		await this.destroyBridgeQuietly(bridgeId);

		await this.deps.publish("call.paging.ended", {
			legId: this.deps.channel.channelId,
			pagingGroupId: node.pagingGroupId,
			pagingGroupName: groupName,
			durationMs: Math.max(0, (this.deps.now?.() ?? Date.now()) - startedAtMs),
			answeredCount: stillConnected,
		});
	}

	private async destroyBridgeQuietly(bridgeId: string): Promise<void> {
		try {
			await this.deps.media.destroyBridge(bridgeId);
		} catch (error) {
			this.log("failed to destroy a bridge", { bridgeId, err: String(error) });
		}
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
	private async ivrMenuNode(node: IvrMenuPlanNode, input: WalkInput): Promise<StepResult> {
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

			const gather = {
				verb: "gather",
				// The LARGER of the two, and `directDialMaxDigits` says why: a menu of single-digit
				// options is configured `maxDigits: 1`, and a collection capped at one digit is over
				// before the second digit of an extension number exists. The inter-digit timeout is
				// what separates the two intents — press `1` and stop and the option is taken, type
				// `1104` without pausing and the extension is.
				maxDigits: Math.max(node.maxDigits, node.directDialMaxDigits ?? 0),
				// `#` ends a variable-length entry. It is not configurable per menu in the artifact,
				// and inventing a per-menu terminator would be a product decision made here.
				terminators: ["#"],
				timeoutMs: node.digitTimeoutMs,
				interDigitTimeoutMs: node.interDigitTimeoutMs,
			} as const;
			let result = await this.deps.execute({
				...gather,
				...(greeting === undefined ? {} : { media: greeting }),
			});

			// A `gather` is a playback AND a collection, and the executor fails the whole verb when
			// the playback is refused. That made an unplayable greeting fatal to the call, which is
			// the wrong end of the trade: a menu with no greeting is still a menu a caller can use if
			// they know the options, and hanging up on them guarantees they cannot. So the collection
			// is retried without the audio, once, and the reason is on the call.
			if (result === undefined && greeting !== undefined) {
				this.noteVerbFailure(`IVR "${node.ivrMenuId}" could not play ${greeting}`);
				result = await this.deps.execute(gather);
			}
			if (result === undefined) {
				this.noteVerbFailure(`IVR "${node.ivrMenuId}" could not collect digits`);
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

			// Options FIRST, then the directory. The order is the product rule and not an
			// implementation detail: an option is something the tenant configured on this menu, and an
			// extension whose number happens to start with the same digit must not take it away from
			// them. The compiler warns about every pair where the two collide.
			if (node.directDialEnabled) {
				// The EXTENSION directory, not the internal number table: direct dial on an
				// auto-attendant means "put me through to a person", and letting it reach a paging
				// group or a park slot is what an option is for. `extensionNodeFor` is the same index
				// screening and `*69` use to decide whether a number is one of ours.
				const extension = this.extensionNodeFor(digits, input);
				if (extension !== undefined) {
					this.note(`IVR "${node.ivrMenuId}": ${digits} was dialled directly`);
					return { kind: "goto", nodeId: extension.id };
				}
				this.note(
					`IVR "${node.ivrMenuId}" allows direct dial, but ${digits} is not an extension of this organization; it was treated as invalid`,
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

	/**
	 * One of an IVR's own prompts, best-effort.
	 *
	 * A prompt that will not play must not end the call — the menu's timeout and invalid budgets are
	 * what shape the branch, and losing the announcement is a degradation rather than a failure. It
	 * IS noted, with the media plane's reason, because a menu whose invalid prompt is missing is a
	 * menu callers appear to abandon at random.
	 */
	private async playPrompt(promptId: string | undefined): Promise<void> {
		const media = resolveMediaRef({ promptId }, this.settings.mediaRefs);
		if (media === undefined) {
			return;
		}
		if ((await this.deps.execute({ verb: "play", media })) === undefined) {
			this.noteVerbFailure(`prompt ${media} could not be played`);
		}
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
		if (node.callScreening === true && this.screeningApplies(node, input)) {
			return await this.screenCall(node, input);
		}
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
					onNet: true,
					timeoutSeconds: node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds,
					delaySeconds: 0,
					callerId: this.callerIdFor(input),
				},
			],
			[],
		);

		const settled = await this.settleDial(outcome, {
			busyNodeId: node.busyNodeId,
			noAnswerNodeId: node.noAnswerNodeId,
			notRegisteredNodeId: node.notRegisteredNodeId,
		});
		if (settled.kind === "bridged") {
			await this.recordExtension(node);
		}
		return settled;
	}

	/**
	 * Starts a recording when the extension's own policy asks for one.
	 *
	 * ## Why this existed nowhere until now
	 *
	 * `extension.record_policy` has been a column, a form control and a compiled
	 * {@link ExtensionPlanNode} field for as long as the queue's and the conference's have, and
	 * those two are honoured — `QueueSession.startRecording` and {@link recordConference}. The
	 * extension's was compiled and then read by nothing, so a tenant who set a desk phone to
	 * "record everything" got no recording and no note saying why. That is the worst shape a
	 * compliance setting can have.
	 *
	 * ## `all` and `inbound`, on the same reading the queue uses
	 *
	 * A call that reaches an extension node is INBOUND to that extension whichever direction the
	 * leg that reached it was travelling, so `inbound` means "record what arrives at this desk".
	 * `outbound` therefore never records here — an extension's outbound calls leave through a trunk
	 * node, which is where that half belongs — and `on-demand` deliberately does not either: that
	 * is the policy that means "the user presses the record key", and pre-empting them would make
	 * the record-toggle feature code a no-op.
	 *
	 * ## After the BRIDGE, best-effort
	 *
	 * Recording is a tap on a bridged conversation, so there is nothing to tap until the two legs
	 * are joined — the same ordering, for the same reason, that `QueueSession` documents. Best-effort for the same
	 * reason the queue's is: a media plane that cannot be tapped is not worth dropping a connected
	 * call over, and a tenant with a legal obligation to record needs the call REFUSED instead,
	 * which is a different setting. Every failure leaves a note, because "why is there no recording
	 * for this call?" is a question that gets asked long afterwards.
	 */
	private async recordExtension(node: ExtensionPlanNode): Promise<void> {
		const policy = node.recordPolicy;
		if (policy !== "all" && policy !== "inbound") {
			return;
		}
		const control = this.deps.control;
		if (control?.startRecording === undefined) {
			this.note(
				`extension ${node.number} has a record policy of "${policy}" and this walk has no call-control port; the call was connected without a recording`,
			);
			return;
		}
		try {
			const outcome = await control.startRecording();
			if (!outcome.ok) {
				this.note(
					`extension ${node.number} has a record policy of "${policy}" and the recording was refused${
						outcome.reason === undefined ? "" : `: ${outcome.reason}`
					}; the call was connected without it`,
				);
			}
		} catch (error) {
			this.note(
				`extension ${node.number} recording could not be started (${String(error)}); the call was connected without it`,
			);
		}
	}

	/**
	 * Whether this particular call is one the screen should be applied to.
	 *
	 * Two gates, and they are gates for different reasons.
	 *
	 * **The setting** ({@link PlanWalkerSettings.callScreeningEnabled}) is off by default and is a
	 * DEPLOYMENT decision, not a tenant one — see the field for why a partially-landed runtime does
	 * not ship on by default.
	 *
	 * **"External"** is a product rule the artifact deliberately does not express (see
	 * `ExtensionPlanNode.callScreening`: internal callers are never screened, and that is not
	 * configurable because it is not a configuration). The definition chosen here is: *the caller's
	 * number does not name an `extension` node in this artifact.* That is what {@link extensionNodeFor}
	 * answers, and it is the same test `*69` uses to decide whether a return call is an on-net `goto`
	 * or an outbound dial — one definition of "one of ours", used twice.
	 *
	 * Its limits, stated rather than discovered:
	 *
	 * - A caller with NO number is treated as external. That is the safe reading — a withheld number
	 *   is exactly the call somebody turns screening on for — but it also means a badly-configured
	 *   trunk that strips caller id would screen every call it delivers.
	 * - The comparison is exact-string. An internal caller whose number reaches this walk in a
	 *   different form from the one compiled onto their extension node (a `+E.164` prefix from an
	 *   inbound route's manipulation, say) reads as external and gets screened. The artifact's number
	 *   index is the thing that would normalise this, and the walk does not carry it.
	 * - It says nothing about TRUST. An external caller is not a hostile one and an internal caller is
	 *   not authenticated by this test; it is a routing fact, and screening is a courtesy feature.
	 */
	private screeningApplies(node: ExtensionPlanNode, input: WalkInput): boolean {
		if (!this.settings.callScreeningEnabled) {
			this.note(
				`extension ${node.number} has call screening configured, but this deployment has the screening runtime switched off; the phone was rung`,
			);
			return false;
		}
		const caller = (input.callerIdNumber ?? this.deps.channel.callerIdNumber)?.trim();
		if (caller === undefined || caller === "") {
			return true;
		}
		return this.extensionNodeFor(caller, input) === undefined;
	}

	/**
	 * Ask an external caller who they are, and let the callee decide.
	 *
	 * ## The shape, and why it is the CONFIRMATION machinery rather than a new one
	 *
	 * A screen is exactly an answer confirmation with a different question. The walker already has
	 * one — {@link ConfirmRequest}, used by ring groups and follow-me — and its contract is precisely
	 * the one screening needs: the callee's leg does not count as ANSWERED until they press the
	 * accept digit, so a refusal falls through the ordinary dial machinery as a leg that never
	 * answered and lands on the extension's own `noAnswerNodeId`. That is the required behaviour for
	 * `2`, for a wrong key, and for silence, with no branch of its own — and it means a screened call
	 * reaches the same mailbox an unanswered one would.
	 *
	 * `attempts: 1`, unlike an ordinary confirmation, and that is the one deliberate difference: a
	 * confirmation re-asks because a mobile in a pocket may have missed the question, whereas a
	 * screen has already played the caller's own voice and the callee has decided. Re-asking would
	 * make `2` mean "ask me again".
	 *
	 * ## What is NOT finished, precisely
	 *
	 * 1. **The caller hears silence while the callee decides.** The leg is ANSWERED (it had to be, to
	 *    record) so there is no ringback, and nothing is played over the gap. The seam is one
	 *    `startMusicOnHold` before the dial and one `stopMusicOnHold` in `bridgeWith`'s
	 *    `beforeBridge` hook — the same pair a transferred leg already uses — and it is not done here
	 *    because `beforeBridge` is currently owned by the orchestrator's transfer path and taking it
	 *    over from inside a node would silently break a transfer that screens.
	 * 2. **The recorded name is never cleaned up.** It is written to the media server's recording
	 *    store under a walk-minted id and nothing deletes it, because the engine has no lifecycle for
	 *    a transient recording — `channel.record.started`/`stopped` exist to hand an object to the
	 *    uploader, which is the opposite of what this needs. The seam is a `kind: "screening"` on the
	 *    recording taxonomy in `packages/events` plus a retention rule, and neither exists.
	 * 3. **A failed recording screens with the intro and no name.** Deliberate: the callee still gets
	 *    the accept/reject question, which is most of the feature, and refusing the call because a
	 *    recording failed would drop calls over a media fault. It is noted on the walk.
	 * 4. **Only the plain dial is screened.** A follow-me ladder outranks screening in the precedence
	 *    chain above, so a user with both gets the ladder and no screen. That is the honest reading of
	 *    "a ladder REPLACES the plain dial" and not an oversight — screening every hop of a ladder
	 *    would ask a mobile to accept a call it is holding to the caller's ear.
	 */
	private async screenCall(node: ExtensionPlanNode, input: WalkInput): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		const recordingId = this.newId();
		const name = await this.recordCallerName(recordingId);
		if (name === undefined) {
			this.note(
				`extension ${node.number}: the screening name recording produced nothing; the callee was asked without it`,
			);
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome = await this.dialSequential(
			[
				{
					endpoint: this.endpointForExtension(node.number),
					label: `extension ${node.number}`,
					destinationNumber: node.number,
					onNet: true,
					timeoutSeconds: node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds,
					delaySeconds: 0,
					callerId: this.callerIdFor(input),
					confirm: {
						media: [
							this.settings.screeningIntroPrompt,
							...(name === undefined ? [] : [name]),
							this.settings.confirmPrompt,
						],
						acceptDigit: this.settings.confirmAcceptDigit,
						// One round. See the method note.
						attempts: 1,
						timeoutMs: Math.max(1, this.settings.confirmTimeoutMs),
					},
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
	 * Records the caller saying their name, and returns it as something the callee's leg can play.
	 *
	 * `recording:<name>` is one of the media server's own schemes — `media-refs.ts` lists it among
	 * `NATIVE_SCHEMES` and passes it through untranslated — so the string this returns is exactly
	 * what a `play` on the CALLEE's channel needs, with no round trip through the object store and
	 * no `MediaRef` that would have to be resolved against a mount that is usually not configured.
	 *
	 * `undefined` means there is no name to play: the recording failed, produced no audio, or the
	 * media server refused it. The screen still runs — see {@link screenCall}.
	 */
	private async recordCallerName(recordingId: string): Promise<string | undefined> {
		await this.deps.execute({ verb: "play", media: this.settings.screeningRecordPrompt });

		const maxSeconds = this.settings.screeningRecordSeconds;
		// Subscribed BEFORE the record call, for the reason every recording path here documents: a
		// very short recording can finish before the HTTP response arrives.
		const finished = this.waitForRecording(recordingId, (maxSeconds + 5) * MILLIS_PER_SECOND);
		try {
			await this.deps.media.record(this.deps.channel.mediaChannelId, {
				name: recordingId,
				format: this.settings.recordingFormat,
				maxDurationSeconds: maxSeconds,
				maxSilenceSeconds: 2,
				beep: true,
				terminateOn: "#",
			});
		} catch (error) {
			finished.cancel();
			this.note(`the screening name recording failed to start: ${String(error)}`);
			return undefined;
		}

		const result = await finished.promise;
		if (result.reason === "failed" || result.durationMs <= 0) {
			return undefined;
		}
		return `recording:${recordingId}`;
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
		const timeoutSeconds =
			hop.timeoutSeconds || node.timeoutSeconds || this.settings.defaultRingTimeoutSeconds;
		const confirm = hop.confirmRequired ? this.confirmRequest() : undefined;

		if (target.kind === "extension") {
			return {
				endpoint: this.endpointForExtension(target.number),
				label: `extension ${target.number}`,
				destinationNumber: target.number,
				onNet: true,
				timeoutSeconds,
				delaySeconds: hop.delaySeconds,
				callerId: this.callerIdFor(input),
				...(confirm === undefined ? {} : { confirm }),
			};
		}

		if (target.kind !== "trunk-dial") {
			this.note(
				`follow-me hop "${hop.destination}" of extension ${node.number} resolves to a ${target.kind} node, which cannot be dialled as a leg; it was skipped`,
			);
			return undefined;
		}

		// The route's own chain, in the same order `trunkDialNode` walks it — weights included, so a
		// tenant's 70/30 split holds for follow-me hops too rather than sending every one of them to
		// whichever carrier happens to sort first. A racing leg takes the head of the chain only:
		// failing over inside one hop of a ladder would stretch that hop past its own timeout and
		// past the hop behind it.
		const trunk = orderTrunkAttempts(target.attempts, this.random)[0];
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
			// The structured target for the SIP edge (§5.1), exactly as `trunkDialNode` sets it. Without
			// it an off-net hop would fall through to an AOR built from the mobile number and be
			// resolved against the tenant's registrations instead of the carrier the compiler chose.
			target: { kind: "trunk", trunkId: trunk.trunkId, number },
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
			...(confirm === undefined ? {} : { confirm }),
		};
	}

	/**
	 * The confirmation this deployment asks for, with a node's own prompt when it has one.
	 *
	 * Assembled once per attempt rather than read out of the settings inside the dial loop, because
	 * the prompt is the one part a ring group may override and the loop should not have to know that.
	 */
	private confirmRequest(promptId?: string): ConfirmRequest {
		return {
			media: [
				resolveMediaRef({ promptId }, this.settings.mediaRefs) ?? this.settings.confirmPrompt,
			],
			acceptDigit: this.settings.confirmAcceptDigit,
			attempts: Math.max(1, this.settings.confirmAttempts),
			timeoutMs: Math.max(1, this.settings.confirmTimeoutMs),
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
			// The compiler has already folded the group's own switch into every member
			// (`member.confirmRequired || group.confirmEnabled`); the group field is read again here
			// only so an artifact written before that fold still confirms.
			const confirm =
				member.confirmRequired || node.confirmEnabled
					? this.confirmRequest(node.confirmPromptId)
					: undefined;
			attempts.push({
				endpoint: this.endpointForExtension(target.number),
				label: `extension ${target.number}`,
				destinationNumber: target.number,
				onNet: true,
				timeoutSeconds:
					member.timeoutSeconds ||
					node.ringTimeoutSeconds ||
					this.settings.defaultRingTimeoutSeconds,
				delaySeconds: member.delaySeconds,
				callerId: this.callerIdFor(input, node.callerIdNamePrefix),
				...(confirm === undefined ? {} : { confirm }),
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

	// -------------------------------------------------------------------------------------------
	// Shared lines
	// -------------------------------------------------------------------------------------------

	/**
	 * A call to a shared line.
	 *
	 * ## It fans out like a ring group and then does the thing a ring group cannot
	 *
	 * Every appearance rings, because a shared line IS one line on several desks. What makes it a
	 * shared line rather than a ring group is what happens at the answer: the line is a single
	 * SEIZABLE resource, so the appearance that answered takes it and every other appearance's lamp
	 * goes remote-active. The seizure is a compare-and-set in the `shared-line-state` bucket, which
	 * is what makes "two appearances can never hold one line" hold across engine instances rather
	 * than merely within one — see `shared-line-registry.ts`.
	 *
	 * ## Losing the seizure is not the same as nobody answering
	 *
	 * An appearance can answer and still lose the line, to another appearance on another instance
	 * that answered a few milliseconds earlier. That leg is hung up rather than bridged: bridging it
	 * would put two callers on one line, which is the exact split the registry exists to prevent. The
	 * caller hears busy, because from their side the line was taken.
	 *
	 * ## Barge-in decides what a call to an already-seized line means
	 *
	 * With `bargeInEnabled` off — the default, and the only behaviour this wave implements — a call
	 * to a line somebody is already on is refused with `USER_BUSY` before anything rings. That is the
	 * behaviour of every key system this feature is modelled on, and it is the half a walk can
	 * honestly deliver. Barging INTO the existing call is a mid-call operation on somebody else's
	 * bridge: it needs `call-control.ts`, not a walk, and a walk that pretended to do it by ringing
	 * the appearances again would produce a second, separate call on a line that is supposed to have
	 * one. So a barge-in-enabled line is noted and rung as if the seizure were not there, which is
	 * the closest correct answer available here, and the note says what is missing.
	 *
	 * ## What is NOT here, and where it belongs
	 *
	 * Hold, retrieve-from-another-appearance and the hold-recall timer are all mid-call: they happen
	 * after this walk has handed the call to the orchestrator, on `hold`/`unhold` events it owns.
	 * `SharedLineRegistry` has `hold`, `armRecall` and `cancelRecall` written and tested for exactly
	 * that, and the seam is one subscription in `apps/engine/src/calls`. The same file owns the
	 * RELEASE on call end, which is why this node releases only the seizure it took and could not
	 * use.
	 */
	private async sharedLineNode(node: SharedLinePlanNode, input: WalkInput): Promise<StepResult> {
		const lines = this.deps.sharedLines;
		if (lines === undefined) {
			this.note(
				`shared line "${node.sharedLineId}" was reached but this walk has no shared-line registry`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		const orgId = this.deps.channel.organizationId;
		const existing = lines.held(orgId, node.sharedLineId);
		// A HELD line dialled from another appearance is a RETRIEVE, not a new call. It is checked
		// before the barge-in question because it is a different question: barge-in is joining a
		// conversation somebody is having, and this is picking up one nobody is currently on.
		if (existing?.state === "held" && lines.retrieve !== undefined) {
			const retrieved = await lines.retrieve(orgId, node.sharedLineId);
			if (retrieved.retrieved) {
				this.note(`shared line "${node.sharedLineId}" was retrieved from hold by this appearance`);
				return { kind: "bridged" };
			}
			this.note(
				`shared line "${node.sharedLineId}" is on hold and could not be retrieved${
					retrieved.reason === undefined ? "" : `: ${retrieved.reason}`
				}`,
			);
			return this.branch(node.timeoutNodeId, "USER_BUSY");
		}
		if (existing !== undefined && !node.bargeInEnabled) {
			this.note(
				`shared line "${node.sharedLineId}" is already seized${
					existing.heldByExtensionId === undefined
						? ""
						: ` by extension ${existing.heldByExtensionId}`
				} and does not allow barge-in`,
			);
			return this.branch(node.timeoutNodeId, "USER_BUSY");
		}
		if (existing !== undefined) {
			this.note(
				`shared line "${node.sharedLineId}" allows barge-in, which needs a mid-call join this walk cannot make; the appearances were rung as a new call instead`,
			);
		}

		const attempts: DialAttempt[] = [];
		const appearances: SharedLineAppearance[] = [];
		for (const appearance of [...node.appearances].sort(
			(left, right) => left.appearanceIndex - right.appearanceIndex,
		)) {
			const target = input.plan.nodes[appearance.targetNodeId];
			if (target === undefined || target.kind !== "extension") {
				this.note(
					`shared line "${node.sharedLineId}" appearance ${String(appearance.appearanceIndex)} is not an extension (${target?.kind ?? "missing"}); skipped`,
				);
				continue;
			}
			appearances.push(appearance);
			attempts.push({
				endpoint: this.endpointForExtension(target.number),
				label: `shared line appearance ${String(appearance.appearanceIndex)} (${target.number})`,
				destinationNumber: target.number,
				onNet: true,
				timeoutSeconds: node.ringTimeoutSeconds || this.settings.defaultRingTimeoutSeconds,
				// Zero on every appearance, even under `sequential`: the compiler carries no per-hop
				// delay for a shared line, and inventing one here would stagger a line whose whole point
				// is that every key lights at once.
				delaySeconds: 0,
				callerId: this.callerIdFor(input),
			});
		}

		if (attempts.length === 0) {
			this.note(`shared line "${node.sharedLineId}" has no dialable appearances`);
			return this.branch(node.timeoutNodeId, "NO_ANSWER");
		}

		await this.deps.execute({ verb: "ringing" });
		this.deps.channel.moveTo("executing");

		const outcome =
			node.strategy === "sequential"
				? await this.dialSequential(attempts, [])
				: await this.dialSimultaneous(
						attempts,
						node.ringTimeoutSeconds || this.settings.defaultRingTimeoutSeconds,
					);

		if (outcome.kind !== "answered") {
			return await this.settleDial(outcome, { noAnswerNodeId: node.timeoutNodeId });
		}

		const answered = appearances[outcome.index];
		if (answered === undefined) {
			// The dial answered on an index this walk did not build an appearance for, which can only
			// be a defect here. Bridging anyway would put a call on an unseized line.
			this.note(
				`shared line "${node.sharedLineId}" answered on appearance index ${String(outcome.index)}, which is not in the fan-out`,
			);
			await this.hangupQuietly(outcome.mediaChannelId, "NORMAL_TEMPORARY_FAILURE");
			return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
		}

		const seized = await lines.seize(orgId, node.sharedLineId, {
			extensionId: answered.extensionId,
			appearanceIndex: answered.appearanceIndex,
			callId: this.deps.channel.callId,
			legId: this.deps.channel.channelId,
		});
		if (!seized.won) {
			this.note(
				`shared line "${node.sharedLineId}" was seized by another appearance before ${answered.extensionNumber} could take it${
					seized.reason === undefined ? "" : `: ${seized.reason}`
				}`,
			);
			await this.hangupQuietly(outcome.mediaChannelId, "USER_BUSY");
			return this.branch(node.timeoutNodeId, "USER_BUSY");
		}

		this.note(
			`shared line "${node.sharedLineId}" was seized by appearance ${String(answered.appearanceIndex)} (extension ${answered.extensionNumber})`,
		);
		const bridged = await this.bridgeWith(outcome.mediaChannelId);
		if (bridged.kind !== "bridged") {
			// The seizure this walk took can never become a call, so it is given back here. A seizure
			// that outlived its call is a line every appearance sees as busy and nobody is on.
			await lines.releaseOwn(orgId, node.sharedLineId);
		}
		return bridged;
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
		// Failover tiers in `order`, and within a tier the share the tenant bought. See
		// `trunk-selection.ts` for why a weight is sampled rather than sorted.
		const attempts = orderTrunkAttempts(node.attempts, this.random);
		if (attempts.length === 0) {
			this.note(`trunk-dial node "${node.id}" has no trunks configured`);
			return this.branch(node.failoverNodeId, "NETWORK_OUT_OF_ORDER");
		}

		// The spend/velocity/geo gate, ahead of the PIN prompt on purpose: a call this organization
		// has decided it will not place should be refused without first making the caller enter a
		// code for it. It is also ahead of the first INVITE and ahead of `ringing`, for the reason
		// spelled out below.
		if (this.deps.tollFraudGuard !== undefined) {
			const verdict = await this.deps.tollFraudGuard.authorize({
				organizationId: this.deps.channel.organizationId,
				// The CALLER's number, which is the extension a per-extension override belongs to.
				...(input.callerIdNumber === undefined ? {} : { extensionNumber: input.callerIdNumber }),
				dialedNumber: number,
				now: this.deps.now?.() ?? Date.now(),
			});
			if (verdict.kind === "refuse") {
				this.note(verdict.detail);
				this.log("an outbound call was refused by the toll-fraud policy", {
					reason: verdict.reason,
					dialedNumber: number,
				});
				return this.branch(node.failoverNodeId, TOLL_FRAUD_REFUSAL_CAUSE);
			}
		}

		// The authorisation gate, before the first INVITE and before `ringing`. Both halves of that
		// ordering matter: a code collected after the carrier has been offered the call is a code
		// collected too late to stop it, and a caller who hears ringback and is then asked for a PIN
		// has been told the call is going through.
		const authorized = await this.challengeOutboundPin(node, number);
		if (authorized.kind === "denied") {
			return authorized.result;
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

			// Before the INVITE, never after: a burst of simultaneous dials that all checked a count
			// they then went on to increase would every one of them pass a full trunk.
			const reservation = this.deps.trunkCapacity?.reserve(
				this.deps.channel.organizationId,
				attempt.trunkId,
				attempt.maxChannels,
			);
			if (this.deps.trunkCapacity !== undefined && reservation === undefined) {
				this.note(
					`trunk ${attempt.name} is at its ${String(attempt.maxChannels)}-channel ceiling; the call was not offered to it`,
				);
				this.log("a trunk was skipped at its channel ceiling", {
					trunk: attempt.name,
					maxChannels: attempt.maxChannels,
				});
				// A retryable cause on purpose: being full is exactly the condition the next trunk in
				// the chain exists for, and a chain of full trunks ends on the route's own failover
				// branch with a congestion cause a carrier and a report both understand.
				lastCause = "SWITCH_CONGESTION";
				continue;
			}

			const outcome = await this.dialOne(
				{
					endpoint: this.settings.trunkDialTemplate
						.replaceAll("{number}", number)
						.replaceAll("{trunk}", attempt.name),
					// The structured target for the SIP edge (§5.1): the trunk row's id, which the edge
					// resolves against its own trunk directory, plus the E.164 being dialled. The Asterisk
					// plane ignores it and dials `endpoint`.
					target: { kind: "trunk", trunkId: attempt.trunkId, number },
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
					// Never on the emergency path. A dispatcher who cannot see who is calling cannot
					// call back a caller who drops, which is the whole reason the ELIN outranks every
					// other identity here.
					...(emergency || input.callerIdPresentation === undefined
						? {}
						: { callerIdPresentation: input.callerIdPresentation }),
				},
				0,
			);

			if (outcome.kind === "answered") {
				// Handed to the leg: from here the channel is spent until the leg ends, and the
				// orchestrator returns it in `onLegEnded`.
				reservation?.bindTo(outcome.mediaChannelId);
				const bridged = await this.bridgeWith(outcome.mediaChannelId);
				if (bridged.kind === "bridged") {
					await this.recordOutboundRoute(node);
				}
				return bridged;
			}
			reservation?.release();
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
	 * Starts a recording when the OUTBOUND ROUTE asks for one.
	 *
	 * ## Why this existed nowhere until now
	 *
	 * `outbound_route.record_enabled` has been a column, a form control and a compiled
	 * {@link TrunkDialPlanNode} field since the routing package was written, and it was read by
	 * nothing. A tenant who ticked "record outbound calls" got no recording and no note saying why —
	 * the same shape of defect as the extension policy closed above it, and worse in one respect:
	 * outbound is the direction with the most one-party-consent exposure, so the estates that tick it
	 * are the estates that need it.
	 *
	 * ## Through the same gate, deliberately
	 *
	 * `WalkerCallControl.startRecording` is the single seam — the record-toggle feature code, the
	 * extension policy, the queue and the conference all go through it — because that is what applies
	 * the CONSENT policy: the announcement to the far end, the accept/decline digits, the consent
	 * record on the leg and in the CDR. A route that started a recorder of its own would produce
	 * audio with no consent row behind it, which is the one recording a compliance review cannot use.
	 *
	 * ## After the BRIDGE, best-effort
	 *
	 * Same ordering and the same best-effort rule as {@link recordExtension}: a recording is a tap on
	 * a bridged conversation, and a media plane that cannot be tapped is not worth dropping a
	 * connected call over. Every failure leaves a note.
	 *
	 * No `autoPauseOnDtmf` argument: a route has no column for it, so the orchestrator's own
	 * resolution — the destination extension's flag, then the organization default — is the honest
	 * answer, and passing `false` here would silently override a tenant's PCI setting. `direction`
	 * IS passed, because a route knows something the leg does not.
	 */
	private async recordOutboundRoute(node: TrunkDialPlanNode): Promise<void> {
		if (!node.recordEnabled) {
			return;
		}
		const control = this.deps.control;
		if (control?.startRecording === undefined) {
			this.note(
				`outbound route ${node.outboundRouteId} is set to record and this walk has no call-control port; the call was connected without a recording`,
			);
			return;
		}
		try {
			// `outbound` stated rather than inferred: see `WalkerCallControl.startRecording`. Without it
			// the consent policy reads this leg as `internal` and never announces to the party being
			// called, which on an outbound recorded call is the only party owed the announcement.
			const outcome = await control.startRecording({ direction: "outbound" });
			if (!outcome.ok) {
				this.note(
					`outbound route ${node.outboundRouteId} is set to record and the recording was refused${
						outcome.reason === undefined ? "" : `: ${outcome.reason}`
					}; the call was connected without it`,
				);
			}
		} catch (error) {
			this.note(
				`outbound route ${node.outboundRouteId} recording could not be started (${String(error)}); the call was connected without it`,
			);
		}
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
				...(this.deps.channel.deviceId === undefined
					? {}
					: { deviceId: this.deps.channel.deviceId }),
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
	/**
	 * Hands the call to a named external application and waits for it to finish.
	 *
	 * ## The three outcomes, and why one of them is an announcement
	 *
	 * `unavailable` — nobody has claimed this application, or the control plane could not be reached
	 * — takes the destination's failure path, which on this platform is an announcement and a hangup
	 * with `FACILITY_NOT_IMPLEMENTED`. That choice is the whole reason the session protocol's
	 * registration is a NATS subject rather than a directory: a claim that does not exist produces
	 * `no responders available` synchronously, so the caller hears the announcement immediately
	 * instead of after a request timeout. Dead air is never an outcome here.
	 *
	 * `hangup` is the application ending the call, with the cause it chose, so a CDR reads
	 * `CALL_REJECTED` when the integration rejected the caller rather than `NORMAL_CLEARING` for
	 * everything.
	 *
	 * `aborted` is the leg going away underneath the application — the caller hung up, or the media
	 * server dropped the channel. There is nothing left to walk, and no verb to send.
	 *
	 * ## The leg is NOT answered first
	 *
	 * Unlike `conference` or `voicemail`, which cannot work on an unanswered leg, an application is
	 * given the call exactly as it found it and decides for itself. That is the point of the
	 * `answered` field on the announcement: a screen-pop integration wants to inspect the caller and
	 * hand the call on WITHOUT answering, because answering starts billing a caller for a call they
	 * never got. Pre-answering here would take that decision away and would make an
	 * `application` destination more expensive than the dial plan it replaced.
	 */
	private async applicationNode(node: ApplicationPlanNode): Promise<StepResult> {
		const application = this.deps.application;
		if (application === undefined) {
			this.note(
				`application "${node.application}" was reached but this walk has no session runtime; announced and hung up`,
			);
			return await this.announceAndHangup(
				this.settings.unavailableAnnouncement,
				"FACILITY_NOT_IMPLEMENTED",
			);
		}

		this.note(`handing the call to application "${node.application}"`);
		const outcome = await application.run({
			application: node.application,
			// The plan models `args` as `string | number | boolean`; the wire carries text. Flattened
			// here rather than in the runtime because this is where the plan's type is still visible.
			...(node.args === undefined
				? {}
				: {
						arguments: Object.fromEntries(
							Object.entries(node.args).map(([key, value]) => [key, String(value)]),
						),
					}),
		});

		switch (outcome.kind) {
			case "unavailable": {
				this.note(`application "${node.application}" did not take the call: ${outcome.reason}`);
				return await this.announceAndHangup(
					this.settings.unavailableAnnouncement,
					"FACILITY_NOT_IMPLEMENTED",
				);
			}
			case "aborted": {
				this.note(`the leg went away while application "${node.application}" held it`);
				return { kind: "aborted" };
			}
			default: {
				this.note(`application "${node.application}" ended the call with ${outcome.cause}`);
				return { kind: "hangup", cause: outcome.cause };
			}
		}
	}

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
		if (joined.kind === "locked") {
			// A DIFFERENT announcement from the full one, and that is the whole reason the lock is a
			// separate result: a full room admits this caller the moment somebody leaves, and a locked
			// one does not admit them until the meeting is over. Telling them the same thing would have
			// them redialling for an hour.
			this.note(
				`conference room ${node.roomNumber} is locked; the caller was refused with ${String(joined.memberCount)} in the room`,
			);
			return await this.announceAndHangup(
				this.settings.conferenceLockedAnnouncement,
				"CALL_REJECTED",
			);
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
			await registry.leave(
				node.conferenceId,
				this.deps.channel.mediaChannelId,
				this.deps.channel.organizationId,
			);
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
			await registry.leave(
				node.conferenceId,
				this.deps.channel.mediaChannelId,
				this.deps.channel.organizationId,
			);
			// Only for the member that opened the room. Everyone else's failed add leaves a bridge the
			// rest of the meeting is still talking in, and destroying that would end it for them.
			if (joined.created) {
				await this.destroyBridgeQuietly(bridgeId);
			}
			this.log("failed to join a conference bridge", { bridgeId, err: String(error) });
			this.note(`joining conference room ${node.roomNumber} failed: ${String(error)}`);
			return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
		}

		this.deps.channel.setBridge(bridgeId);
		this.deps.channel.moveTo("exchanging-media");

		const room = registry.room(node.conferenceId, this.deps.channel.organizationId);
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

		// The arrival, HEARD. Ordered after the media join and after the event, so a room hears the
		// beep for somebody who is actually in it — a tone played before the bridge join would announce
		// a participant whose media add then failed.
		await this.announceConferenceArrival(node, bridgeId, "join");

		await this.recordConference(node, joined.created);

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
	 * Beeps the room, and says somebody came or went.
	 *
	 * ## Into the ROOM, not at the caller
	 *
	 * The media reference is played at the BRIDGE, not at this leg, which is what makes it an
	 * announcement rather than a private noise: everybody already in the meeting is the audience, and
	 * the arriving participant hearing their own beep is a side effect of being in the bridge by then.
	 * The ARI driver plays into a bridge directly; `mediad` mixes a playback into the room the same
	 * way. Both are `MediaPort.play` addressed at the bridge id.
	 *
	 * ## The tone and the announcement are two settings and two costs
	 *
	 * `entryToneEnabled` is a quarter of a second of generated audio and needs nothing mounted.
	 * `announceJoinLeave` is a spoken clause and needs a prompt package. A large room usually wants
	 * the first and not the second — which is a preference `conference.announce_join_leave` alone
	 * could not express, and is why the columns are separate.
	 *
	 * ## What is NOT announced, and the seam for it
	 *
	 * The participant's NAME. Announcing "Priya has joined" needs a recording of Priya saying so,
	 * captured at the gate before the room is entered and kept for the life of the meeting — a record
	 * step in `challengeConferencePin`, a per-member media ref on `ConferenceMember`, and a decision
	 * about where the clip lives. This release plays the stock generic form instead, which is what
	 * `conf-hasjoin` says, and says so here rather than shipping a flag that does less than its name.
	 *
	 * Never throws. A beep that could not be played is a meeting that carries on; failing the join
	 * over its sound effect would drop a participant to protect an announcement.
	 */
	private async announceConferenceArrival(
		node: ConferencePlanNode,
		bridgeId: string,
		event: "join" | "leave",
	): Promise<void> {
		const joining = event === "join";
		const media: string[] = [];
		// `!== false` and not `=== true`: the flags default ON at every layer, and the compiler emits
		// them only when a tenant switched them off. An artifact from before the columns existed must
		// beep — a participant who cannot tell a third party arrived is one who does not know the
		// conversation stopped being private.
		if ((joining ? node.entryToneEnabled : node.exitToneEnabled) !== false) {
			media.push(joining ? this.settings.conferenceEntryTone : this.settings.conferenceExitTone);
		}
		if (node.announceJoinLeave !== false) {
			media.push(
				joining
					? this.settings.conferenceJoinAnnouncement
					: this.settings.conferenceLeaveAnnouncement,
			);
		}
		if (media.length === 0) {
			return;
		}

		try {
			await this.deps.media.play(bridgeId, { media, playbackRef: this.newId() });
		} catch (error) {
			// Noted rather than swallowed, because "the beeps stopped working" is a question somebody
			// asks about a room and a silent catch is not an answer to it.
			this.note(
				`conference room ${node.roomNumber} could not play its ${event} announcement: ${String(error)}`,
			);
		}
	}

	/**
	 * Starts the room's recording, when the tenant asked for one and this is the member who opens it.
	 *
	 * ## Once per ROOM, not once per participant
	 *
	 * `created` is the gate, and it is the registry's answer to "is this instance now responsible for
	 * a bridge?". A recording per participant would produce N files of one meeting, N retention
	 * clocks and N signed URLs for the same audio — and, worse, N copies of every other participant's
	 * voice, since each one records the whole mix.
	 *
	 * The consequence is stated rather than hidden: on a room split across instances, EACH instance's
	 * first joiner opens a recording, so a cluster produces one file per participating instance. That
	 * is a real limitation of recording a jointly-held room from its members, and the fix is a
	 * recorder that is a member of the room in its own right — the seam is `ConferenceClaim` growing
	 * a `recorderInstanceId` the first writer takes and every other instance defers to.
	 *
	 * ## Which policies record, and why three of five behave alike
	 *
	 * `all`, `inbound` and `outbound` all record. Every leg in a conference is inbound TO the room,
	 * so there is no outbound half to leave out — the values are accepted because the vocabulary is
	 * shared with `extension` and `queue`, and refusing three of five on one table would be a second,
	 * narrower vocabulary wearing the same name. `on-demand` deliberately does NOT start one: it
	 * means "somebody presses the record key", and the key is a mid-call feature that already works.
	 *
	 * BEST-EFFORT, exactly as a queue's is, and for the same reason with the same caveat: a media
	 * plane that cannot record is not worth dropping a meeting over, and a tenant with a legal
	 * obligation to record needs the call REFUSED instead — which is a different setting and a
	 * different conversation with the operator.
	 */
	private async recordConference(node: ConferencePlanNode, created: boolean): Promise<void> {
		const policy = node.recordPolicy;
		if (policy === "none" || policy === "on-demand") {
			return;
		}
		if (!created) {
			// Somebody already opened it. Not a failure and not worth a note: this is every participant
			// after the first, on every recorded room.
			return;
		}

		const control = this.deps.control;
		if (control?.startRecording === undefined) {
			// A tenant who ticked "record this room" and finds no recording has a compliance problem,
			// and a note in the call log is the difference between finding out now and finding out at
			// the hearing.
			this.note(
				`conference room ${node.roomNumber} has a record policy of "${policy}" and this walk has no call-control port; the room was opened without a recording`,
			);
			return;
		}

		try {
			const outcome = await control.startRecording();
			if (!outcome.ok) {
				this.note(
					`conference room ${node.roomNumber} has a record policy of "${policy}" and the recording was refused${
						outcome.reason === undefined ? "" : `: ${outcome.reason}`
					}; the room was opened without it`,
				);
			}
		} catch (error) {
			this.note(
				`conference room ${node.roomNumber} recording could not be started (${String(error)}); the room was opened without it`,
			);
		}
	}

	/**
	 * The outbound route's authorisation-code gate.
	 *
	 * ## What it is for, and why it fails CLOSED where the compiler fails open
	 *
	 * A PIN on an outbound route is a spending control: it is the difference between "anyone who can
	 * reach a handset can dial Paraguay" and "anyone who knows the code can". So the runtime refuses
	 * the call on a wrong code, on an unreadable digest, and on exhausted attempts.
	 *
	 * That is the OPPOSITE of what the compiler does with the same data, and the two are not in
	 * conflict — they are refusing different things. `compilePinSet` fails OPEN: a set that is
	 * missing, disabled, or whose every digest this release cannot parse produces a warning and NO
	 * gate, because taking a tenant's phones down to protect a gate they can re-create in a form is
	 * the worse outcome. But once a gate has been compiled, the artifact is asserting that this route
	 * is gated, and a runtime that then waved a caller through on a digest it could not read would
	 * make the gate decorative. `CompiledPinSet.entries` is documented as never empty for exactly
	 * this reason: by the time it reaches here, every entry is one the compiler could read.
	 *
	 * ## The attempt budget is the tenant's, not the platform's
	 *
	 * `maxAttempts` and `digitTimeoutMs` come off the set, because how many guesses an international
	 * calling code is worth is a decision somebody made in a form. Only the digit CEILING is a
	 * platform fact, and it exists so a caller leaning on a key cannot make the gather run forever.
	 *
	 * ## The call is not answered to ask
	 *
	 * {@link ensureAnswered} is called, because a gather on an unanswered leg collects nothing —
	 * this is a gate the caller has to interact with, unlike the concurrency ceiling the orchestrator
	 * refuses at the door without answering. The cost is that a refused call is a connected call in
	 * the tenant's own CDR, which is correct here: the caller reached the system and was told no.
	 */
	private async challengeOutboundPin(
		node: TrunkDialPlanNode,
		number: string,
	): Promise<
		{ readonly kind: "granted" } | { readonly kind: "denied"; readonly result: StepResult }
	> {
		const set = node.pinSet;
		if (set === undefined) {
			return { kind: "granted" };
		}
		if (!(await this.ensureAnswered())) {
			return { kind: "denied", result: { kind: "aborted" } };
		}

		const prompt =
			resolveMediaRef({ promptId: set.promptId }, this.settings.mediaRefs) ??
			this.settings.outboundPinPrompt;

		for (let attempt = 0; attempt < Math.max(1, set.maxAttempts); attempt += 1) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "denied", result: { kind: "aborted" } };
			}

			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: this.settings.outboundPinMaxDigits,
				terminators: ["#"],
				timeoutMs: set.digitTimeoutMs,
				interDigitTimeoutMs: this.settings.outboundPinInterDigitTimeoutMs,
				media: prompt,
			});
			if (result === undefined) {
				return { kind: "denied", result: { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" } };
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "denied", result: { kind: "aborted" } };
			}

			const digits = collection?.digits.join("") ?? "";
			const matched = await this.matchPinEntry(set, digits);
			if (matched.kind === "matched") {
				// Reported BEFORE the dial, for the reason `onDestination` is: the call may end in any
				// number of ways from here, and the CDR must already know which code paid for it.
				await this.deps.onPinAuthorization?.({
					pinSetId: set.pinSetId,
					pinSetEntryId: matched.entry.pinSetEntryId,
					ordinal: matched.entry.ordinal,
					...(matched.entry.label === undefined ? {} : { label: matched.entry.label }),
				});
				this.log("an authorisation code opened an outbound route", {
					pinSet: set.name,
					ordinal: matched.entry.ordinal,
				});
				return { kind: "granted" };
			}
			if (matched.kind === "unreadable") {
				// A defect and not a wrong guess: the compiler refuses to embed a digest it cannot read,
				// so reaching here means the artifact came from something that skipped that check.
				// Retrying would only burn the caller's remaining attempts against a broken gate.
				this.note(
					`PIN set "${set.name}" carries a digest this release cannot verify (${matched.failure}); the route was refused`,
				);
				return {
					kind: "denied",
					result: await this.announceAndHangup(
						this.settings.unavailableAnnouncement,
						"NORMAL_TEMPORARY_FAILURE",
					),
				};
			}
			await this.deps.execute({ verb: "play", media: this.settings.outboundPinInvalidPrompt });
		}

		// `CALL_REJECTED` and not `NORMAL_CLEARING`: a report that cannot tell a refused authorisation
		// from a caller who changed their mind cannot answer "is somebody guessing our codes?".
		this.note(
			`the call to ${number} failed ${String(set.maxAttempts)} authorisation-code attempts against PIN set "${set.name}"`,
		);
		const failure =
			resolveMediaRef({ promptId: set.failurePromptId }, this.settings.mediaRefs) ??
			this.settings.outboundPinFailurePrompt;
		return { kind: "denied", result: await this.announceAndHangup(failure, "CALL_REJECTED") };
	}

	/**
	 * The entered digits against every code in the set, in ordinal order.
	 *
	 * Every entry is checked even after one has matched — no early `break` on the FIRST match beyond
	 * returning it — because the loop must not exit early on a MISS either: an implementation that
	 * returned as soon as one digest mismatched would only ever accept code number one. An empty
	 * entry is refused without a KDF call, which is `verifyPinDigest`'s own `empty-pin` answer and is
	 * repeated here so a caller who pressed `#` immediately does not consume scrypt work per code.
	 */
	private async matchPinEntry(
		set: CompiledPinSet,
		digits: string,
	): Promise<
		| { readonly kind: "matched"; readonly entry: CompiledPinEntry }
		| { readonly kind: "mismatch" }
		| { readonly kind: "unreadable"; readonly failure: string }
	> {
		if (digits === "") {
			return { kind: "mismatch" };
		}
		for (const entry of set.entries) {
			const verified = await verifyPinDigest(digits, entry.pinHash);
			if (verified.ok) {
				return { kind: "matched", entry };
			}
			if (verified.failure === "malformed-hash" || verified.failure === "kdf-error") {
				return { kind: "unreadable", failure: verified.failure };
			}
		}
		return { kind: "mismatch" };
	}

	/**
	 * A remote audio source, and the fallback that is the whole point of the node.
	 *
	 * ## This announces nothing and never hangs up
	 *
	 * Every other "we cannot do this" path in this walker ends in {@link announceAndHangup}. This one
	 * ends in a `goto`, because `StreamPlanNode.fallbackNodeId` is NOT optional — the compiler
	 * requires it precisely so that a source no media server can open produces a ROUTED call rather
	 * than an announcement. A caller who reached a shop-radio node whose stream is down should hear
	 * the shop's IVR, not "the number you have dialled is not available".
	 *
	 * ## Why the fallback is taken today, always
	 *
	 * `resolveMediaRefOrExplain` refuses every `http(s)` source, and that refusal was verified
	 * against both drivers rather than assumed — the reason is on that function. So this runtime is,
	 * for now, an honest recording of an unplayable source: it resolves, notes exactly why the
	 * platform cannot open it, and branches. That is a different thing from the node kind having no
	 * case at all, which is what it had before: the walk used to fall into the unimplemented arm,
	 * announce "unavailable" and HANG UP, discarding a fallback branch the tenant configured.
	 *
	 * When the remote-fetch rung lands behind the seam in `media-refs.ts`, the resolution starts
	 * coming back `playable` and this method plays it. Nothing else here changes.
	 */
	private async streamNode(node: StreamPlanNode): Promise<StepResult> {
		const resolution = resolveMediaRefOrExplain(node.url, this.settings.mediaRefs);
		if (resolution.kind === "unplayable") {
			this.note(
				`audio stream ${node.audioStreamId} could not be played (${resolution.reason}); the call took the stream's fallback`,
			);
			return { kind: "goto", nodeId: node.fallbackNodeId };
		}

		// Only when the source is actually playable. Answering first and then discovering we cannot
		// play would bill the tenant for a connected call that produced nothing but a branch.
		if (node.answerFirst && !(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}

		const played = await this.deps.execute({ verb: "play", media: resolution.media });
		if (played === undefined) {
			this.note(
				`audio stream ${node.audioStreamId} failed to play; the call took the stream's fallback`,
			);
		}
		// The fallback is taken when the stream ENDS too, not only when it fails — `maxSeconds` of
		// zero means "until the caller hangs up", and a caller who is still there when a finite
		// stream finishes must go somewhere rather than sit in silence.
		return { kind: "goto", nodeId: node.fallbackNodeId };
	}

	/**
	 * Dial by name: spell a colleague, hear who matched, press a digit, get connected.
	 *
	 * Modelled on {@link ivrMenuNode} — answer, gather with the prompt riding the gather so barge-in
	 * works, budget the failures, branch on exhaustion — and different from it in the one way that
	 * makes this feature possible at all: the LIST is compiled. `DialByNamePlanNode.entries` is
	 * sorted by `digits`, so matching is a prefix scan over an array rather than a query, which is
	 * what lets the engine answer "who is S-M-I" while holding no database handle.
	 *
	 * ## Every name that is offered can be spoken
	 *
	 * This platform has no text-to-speech, so a directory that offered an entry it could not SAY
	 * would produce "for, press one" — which is worse than not offering the person. The compiler
	 * already drops extensions whose mailbox never recorded a name (`directory-entry-skipped`), so
	 * `DirectoryEntry.nameMedia` is documented as never absent. It can still fail to RENDER on a
	 * deployment whose object store is not mounted, and that case is skipped here with a note naming
	 * the entry rather than played as silence.
	 *
	 * ## Why a bounded number of matches is offered
	 *
	 * A caller who typed one letter in a company of four hundred should be asked for more letters,
	 * not read four hundred names. The compiler cannot make that call — it does not know how long an
	 * audience will listen — so it compiles everyone and `directoryMaxOffers` decides how many one
	 * round reads out.
	 */
	private async dialByNameNode(node: DialByNamePlanNode): Promise<StepResult> {
		if (!(await this.ensureAnswered())) {
			return { kind: "aborted" };
		}
		if (node.entries.length === 0) {
			// The compiler warns `empty-directory` for this and still emits the node, because a
			// directory whose every member lost their recorded name is a real state. Announce rather
			// than gather: asking somebody to spell a name that can match nobody is a worse minute.
			this.note(
				`directory ${node.directoryId} has no entries that can be spoken; announced and hung up`,
			);
			return await this.announceAndHangup(
				this.settings.directoryNoMatchPrompt,
				"NO_ROUTE_DESTINATION",
			);
		}

		let failures = 0;
		let attempt = 0;

		while (failures <= node.maxFailures) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}

			const greeting =
				attempt === 0
					? (resolveMediaRef({ promptId: node.greetingPromptId }, this.settings.mediaRefs) ??
						this.settings.directoryGreeting)
					: this.settings.directoryInstructions;
			attempt += 1;

			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: this.settings.directoryMaxDigits,
				terminators: ["#"],
				timeoutMs: this.settings.directoryTimeoutMs,
				interDigitTimeoutMs: this.settings.directoryInterDigitTimeoutMs,
				media: greeting,
			});
			if (result === undefined) {
				return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "aborted" };
			}

			const digits = collection?.digits.join("") ?? "";
			// Too few digits and no digits are the same failure with different causes, and both are
			// answered the same way: too few letters cannot narrow a directory, and the caller has to
			// be asked again either way.
			const matches =
				digits.length < node.minDigits
					? []
					: node.entries.filter((entry) => entry.digits.startsWith(digits));

			if (matches.length === 0) {
				failures += 1;
				if (failures > node.maxFailures) {
					break;
				}
				await this.playPrompt(node.invalidPromptId);
				if (node.invalidPromptId === undefined) {
					await this.deps.execute({
						verb: "play",
						media: this.settings.directoryNoMatchPrompt,
					});
				}
				continue;
			}

			const offered = await this.offerDirectoryMatches(
				matches.slice(0, this.settings.directoryMaxOffers),
			);
			if (offered.kind === "selected") {
				return { kind: "goto", nodeId: offered.entry.targetNodeId };
			}
			if (offered.kind === "aborted") {
				return { kind: "aborted" };
			}
			if (offered.kind === "failed") {
				return { kind: "hangup", cause: "NORMAL_TEMPORARY_FAILURE" };
			}

			// Everyone offered, nobody accepted. That is a failed round, not a hangup: the caller may
			// have spelt the wrong name, and asking again is what a receptionist would do.
			failures += 1;
			if (failures > node.maxFailures) {
				break;
			}
		}

		// Out of attempts. The timeout branch when the tenant configured one, and otherwise a cause
		// that says what happened — never `NORMAL_CLEARING`, which reads as "the caller hung up".
		this.note(
			`directory ${node.directoryId} was left after ${String(failures)} unsuccessful attempts`,
		);
		return this.branch(node.timeoutNodeId, "NO_USER_RESPONSE");
	}

	/**
	 * Reads out each match and waits for the accept digit.
	 *
	 * The sentence is assembled the way `app_directory` assembles it — the recorded name, "please
	 * press", the digit, "to select this person" — because the verb surface plays one media per
	 * `play` and because building it from those parts means the accept digit is configurable without
	 * re-recording anything: it is rendered as `digits:<n>`, a GENERATED media, so there is no file
	 * to be missing.
	 *
	 * The gather rides the trailing fragment, so a caller who already knows which colleague they want
	 * can press the digit over it instead of waiting out the sentence.
	 */
	private async offerDirectoryMatches(
		matches: readonly DirectoryEntry[],
	): Promise<
		| { readonly kind: "selected"; readonly entry: DirectoryEntry }
		| { readonly kind: "exhausted" }
		| { readonly kind: "aborted" }
		| { readonly kind: "failed" }
	> {
		for (const entry of matches) {
			if (this.deps.channel.isTearingDown) {
				return { kind: "aborted" };
			}
			const name = translateMediaRef(entry.nameMedia, this.settings.mediaRefs);
			if (name === undefined) {
				// Skipped rather than offered silently. `nameMedia` is compiled as never absent, so this
				// is a deployment whose object store is not mounted for the media server, and the note
				// names the extension so an operator can tell which of the two it is.
				this.note(
					`directory entry for extension ${entry.extensionNumber} has a recorded name this deployment cannot render; it was not offered`,
				);
				continue;
			}

			await this.deps.execute({ verb: "play", media: name });
			await this.deps.execute({ verb: "play", media: this.settings.directorySelectPrefix });
			await this.deps.execute({
				verb: "play",
				media: `digits:${this.settings.directorySelectDigit}`,
			});
			const result = await this.deps.execute({
				verb: "gather",
				maxDigits: 1,
				terminators: ["#"],
				timeoutMs: this.settings.directorySelectTimeoutMs,
				interDigitTimeoutMs: this.settings.directoryInterDigitTimeoutMs,
				media: this.settings.directorySelectSuffix,
			});
			if (result === undefined) {
				return { kind: "failed" };
			}
			const collection = collectionOf(result);
			if (collection?.endReason === "hangup") {
				return { kind: "aborted" };
			}
			if (collection?.digits.join("") === this.settings.directorySelectDigit) {
				return { kind: "selected", entry };
			}
		}
		return { kind: "exhausted" };
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

		const organizationId = this.deps.channel.organizationId;
		const waiter = registry.awaitModerator(node.conferenceId, organizationId);
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
				if (await registry.refresh(node.conferenceId, organizationId)) {
					return;
				}
			}
		};
		void poll().catch((error: unknown) => {
			this.log("the moderator claim poll failed", { err: String(error) });
		});
		const unwatch = this.deps.signals.watch(
			legSignalKey(this.deps.channel.mediaChannelId),
			(signal) => {
				if ((signal as LegSignal).kind === "ended") {
					hungUp = true;
					waiter.cancel();
				}
			},
		);
		// A clearable timer rather than `this.delay`, which has none: a moderator who joins in the
		// first second would otherwise leave the ten-minute wait — and the closure holding `waiter`,
		// and through it this walker — alive for the whole of it.
		let expiryTimer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<void>((resolve) => {
			expiryTimer = setTimeout(() => {
				waiter.cancel();
				resolve();
			}, this.settings.conferenceModeratorWaitMs);
			expiryTimer.unref?.();
		});

		await Promise.race([waiter.arrived, expiry]);
		if (expiryTimer !== undefined) {
			clearTimeout(expiryTimer);
		}
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
		if (registry.room(node.conferenceId, organizationId)?.moderatorPresent !== true) {
			// One last read before giving up: the moderator may have arrived on another instance
			// between the last poll and the budget expiring.
			if (await registry.refresh(node.conferenceId, organizationId)) {
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
		const departure = await registry.leave(
			node.conferenceId,
			this.deps.channel.mediaChannelId,
			this.deps.channel.organizationId,
		);
		try {
			await this.deps.publish("conference.left", {
				legId: this.deps.channel.channelId,
				conferenceId: node.conferenceId,
				roomNumber: node.roomNumber,
				bridgeId,
				moderator,
				memberCount: departure.memberCount,
				durationMs: Math.max(0, (this.deps.now ?? Date.now)() - joinedAtMs),
				// `hung-up` and not `kicked`: this path is the leg's own death. A moderator's removal
				// publishes its own `conference.left` from the control responder, with the reason and
				// the user who did it, because that is the fact a report has to be able to tell apart.
				reason: "hung-up",
			});
			this.deps.channel.setBridge(undefined);
			// Only into a room that still exists. Beeping an empty bridge on the way to destroying it
			// is a playback nobody hears and a media command that races the teardown.
			if (!departure.emptied) {
				await this.announceConferenceArrival(node, bridgeId, "leave");
			}
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

		let outcome: QueueOutcome;
		try {
			outcome = await session.run();
			await this.reportQueueOutcome(node, outcome);
		} catch (error) {
			// The session closes the digit watch itself on every path it controls, because a
			// post-call survey has to keep polling long after `run` has returned `answered`. This is
			// the net for a session that threw before it could.
			this.releaseQueueDigits();
			throw error;
		}

		switch (outcome.kind) {
			case "answered": {
				return { kind: "bridged" };
			}
			case "timeout": {
				return this.branch(node.timeoutNodeId, "ALLOTTED_TIMEOUT");
			}
			case "exit-key": {
				// `NORMAL_CLEARING` and not `ALLOTTED_TIMEOUT`, which is the whole difference between
				// this branch and the one above it. A caller who pressed a key made a choice and the
				// call ended normally; a caller who timed out did not, and an SLA report built on the
				// cause would otherwise count a working exit key as a queue that runs out of patience.
				return this.branch(node.exitNodeId, "NORMAL_CLEARING");
			}
			case "callback": {
				// There is nowhere to route somebody who has agreed to hang up, so this is a terminal
				// and not a branch. `NORMAL_CLEARING` for the reason the exit key uses it: the caller
				// made a choice and the call ended the way they wanted it to. What they are owed lives
				// in the queue's callback token, not in this walk.
				this.note(
					`queue "${node.queueId}": the caller took the callback offer; their place is held for ${outcome.callerNumber}`,
				);
				return { kind: "hangup", cause: "NORMAL_CLEARING" };
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
	 * Translates the session's outcome into the CDR's vocabulary and reports it.
	 *
	 * `failed` and `aborted` deliberately report NOTHING. Neither is a fact about the caller's stay:
	 * `failed` is the roster being unreadable, and `aborted` is the leg going away before the session
	 * could join the line. Filing either as an abandonment would put an infrastructure fault into a
	 * tenant's service level, where it would look exactly like callers giving up — which is the one
	 * reading a supervisor must not be handed.
	 */
	private async reportQueueOutcome(node: QueuePlanNode, outcome: QueueOutcome): Promise<void> {
		const report = this.deps.onQueueOutcome;
		if (report === undefined) {
			return;
		}
		switch (outcome.kind) {
			case "answered": {
				await report({
					queueId: node.queueId,
					waitMs: outcome.waitMs,
					outcome: "answered",
					agentId: outcome.agentId,
				});
				return;
			}
			case "abandoned": {
				await report({ queueId: node.queueId, waitMs: outcome.waitMs, outcome: "caller-hangup" });
				return;
			}
			case "exit-key": {
				await report({ queueId: node.queueId, waitMs: outcome.waitMs, outcome: "exit-key" });
				return;
			}
			case "callback": {
				await report({ queueId: node.queueId, waitMs: outcome.waitMs, outcome: "callback" });
				return;
			}
			case "timeout": {
				await report({ queueId: node.queueId, waitMs: outcome.waitMs, outcome: outcome.reason });
				return;
			}
			default: {
				return;
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
	/** Idempotent: the session releases on several paths and the node's catch is a net over them. */
	private releaseQueueDigits(): void {
		this.queueDigitUnwatch?.();
		this.queueDigitUnwatch = undefined;
	}

	private queueCallPort(): QueueCallPort {
		const { channel, media, execute } = this.deps;
		// The exit key's digit source, opened for the life of the queued call and closed when the
		// session returns.
		//
		// The signal bus rather than the leg's DTMF inbox, and the choice is worth stating because
		// both would work. The bus is fed by `onDtmf` BEFORE the digit is offered to anything else,
		// carries no collection state, and needs nothing threaded through the walker's dependencies —
		// it is already here for answer confirmation and for supervision escalation. Reading the
		// inbox instead would mean CONSUMING the digit, which is the wrong default: a `4` pressed in a
		// queue with no exit key belongs to whatever the caller reaches next, and type-ahead into an
		// overflow IVR is a thing experienced callers do on purpose.
		//
		// The cost of observing rather than consuming is that a digit which IS the exit key is also
		// left in the buffer. Harmless: the session leaves the queue on it, and the branch it takes
		// gets one stale digit at most — the same thing that happens today when a caller types over a
		// greeting.
		const digits: string[] = [];
		const unwatch = this.deps.signals?.watch(legSignalKey(channel.mediaChannelId), (signal) => {
			if (signal.kind === "dtmf") {
				// Bounded, because a caller holding for twenty minutes on a numeric keypad is a real
				// thing and this array has no other reader when the queue has no exit key.
				if (digits.length >= MAX_QUEUE_BUFFERED_DIGITS) {
					digits.shift();
				}
				digits.push(signal.digit);
			}
		});
		this.queueDigitUnwatch = unwatch;
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
			playToAgent: async (mediaChannelId: string, playable: string) => {
				// `media.play` directly rather than the `play` VERB, because a verb is bound to the
				// A-leg — the verb executor's whole context is the channel the walk is routing — and
				// this plays at a leg the walk originated. The playback ref is minted here for the same
				// reason it is minted everywhere else in this file: the client names it so it can be
				// stopped without holding server state, even though nothing stops this one.
				try {
					await media.play(mediaChannelId, {
						media: [playable],
						playbackRef: this.newId(),
					});
					return true;
				} catch (error) {
					this.log("failed to whisper to a queue agent", { mediaChannelId, err: String(error) });
					return false;
				}
			},
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
			hangupAnsweredAgent: async (mediaChannelId) =>
				await this.hangupQuietly(mediaChannelId, "NORMAL_TEMPORARY_FAILURE"),
			bridge: async (mediaChannelId, onEnded, options) =>
				(await this.bridgeWith(mediaChannelId, onEnded, options?.keepCallerOnPeerEnd === true))
					.kind === "bridged",
			endCaller: async () => {
				// `NORMAL_CLEARING` and not a failure cause: the call really did complete, and the
				// caller is being released because the survey after it is over.
				await this.hangupQuietly(this.deps.channel.mediaChannelId, "NORMAL_CLEARING");
			},
			pollDigit: () => digits.shift(),
			releaseDigits: () => {
				this.releaseQueueDigits();
				// Emptied as well as unwatched: the array is closed over by a port the survey may
				// still hold, and stale keypresses answering a later question would be worse than
				// none.
				digits.length = 0;
			},
			startRecording: async (request) => {
				// The same seam the record-toggle feature code uses, so a queue recording is
				// indistinguishable from an on-demand one downstream: one `channel.record.started`, one
				// object key, one retention rule. A walk with no call-control port announces nothing and
				// records nothing, which is what an engine with no such port already does everywhere.
				const control = this.deps.control;
				if (control?.startRecording === undefined) {
					this.note(
						"queue call recording was asked for but this walk has no call-control port; the call was connected without it",
					);
					return false;
				}
				const outcome = await control.startRecording(request);
				if (!outcome.ok && outcome.reason !== undefined) {
					this.note(`queue call recording was refused: ${outcome.reason}`);
				}
				return outcome.ok;
			},
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
	 * Nothing here is queue-specific any more: `abortOnCallerHangup` now defaults to on for every
	 * dial, because under the split plane a caller's hangup reaches the walk as a bus signal rather
	 * than as the destruction of the dial. See {@link watchCallerHangup}.
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
			onNet: attempt.onNet,
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

	/**
	 * Rings the attempts one at a time, stopping on an answer or on a cause that is not allowed.
	 *
	 * ## `delaySeconds` is an OFFSET FROM THE START OF THE DIAL, in both strategies
	 *
	 * It is the one thing the field can mean without meaning two things. `dialSimultaneous` has
	 * always read it that way ("start ringing this member N seconds in"), and it is what the form
	 * that sets it says — the control is labelled "Start ringing after (seconds)" and the group's
	 * summary line reads `starts at +Ns`. A sequential ladder that slept the delay BETWEEN members
	 * instead read it as a gap, and the two readings compound: a member configured `delaySeconds: 8`
	 * behind a member with `timeoutSeconds: 8` rang at sixteen seconds, with eight seconds in the
	 * middle where nobody's phone was ringing and the caller heard ringback from a switch that was
	 * doing nothing. The ordering already makes a sequential group sequential; the delay only ever
	 * decides how far in a member may start.
	 *
	 * So each hop waits for whatever is LEFT of its offset. A member whose offset has already passed
	 * — the usual case, because the members ahead of it rang out — starts immediately.
	 */
	private async dialSequential(
		attempts: readonly DialAttempt[],
		stopOnCauses: readonly HangupCause[],
	): Promise<DialOutcome> {
		const stop = new Set<string>(stopOnCauses);
		let last: DialOutcome = { kind: "timeout" };
		const startedAt = this.deps.now?.() ?? Date.now();

		for (const [index, attempt] of attempts.entries()) {
			// `abandoned`, not just `isTearingDown`: a pickup takes the caller away while this loop is
			// between two members of a ring group, and the leg it takes is still very much alive.
			if (this.abandoned) {
				return { kind: "aborted" };
			}
			const remainingDelayMs =
				attempt.delaySeconds * MILLIS_PER_SECOND - ((this.deps.now?.() ?? Date.now()) - startedAt);
			if (remainingDelayMs > 0) {
				await this.delay(remainingDelayMs);
			}
			const outcome = await this.dialOne({ ...attempt, delaySeconds: 0 }, index);
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
	 *
	 * ## A leg that has to confirm does not win by answering
	 *
	 * It wins by pressing the accept digit, and the race stays OPEN underneath it: the other phones
	 * go on ringing for the whole time a mobile is being asked the question, because the thing that
	 * answered may be its voicemail and giving it the race would hand the caller to it. Two legs
	 * that answer within a millisecond of each other are therefore both asked, and the first one to
	 * accept takes the call — `resolveOutcome` is single-shot, so the second acceptance lands on a
	 * settled race and that leg is torn down with the rest of the losers.
	 */
	private async dialSimultaneous(
		originalAttempts: readonly DialAttempt[],
		overallTimeoutSeconds: number,
		abortOnCallerHangup = true,
	): Promise<DialOutcome> {
		const routes = (
			await Promise.all(
				originalAttempts.map(async (attempt, originalIndex) => {
					const target = this.targetFor(attempt);
					let groups: readonly (readonly DialTarget[])[] | undefined;
					let unavailable = false;
					if (
						target?.kind === "aor" &&
						target.contactUri === undefined &&
						this.deps.media.resolveTargets !== undefined
					) {
						try {
							groups = await this.deps.media.resolveTargets(
								this.deps.channel.organizationId,
								target,
								this.deps.channel.channelId,
							);
						} catch (error) {
							unavailable = true;
							this.note(`${attempt.label} has no reachable registration: ${String(error)}`);
						}
					}
					if (groups === undefined || groups.length === 0)
						return [
							{
								attempt,
								originalIndex,
								group: 0,
								unavailable: unavailable || groups?.length === 0,
							},
						];
					return groups.flatMap((contacts, group) =>
						contacts.map((target) => ({
							attempt: { ...attempt, target },
							originalIndex,
							group,
							unavailable: false,
						})),
					);
				}),
			)
		).flat();
		if (this.abandoned) return { kind: "aborted" };
		if (routes.length === 0) return { kind: "failed", cause: "USER_NOT_REGISTERED", index: 0 };
		const attempts = routes.map((route) => route.attempt);
		const started = new Set<number>();
		/**
		 * The legs an INVITE was actually asked for. A delayed ring-group member whose delay is still
		 * running when somebody else answers is `started` but has no channel; hanging it up would file
		 * a `LOSE_RACE` cause against a media channel that was never originated.
		 */
		const originated = new Set<number>();
		const closing = new Set<number>();
		const groupDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
		const inFlight = new Set<Promise<void>>();
		const progressByIndex = new Map<
			number,
			{ readonly sawProgress: () => void; readonly cancel: () => void }
		>();
		let startGroup: (originalIndex: number, group: number) => void = () => undefined;

		const channelIds = attempts.map(() => this.newId());
		const unwatchers: (() => void)[] = [];
		const progressTimers: { readonly cancel: () => void }[] = [];
		const abortConfirmations: (() => void)[] = [];
		const confirming = new Set<number>();
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

		/**
		 * One leg is out of the race, for whatever reason.
		 *
		 * `cause` is absent when the leg was not ANSWERED-and-then-lost but never counted as answered
		 * at all — a declined confirmation. A race in which every leg declined ends as a timeout and
		 * therefore on the no-answer branch, because nobody accepted the call, which is not the same
		 * fact as everybody rejecting it.
		 *
		 * The cause kept for the race is the most INFORMATIVE one, not the last one to arrive. A
		 * fan-out reaches every contact an extension has registered, and a phone that answers
		 * `486 Busy Here` is answered by one of them while a contact nobody is behind fails a moment
		 * later; last-writer-wins then reported the stale contact, the walk hung the caller up with
		 * `USER_NOT_REGISTERED`, and the edge — which has no status for that cause — relayed a genuine
		 * busy to the caller as `480 Temporarily Unavailable`. See {@link causeRank}.
		 */
		const legIsOut = (index: number, cause?: HangupCause): void => {
			if (ended.has(index)) return;
			if (
				cause !== undefined &&
				(lastCause === undefined || causeRank(cause) > causeRank(lastCause))
			) {
				lastCause = cause;
			}
			ended.add(index);
			const route = routes[index]!;
			if (
				!settled &&
				routes.every(
					(candidate, position) =>
						candidate.originalIndex !== route.originalIndex ||
						candidate.group !== route.group ||
						ended.has(position),
				)
			) {
				startGroup(route.originalIndex, route.group + 1);
			}
			if (ended.size === attempts.length) {
				resolveOutcome(
					lastCause === undefined
						? { kind: "timeout" }
						: { kind: "failed", cause: lastCause, index },
				);
			}
		};

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
			const attempt = attempts[index] as DialAttempt;
			unwatchers.push(
				this.deps.signals.watch(legSignalKey(channelId), (signal) => {
					if (ended.has(index) || closing.has(index)) return;
					const leg = signal as LegSignal;
					if (leg.kind === "ringing" || leg.kind === "progress") {
						progressByIndex.get(index)?.sawProgress();
						return;
					}
					if (leg.kind === "answered" || leg.kind === "entered") {
						progressByIndex.get(index)?.sawProgress();
						const confirm = attempt.confirm;
						if (confirm === undefined) {
							resolveOutcome({ kind: "answered", mediaChannelId: channelId, index });
							return;
						}
						// Claimed once per leg: `entered` and `answered` both arrive for one leg, and
						// asking the same phone the same question twice would collect its `1` for the
						// first question and time the second one out.
						if (confirming.has(index) || ended.has(index) || settled) {
							return;
						}
						confirming.add(index);
						void this.confirmRacingLeg(channelId, attempt, confirm, {
							abortable: (abort) => abortConfirmations.push(abort),
							accepted: () => {
								resolveOutcome({ kind: "answered", mediaChannelId: channelId, index });
							},
							callerGone: () => {
								resolveOutcome({ kind: "aborted" });
							},
							rejected: () => {
								legIsOut(index);
							},
						});
						return;
					}
					if (leg.kind === "ended") {
						legIsOut(index, leg.cause);
					}
				}),
			);
		}

		// Install every watcher first. A lower-preference group starts only when the entire
		// previous group failed, while other extensions keep ringing independently.
		startGroup = (originalIndex, group) => {
			for (const [index, route] of routes.entries()) {
				if (
					route.originalIndex !== originalIndex ||
					route.group !== group ||
					started.has(index) ||
					settled
				)
					continue;
				started.add(index);
				const attempt = route.attempt;
				const work = (async () => {
					if (group === 0 && attempt.delaySeconds > 0)
						await Promise.race([
							this.delay(attempt.delaySeconds * MILLIS_PER_SECOND),
							outcomePromise,
						]);
					if (settled || this.abandoned) return;
					if (route.unavailable) {
						legIsOut(index, "USER_NOT_REGISTERED");
						return;
					}
					const groupKey = `${originalIndex}:${group}`;
					if (!groupDeadlines.has(groupKey)) {
						const groups =
							Math.max(
								...routes
									.filter((candidate) => candidate.originalIndex === originalIndex)
									.map((candidate) => candidate.group),
							) + 1;
						// Share this destination's ring budget across its preference groups. A silent
						// first group must leave time for the backup device before the overall deadline.
						const deadline = setTimeout(
							() => {
								if (settled) return;
								for (const [position, candidate] of routes.entries()) {
									if (
										candidate.originalIndex !== originalIndex ||
										candidate.group !== group ||
										ended.has(position) ||
										closing.has(position)
									)
										continue;
									closing.add(position);
									void this.hangupQuietly(channelIds[position]!, "ORIGINATOR_CANCEL").finally(() =>
										legIsOut(position),
									);
								}
							},
							Math.max(1, (attempt.timeoutSeconds * MILLIS_PER_SECOND) / groups),
						);
						deadline.unref?.();
						groupDeadlines.set(groupKey, deadline);
					}
					const progress = this.armProgressTimeout(attempt, () => {
						if (settled || ended.has(index)) return;
						this.note(`${attempt.label} showed no progress and was dropped from the race`);
						closing.add(index);
						void this.hangupQuietly(channelIds[index]!, "ORIGINATOR_CANCEL").finally(() =>
							legIsOut(index),
						);
					});
					progressByIndex.set(index, progress);
					progressTimers.push(progress);
					originated.add(index);
					await this.originate(attempt, channelIds[index]!, route.originalIndex, (cause) =>
						legIsOut(index, cause),
					);
				})().catch((error) => {
					this.log("dial attempt failed", { err: String(error) });
					legIsOut(index, "NORMAL_TEMPORARY_FAILURE");
				});
				inFlight.add(work);
				void work.finally(() => inFlight.delete(work));
			}
		};
		for (const index of originalAttempts.keys()) startGroup(index, 0);

		const outcome = await outcomePromise;
		await Promise.allSettled(inFlight);
		for (const deadline of groupDeadlines.values()) clearTimeout(deadline);
		clearTimeout(overall);
		for (const progress of progressTimers) {
			progress.cancel();
		}
		for (const unwatch of unwatchers) {
			unwatch();
		}
		// A question nobody is waiting for the answer to. The loser it was being asked of is hung up
		// below, and on a real media server that would end it anyway — but a confirmation left running
		// against a leg that no longer exists is a listener on the bus for the rest of the process.
		for (const abort of abortConfirmations) {
			abort();
		}

		const winner = outcome.kind === "answered" ? outcome.mediaChannelId : undefined;
		for (const [index, channelId] of channelIds.entries()) {
			if (!originated.has(index) || channelId === winner || ended.has(index)) {
				continue;
			}
			await this.hangupQuietly(channelId, winner === undefined ? "ORIGINATOR_CANCEL" : "LOSE_RACE");
		}

		if (outcome.kind === "timeout" && lastCause !== undefined && ended.size === attempts.length) {
			return { kind: "failed", cause: lastCause, index: 0 };
		}
		return outcome.kind === "answered" || outcome.kind === "failed"
			? { ...outcome, index: routes[outcome.index]?.originalIndex ?? 0 }
			: outcome;
	}

	/**
	 * Arms one leg's `progress_timeout`, or a no-op when the deployment has it switched off.
	 *
	 * Single-shot in both directions: the first progress signal disarms it for good (a leg that
	 * rings, stops and rings again has already proved the far end is alive), and `onSilence` fires
	 * at most once. Returning a pair of closures rather than a timer handle keeps the two dial
	 * loops from having to know whether a timer exists at all.
	 */
	private armProgressTimeout(
		attempt: DialAttempt,
		onSilence: () => void,
	): { readonly sawProgress: () => void; readonly cancel: () => void } {
		const seconds = this.settings.progressTimeoutSeconds;
		if (seconds <= 0) {
			return { sawProgress: () => undefined, cancel: () => undefined };
		}
		// Never longer than the ring budget: a progress timeout above it can only fire after the
		// dial has already been settled by its own timer, which is a timer that does nothing.
		const budget = Math.min(seconds, Math.max(1, attempt.timeoutSeconds)) * MILLIS_PER_SECOND;
		let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
			timer = undefined;
			onSilence();
		}, budget);
		timer.unref?.();
		const cancel = (): void => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};
		return { sawProgress: cancel, cancel };
	}

	/** Rings exactly one attempt and waits for it to answer, fail or time out. */
	private async dialOne(
		attempt: DialAttempt,
		index: number,
		abortOnCallerHangup = true,
	): Promise<DialOutcome> {
		const target = this.targetFor(attempt);
		if (
			target?.kind === "aor" &&
			target.contactUri === undefined &&
			this.deps.media.resolveTargets !== undefined
		) {
			const outcome = await this.dialSimultaneous(
				[attempt],
				attempt.timeoutSeconds,
				abortOnCallerHangup,
			);
			return outcome.kind === "answered" || outcome.kind === "failed"
				? { ...outcome, index }
				: outcome;
		}

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

		// Cleared by the first sign of life from the far end, whichever it is. See
		// {@link PlanWalkerSettings.progressTimeoutSeconds} for why a silent leg is cut early.
		const progress = this.armProgressTimeout(attempt, () => {
			this.note(`${attempt.label} showed no progress and was given up on`);
			resolveOutcome({ kind: "timeout" });
		});

		const unwatch = this.deps.signals.watch(legSignalKey(channelId), (signal) => {
			const leg = signal as LegSignal;
			if (leg.kind === "ringing" || leg.kind === "progress") {
				progress.sawProgress();
				return;
			}
			if (leg.kind === "answered" || leg.kind === "entered") {
				progress.sawProgress();
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
		progress.cancel();
		unwatch();
		unwatchCaller();

		// The confirmation installs its own watchers, and it does so with no `await` between here and
		// there, so nothing this leg does can fall between the two subscriptions.
		const settledOutcome =
			outcome.kind === "answered" && attempt.confirm !== undefined
				? this.settleConfirm(await this.confirmAnswer(channelId, attempt.confirm), outcome, attempt)
				: outcome;

		if (settledOutcome.kind !== "answered") {
			await this.hangupQuietly(channelId, "ORIGINATOR_CANCEL");
		}
		return settledOutcome;
	}

	/**
	 * A confirmation verdict, as the dial that is waiting on it reads it.
	 *
	 * Everything except an acceptance is the leg NOT HAVING ANSWERED — a `timeout`, which is exactly
	 * what the ladder would have seen had the phone rung out — rather than a `failed` with a cause.
	 * The difference is not cosmetic: a cause reaches `stopOnCauses`, and a mobile whose voicemail
	 * picked up and declined would then stop a sequential ladder dead on the hop before the one the
	 * user is actually sitting next to.
	 */
	private settleConfirm(
		verdict: ConfirmVerdict,
		answered: DialOutcome,
		attempt: DialAttempt,
	): DialOutcome {
		if (verdict === "accepted") {
			return answered;
		}
		if (verdict === "caller-gone") {
			this.note(`${attempt.label} was being asked to confirm when the caller hung up`);
			return { kind: "aborted" };
		}
		this.noteConfirmVerdict(verdict, attempt);
		return { kind: "timeout" };
	}

	/** One racing leg's confirmation, run without settling the race it is still part of. */
	private async confirmRacingLeg(
		mediaChannelId: string,
		attempt: DialAttempt,
		confirm: ConfirmRequest,
		hooks: {
			readonly abortable: (abort: () => void) => void;
			readonly accepted: () => void;
			readonly callerGone: () => void;
			readonly rejected: () => void;
		},
	): Promise<void> {
		let verdict: ConfirmVerdict;
		try {
			verdict = await this.confirmAnswer(mediaChannelId, confirm, hooks.abortable);
		} catch (error) {
			// Never throws into the signal callback that started it: that path runs on the media
			// server's event socket, where an exception takes every other live call with it.
			this.log("a confirmation failed", { mediaChannelId, err: String(error) });
			verdict = "unplayable";
		}

		if (verdict === "accepted") {
			hooks.accepted();
			return;
		}
		if (verdict === "caller-gone") {
			this.note(`${attempt.label} was being asked to confirm when the caller hung up`);
			hooks.callerGone();
			return;
		}
		this.noteConfirmVerdict(verdict, attempt);
		// Hung up here rather than by the race's own loser cleanup: the race is still open, and this
		// leg has to stop ringing (or stop being connected to a voicemail greeting) NOW.
		await this.hangupQuietly(mediaChannelId, "ORIGINATOR_CANCEL");
		hooks.rejected();
	}

	private noteConfirmVerdict(verdict: ConfirmVerdict, attempt: DialAttempt): void {
		switch (verdict) {
			case "leg-gone": {
				this.note(`${attempt.label} hung up before it confirmed the call`);
				return;
			}
			case "unplayable": {
				// The mediad rung this deployment is on cannot play audio, so the question was never
				// asked. Bridging anyway is the exact defect confirmation exists to prevent — a
				// mobile's voicemail taking the call — so it fails CLOSED and says why.
				this.note(
					`${attempt.label} could not be asked to confirm (this media plane cannot play audio); the leg was treated as unconfirmed and dropped`,
				);
				return;
			}
			default: {
				this.note(`${attempt.label} did not confirm the call; it was dropped`);
			}
		}
	}

	/**
	 * Asks an answered leg to accept the call, and reports whether it did.
	 *
	 * ## Why this exists
	 *
	 * A ladder hop to a mobile is answered by whichever of two things gets there first: the person,
	 * or the carrier's voicemail. Both look identical to a switch — a `200 OK` — so a switch that
	 * treats an answer as an answer hands the caller to a voicemail box that is not the one they were
	 * ringing, and every later hop of the ladder is skipped because the call was "answered". The only
	 * cure is to ask for something a machine will not do: press a digit.
	 *
	 * ## It fails closed, in every direction
	 *
	 * Silence, the wrong digit, a leg that hangs up, a media plane that cannot play the question —
	 * all of them are "unconfirmed", and unconfirmed is never bridged. The one that is easiest to get
	 * wrong is the last: `mediad` refuses `play` on the rungs below file playback, and a confirmation
	 * that treated a refusal as "well, connect them anyway" would be worse than no confirmation at
	 * all, because it would be silently absent exactly where the deployment believed it was on.
	 *
	 * ## The digits arrive on the signal bus
	 *
	 * Not through a `gather` verb: a verb runs against the leg the walk owns (the CALLER), and this
	 * question is asked of the callee. See `LegSignal`'s `dtmf` member for why an originated leg has
	 * no DTMF inbox of its own.
	 */
	private async confirmAnswer(
		mediaChannelId: string,
		confirm: ConfirmRequest,
		abortable?: (abort: () => void) => void,
	): Promise<ConfirmVerdict> {
		let terminal: ConfirmVerdict | undefined;
		let settleTerminal: (verdict: ConfirmVerdict) => void = () => undefined;
		let offerDigit: ((digit: string) => void) | undefined;

		const terminalPromise = new Promise<ConfirmStep>((resolve) => {
			settleTerminal = (verdict) => {
				if (terminal !== undefined) {
					return;
				}
				terminal = verdict;
				resolve({ kind: "terminal", verdict });
			};
		});

		const unwatchLeg = this.deps.signals.watch(legSignalKey(mediaChannelId), (signal) => {
			const leg = signal as LegSignal;
			if (leg.kind === "ended") {
				settleTerminal("leg-gone");
				return;
			}
			if (leg.kind === "dtmf") {
				offerDigit?.(leg.digit);
			}
		});
		// The caller is not in a bridge yet — they are hearing ringback — so their hangup arrives
		// here as an ordinary leg signal rather than as anything the walk would otherwise notice
		// mid-question. Without this, a callee would go on being asked to accept a call from
		// somebody who left thirty seconds ago.
		const unwatchCaller = this.deps.signals.watch(
			legSignalKey(this.deps.channel.mediaChannelId),
			(signal) => {
				if ((signal as LegSignal).kind === "ended") {
					settleTerminal("caller-gone");
				}
			},
		);
		abortable?.(() => {
			settleTerminal("leg-gone");
		});

		try {
			for (let round = 0; round < confirm.attempts; round += 1) {
				if (terminal !== undefined) {
					break;
				}
				if (this.abandoned) {
					return "caller-gone";
				}

				const playbackRef = this.newId();
				try {
					await this.deps.media.play(mediaChannelId, {
						media: [...confirm.media],
						playbackRef,
					});
				} catch (error) {
					this.log("could not ask a leg to confirm", { mediaChannelId, err: String(error) });
					return "unplayable";
				}

				const digit = this.awaitConfirmDigit(confirm.timeoutMs, (offer) => {
					offerDigit = offer;
				});
				const step = await Promise.race([terminalPromise, digit.promise]);
				digit.cancel();
				offerDigit = undefined;
				// The prompt is stopped whatever happened: a leg that pressed `1` two syllables in
				// must not hear the rest of the question, and an already-finished playback is a no-op.
				await this.stopPlaybackQuietly(playbackRef);

				if (step.kind === "terminal") {
					return step.verdict;
				}
				if (step.kind === "digit" && step.digit === confirm.acceptDigit) {
					return "accepted";
				}
				// A wrong digit costs an attempt exactly as silence does. A phone in a pocket presses
				// things, and re-asking forever is how a caller waits out a whole ladder on one hop.
			}
		} finally {
			unwatchLeg();
			unwatchCaller();
		}

		return terminal ?? "declined";
	}

	/** One digit, or silence. Cancellable, so a lost race does not leave a timer holding a closure. */
	private awaitConfirmDigit(
		timeoutMs: number,
		register: (offer: (digit: string) => void) => void,
	): { readonly promise: Promise<ConfirmStep>; readonly cancel: () => void } {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const promise = new Promise<ConfirmStep>((resolve) => {
			timer = setTimeout(() => {
				resolve({ kind: "timeout" });
			}, timeoutMs);
			timer.unref?.();
			register((digit) => {
				resolve({ kind: "digit", digit });
			});
		});
		return {
			promise,
			cancel: () => {
				if (timer !== undefined) {
					clearTimeout(timer);
				}
			},
		};
	}

	private async stopPlaybackQuietly(playbackRef: string): Promise<void> {
		try {
			await this.deps.media.stopPlayback(playbackRef);
		} catch (error) {
			this.log("failed to stop a confirmation prompt", { playbackRef, err: String(error) });
		}
	}

	/**
	 * Ends a dial the moment the CALLER goes away.
	 *
	 * Every dial installs this. It used to be queue-only, on the assumption that "for an unanswered
	 * inbound call the caller's hangup tears the whole call down in one event and the walk aborts
	 * anyway". That was true of ARI, where destroying the caller's channel destroyed the dial with
	 * it. Under the split plane it is not: the A-leg's CANCEL arrives as a `dialog.terminated` event
	 * that becomes a bus signal, while the walk is parked inside `dialSimultaneous` awaiting the
	 * ring, and {@link abandoned} is only consulted BETWEEN steps. A caller who hung up before the
	 * callee answered therefore left the callee's phone ringing for the whole timeout with nobody on
	 * the other end — and, worse, answering it bridged them to a dead leg.
	 *
	 * Resolving `aborted` unwinds through the dial's existing cleanup, which hangs every outstanding
	 * B-leg up with `ORIGINATOR_CANCEL` — a CANCEL on the wire for a leg that never answered.
	 */
	private watchCallerHangup(resolve: (outcome: DialOutcome) => void): () => void {
		return this.deps.signals.watch(legSignalKey(this.deps.channel.mediaChannelId), (signal) => {
			const leg = signal as LegSignal;
			if (leg.kind === "ended") {
				// Noted, because this is the ONE `aborted` a dial can return with nothing to show for
				// it: every other one carries a note, so a walk that ends `aborted` with an empty
				// `notes` is either this or the caller being detached, and telling those apart from
				// the outside took a log correlation across three services.
				//
				// The CAUSE is in the note because the note alone cannot answer the question that
				// follows it. A dial that ends a few milliseconds after it started looks identical
				// whether the caller really hung up or the engine acted on a leg-ended nothing on the
				// wire produced, and the cause is what separates them: a real caller teardown arrives
				// as the cause `sipd` or `mediad` reported, so a note here naming a cause the wire
				// never carried is the evidence that the signal was synthetic.
				this.note(
					`the caller's leg ended (${leg.cause}/${String(leg.causeCode)}) while the dial was running; the dial was abandoned`,
				);
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
		try {
			await this.deps.legs?.originated({
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
			// Structured for the SIP edge (§5.1). An explicit `attempt.target` (a trunk, set where the
			// trunk id is in hand) wins; otherwise an extension is dialled `sip:{number}@{realm}` when a
			// realm is configured. `undefined` is passed through untouched — the ARI adapter ignores it and
			// the composite refuses `originate` by name, which the walker already reads as "not reachable".
			const target = this.targetFor(attempt);
			await this.deps.media.originate({
				endpoint: attempt.endpoint,
				application: this.settings.application,
				channelId,
				callerId: attempt.callerId,
				timeoutSeconds: attempt.timeoutSeconds,
				originatorChannelId: this.deps.channel.mediaChannelId,
				...(target === undefined ? {} : { target }),
				...(attempt.callerIdPresentation === undefined
					? {}
					: { callerIdPresentation: attempt.callerIdPresentation }),
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
			// The leg aggregate already exists — `legs.originated` ran BEFORE the originate — so a
			// refused INVITE leaves a B-leg that nothing has given a cause to, and the CDR files it
			// with whatever the teardown supplies, which is a generic clearing. Fix the cause here,
			// first-wins, exactly as `hangupQuietly` does for a loser: a leg whose INVITE never left
			// the platform is not "nobody answered", and the difference is what the not-registered
			// branch of an extension routes on.
			this.deps.legs?.hangingUp(channelId, "USER_NOT_REGISTERED");
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
		onPeerEnded?: (detached: Promise<boolean>) => void,
		keepLegOnPeerEnd = false,
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
			// `createBridge` may well have succeeded and the add failed on a leg that died in between,
			// which leaves a mixing bridge nobody is in and nothing downstream to clean it up:
			// `setBridge` has not been called yet.
			await this.destroyBridgeQuietly(bridgeId);
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
			mode: "media",
		});

		// Once bridged, the B-leg's death is what ends the call. Nothing else is watching it: the
		// dial helper unsubscribed when it won the race.
		const unwatch = this.deps.signals.watch(legSignalKey(peerMediaChannelId), (signal) => {
			if ((signal as LegSignal).kind !== "ended") {
				return;
			}
			unwatch();
			// The teardown is STARTED before the hook is told, and the hook is handed its promise
			// rather than waiting on it. Both halves matter: the agent's wrap-up timer has to start at
			// the moment their call ended rather than after two awaited media-server round trips,
			// while the caller's post-call survey must not speak into a bridge that is still being
			// pulled apart. One promise serves both — the wrap-up ignores it, the survey awaits it.
			const detached = this.onPeerEnded(bridgeId, peerMediaChannelId, keepLegOnPeerEnd);
			onPeerEnded?.(detached);
			void detached;
		});

		return { kind: "bridged" };
	}

	/**
	 * The peer of a bridge this leg is in has gone.
	 *
	 * Returns whether this leg SURVIVED it and is now out of the bridge — which is only ever true
	 * under `keepLeg`, and is the fact a post-call survey needs before it plays anything.
	 *
	 * ## `keepLeg`, and why it is not "park"
	 *
	 * A queue with a survey configured has to keep the caller after the agent hangs up, and the
	 * shape that already exists for "take this leg out of the bridge and leave it alive" is what
	 * park and a shared-line recall do. This is the same move without the lot: the bridge is
	 * unbridged and destroyed, `channel.bridgeId` is cleared — so any OTHER watcher closed over this
	 * bridge also leaves the leg alone — and the hangup is simply not sent. The caller is then a
	 * live, answered leg with nothing on the other end, which is exactly what a survey needs and
	 * exactly what a parked caller is.
	 *
	 * The leg does NOT become immortal: whoever asked for `keepLeg` owns ending it, and the queue's
	 * survey ends it through `QueueCallPort.endCaller` on every exit including its failures.
	 */
	private async onPeerEnded(
		bridgeId: string,
		peerMediaChannelId: string,
		keepLeg = false,
	): Promise<boolean> {
		// A call-control feature may have taken this leg out of the bridge before the peer ended —
		// which is exactly what park and a shared-line hold recall do: they move the CALLER out, then
		// release the leg on the other side. This watcher is a closure over the bridge that walk
		// built, so it went on firing and hung the caller up three milliseconds before the recall's
		// own dial began, with `NORMAL_CLEARING` and no explanation on either side. `park` and
		// `recallSharedLine` clear this leg's bridge for that purpose; the comparison is what makes
		// the clearing mean something.
		if (this.deps.channel.bridgeId !== bridgeId) {
			this.log("the peer of a bridge this leg has already left ended; leaving the leg alone", {
				bridgeId,
				peerMediaChannelId,
			});
			return false;
		}
		try {
			await this.deps.publish("channel.unbridged", {
				legId: this.deps.channel.channelId,
				peerLegId: this.peerLegIdOf(peerMediaChannelId),
				bridgeId,
				reason: "peer-hangup",
			});
			this.deps.channel.setBridge(undefined);
			await this.deps.media.destroyBridge(bridgeId);
			if (this.deps.channel.isTearingDown) {
				// The caller went too, in the same instant. Nothing survived, whatever was asked for.
				return false;
			}
			if (keepLeg) {
				// BEFORE the note and before anything else can act on the stamp: the peer's teardown is
				// already running, and it ends whatever `bridged` named.
				this.deps.legs?.unbridged?.(peerMediaChannelId);
				this.note("the agent's leg ended; the caller was kept out of the bridge");
				return true;
			}
			await this.hangupQuietly(this.deps.channel.mediaChannelId, "NORMAL_CLEARING");
		} catch (error) {
			this.log("failed to tear the bridge down after the peer hung up", { err: String(error) });
			// A leg whose detach failed is NOT one a survey may speak to: the bridge may still be
			// standing and the audio would go to a call that is over.
			return false;
		}
		return false;
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
	 * The structured {@link DialTarget} one attempt is originated with, or `undefined`.
	 *
	 * An explicit {@link DialAttempt.target} — a trunk, set wherever the trunk id is in hand — wins.
	 * Otherwise an AOR is derived ONLY for a leg the site marked {@link DialAttempt.onNet}; anything
	 * else is originated with no structured target, which the ARI adapter ignores and the composite
	 * refuses `originate` for by name. That refusal is the honest failure; an AOR built out of an
	 * off-net number would instead be resolved against the tenant's registrations.
	 */
	private targetFor(attempt: DialAttempt): DialTarget | undefined {
		if (attempt.target !== undefined) {
			return attempt.target;
		}
		return attempt.onNet === true ? this.aorTargetFor(attempt.destinationNumber) : undefined;
	}

	/**
	 * The `{kind:"aor"}` {@link DialTarget} for an on-net extension number, or `undefined`.
	 *
	 * `apps/sipd` resolves `{kind:"aor"}` against the `registrations` bucket it owns, so the AOR must be
	 * the one the phone registered under — `sip:{number}@{realm}`. The realm is a per-tenant fact
	 * (`plans/sipd-invite-design.md` §5.1); until it is threaded from the org's `sip` settings into
	 * {@link PlanWalkerSettings.sipRealm}, this returns `undefined`. Only ever reached for an attempt
	 * that {@link DialAttempt.onNet} marks as one — see {@link PlanWalker.targetFor}.
	 */
	private aorTargetFor(number: string): DialTarget | undefined {
		if (this.settings.sipRealm === undefined || this.settings.sipRealm === "") {
			return undefined;
		}
		return { kind: "aor", aor: `sip:${number}@${this.settings.sipRealm}` };
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

	/**
	 * A note that carries the media plane's own words for why a verb did not run.
	 *
	 * `what` says which piece of the call was lost; the host's detail says why. Without the second
	 * half the note reads "the greeting did not play", which is what the caller already knew.
	 */
	private noteVerbFailure(what: string): void {
		const detail = this.deps.verbFailure?.();
		this.note(detail === undefined ? what : `${what}: ${detail}`);
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
