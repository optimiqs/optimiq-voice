/** Injection tokens for the auth slice. Symbols keep them unforgeable and rename-safe. */
export const AUTH_PLATFORM = Symbol.for("@optimiq-voice/api/AuthPlatform");
export const AUTH_REPOSITORY = Symbol.for("@optimiq-voice/api/AuthRepository");
/** `accessKeyId` ⇄ `organization.id`; transitional, dies with the mapping tables in Step 9. */
export const AUTH_LEGACY_ACCESS_KEYS = Symbol.for("@optimiq-voice/api/LegacyAccessKeyRepository");
