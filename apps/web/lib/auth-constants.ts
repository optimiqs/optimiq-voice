/**
 * Values that must agree with `packages/auth/src/auth.ts` but cannot be imported from it.
 *
 * `@optimiq-voice/auth`'s entrypoint pulls in better-auth's server build, drizzle and the database
 * schema — none of which belongs in a middleware bundle or a browser chunk. Rather than import it,
 * these are declared here and `auth-constants.spec.ts` asserts they still match the real values,
 * so a server-side rename fails a test instead of silently signing everyone out.
 */

/** Bumping this on the server invalidates every cached session cookie. */
export const SESSION_COOKIE_CACHE_VERSION = "session-v1";

/** `advanced.cookiePrefix` — what better-auth namespaces its cookies with. */
export const SESSION_COOKIE_PREFIX = `optimiq_voice_${SESSION_COOKIE_CACHE_VERSION}`;
