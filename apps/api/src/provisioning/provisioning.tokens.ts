/**
 * Injection tokens for the provisioning area.
 *
 * Symbols rather than strings, per the oikos convention: a Symbol token cannot collide with another
 * module's token by accident and cannot be produced by a typo. The area reuses `PBX_DATABASE`,
 * `PBX_ENV` and `PBX_EFFECT_RUNTIME` from `PbxModule` rather than building a second connection pool
 * — see `provisioning.module.ts`.
 */

/** The validated provisioning environment (`ProvisioningEnv`). */
export const PROVISIONING_ENV = Symbol("api/provisioning/Env");
