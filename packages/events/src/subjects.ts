import { createHash } from "node:crypto";

/**
 * The versioned NATS subject taxonomy — the single place a subject string is ever assembled.
 *
 * Spec: `plans/optimiq-voice-master-plan.md` §3.5. Nothing outside this file may concatenate
 * subject tokens; publishers use {@link subjectFor}, subscribers use {@link subjectFilterFor}
 * and consumers reverse a delivered subject with {@link parseSubject}.
 *
 * ## Shape
 *
 * ```text
 * calls.evt.v1.<orgId>.<callId>.<event>      event = channel.created … channel.destroyed
 * sip.reg.v1.<orgId>.<aorHash>.<event>       event = registered | unregistered | expired
 * queue.evt.v1.<orgId>.<queueId>.<event>     event = caller.joined | … | agent.state
 * voicemail.evt.v1.<orgId>.<mailboxId>.<event>  event = message.left | mwi.updated
 * media.evt.v1.<orgId>.<sessionId>.<event>   event = session.ended | session.rtp-timeout |
 *                                                    playback.finished
 * cdr.leg.v1.<orgId>                         one subject per org; event type is in the envelope
 * audit.evt.v1.<orgId>
 * provision.evt.v1.<orgId>
 * rpc.routing.v1.resolve                     request-reply, not JetStream
 * rpc.authz.v1.check
 * rpc.sip.v1.credential
 * rpc.media.v1.allocate-session              engine -> mediad; RAW NATS both ends (see rpc.ts)
 * rpc.media.v1.bridge-sessions
 * rpc.media.v1.unbridge-sessions
 * rpc.media.v1.release-session
 * rpc.media.v1.start-playback
 * rpc.media.v1.stop-playback
 * rpc.engine.v1.park-handoff.<instanceTok>   engine -> engine; the OWNING instance answers
 * ```
 *
 * The version token (`v1`) is a MAJOR version and is part of the subject, not the payload: a
 * breaking payload change ships as `v2` subjects alongside `v1` so producers and consumers can
 * be rolled independently. Additive payload changes never bump it (see `README.md`).
 *
 * ## Multi-token event names
 *
 * Event names are hierarchical and may contain dots (`channel.record.started`), so the event
 * occupies the subject's TAIL rather than a single token. Every subscription filter that spans
 * events therefore terminates in `>`, and {@link parseSubject} rejoins the trailing tokens.
 */

/** MAJOR version token embedded in every subject. */
export const SUBJECT_VERSION = "v1";

/** Fixed prefix of each subject family, up to and including the version token. */
export const SUBJECT_ROOTS = {
	call: `calls.evt.${SUBJECT_VERSION}`,
	registration: `sip.reg.${SUBJECT_VERSION}`,
	queue: `queue.evt.${SUBJECT_VERSION}`,
	voicemail: `voicemail.evt.${SUBJECT_VERSION}`,
	media: `media.evt.${SUBJECT_VERSION}`,
	cdrLeg: `cdr.leg.${SUBJECT_VERSION}`,
	audit: `audit.evt.${SUBJECT_VERSION}`,
	provision: `provision.evt.${SUBJECT_VERSION}`,
} as const;

