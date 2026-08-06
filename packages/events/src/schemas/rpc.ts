import { z } from "zod";
import { RPC_SUBJECTS } from "../subjects";
import { callDirectionSchema, destinationTypeSchema, dialStringSchema } from "./telephony";

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

/** Every request-reply contract, keyed by subject. */
export const RPC_CONTRACTS = {
	[RPC_SUBJECTS.routingResolve]: ROUTING_RESOLVE_RPC,
	[RPC_SUBJECTS.authzCheck]: AUTHZ_CHECK_RPC,
	[RPC_SUBJECTS.voicemailList]: VOICEMAIL_LIST_RPC,
} as const;
