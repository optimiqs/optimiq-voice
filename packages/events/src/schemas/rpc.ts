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

/** Every request-reply contract, keyed by subject. */
export const RPC_CONTRACTS = {
	[RPC_SUBJECTS.routingResolve]: ROUTING_RESOLVE_RPC,
	[RPC_SUBJECTS.authzCheck]: AUTHZ_CHECK_RPC,
} as const;