/** Request-reply subjects (NATS core, never JetStream-backed). */
export const RPC_SUBJECTS = {
	routingResolve: `rpc.routing.${SUBJECT_VERSION}.resolve`,
	authzCheck: `rpc.authz.${SUBJECT_VERSION}.check`,
	voicemailList: `rpc.voicemail.${SUBJECT_VERSION}.list`,
	sipCredential: `rpc.sip.${SUBJECT_VERSION}.credential`,
	/**
	 * The SIP edge asking the call engine to execute a phone's REFER: `apps/sipd` (Go) → the
	 * NestJS engine.
	 *
	 * The second subject whose caller is Go, and the FIRST whose caller is Go and whose responder
	 * is TypeScript — `rpc.sip.v1.credential` points the same way but is answered by `apps/api`.
	 * Both directions carry the same obligation: raw NATS, because a Nest `@MessagePattern` would
	 * wait for framing a Go caller never sends. See `schemas/rpc.ts`.
	 */
	sipTransfer: `rpc.sip.${SUBJECT_VERSION}.transfer`,
	/**
	 * The media-plane command surface: `apps/engine` (TypeScript) → `apps/mediad` (Go).
	 *
	 * These are the FIRST subjects on this backbone whose responder is Go and whose caller is
	 * TypeScript, which inverts the framing obligation every other subject carries — see the
	 * "raw NATS on both ends" note at the head of `schemas/rpc.ts`.
	 */
	mediaAllocateSession: `rpc.media.${SUBJECT_VERSION}.allocate-session`,
	mediaBridgeSessions: `rpc.media.${SUBJECT_VERSION}.bridge-sessions`,
	mediaUnbridgeSessions: `rpc.media.${SUBJECT_VERSION}.unbridge-sessions`,
	mediaReleaseSession: `rpc.media.${SUBJECT_VERSION}.release-session`,
	/**
	 * Rung 1's playback pair, added when `mediad` learned to source frames from a file.
	 *
	 * `stop-playback` is keyed by `playbackRef` ALONE and carries no session id, because
	 * `MediaPort.stopPlayback(playbackRef)` has none to give: the engine stops a prompt from a
	 * barge-in handler that holds a reference and nothing else. `mediad` therefore indexes live
	 * playbacks by reference — see `apps/mediad/internal/rtp`.
	 */
	mediaStartPlayback: `rpc.media.${SUBJECT_VERSION}.start-playback`,
	mediaStopPlayback: `rpc.media.${SUBJECT_VERSION}.stop-playback`,
	/**
	 * The engine-to-engine command surface. A PREFIX, not a complete subject.
	 *
	 * Every other entry here is a subject any responder may serve, because any instance of the
	 * responding service can answer. This one cannot be: a parked call lives on ONE engine
	 * instance's media channel, and only that instance can move it. So the instance's own token is
	 * appended — see {@link subjectFor.engineParkHandoff} — and the requester addresses the owner
	 * it read out of the `park-claims` bucket rather than whichever engine answers first.
	 *
	 * A queue group on a flat subject would have been the other option and is wrong for the same
	 * reason: a queue delivers to one member, chosen by the server, and seven times out of eight
	 * that member is not the one holding the call.
	 */
	engineParkHandoff: `rpc.engine.${SUBJECT_VERSION}.park-handoff`,
} as const;

/**
 * Channel-lifecycle vocabulary, the FreeSWITCH-semantic superset the engine emits
 * (`plans/reference/freeswitch-capabilities.md` §8, trimmed to what the plan's §4.2 names).
 */
export const CALL_EVENTS = [
	"channel.created",
	"channel.ringing",
	"channel.early-media",
	"channel.answered",
	"channel.bridged",
	"channel.unbridged",
	"channel.held",
	"channel.unheld",
	"channel.dtmf",
	"channel.record.started",
	"channel.record.stopped",
	"channel.hangup",
	"channel.destroyed",
	// --- not channel lifecycle: facts ABOUT a call that a consumer acts on ---------------------
	/**
	 * A conference participant joined a room. Carries whether they came in as a moderator, which
	 * is what releases everyone else's `waitForModerator` hold.
	 */
	"conference.joined",
	/** A conference participant left. The pair bounds a participant's time in the room. */
	"conference.left",
	/**
	 * A call was placed in a park lot's orbit slot.
	 *
	 * Not `channel.held` with extra fields: a held call is still somebody's call and cannot be
	 * collected by anybody else, whereas a parked one is addressable by slot number from every
	 * phone in the building. That is the fact a wallboard renders and a "who is on 401?" question
	 * is answered from.
	 */
	"call.parked",
	/**
	 * A call left its orbit slot, with the reason it left.
	 *
	 * `retrieved`, `timeout` and `abandoned` are the whole point — see `parkEndReasonSchema`. The
	 * pair with `call.parked` bounds a call's time in the lot.
	 */
	"call.unparked",
	/**
	 * A call was handed to a new party.
	 *
	 * Published when the transfer COMPLETES, not when it is requested: an attended transfer that
	 * the transferor cancels never happened as far as anybody downstream is concerned, and
	 * publishing the request would put a transfer in the report for every consultation.
	 */
	"call.transferred",
	/**
	 * A ringing call was answered from a different extension.
	 *
	 * Distinct from `channel.answered` because two legs are involved and the interesting one is the
	 * leg that did NOT answer: it is hung up with `PICKED_OFF` (805) rather than `NO_ANSWER`, and
	 * without this event the only evidence a pickup happened is that pairing.
	 */
	"call.picked-up",
	/**
	 * An emergency call was originated. **This is the Kari's Law notification seam.**
	 *
	 * 47 U.S.C. §623(b) requires an MLTS to notify a central location — a front desk, a security
	 * office, a distribution list — when a `911` call is placed from the system, contemporaneously
	 * and without requiring anyone to reconfigure anything. The engine cannot deliver an email or
	 * a webhook (it holds no tenant configuration and no SMTP handle), and a notification that
	 * lives inside the engine is a notification one process can lose.
	 *
	 * So the contract is the EVENT: the engine publishes this the moment the first trunk attempt
	 * is made — before the answer, because the notification is about the attempt — and delivery is
	 * a consumer's job. It carries the dialed number, the caller, the ELIN actually presented and
	 * the dispatchable location's id, which is everything a "someone on the 4th floor dialed 911"
	 * message needs.
	 */
	"call.emergency.dialed",
] as const;
export type CallEvent = (typeof CALL_EVENTS)[number];

