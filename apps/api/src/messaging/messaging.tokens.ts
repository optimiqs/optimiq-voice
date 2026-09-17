/**
 * Injection tokens for the messaging area. Symbols, per the convention in `pbx/shared/pbx.tokens.ts`.
 */

/** The validated `MessagingEnv`. */
export const MESSAGING_ENV = Symbol("api/messaging/Env");

/**
 * The configured {@link MessagingProvider}, or `undefined` when `MESSAGING_DRIVER` is `none`.
 *
 * `undefined` rather than a null-object that silently swallows sends, on the argument
 * `carrier.providers.ts` makes for the Telnyx client: a deployment with no provider must answer 503
 * with a reason, and a no-op double would instead produce an inbox where every message sits in
 * `queued` forever and nobody can say why.
 */
export const MESSAGING_PROVIDER = Symbol("api/messaging/Provider");

/**
 * The object store for MMS parts, rooted at `MESSAGING_OBJECT_ROOT`.
 *
 * Its own store rather than a ride on the media store, for the reason the fax store gives: nothing
 * in the media plane reads these bytes, so this is one of the two object classes an operator may
 * legitimately place elsewhere.
 */
export const MESSAGING_STORE = Symbol("api/messaging/Store");
