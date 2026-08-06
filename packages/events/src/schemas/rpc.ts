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
 * `rpc.media.*` (engine → `mediad`) is deliberately absent: it arrives with `apps/mediad`, and
 * inventing its shape before the media plane exists would be fiction.
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
	/** `<resource>.<action>[.<scope>]` strings from the permission registry in `packages/common`. */
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

/** Every request-reply contract, keyed by subject. */
export const RPC_CONTRACTS = {
	[RPC_SUBJECTS.routingResolve]: ROUTING_RESOLVE_RPC,
	[RPC_SUBJECTS.authzCheck]: AUTHZ_CHECK_RPC,
	[RPC_SUBJECTS.voicemailList]: VOICEMAIL_LIST_RPC,
	[RPC_SUBJECTS.sipCredential]: SIP_CREDENTIAL_RPC,
} as const;