/** SIP registrar vocabulary. `expired` is the registrar's TTL sweep, not a client REGISTER. */
export const REGISTRATION_EVENTS = ["registered", "unregistered", "expired"] as const;
export type RegistrationEvent = (typeof REGISTRATION_EVENTS)[number];

/** Queue/ACD vocabulary. */
export const QUEUE_EVENTS = [
	"caller.joined",
	"caller.answered",
	"caller.abandoned",
	"agent.state",
] as const;
export type QueueEvent = (typeof QUEUE_EVENTS)[number];

/**
 * Voicemail vocabulary.
 *
 * `message.left` is the FACT that a caller recorded something — the engine publishes it and the
 * control plane files the row. `mwi.updated` is the DERIVED count that lights a lamp, published by
 * whoever owns the mailbox's row, because only that process can count what is in it.
 *
 * Keeping them separate is what stops the engine from having to know how many unread messages a
 * box holds in order to record one.
 */
export const VOICEMAIL_EVENTS = ["message.left", "mwi.updated"] as const;
export type VoicemailEvent = (typeof VOICEMAIL_EVENTS)[number];

/**
 * Media-plane session vocabulary — what `apps/mediad` TELLS, as opposed to what it is ASKED
 * (`rpc.media.v1.*`).
 *
 * The split is the platform's usual one: ask over core request-reply, tell over JetStream. A
 * command is a synchronous question inside a call setup; these two are facts about a session that
 * outlive the asking, and the engine acts on them by tearing a leg down.
 *
 * Every member exists because something reads it:
 *
 * - `session.ended` is the fact. It carries the reason, so one consumer can tell a session that was
 *   released in the normal course of a hangup from one that died — which is the difference between
 *   a clean call and a media outage in the same wallboard.
 * - `session.rtp-timeout` is the DIAGNOSIS that precedes an `ended` whose reason is `rtp-timeout`.
 *   It is separate rather than folded in because it is actionable on its own: audio stopped while
 *   the signalling plane still believes the call is up, which is the single most common shape of a
 *   "the call was still connected but we could not hear each other" report.
 * - `playback.finished` says a prompt stopped and WHY. The engine does not branch on it — see the
 *   note on {@link mediaPlaybackFinishedDataSchema} — and it is published anyway for the same
 *   reason `session.rtp-timeout` is: `reason: error` is a media failure on a call that is still up,
 *   and without a durable record of it "the caller says they never heard the menu" has no evidence
 *   behind it at all.
 *
 * There is deliberately no `session.allocated`, `session.bridged` or `playback.started`: all three
 * are the successful reply to a command the engine issued and is still holding, so publishing them
 * would be telling the caller something it already knows.
 *
 * Named `MEDIA_SESSION_EVENTS` rather than `MEDIA_EVENTS`, breaking the `CALL_EVENTS` /
 * `QUEUE_EVENTS` pattern on purpose: `apps/engine` already owns a domain type called `MediaEvent`
 * (its media-server-agnostic event union, `src/media/media-event.ts`), and the one file that must
 * import both is the `mediad` adapter. Two different `MediaEvent`s in one import list is a rename
 * waiting to be applied to the wrong one.
 */
