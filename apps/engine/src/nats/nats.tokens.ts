/**
 * Injection tokens.
 *
 * Symbols rather than strings, per the oikos convention: a Symbol token cannot collide with
 * another module's token by accident, and it cannot be produced by a typo.
 */

/**
 * The NestJS `ClientProxy` used for core EVENT publishes.
 *
 * Separate from {@link ROUTING_RPC_CLIENT} because the two need different wire formats: an event
 * must reach the broker as the bare envelope `@optimiq-voice/events` specifies, while a
 * request-reply call must carry Nest's own packet shape or the API's microservice never answers.
 */
export const CALL_EVENTS_CLIENT = Symbol("engine/CallEventsClient");

/** The NestJS `ClientProxy` used for `rpc.*` request-reply. Keeps Nest's default serializer. */
export const ROUTING_RPC_CLIENT = Symbol("engine/RoutingRpcClient");

/** The engine's validated environment. */
export const ENGINE_ENV = Symbol("engine/Env");

/** The `AriClient` instance for this process. */
export const ARI_CLIENT = Symbol("engine/AriClient");

/** The {@link import("../ari/media-port").MediaPort} implementation. */
export const MEDIA_PORT = Symbol("engine/MediaPort");

/** The calls module's Effect runtime (`ModuleEffectRuntime`). */
export const CALLS_EFFECT_RUNTIME = Symbol("engine/CallsEffectRuntime");
