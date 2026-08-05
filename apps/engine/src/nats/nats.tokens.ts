/**
 * Injection tokens.
 *
 * Symbols rather than strings, per the oikos convention: a Symbol token cannot collide with
 * another module's token by accident, and it cannot be produced by a typo.
 */

/** The NestJS `ClientProxy` over the NATS transport, used for core event publishes. */
export const CALL_EVENTS_CLIENT = Symbol("engine/CallEventsClient");

/** The engine's validated environment. */
export const ENGINE_ENV = Symbol("engine/Env");

/** The `AriClient` instance for this process. */
export const ARI_CLIENT = Symbol("engine/AriClient");

/** The {@link import("../ari/media-port").MediaPort} implementation. */
export const MEDIA_PORT = Symbol("engine/MediaPort");

/** The calls module's Effect runtime (`ModuleEffectRuntime`). */
export const CALLS_EFFECT_RUNTIME = Symbol("engine/CallsEffectRuntime");