export const MEDIA_SESSION_EVENTS = [
	"session.ended",
	"session.rtp-timeout",
	"playback.finished",
] as const;
export type MediaSessionEvent = (typeof MEDIA_SESSION_EVENTS)[number];

/**
 * Reserved queue-scope token for events that belong to the org rather than to one queue —
 * in practice `agent.state`, since an agent has one status across every tier they sit in.
 * Wallboards subscribe to `queue.evt.v1.<org>.>` and therefore see both scopes.
 */
export const QUEUE_SCOPE_ALL = "_all";

/**
 * Event families. A family is identified by the SUBJECT; `type` inside the envelope is only
 * unique within its family (`registered` means nothing without `sip.reg.v1.…` around it).
 */
export const EVENT_FAMILIES = [
	"call",
	"registration",
	"queue",
	"voicemail",
	"media",
	"cdr",
	"audit",
	"provision",
] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

/** Raised when a caller tries to build a subject from a value that cannot be a subject token. */
export class SubjectTokenError extends Error {
	readonly role: string;
	readonly value: string;

	constructor(role: string, value: string) {
		super(
			`Invalid ${role} subject token ${JSON.stringify(value)}: expected one or more ` +
				"dot-separated tokens of [A-Za-z0-9_-].",
		);
		this.name = "SubjectTokenError";
		this.role = role;
		this.value = value;
	}
}

/** A single subject token: no dots, no whitespace, no `*`/`>` wildcards, never empty. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
/** A hierarchical event name: one or more tokens joined by dots. */
const EVENT_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

/** Returns whether `value` is usable as exactly one subject token. */
export function isSubjectToken(value: string): boolean {
	return TOKEN_PATTERN.test(value);
}

/** Returns whether `value` is usable as a (possibly dotted) event name. */
export function isEventName(value: string): boolean {
	return EVENT_PATTERN.test(value);
}

function assertToken(role: string, value: string): string {
	if (!TOKEN_PATTERN.test(value)) {
		throw new SubjectTokenError(role, value);
	}
	return value;
}

function assertEvent(value: string): string {
	if (!EVENT_PATTERN.test(value)) {
		throw new SubjectTokenError("event", value);
	}
	return value;
}

/**
 * Stable subject token for an Address of Record.
 *
 * An AOR (`sip:1001@acme.example.com`) contains `@`, `:` and dots, none of which survive as a
 * single subject token, and it is PII-adjacent. The token is the first 32 hex characters of the
 * SHA-256 of the lower-cased AOR — 128 bits, collision-free at any registrar scale, and stable
 * across processes so `sip.reg.v1.<org>.<aorHash>.>` is a usable per-device filter.
 *
 * The full AOR always travels in the event payload; the hash is addressing only.
 */
