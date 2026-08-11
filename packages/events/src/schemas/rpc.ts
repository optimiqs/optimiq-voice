import { z } from "zod";
import { RPC_SUBJECTS } from "../subjects";
import {
	callDirectionSchema,
	destinationTypeSchema,
	dialStringSchema,
	sipTransportSchema,
} from "./telephony";

/**
 * Request-reply contracts for the `rpc.*` subjects (plan §3.5).
 *
 * These are CONTRACTS ONLY — subject plus a request/response schema pair. Transport is the
 * application's business: services expose them with NestJS `@MessagePattern` over the NATS
 * transport and call them with a `ClientProxy`. This package neither opens a connection nor
 * wraps one.
 *
 * `rpc.media.*` (engine → `mediad`) was deliberately absent while the media plane was a walking
 * skeleton. It is here now, as `rpc.media.v1.*`, because all four promotion criteria in
 * `plans/mediad-design.md` §4.3 are met: SDP is in the payloads, there is a real Go responder in
 * `apps/mediad/internal/control`, and there is a real TypeScript caller in the engine's
 * `MediadMediaPort`. **Read the note on {@link mediaAllocateSessionRequestSchema} before writing
 * either end** — this is the one subject family whose caller must NOT use a Nest `ClientProxy`.
 *
 * ## What is actually on the wire — read this before adding a responder
 *
 * A schema here describes the PAYLOAD. NestJS's NATS transport does not put the payload on the
 * wire for request-reply; it puts its own framing around it:
 *
 * ```text
 * request   {"pattern":"<subject>","data":{…the schema…},"id":"…"}
 * reply     {"response":{…the schema…},"isDisposed":true,"id":"…"}
 * ```
 *
 * and a request carrying the bare payload is **not answered at all** — it times out. That is
 * invisible while both ends are Nest (`@MessagePattern` ↔ `ClientProxy.send`), which is what every
 * subject above was when it was written, and `apps/engine/src/nats/envelope.serializer.ts` records
 * the same leak on the event side.
 *
 * It stops being invisible the moment a caller is not TypeScript. `packages/events-go` generates
 * request/response structs from these schemas, so a Go caller speaks the payload and nothing else.
 * `rpc.sip.v1.credential` therefore has a **raw** responder
 * (`apps/api/src/pbx/sip-credentials/sip-credentials.responder.ts`), not a `@MessagePattern` one.
 *
 * Rule of thumb: if a subject has, or could have, a non-TypeScript participant, serve it raw so
 * that the contract is the wire. If it is Nest-to-Nest, `@MessagePattern` is fine — but the
 * generated Go structs for it are then documentation, not a usable client.
 *
 * There is one exception to the second half, and it is `rpc.engine.v1.park-handoff`: Nest on both
 * ends and raw anyway, because its subject is not a constant. See its own note.
 */

/** A request-reply contract: one subject, one request schema, one response schema. */
export interface RpcContract<TRequest extends z.ZodType, TResponse extends z.ZodType> {
	readonly subject: string;
	readonly request: TRequest;
	readonly response: TResponse;
	/** Suggested client deadline. These are on the call path — slow is the same as broken. */
	readonly timeoutMs: number;
}

function defineRpc<TRequest extends z.ZodType, TResponse extends z.ZodType>(
	subject: string,
	request: TRequest,
	response: TResponse,
	timeoutMs: number,
): RpcContract<TRequest, TResponse> {
	return { subject, request, response, timeoutMs };
}

// ---------------------------------------------------------------------------------------------
// rpc.routing.v1.resolve — engine → api, on a routing-cache miss
// ---------------------------------------------------------------------------------------------

export const routingResolveRequestSchema = z.object({
	orgId: z.uuid(),
	direction: callDirectionSchema,
	destinationNumber: dialStringSchema,
	callerNumber: dialStringSchema.optional(),
	callerName: z.string().max(128).optional(),
	/**
	 * The named routing namespace the leg is executing in. This is the toll-fraud boundary from
	 * `plans/reference/freeswitch-capabilities.md` §7 — unauthenticated traffic never resolves in
	 * a trunk-capable context.
	 */
	routingContext: z.string().min(1).max(64),
	/** Present when the lookup is for a live call; used for logging correlation only. */
	callId: z.uuid().optional(),
	/**
	 * Evaluation instant. Time conditions (business hours, holidays) are first-class routing
	 * predicates, so a resolve is only reproducible against an explicit clock.
	 */
	at: z.iso.datetime().optional(),
});

export const routingResolveResponseSchema = z.object({
	matched: z.boolean(),
	destinationType: destinationTypeSchema.optional(),
	destinationRef: z.uuid().optional(),
	/** Context the call should continue in, when the rule moves it. */
	routingContext: z.string().max(64).optional(),
	/**
	 * The compiled routing artifact. Opaque here on purpose — `packages/routing` owns its shape,
	 * and the engine caches it verbatim under `cacheKey`.
	 */
	artifact: z.unknown().optional(),
	/** `routing-cache` KV key the engine should store `artifact` under (see `kvKeyFor`). */
	cacheKey: z.string().max(256).optional(),
	ttlMs: z.int().min(0).optional(),
	/** Why nothing matched, for the "call went nowhere" support ticket. */
	reason: z.string().max(256).optional(),
});

export type RoutingResolveRequest = z.infer<typeof routingResolveRequestSchema>;
export type RoutingResolveResponse = z.infer<typeof routingResolveResponseSchema>;

