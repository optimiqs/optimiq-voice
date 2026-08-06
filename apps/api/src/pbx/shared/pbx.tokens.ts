/**
 * Injection tokens for the PBX area.
 *
 * Symbols rather than strings, per the oikos convention: a Symbol token cannot collide with
 * another module's token by accident and cannot be produced by a typo.
 */

/** The validated PBX environment (`PbxEnv`). */
export const PBX_ENV = Symbol("api/pbx/Env");

/** The `PbxDatabaseClient` for the telephony bounded context. */
export const PBX_DATABASE = Symbol("api/pbx/Database");

/** The PBX area's shared `ModuleEffectRuntime`. */
export const PBX_EFFECT_RUNTIME = Symbol("api/pbx/EffectRuntime");