export function aorSubjectToken(aor: string): string {
	const normalized = aor.trim().toLowerCase();
	if (normalized.length === 0) {
		throw new SubjectTokenError("aor", aor);
	}
	return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Stable subject token for a service instance id.
 *
 * An instance id is whatever the operator (or the container runtime) called the process:
 * `ENGINE_INSTANCE_ID`, defaulting to `HOSTNAME`. Most of the time that is already one subject
 * token — `engine`, `engine-2`, `engine-7d9f4c-xk2lp` — and it is returned VERBATIM, because a
 * subject an operator can read is a subject an operator can `nats sub` while a call is stuck in a
 * lot. Some of the time it is not: an FQDN hostname carries dots, and a dot is a token separator,
 * so `engine.eu-west.internal` would silently become four tokens and address a subject nobody
 * subscribes to.
 *
 * So: verbatim when it is a token, and the first 32 hex characters of its SHA-256 when it is not.
 * Both ends compute it from the same string — the owner from its own configured id, the retriever
 * from the `instanceId` it read out of the claim — so the two always agree, whichever branch runs.
 *
 * @throws {SubjectTokenError} when the id is empty.
 */
export function instanceSubjectToken(instanceId: string): string {
	const normalized = instanceId.trim();
	if (normalized.length === 0) {
		throw new SubjectTokenError("instanceId", instanceId);
	}
	return TOKEN_PATTERN.test(normalized)
		? normalized
		: createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/**
 * Stable key token for a DID, for the `did-index` KV bucket.
 *
 * An E.164 number is stored as `+441632960111` and dialled as `441632960111`, `+441632960111` or
 * (from a carrier that strips it) `441632960111` with punctuation. None of `+`, spaces, dashes or
 * parentheses survive as a KV key token, and none of them carry meaning, so the token is the
 * DIGITS of the number and nothing else. Both writers (the control plane, from the stored E.164)
 * and the reader (the engine, from the dialled number) go through this one function, which is what
 * makes "the DID the tenant configured" and "the DID the carrier delivered" the same key.
 *
 * What it deliberately does NOT do is guess a dial plan. `0044…` and `+44…` are the same number to
 * a human and different tokens here, because turning a national prefix into a country code needs to
 * know which country the trunk is in — a per-trunk normalization step that belongs to the SIP edge,
 * not to a string function in the contract package.
 *
 * @throws {SubjectTokenError} when the value contains no digits at all.
 */
export function didIndexToken(did: string): string {
	const digits = did.replace(/[^0-9]/gu, "");
	if (digits.length === 0) {
		throw new SubjectTokenError("did", did);
	}
	return digits;
}

/** Builds a concrete publish subject. Never concatenate subjects at a call site. */
export const subjectFor = {
	/** `calls.evt.v1.<orgId>.<callId>.<event>` */
	call(orgId: string, callId: string, event: CallEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.call}.${assertToken("orgId", orgId)}.${assertToken("callId", callId)}.${assertEvent(event)}`;
	},
	/** `sip.reg.v1.<orgId>.<aorHash>.<event>` — `aorHash` comes from {@link aorSubjectToken}. */
	registration(orgId: string, aorHash: string, event: RegistrationEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.registration}.${assertToken("orgId", orgId)}.${assertToken("aorHash", aorHash)}.${assertEvent(event)}`;
	},
	/** `queue.evt.v1.<orgId>.<queueId>.<event>` */
	queue(orgId: string, queueId: string, event: QueueEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.queue}.${assertToken("orgId", orgId)}.${assertToken("queueId", queueId)}.${assertEvent(event)}`;
	},
	/** `voicemail.evt.v1.<orgId>.<mailboxId>.<event>` — `mailboxId` is the voicemail box's id. */
	voicemail(orgId: string, mailboxId: string, event: VoicemailEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.voicemail}.${assertToken("orgId", orgId)}.${assertToken("mailboxId", mailboxId)}.${assertEvent(event)}`;
	},
	/**
	 * `media.evt.v1.<orgId>.<sessionId>.<event>` — the media plane's session lifecycle.
	 *
	 * `sessionId` and not `callId`: a call has one id and several media sessions (one per leg), and
	 * the thing that ends, times out, or is reaped is the session. The call it belongs to travels in
	 * the payload, so a consumer that thinks in calls has it without the subject having to lie.
	 */
	media(orgId: string, sessionId: string, event: MediaSessionEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.media}.${assertToken("orgId", orgId)}.${assertToken("sessionId", sessionId)}.${assertEvent(event)}`;
	},
	/** `cdr.leg.v1.<orgId>` — a single ordered subject per org; the CDR writer consumes it. */
	cdrLeg(orgId: string): string {
		return `${SUBJECT_ROOTS.cdrLeg}.${assertToken("orgId", orgId)}`;
	},
	/** `audit.evt.v1.<orgId>` */
	audit(orgId: string): string {
		return `${SUBJECT_ROOTS.audit}.${assertToken("orgId", orgId)}`;
	},
	/** `provision.evt.v1.<orgId>` */
	provision(orgId: string): string {
		return `${SUBJECT_ROOTS.provision}.${assertToken("orgId", orgId)}`;
	},
	/** `rpc.routing.v1.resolve` */
	routingResolveRpc(): string {
		return RPC_SUBJECTS.routingResolve;
	},
	/** `rpc.authz.v1.check` */
	authzCheckRpc(): string {
		return RPC_SUBJECTS.authzCheck;
	},
	/** `rpc.sip.v1.credential` */
	sipCredentialRpc(): string {
		return RPC_SUBJECTS.sipCredential;
	},
	/** `rpc.sip.v1.transfer` */
	sipTransferRpc(): string {
		return RPC_SUBJECTS.sipTransfer;
	},
	/**
	 * `rpc.engine.v1.park-handoff.<instanceToken>` — addressed at ONE engine instance.
	 *
	 * The token comes from {@link instanceSubjectToken}, so a responder subscribing with its own
	 * id and a requester building the subject from the claim's `instanceId` land on the same
	 * string. See {@link RPC_SUBJECTS.engineParkHandoff} for why this is not a flat subject.
	 */
	engineParkHandoffRpc(instanceId: string): string {
		return `${RPC_SUBJECTS.engineParkHandoff}.${instanceSubjectToken(instanceId)}`;
	},
} as const;

/**
 * Builds a subscription/consumer filter. Every filter that spans event names ends in `>` because
 * event names are multi-token (see the file header).
 */
export const subjectFilterFor = {
	/** Every call event, every org — the CALLS stream's own subject list. */
	allCalls(): string {
		return `${SUBJECT_ROOTS.call}.>`;
	},
	/** Every call event for one org. */
	callsInOrg(orgId: string): string {
		return `${SUBJECT_ROOTS.call}.${assertToken("orgId", orgId)}.>`;
	},
	/** Every event of one call — JetStream guarantees per-subject ordering within it. */
	call(orgId: string, callId: string): string {
		return `${SUBJECT_ROOTS.call}.${assertToken("orgId", orgId)}.${assertToken("callId", callId)}.>`;
	},
	/** One event name across every call of one org, e.g. `channel.hangup`. */
	callEventInOrg(orgId: string, event: CallEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.call}.${assertToken("orgId", orgId)}.*.${assertEvent(event)}`;
	},
	/** One event name across every call of every org. */
	callEvent(event: CallEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.call}.*.*.${assertEvent(event)}`;
	},

	allRegistrations(): string {
		return `${SUBJECT_ROOTS.registration}.>`;
	},
	registrationsInOrg(orgId: string): string {
		return `${SUBJECT_ROOTS.registration}.${assertToken("orgId", orgId)}.>`;
	},
	registrationsForAor(orgId: string, aorHash: string): string {
		return `${SUBJECT_ROOTS.registration}.${assertToken("orgId", orgId)}.${assertToken("aorHash", aorHash)}.>`;
	},
	registrationEventInOrg(orgId: string, event: RegistrationEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.registration}.${assertToken("orgId", orgId)}.*.${assertEvent(event)}`;
	},

	allQueues(): string {
		return `${SUBJECT_ROOTS.queue}.>`;
	},
	queuesInOrg(orgId: string): string {
		return `${SUBJECT_ROOTS.queue}.${assertToken("orgId", orgId)}.>`;
	},
	queue(orgId: string, queueId: string): string {
		return `${SUBJECT_ROOTS.queue}.${assertToken("orgId", orgId)}.${assertToken("queueId", queueId)}.>`;
	},
	queueEventInOrg(orgId: string, event: QueueEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.queue}.${assertToken("orgId", orgId)}.*.${assertEvent(event)}`;
	},

	/** Every voicemail event, every org — the VOICEMAIL stream's own subject list. */
	allVoicemail(): string {
		return `${SUBJECT_ROOTS.voicemail}.>`;
	},
	voicemailInOrg(orgId: string): string {
		return `${SUBJECT_ROOTS.voicemail}.${assertToken("orgId", orgId)}.>`;
	},
	/** Every event of one mailbox — what a BLF/MWI subscriber for one box watches. */
	voicemailBox(orgId: string, mailboxId: string): string {
		return `${SUBJECT_ROOTS.voicemail}.${assertToken("orgId", orgId)}.${assertToken("mailboxId", mailboxId)}.>`;
	},
	voicemailEventInOrg(orgId: string, event: VoicemailEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.voicemail}.${assertToken("orgId", orgId)}.*.${assertEvent(event)}`;
	},

	/** Every media-session event, every org — the MEDIA stream's own subject list. */
	allMedia(): string {
		return `${SUBJECT_ROOTS.media}.>`;
	},
	mediaInOrg(orgId: string): string {
		return `${SUBJECT_ROOTS.media}.${assertToken("orgId", orgId)}.>`;
	},
	/** Every event of one media session. */
	mediaSession(orgId: string, sessionId: string): string {
		return `${SUBJECT_ROOTS.media}.${assertToken("orgId", orgId)}.${assertToken("sessionId", sessionId)}.>`;
	},
	mediaEventInOrg(orgId: string, event: MediaSessionEvent | (string & {})): string {
		return `${SUBJECT_ROOTS.media}.${assertToken("orgId", orgId)}.*.${assertEvent(event)}`;
	},

	/** `cdr.leg.v1.*` — the CDR writer's filter; one token, so `*` not `>`. */
	allCdrLegs(): string {
		return `${SUBJECT_ROOTS.cdrLeg}.*`;
	},
	cdrLegsInOrg(orgId: string): string {
		return subjectFor.cdrLeg(orgId);
	},

	allAudit(): string {
		return `${SUBJECT_ROOTS.audit}.*`;
	},
	auditInOrg(orgId: string): string {
		return subjectFor.audit(orgId);
	},

	allProvision(): string {
		return `${SUBJECT_ROOTS.provision}.*`;
	},
	provisionInOrg(orgId: string): string {
		return subjectFor.provision(orgId);
	},
} as const;

