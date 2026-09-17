/**
 * Injection tokens for the fax slice. Symbols, per the area convention in `shared/pbx.tokens.ts`.
 */

/** The validated `FaxEnv`. */
export const FAX_ENV = Symbol("api/pbx/fax/Env");

/**
 * The object store for fax documents (received TIFF/PDF and stored outbound sources), rooted at
 * `FAX_OBJECT_ROOT`.
 *
 * A store of its own rather than a ride on {@link PBX_MEDIA_STORE}: unlike prompts and greetings,
 * fax documents are never read by Asterisk off the shared mount — they are written by this API from
 * the carrier and served back over a signed link — so the one object class that has no reason to sit
 * on the media mount is the one an operator can legitimately place elsewhere. Same argument the CDR
 * export store makes for not sharing the recording root.
 */
export const FAX_STORE = Symbol("api/pbx/fax/Store");

/**
 * The fetcher used to download inbound fax media from the carrier's URL into the store.
 *
 * Injected rather than reaching for the global `fetch` so a test drives the download deterministically
 * without a network — there is no prior "download a remote URL into the object store" seam in this
 * API, so this is the one place that does it, and it is a seam on purpose.
 */
export const FAX_MEDIA_FETCH = Symbol("api/pbx/fax/MediaFetch");
