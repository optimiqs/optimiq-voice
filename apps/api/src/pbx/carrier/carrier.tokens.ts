/**
 * Injection tokens for the carrier slice. Symbols, per the convention in `shared/pbx.tokens.ts`.
 */

/** The validated `CarrierEnv`. */
export const CARRIER_ENV = Symbol("api/pbx/carrier/Env");

/**
 * The `TelnyxClient`, or `undefined` when this deployment has no key.
 *
 * `undefined` rather than a null-object that throws on every call: an explicit absence forces
 * every call site to answer "what does this endpoint do without a carrier?", and the answer — a
 * 503 with a code the UI can render — is the whole reason the feature degrades gracefully instead
 * of erroring.
 */
export const TELNYX_CLIENT = Symbol("api/pbx/carrier/TelnyxClient");