/** The reverse of {@link subjectFor}: a delivered subject decomposed into its parts. */
export type ParsedSubject =
	| {
			readonly kind: "call";
			readonly family: "call";
			readonly version: string;
			readonly orgId: string;
			readonly callId: string;
			readonly event: string;
	  }
	| {
			readonly kind: "registration";
			readonly family: "registration";
			readonly version: string;
			readonly orgId: string;
			readonly aorHash: string;
			readonly event: string;
	  }
	| {
			readonly kind: "queue";
			readonly family: "queue";
			readonly version: string;
			readonly orgId: string;
			readonly queueId: string;
			readonly event: string;
	  }
	| {
			readonly kind: "voicemail";
			readonly family: "voicemail";
			readonly version: string;
			readonly orgId: string;
			readonly mailboxId: string;
			readonly event: string;
	  }
	| {
			readonly kind: "media";
			readonly family: "media";
			readonly version: string;
			readonly orgId: string;
			readonly sessionId: string;
			readonly event: string;
	  }
	| {
			readonly kind: "cdr-leg";
			readonly family: "cdr";
			readonly version: string;
			readonly orgId: string;
	  }
	| {
			readonly kind: "audit";
			readonly family: "audit";
			readonly version: string;
			readonly orgId: string;
	  }
	| {
			readonly kind: "provision";
			readonly family: "provision";
			readonly version: string;
			readonly orgId: string;
	  }
	| {
			readonly kind: "rpc";
			readonly family: "rpc";
			readonly version: string;
			readonly service: string;
			readonly method: string;
	  };

