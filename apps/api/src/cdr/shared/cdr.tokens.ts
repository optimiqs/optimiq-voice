/** Injection tokens for the CDR area. Symbols, so nothing can collide with a class token. */
export const CDR_ENV = Symbol("CDR_ENV");
export const CDR_DATABASE = Symbol("CDR_DATABASE");

/**
 * The recording object store, rooted at `CDR_RECORDING_ROOT`.
 *
 * The one object class in this API that Asterisk WRITES and never reads back, which is what makes it
 * the class an object store can genuinely own: the media server drops the file on the shared volume,
 * `CdrRecordingWriter` files the metadata row and archives the bytes, and every read after that is
 * this API serving a signed link. See `src/storage/object-store.factory.ts`.
 */
export const CDR_RECORDING_STORE = Symbol("CDR_RECORDING_STORE");