export const ROUTING_RESOLVE_RPC = defineRpc(
	RPC_SUBJECTS.routingResolve,
	routingResolveRequestSchema,
	routingResolveResponseSchema,
	2_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.authz.v1.check — any service → api
// ---------------------------------------------------------------------------------------------

export const authzCheckRequestSchema = z.object({
	orgId: z.uuid(),
	subject: z.object({
		type: z.enum(["user", "api-key", "service"]),
		id: z.string().min(1).max(128),
	}),
	/** `<resource>.<action>[.<scope>]` strings from the permission registry in `packages/auth`. */
	permissions: z
		.array(
			z
				.string()
				.min(1)
				.max(96)
				.regex(/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/, "permission must be dotted kebab-case"),
		)
		.min(1)
		.max(64),
	resource: z
		.object({ type: z.string().min(1).max(64), id: z.string().max(128).optional() })
		.optional(),
});

export const authzCheckResponseSchema = z.object({
	/** True only when EVERY requested permission is granted. */
	allowed: z.boolean(),
	granted: z.array(z.string().max(96)).max(64),
	missing: z.array(z.string().max(96)).max(64),
	reason: z.string().max(256).optional(),
});

export type AuthzCheckRequest = z.infer<typeof authzCheckRequestSchema>;
export type AuthzCheckResponse = z.infer<typeof authzCheckResponseSchema>;

export const AUTHZ_CHECK_RPC = defineRpc(
	RPC_SUBJECTS.authzCheck,
	authzCheckRequestSchema,
	authzCheckResponseSchema,
	1_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.voicemail.v1.list — engine → api, when a caller opens a mailbox
// ---------------------------------------------------------------------------------------------

/**
 * The read model behind the `*97` menu.
 *
 * Messages live in `pbx-db`'s `voicemail_message`, which is the control plane's table; the engine
 * holds no database handle and must not grow one, so a caller who has just authenticated needs a
 * request-reply to find out what is in their mailbox. Request-reply rather than an event stream
 * because the answer is needed *now*, at the moment the caller is listening to silence, and a
 * consumer-maintained projection would be a second copy of the same rows with its own staleness.
 *
 * The engine is expected to survive nobody answering. A mailbox it cannot list is announced as
 * unavailable and the call ends — never as "you have no messages", which is a different and much
 * more damaging thing to tell somebody who has nine.
 */
export const voicemailListRequestSchema = z.object({
	orgId: z.uuid(),
	voicemailBoxId: z.uuid(),
	/**
	 * The number the caller reached the mailbox from, as the engine authenticated it.
	 *
	 * The responder MUST treat this as a claim to be checked against the box, not as authorisation:
	 * the engine authenticates a caller with the box's PIN and its own extension check, but a
	 * responder that trusted a request purely because it arrived on the broker would hand any
	 * process on the network any tenant's messages.
	 */
	mailboxNumber: z.string().min(1).max(32),
	/** `new` is what the menu plays. `saved` and `deleted` are the other `voicemail_message` folders. */
	folder: z.enum(["new", "saved", "deleted"]).default("new"),
	/** Newest first, capped so one mailbox cannot produce an unbounded reply. */
	limit: z.int().min(1).max(100).default(20),
	callId: z.uuid().optional(),
});

export const voicemailMessageSummarySchema = z.object({
	messageId: z.uuid(),
	folder: z.enum(["new", "saved", "deleted"]),
	/** Object-storage key for the audio. The engine renders it as an `object://` media ref. */
	objectKey: z.string().min(1).max(1024),
	durationMs: z.int().min(0),
	receivedAt: z.iso.datetime(),
	callerIdNumber: z.string().max(64).optional(),
	callerIdName: z.string().max(128).optional(),
});

export const voicemailListResponseSchema = z.object({
	/** False means "this mailbox could not be read" — never "it is empty". */
	found: z.boolean(),
	/** Newest first. Empty with `found: true` is a genuinely empty folder. */
	messages: z.array(voicemailMessageSummarySchema).max(100).default([]),
	/** Total in the folder, which may exceed `messages.length` when `limit` truncated it. */
	total: z.int().min(0).default(0),
	newCount: z.int().min(0).default(0),
	savedCount: z.int().min(0).default(0),
	/** Why the mailbox could not be read, for the support ticket. */
	reason: z.string().max(256).optional(),
});

export type VoicemailListRequest = z.infer<typeof voicemailListRequestSchema>;
export type VoicemailListResponse = z.infer<typeof voicemailListResponseSchema>;
export type VoicemailMessageSummary = z.infer<typeof voicemailMessageSummarySchema>;

export const VOICEMAIL_LIST_RPC = defineRpc(
	RPC_SUBJECTS.voicemailList,
	voicemailListRequestSchema,
	voicemailListResponseSchema,
	// Longer than a routing resolve: this one is answered while the caller is already connected and
	// listening, so a slow reply costs a second of dead air rather than a call that never connects.
	3_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.sip.v1.credential — sipd → api, on every REGISTER that answers a digest challenge
// ---------------------------------------------------------------------------------------------

/**
 * The registrar's credential lookup.
 *
 * ## Why the registrar cannot answer this itself
 *
 * `apps/sipd` holds no database handle and must not grow one: extension rows are `pbx-db`, which
 * the API owns. All the registrar has at the moment it must decide is what the phone put on the
 * wire — a realm and a username — so this is the one `rpc.*` request that does **not** carry an
 * `orgId`. Every other subject is called by something that already knows its tenant; here,
 * resolving the tenant IS the request. The responder derives it from the realm and MUST NOT take
 * a tenant hint from the caller, which is why no such field exists to be trusted.
 *
 * ## Why the reply carries HA1 and never a password
 *
 * `ha1 = MD5(username:realm:password)` is exactly what RFC 2617 digest verification consumes, so
 * shipping it lets the registrar answer a REGISTER without ever holding a credential it could
 * replay somewhere else. It also puts the realm inside the hash, which makes a realm change an
 * explicit re-provisioning event rather than a silent authentication outage.
 *
 * The alternative — replying `{ orgId, secretRef }` and letting `apps/sipd` run the derivation —
 * was rejected: it would require `PROVISION_SIP_SECRET_KEY` to be deployed to the SIP edge, which
 * is the most exposed process in the system. The root key derives **every** tenant's password, so
 * a compromised edge would be a total credential compromise rather than the loss of whatever is
 * registered against that edge. Deriving in the API keeps the root key on the control plane, and
 * `apps/sipd/internal/credentials/derive.go` exists to prove the two languages agree on the
 * derivation, not to run it in production.
 *
 * ## `found` and `enabled` are separate, and the SIP layer merges them
 *
 * The registrar answers `403` for both, so a caller cannot tell an unknown extension from a
 * disabled one — no enumeration oracle. They stay distinct on the wire so an operator UI and the
 * logs can say which one actually happened.
 */
export const sipCredentialRequestSchema = z.object({
	/** The digest realm the registrar challenged with. This is what resolves the tenant. */
	realm: z.string().min(1).max(255),
	/** SIP user part, matched case-sensitively per RFC 3261 §19.1.4. */
	username: z.string().min(1).max(128),
	/**
	 * `ip:port` the REGISTER arrived from, and its transport.
	 *
	 * Sent so the responder can apply per-account ACLs and feed the fail2ban-style counters in the
	 * master plan §5 T1 — **not** because the registrar needs them back. A responder that ignores
	 * them is correct today.
	 */
	sourceAddress: z.string().max(64).optional(),
	transport: sipTransportSchema.optional(),
});

export const sipCredentialResponseSchema = z.object({
	/** False means "no such account in this realm". Never means "the lookup failed" — see `reason`. */
	found: z.boolean(),
	/** An account that exists but is administratively off. Distinct on the wire, merged at SIP. */
	enabled: z.boolean().default(false),
	orgId: z.uuid().optional(),
	username: z.string().max(128).optional(),
	realm: z.string().max(255).optional(),
	/** `MD5(username:realm:password)`, lower-case hex. Never a password. */
	ha1: z
		.string()
		.regex(/^[0-9a-f]{32}$/, "ha1 must be 32 lower-case hex characters")
		.optional(),
	deviceId: z.uuid().optional(),
	extensionId: z.uuid().optional(),
	/** Why the lookup could not be answered, for the support ticket. Never shown to a phone. */
	reason: z.string().max(256).optional(),
});

export type SipCredentialRequest = z.infer<typeof sipCredentialRequestSchema>;
export type SipCredentialResponse = z.infer<typeof sipCredentialResponseSchema>;

export const SIP_CREDENTIAL_RPC = defineRpc(
	RPC_SUBJECTS.sipCredential,
	sipCredentialRequestSchema,
	sipCredentialResponseSchema,
	// The tightest deadline in this file, and deliberately so: this one sits inside a REGISTER
	// transaction. A phone's retransmission timer starts at 500 ms, so a reply that arrives later
	// than that is already competing with the retry it caused.
	500,
);

// ---------------------------------------------------------------------------------------------
// rpc.sip.v1.transfer — sipd → engine, on a REFER from a desk phone
// ---------------------------------------------------------------------------------------------

/**
 * Why a SIP transfer was refused.
 *
 * As everywhere else on this backbone, a refusal is a REPLY. Here it is not merely good manners:
 * RFC 3515 obliges the referee to report the outcome back to the phone in a NOTIFY carrying a
 * `message/sipfrag` status line, and a silence would leave `apps/sipd` inventing one. The registrar
 * maps every code below onto a single `SIP/2.0 503 Service Unavailable` frag — the phone gets one
 * honest failure rather than a taxonomy it cannot act on — while the code itself is what the logs
 * and any future operator UI branch on.
 */
export const SIP_TRANSFER_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/**
	 * No live call matches the SIP dialog the REFER arrived in.
	 *
	 * The ordinary answer, and the racy one: the transferor hung up, or the far end did, between the
	 * REFER leaving the phone and this request being served.
	 */
	"unknown_dialog",
	/**
	 * The engine cannot map a SIP `Call-ID` onto a channel AT ALL — not "looked and found nothing",
	 * but "there is no index to look in".
	 *
	 * A structurally different answer from {@link unknown_dialog} and worth its own name, because the
	 * two need different fixes: one is a call that ended, the other is a deployment where the media
	 * driver never recorded which SIP dialog produced a channel. `channelCreatedDataSchema.sipCallId`
	 * is optional precisely because the ARI driver does not populate it today; until something does,
	 * every well-formed request is answered with this, and it is a REFUSAL rather than a pretend
	 * success so that a phone's transfer button fails visibly instead of silently doing nothing.
	 */
	"correlation_unavailable",
	/**
	 * The dialog resolved, but to a call in another tenant, or to one the referrer is not a party to.
	 *
	 * The authorisation boundary. `apps/sipd` digest-authenticates the REFER and checks that the
	 * referrer owns a live registration, but it cannot check who is on a call it is not in the path
	 * of. The engine can, and must: without this, any authenticated extension could redirect any
	 * other extension's conversation by guessing a `Call-ID`.
	 */
	"not_permitted",
	/**
	 * The dialog belongs to a call held by ANOTHER engine instance.
	 *
	 * Reserved rather than raised today. The subject is flat and served on a queue group, so exactly
	 * one instance answers and it may not be the one holding the leg; distinguishing that from
	 * `unknown_dialog` needs a dialog directory in KV, the same shape as `park-claims` and
	 * `media-sessions`. Named now so the retry semantics — do not retry here, ask the owner — exist
	 * in the vocabulary before the directory does.
	 */
	"wrong_instance",
	/** The `Refer-To` user part resolves to nothing dialable in this tenant's plan. */
	"unknown_target",
	/**
	 * The REFER carried a `Replaces` header — an ATTENDED transfer completed at the phone — and this
	 * engine cannot honour it.
	 *
	 * Attended transfer exists in `CallControl`, but as a CONSULTATION the engine itself created and
	 * therefore holds the two halves of. A phone that consulted on its own second line and then sent
	 * `Replaces` is asking the engine to join two dialogs it never brokered. Refused by name rather
	 * than downgraded to a blind transfer, which would drop the consultation leg the user is talking
	 * to.
	 */
	"attended_unsupported",
	/** The leg went away between resolution and the transfer. */
	"channel_gone",
	/** The engine tried and the media plane or the dial plan refused. See `error`. */
	"transfer_failed",
	/** This instance is draining. Do not retry HERE. */
	"shutting_down",
	/** Anything else. */
	"internal",
] as const;

export const sipTransferRefusalReasonSchema = z.enum(SIP_TRANSFER_REFUSAL_REASONS);
export type SipTransferRefusalReason = (typeof SIP_TRANSFER_REFUSAL_REASONS)[number];

/** Blind (RFC 5589 §6) versus attended (`Replaces`, RFC 3891). */
export const sipTransferKindSchema = z.enum(["blind", "attended"]);
export type SipTransferKind = z.infer<typeof sipTransferKindSchema>;

/**
 * `rpc.sip.v1.transfer` — the SIP edge asking the call engine to execute a phone's REFER.
 *
 * ## Why this exists at all
 *
 * The engine already transfers calls: `CallControl.transfer` is driven by mid-call DTMF feature
 * codes (`*1`, `*2`). That covers the softphone user who knows the code and nobody else. Every desk
 * phone in the vendor catalogue has a physical TRANSFER key, and pressing it sends a SIP REFER —
 * which reaches the SIP edge, not the engine, because the edge is what the phone has a dialog with.
 * This subject is the seam between the two, and it is the only reason a deskphone's transfer button
 * can work without teaching `apps/sipd` what a dial plan is.
 *
 * ## RAW NATS ON BOTH ENDS
 *
 * The caller is Go (`apps/sipd/internal/transfer`) and the responder is the NestJS engine — the same
 * inversion as `rpc.media.v1.*` with the languages the other way round, and the same obligation. A
 * Nest `@MessagePattern` responder would expect `{"pattern":…,"data":…}` framing that a Go caller
 * does not send, and would simply never answer. The engine serves this on its raw connection
 * (`apps/engine/src/nats/sip-transfer.service.ts`), on the queue group `optimiq-engine-sip-transfer`.
 *
 * ## Why request-reply and not an event
 *
 * RFC 3515 §2.4.4 makes the referee's progress a REQUIRED notification: after the `202 Accepted`,
 * the phone waits for a NOTIFY whose `message/sipfrag` body is the outcome. An event would give
 * `apps/sipd` nothing to put in that body, so it would have to either lie (`200 OK` on publish) or
 * never send one — and a phone that never learns the outcome leaves its transfer indicator lit until
 * the dialog dies. The deadline below is what bounds how long that indicator can stay ambiguous.
 *
 * ## What the edge can and cannot tell you
 *
 * `apps/sipd` is a registrar; it is not in the media path and holds no call state, so every field
 * here is either something the phone put on the wire or something the digest exchange established.
 * In particular it sends the SIP `Call-ID` and the dialog tags VERBATIM and makes no claim that they
 * identify a call the engine knows — resolving that is the engine's half, and `unknown_dialog` /
 * `correlation_unavailable` are the two ways it can fail.
 *
 * ## The referrer is authenticated, the dialog is not
 *
 * `referredBy` is trustworthy: it is the account whose digest response verified against the HA1 the
 * API derived, and the edge refuses a REFER whose `From` is not that account's own AOR. The dialog
 * identity is NOT: a `Call-ID` is a string the phone chose. So the responder must check that the
 * resolved call actually involves `referredBy` before touching it, and answer `not_permitted` when
 * it does not. Trusting the pair would make any authenticated extension able to redirect any other
 * extension's conversation.
 */
export const sipTransferRequestSchema = z.object({
	/** The tenant, from the credential the digest exchange resolved. Re-checked by the responder. */
	orgId: z.uuid(),
	/**
	 * The `Call-ID` of the dialog the REFER arrived in — the call being transferred, not the REFER.
	 *
	 * Opaque and phone-chosen, so it is a LOOKUP KEY and never an authorisation. 256 is RFC 3261's
	 * practical ceiling for the header and matches `channelCreatedDataSchema.sipCallId`.
	 */
	sipCallId: z.string().min(1).max(256),
	/**
	 * The other two thirds of the dialog identifier (RFC 3261 §12), as seen ON THE REFER.
	 *
	 * `fromTag` is therefore the transferor's tag and `toTag` the far end's. Optional because a
	 * responder that can only index `Call-ID` must still be able to serve the common case, and
	 * because a REFER outside a dialog carries no `To` tag at all.
	 */
	fromTag: z.string().max(128).optional(),
	toTag: z.string().max(128).optional(),
	/** The authenticated account that pressed TRANSFER. See the note above on why this is trusted. */
	referredBy: z.object({
		/** `sip:1001@acme.example.com`, host lower-cased — the same spelling the registrar binds. */
		aor: z.string().min(1).max(512),
		/** SIP user part, matched case-sensitively per RFC 3261 §19.1.4. */
		username: z.string().min(1).max(128),
		extensionId: z.uuid().optional(),
		deviceId: z.uuid().optional(),
	}),
	/**
	 * Where the call is going: the `Refer-To` header, taken apart.
	 *
	 * `user` is what the engine dials, because a dial plan takes a destination string and not a URI.
	 * `host` and `uri` come along for the log and for the day a REFER to another domain has to be
	 * refused explicitly rather than silently dialled as a local extension.
	 */
	target: z.object({
		/** The `Refer-To` user part — an extension, a feature code, or an E.164 number. */
		user: dialStringSchema,
		host: z.string().max(255).optional(),
		/** The `Refer-To` URI verbatim, `Replaces` stripped. Diagnostics only. */
		uri: z.string().max(1024).optional(),
	}),
	/** `attended` exactly when {@link replaces} is present; `blind` otherwise. */
	kind: sipTransferKindSchema,
	/**
	 * The `Replaces` parameter of a `Refer-To`, parsed (RFC 3891).
	 *
	 * Present means the phone completed the consultation itself and is asking the engine to join the
	 * dialog it names. Answered `attended_unsupported` today — see that reason.
	 */
	replaces: z
		.object({
			callId: z.string().min(1).max(256),
			toTag: z.string().min(1).max(128),
			fromTag: z.string().min(1).max(128),
			/** The `early-only` flag, which forbids replacing a confirmed dialog. */
			earlyOnly: z.boolean().default(false),
		})
		.optional(),
	/**
	 * The REFER's CSeq number.
	 *
	 * Sent back so a log can be lined up with a packet capture, and because RFC 3515 §2.4.4 keys the
	 * implicit subscription's `Event: refer;id=<cseq>` on exactly this value — the edge needs it to
	 * build the NOTIFY, and echoing it here makes the two halves diagnosable together.
	 */
	referCSeq: z.int().min(0).optional(),
	/**
	 * `ip:port` the REFER arrived from, and its transport. For the responder's audit trail and the
	 * anti-fraud counters; a responder that ignores them is correct.
	 */
	sourceAddress: z.string().max(64).optional(),
	transport: sipTransportSchema.optional(),
});

export const sipTransferResponseSchema = z.object({
	ok: z.boolean(),
	/** Echoed so a reply can be attributed without the requester holding per-request state. */
	sipCallId: z.string().max(256),
	/** The engine instance that answered. Always present, refusal included, for the edge's log. */
	instanceId: z.string().min(1).max(128).optional(),
	/** The leg the transfer was executed on. Present when the dialog resolved, `ok` or not. */
	legId: z.string().min(1).max(128).optional(),
	callId: z.string().min(1).max(128).optional(),
	/** The destination the engine actually dialled, after any plan-side normalisation. */
	destination: z.string().max(128).optional(),
	reason: sipTransferRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type SipTransferRequest = z.infer<typeof sipTransferRequestSchema>;
export type SipTransferResponse = z.infer<typeof sipTransferResponseSchema>;

export const SIP_TRANSFER_RPC = defineRpc(
	RPC_SUBJECTS.sipTransfer,
	sipTransferRequestSchema,
	sipTransferResponseSchema,
	// Two seconds, and the reasoning is neither of the two used elsewhere in this file.
	//
	// It is NOT inside a SIP transaction: the edge answers `202 Accepted` first and reports the
	// outcome later in a NOTIFY, so nothing retransmits while this is in flight and the 500 ms
	// pressure that shapes `rpc.sip.v1.credential` does not apply. What bounds it instead is a human:
	// somebody pressed TRANSFER and is watching their handset for the call to leave. A blind transfer
	// is a dial-plan resolve plus a media move — a couple of ARI round trips — so two seconds is
	// generous for the work and short enough that a sick engine produces a failed transfer the user
	// can retry rather than a phone stuck mid-transfer.
	2_000,
);

// ---------------------------------------------------------------------------------------------
// rpc.media.v1.* — engine → mediad, the media plane's command surface
// ---------------------------------------------------------------------------------------------

/**
 * Why a media command was refused.
 *
 * A refusal is always a REPLY, never a silence. A responder that simply does not answer a request
 * it dislikes is indistinguishable from a crashed one, and the caller pays the whole timeout to
 * learn nothing. The engine branches on this code and never on the human-readable `error`.
 */
export const MEDIA_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/** No RTP port pair is free. A LOAD signal: try another instance, or fail with congestion. */
	"capacity",
	/** This instance is draining. Do not retry HERE. */
	"shutting_down",
	/** No such session on this instance. The engine's picture is stale, or it asked the wrong one. */
	"unknown_session",
	/**
	 * The session exists, but on another instance.
	 *
	 * Answerable only because of the `media-sessions` KV directory: without it a second instance
	 * could not tell "never existed" from "belongs to my neighbour", and the two need different
	 * recoveries — give up, versus re-issue against the instance the directory names.
	 */
	"wrong_instance",
	/**
	 * The command is real but this media plane cannot do it yet.
	 *
	 * The honest answer during a per-capability cutover: `mediad` climbs the ladder in
	 * `plans/mediad-design.md` §2 one rung at a time, and a rung it has not reached must fail
	 * LOUDLY. A media server that quietly did nothing would produce a call that connects and has no
	 * audio, which is the single hardest telephony defect to trace back to its cause.
	 */
	"not_supported",
	/** Anything else. */
	"internal",
] as const;

export const mediaRefusalReasonSchema = z.enum(MEDIA_REFUSAL_REASONS);
export type MediaRefusalReason = (typeof MEDIA_REFUSAL_REASONS)[number];

/** The G.711 payload types `mediad` handles. v1 is passthrough — see `plans/mediad-design.md` §7. */
export const mediaCodecSchema = z.enum(["PCMU", "PCMA"]);
export type MediaCodec = z.infer<typeof mediaCodecSchema>;

/**
 * An SDP body, as bytes the signalling plane handed over.
 *
 * A string and not a parsed structure, deliberately. `apps/sipd` treats SDP as opaque and never
 * picks a codec; `apps/engine` is the courier; `mediad` is the only process that knows which ports
 * are free and which payload types it can really handle, so it is the only one that parses. A
 * structured field here would be a second opinion about mediad's own capabilities, held by two
 * services that cannot check it.
 *
 * 16 KiB is far above any real offer (a verbose WebRTC one is ~4 KiB) and far below a size a
 * malicious sender could use to make a broker do work.
 */
const sdpSchema = z.string().min(1).max(16_384);

/** Fields every media command carries so a refusal can be attributed without a lookup. */
const mediaCommandShape = {
	/** Caller-assigned session id. See {@link mediaAllocateSessionRequestSchema}. */
	sessionId: z.string().min(1).max(128),
};

/**
 * `rpc.media.v1.allocate-session` — reserve an RTP port pair and answer an SDP offer.
 *
 * ## RAW NATS ON BOTH ENDS. This is not a style preference.
 *
 * Every prior `rpc.*` subject had a TypeScript responder, and two of them a Go caller. This family
 * inverts it: the responder is Go (`apps/mediad/internal/control`) and the caller is the NestJS
 * engine. The obligation inverts with it.
 *
 * A NestJS `ClientProxy.send()` does not put this payload on the wire. It wraps it:
 *
 * ```text
 * request   {"pattern":"rpc.media.v1.allocate-session","data":{…this schema…},"id":"…"}
 * reply     {"response":{…this schema…},"isDisposed":true,"id":"…"}
 * ```
 *
 * `mediad` unmarshals the bare contract and would see a request with no `sessionId`, refuse it as
 * `bad_request`, and reply in a frame the `ClientProxy` would not recognise either. So the engine's
 * client MUST issue a raw `NatsConnection.request()` — the engine already holds a raw connection
 * (`apps/engine/src/nats/jetstream.service.ts`), so this costs nothing but has to be written down,
 * because `ClientProxy` is the idiomatic Nest thing to reach for and it is wrong here.
 *
 * ## Why `sessionId` is assigned by the CALLER
 *
 * Same reason `OriginateRequest.channelId` is client-assigned at the engine's `MediaPort` seam: the
 * caller must be able to release a session whose allocate reply it never received. A
 * server-assigned id means a timed-out allocate leaves a port held under a name nobody knows, and
 * the only recovery is the idle reaper minutes later. It is also what makes allocate IDEMPOTENT —
 * a retry returns the same session rather than opening a second port.
 *
 * ## Why the offer is required
 *
 * v1 ANSWERS offers. Generating an offer for a leg the engine is originating (where no offer exists
 * yet) is a different negotiation and arrives with the rung that needs it; leaving `sdpOffer`
 * optional would let a caller ask for something no code path serves and get a reply that looked
 * successful.
 */
export const mediaAllocateSessionRequestSchema = z.object({
	...mediaCommandShape,
	/**
	 * The tenant. Carried so `mediad` can publish its lifecycle events on an org-scoped subject —
	 * `media.evt.v1.<orgId>.<sessionId>.<event>` — without holding a database handle or a directory
	 * lookup it would have to keep fresh.
	 */
	orgId: z.uuid(),
	/** The call this leg belongs to. Lands on the lifecycle events and in the session directory. */
	callId: z.string().min(1).max(128),
	/** The engine's leg id, when it differs from the session id. Logging and correlation only. */
	legId: z.string().min(1).max(128).optional(),
	/** The far end's offer, verbatim. See {@link sdpSchema}. */
	sdpOffer: sdpSchema,
	/**
	 * The direction to answer with.
	 *
	 * `sendrecv` for a normal leg, `inactive` for one that is ringing but not yet answered. Held
	 * legs (`sendonly`/`recvonly`) are rung 5; asking for one today is answered `not_supported`
	 * rather than silently downgraded to `sendrecv`, because a downgrade would put a held caller
	 * back into the conversation.
	 */
	direction: z.enum(["sendrecv", "sendonly", "recvonly", "inactive"]).default("sendrecv"),
});

export const mediaAllocateSessionResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** The answer to put back into the SIP dialog. Present exactly when `ok`. */
	sdpAnswer: sdpSchema.optional(),
	/**
	 * The `mediad` process holding the session, and the value written to the `media-sessions` KV
	 * directory. The engine keeps it so a later command can be attributed when it is refused.
	 */
	instanceId: z.string().min(1).max(128).optional(),
	/** Where the far end should send RTP — `MEDIAD_PUBLIC_IP`, never the bind address. */
	address: z.string().max(64).optional(),
	rtpPort: z.int().min(1).max(65_534).optional(),
	/** Always `rtpPort + 1` (RFC 3550 §11). Stated so a caller never re-derives a convention. */
	rtcpPort: z.int().min(1).max(65_535).optional(),
	ssrc: z.int().min(0).max(4_294_967_295).optional(),
	/** The codec the answer settled on. One of them, not a list: the answer is a choice. */
	codec: mediaCodecSchema.optional(),
	/** The negotiated RFC 4733 telephone-event payload type, when the offer carried one. */
	telephoneEventPayloadType: z.int().min(0).max(127).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaAllocateSessionRequest = z.infer<typeof mediaAllocateSessionRequestSchema>;
export type MediaAllocateSessionResponse = z.infer<typeof mediaAllocateSessionResponseSchema>;

export const MEDIA_ALLOCATE_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaAllocateSession,
	mediaAllocateSessionRequestSchema,
	mediaAllocateSessionResponseSchema,
	// An allocate binds two sockets and parses an offer — microseconds of work. It also sits inside
	// the engine's answer of an INVITE, where the caller hears every millisecond as silence before
	// ringback. 500 ms is three orders of magnitude of headroom, and a reply slower than that means
	// the instance is sick rather than busy.
	500,
);

/**
 * `rpc.media.v1.bridge-sessions` — start relaying RTP between two allocated sessions.
 *
 * Exactly two, and the schema says so. Two-party audio is a RELAY: each session forwards its
 * payload to the other, no decode, no mix, no jitter buffer. N-way is mixing, which needs all three
 * of those, and is rung 6 of `plans/mediad-design.md` §2 — a three-element array here would be a
 * contract promising something the media plane cannot do.
 *
 * `bridgeId` is caller-assigned for the same reason `sessionId` is, and because the engine's
 * `MediaPort` already mints one in `createBridge` before any leg joins.
 */
export const mediaBridgeSessionsRequestSchema = z.object({
	bridgeId: z.string().min(1).max(128),
	/** The two sessions to relay between. Order is not significant; the relay is bidirectional. */
	sessionIds: z.array(z.string().min(1).max(128)).length(2),
});

export const mediaBridgeSessionsResponseSchema = z.object({
	ok: z.boolean(),
	bridgeId: z.string().min(1).max(128),
	/** The sessions actually relaying. Empty on a refusal. */
	sessionIds: z.array(z.string().max(128)).max(2).default([]),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaBridgeSessionsRequest = z.infer<typeof mediaBridgeSessionsRequestSchema>;
export type MediaBridgeSessionsResponse = z.infer<typeof mediaBridgeSessionsResponseSchema>;

export const MEDIA_BRIDGE_SESSIONS_RPC = defineRpc(
	RPC_SUBJECTS.mediaBridgeSessions,
	mediaBridgeSessionsRequestSchema,
	mediaBridgeSessionsResponseSchema,
	500,
);

/**
 * `rpc.media.v1.unbridge-sessions` — stop the relay, leave both sessions alive.
 *
 * Separating legs is NOT hanging them up: an attended transfer takes a leg out of one bridge and
 * puts it in another, and a media plane that tore the session down in between would drop the call
 * it was in the middle of moving.
 *
 * Idempotent: unbridging a bridge that is already gone answers `ok: true, unbridged: false`. The
 * engine retries an unbridge, and a retry after a lost reply must not look like a failure.
 */
export const mediaUnbridgeSessionsRequestSchema = z.object({
	bridgeId: z.string().min(1).max(128),
});

export const mediaUnbridgeSessionsResponseSchema = z.object({
	ok: z.boolean(),
	bridgeId: z.string().min(1).max(128),
	/** False when there was no such relay. A SUCCESS, not a failure — see the note above. */
	unbridged: z.boolean().default(false),
	sessionIds: z.array(z.string().max(128)).max(2).default([]),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaUnbridgeSessionsRequest = z.infer<typeof mediaUnbridgeSessionsRequestSchema>;
export type MediaUnbridgeSessionsResponse = z.infer<typeof mediaUnbridgeSessionsResponseSchema>;

export const MEDIA_UNBRIDGE_SESSIONS_RPC = defineRpc(
	RPC_SUBJECTS.mediaUnbridgeSessions,
	mediaUnbridgeSessionsRequestSchema,
	mediaUnbridgeSessionsResponseSchema,
	500,
);

/**
 * `rpc.media.v1.release-session` — free the port pair and forget the session.
 *
 * Also removes the session's entry from the `media-sessions` KV directory. That cleanup is part of
 * the contract rather than an implementation detail: a directory entry that outlives its session is
 * an instance name the engine will keep routing commands to, and every one of them answers
 * `unknown_session` until an operator notices.
 */
export const mediaReleaseSessionRequestSchema = z.object({
	...mediaCommandShape,
});

export const mediaReleaseSessionResponseSchema = z.object({
	ok: z.boolean(),
	sessionId: z.string().min(1).max(128),
	/** False when there was no such session. Idempotent, exactly like `unbridged` above. */
	released: z.boolean().default(false),
	instanceId: z.string().min(1).max(128).optional(),
	reason: mediaRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type MediaReleaseSessionRequest = z.infer<typeof mediaReleaseSessionRequestSchema>;
export type MediaReleaseSessionResponse = z.infer<typeof mediaReleaseSessionResponseSchema>;

export const MEDIA_RELEASE_SESSION_RPC = defineRpc(
	RPC_SUBJECTS.mediaReleaseSession,
	mediaReleaseSessionRequestSchema,
	mediaReleaseSessionResponseSchema,
	500,
);

// ---------------------------------------------------------------------------------------------
// rpc.engine.v1.park-handoff — engine → engine, when a park is retrieved from the wrong node
// ---------------------------------------------------------------------------------------------

/**
 * Why a park handoff was refused.
 *
 * As with the media plane: a refusal is a REPLY. The retriever branches on this code and never on
 * `error`, because the four interesting outcomes need four different things said to the person who
 * dialled the orbit — "somebody already took that call", "that caller has hung up", "the call is
 * there but I cannot reach it", and "try again".
 */
export const PARK_HANDOFF_REFUSAL_REASONS = [
	/** Malformed payload, or a required field missing. Retrying the same bytes fails the same way. */
	"bad_request",
	/**
	 * This instance holds no park on that orbit.
	 *
	 * The RACE answer, and the common one: the claim the retriever read was a snapshot, and between
	 * the read and this request the call was collected locally, timed out back to its parker, or
	 * hung up. The retriever must say "no longer parked", NOT "parked elsewhere" — the search is
	 * over either way, but only one of those sends somebody looking for another engine.
	 */
	"not_parked",
	/**
	 * The orbit IS held here, by a different channel than the one the request named.
	 *
	 * A claim that was reaped and re-taken between the read and the request: the slot now holds
	 * somebody else's caller. Bridging them would connect the retriever to a stranger, which is the
	 * exact failure the whole claim mechanism exists to prevent, so it is refused rather than
	 * treated as a near-enough match.
	 */
	"claim_superseded",
	/** The parked leg has gone — hung up between the claim and the move. Nothing to hand over. */
	"channel_gone",
	/**
	 * The retriever's own channel is not visible to this instance's media server.
	 *
	 * The handoff bridges two channels from ONE side (see
	 * {@link parkHandoffRequestSchema}), which holds only while both engines drive the same media
	 * server. Two engines on two Asterisks is a supported deployment and a call parked on one of
	 * them genuinely cannot be collected from the other yet — so it is named, rather than surfacing
	 * as a media error the retriever cannot interpret.
	 */
	"unreachable_channel",
	/**
	 * The media server refused the move. The caller has been put BACK in their orbit and is still
	 * collectable — from the owning instance, and by a retry of this request.
	 */
	"media_failed",
	/** This instance is draining. Do not retry HERE. */
	"shutting_down",
	/** Anything else. */
	"internal",
] as const;

export const parkHandoffRefusalReasonSchema = z.enum(PARK_HANDOFF_REFUSAL_REASONS);
export type ParkHandoffRefusalReason = (typeof PARK_HANDOFF_REFUSAL_REASONS)[number];

/**
 * `rpc.engine.v1.park-handoff` — collect a call parked on ANOTHER engine instance.
 *
 * ## RAW NATS ON BOTH ENDS, even though both ends are NestJS
 *
 * The other raw family (`rpc.media.v1.*`) is raw because one end is Go. This one is raw for a
 * different reason, and it is worth stating because "both ends are Nest, so `@MessagePattern` is
 * fine" is the rule of thumb at the head of this file and this is the exception to it.
 *
 * The subject carries an INSTANCE TOKEN — `rpc.engine.v1.park-handoff.<instanceToken>`, built by
 * `subjectFor.engineParkHandoffRpc`. A Nest `@MessagePattern` is a fixed string decided at class
 * decoration time, and a `ClientProxy` sends to a pattern rather than to a subject; neither end can
 * express "the subject depends on which process is answering". The engine already holds a raw
 * connection (`apps/engine/src/nats/jetstream.service.ts`) and already speaks raw to `mediad`, so
 * the same transport serves this at no cost.
 *
 * ## Why the OWNING instance does the whole media move
 *
 * The obvious alternative is a split: the owner puts its parked channel in a bridge and answers
 * with the bridge id, and the retriever adds its own channel to it. That is tidier on paper and
 * worse in practice — it needs a SECOND round trip to undo the first when the retriever's half
 * fails, and until that round trip lands the caller is sitting in a bridge with nobody in it and no
 * longer in a lot anybody can dial. So the owner does both halves and the request carries the
 * retriever's channel: one operation, one outcome, and a failure path
 * ({@link ParkRegistry.restore}, on the owner) that already exists.
 *
 * The tradeoff, stated plainly: this works because both engines drive the SAME media server, where
 * a channel id is meaningful to either of them. Under the ARI driver that is the deployment the
 * `park-claims` bucket was built for in the first place — several engines behind one Asterisk. The
 * owner pre-flights the retriever's channel and refuses `unreachable_channel` when it cannot see
 * it, so the unsupported deployment fails with its own name rather than as a bridge error.
 *
 * ## Why the request names the parked channel
 *
 * Fencing. The retriever read the claim, and the claim may be stale by the time this arrives —
 * reaped and re-taken by a different caller. Naming the `mediaChannelId` it expects turns that from
 * "connected to a stranger" into `claim_superseded`.
 */
export const parkHandoffRequestSchema = z.object({
	/** The tenant. Both legs must belong to it; the owner re-checks rather than trusting it. */
	orgId: z.uuid(),
	parkLotId: z.string().min(1).max(128),
	/** The orbit being collected. */
	slot: z.int().min(0).max(1_000_000),
	/** The parked leg the retriever expects to find there. See the fencing note above. */
	mediaChannelId: z.string().min(1).max(128),
	/** The instance asking, for the owner's log and for a loop check. */
	retrieverInstanceId: z.string().min(1).max(128),
	/** The channel to bridge the parked caller to: the phone that dialled the orbit. */
	retrieverMediaChannelId: z.string().min(1).max(128),
	/** The retriever's leg id, which lands on the parked leg's CDR as its peer. */
	retrieverLegId: z.string().min(1).max(128),
	/**
	 * The bridge to build, assigned by the CALLER for the same reason `sessionId` is on the media
	 * plane: a request whose reply is lost must still name a thing the retriever can identify.
	 */
	bridgeId: z.string().min(1).max(128),
});

export const parkHandoffResponseSchema = z.object({
	ok: z.boolean(),
	parkLotId: z.string().max(128),
	slot: z.int().min(0).max(1_000_000),
	/** The instance that answered. Always present, including on a refusal, for the retriever's log. */
	instanceId: z.string().min(1).max(128),
	/** The bridge both legs are now in. Present exactly when `ok`. */
	bridgeId: z.string().min(1).max(128).optional(),
	/** The parked leg's ids, so the retriever can set its own CDR peer and log the pair. */
	legId: z.string().min(1).max(128).optional(),
	callId: z.string().min(1).max(128).optional(),
	/** When the call went into the lot, so the retriever can report how long it waited. */
	parkedAtMs: z.int().min(0).optional(),
	reason: parkHandoffRefusalReasonSchema.optional(),
	error: z.string().max(512).optional(),
});

export type ParkHandoffRequest = z.infer<typeof parkHandoffRequestSchema>;
export type ParkHandoffResponse = z.infer<typeof parkHandoffResponseSchema>;

export const PARK_HANDOFF_RPC = defineRpc(
	RPC_SUBJECTS.engineParkHandoff,
	parkHandoffRequestSchema,
	parkHandoffResponseSchema,
	// Longer than the media plane's 500 ms, and deliberately so: this is not one socket operation
	// but a KV release plus three media-server calls on the far side, any of which is an HTTP round
	// trip under the ARI driver. It is still on a call path — somebody is holding a handset waiting
	// to be connected — so it is bounded well under the two seconds at which a person assumes the
	// feature is broken and hangs up.
	3_000,
);

/** Every request-reply contract, keyed by subject. */
export const RPC_CONTRACTS = {
	[RPC_SUBJECTS.routingResolve]: ROUTING_RESOLVE_RPC,
	[RPC_SUBJECTS.authzCheck]: AUTHZ_CHECK_RPC,
	[RPC_SUBJECTS.voicemailList]: VOICEMAIL_LIST_RPC,
	[RPC_SUBJECTS.sipCredential]: SIP_CREDENTIAL_RPC,
	[RPC_SUBJECTS.sipTransfer]: SIP_TRANSFER_RPC,
	[RPC_SUBJECTS.mediaAllocateSession]: MEDIA_ALLOCATE_SESSION_RPC,
	[RPC_SUBJECTS.mediaBridgeSessions]: MEDIA_BRIDGE_SESSIONS_RPC,
	[RPC_SUBJECTS.mediaUnbridgeSessions]: MEDIA_UNBRIDGE_SESSIONS_RPC,
	[RPC_SUBJECTS.mediaReleaseSession]: MEDIA_RELEASE_SESSION_RPC,
	[RPC_SUBJECTS.engineParkHandoff]: PARK_HANDOFF_RPC,
} as const;