/** Raised by {@link parseSubjectOrThrow} when a subject is outside the taxonomy. */
export class UnknownSubjectError extends Error {
	readonly subject: string;

	constructor(subject: string) {
		super(`Subject ${JSON.stringify(subject)} is not part of the Optimiq Voice taxonomy.`);
		this.name = "UnknownSubjectError";
		this.subject = subject;
	}
}

/**
 * Decomposes a concrete (wildcard-free) subject. Returns `undefined` for anything outside the
 * taxonomy, including subjects of a different MAJOR version.
 *
 * The `event` is returned as a plain `string`, not a narrowed union: a v1.n producer may emit an
 * event name a v1.0 consumer has never heard of, and dropping that message on the floor at parse
 * time would break the additive-evolution guarantee. Narrow with {@link isCallEvent} and friends
 * when the code actually needs to branch.
 */
export function parseSubject(subject: string): ParsedSubject | undefined {
	if (subject.includes("*") || subject.includes(">")) {
		return undefined;
	}
	const tokens = subject.split(".");
	if (tokens.length < 4) {
		return undefined;
	}
	const [first, second, version, ...rest] = tokens as [string, string, string, ...string[]];
	if (version !== SUBJECT_VERSION) {
		return undefined;
	}
	const prefix = `${first}.${second}`;

	if (prefix === "calls.evt" && rest.length >= 3) {
		const [orgId, callId, ...event] = rest as [string, string, ...string[]];
		return { kind: "call", family: "call", version, orgId, callId, event: event.join(".") };
	}
	if (prefix === "sip.reg" && rest.length >= 3) {
		const [orgId, aorHash, ...event] = rest as [string, string, ...string[]];
		return {
			kind: "registration",
			family: "registration",
			version,
			orgId,
			aorHash,
			event: event.join("."),
		};
	}
	if (prefix === "queue.evt" && rest.length >= 3) {
		const [orgId, queueId, ...event] = rest as [string, string, ...string[]];
		return { kind: "queue", family: "queue", version, orgId, queueId, event: event.join(".") };
	}
	if (prefix === "voicemail.evt" && rest.length >= 3) {
		const [orgId, mailboxId, ...event] = rest as [string, string, ...string[]];
		return {
			kind: "voicemail",
			family: "voicemail",
			version,
			orgId,
			mailboxId,
			event: event.join("."),
		};
	}
	if (prefix === "media.evt" && rest.length >= 3) {
		const [orgId, sessionId, ...event] = rest as [string, string, ...string[]];
		return { kind: "media", family: "media", version, orgId, sessionId, event: event.join(".") };
	}
	if (prefix === "cdr.leg" && rest.length === 1) {
		return { kind: "cdr-leg", family: "cdr", version, orgId: rest[0] as string };
	}
	if (prefix === "audit.evt" && rest.length === 1) {
		return { kind: "audit", family: "audit", version, orgId: rest[0] as string };
	}
	if (prefix === "provision.evt" && rest.length === 1) {
		return { kind: "provision", family: "provision", version, orgId: rest[0] as string };
	}
	if (first === "rpc" && rest.length === 1) {
		return { kind: "rpc", family: "rpc", version, service: second, method: rest[0] as string };
	}
	return undefined;
}

/** {@link parseSubject}, throwing {@link UnknownSubjectError} instead of returning `undefined`. */
export function parseSubjectOrThrow(subject: string): ParsedSubject {
	const parsed = parseSubject(subject);
	if (parsed === undefined) {
		throw new UnknownSubjectError(subject);
	}
	return parsed;
}

/** The event family a subject belongs to, or `undefined` when it is not an event subject. */
export function eventFamilyForSubject(subject: string): EventFamily | undefined {
	const parsed = parseSubject(subject);
	if (parsed === undefined || parsed.kind === "rpc") {
		return undefined;
	}
	return parsed.family;
}

export function isCallEvent(value: string): value is CallEvent {
	return (CALL_EVENTS as readonly string[]).includes(value);
}

export function isRegistrationEvent(value: string): value is RegistrationEvent {
	return (REGISTRATION_EVENTS as readonly string[]).includes(value);
}

export function isQueueEvent(value: string): value is QueueEvent {
	return (QUEUE_EVENTS as readonly string[]).includes(value);
}

export function isVoicemailEvent(value: string): value is VoicemailEvent {
	return (VOICEMAIL_EVENTS as readonly string[]).includes(value);
}

export function isMediaSessionEvent(value: string): value is MediaSessionEvent {
	return (MEDIA_SESSION_EVENTS as readonly string[]).includes(value);
}

/**
 * NATS subject matching: `*` matches exactly one token, `>` matches one or more trailing tokens
 * and is only meaningful as the final token.
 *
 * Reimplemented here rather than imported so subject filters can be unit-tested without a broker
 * and so the in-memory fake in `testing.ts` routes exactly like the server does.
 */
export function matchesSubject(filter: string, subject: string): boolean {
	const filterTokens = filter.split(".");
	const subjectTokens = subject.split(".");

	for (let index = 0; index < filterTokens.length; index += 1) {
		const token = filterTokens[index];
		if (token === ">") {
			return index === filterTokens.length - 1 && subjectTokens.length > index;
		}
		if (index >= subjectTokens.length) {
			return false;
		}
		if (token === "*") {
			continue;
		}
		if (token !== subjectTokens[index]) {
			return false;
		}
	}
	return filterTokens.length === subjectTokens.length;
}
