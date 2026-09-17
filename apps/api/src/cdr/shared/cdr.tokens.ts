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

/**
 * The CDR export object store, rooted at `CDR_EXPORT_ROOT`.
 *
 * Its own token and its own root rather than a prefix under `CDR_RECORDING_STORE`, because the two
 * classes differ in the property the storage design turns on: a recording is written by Asterisk
 * onto a shared volume and mirrored afterwards, and an export is written and read by this process
 * alone. Sharing the token would make "where do reports live" and "where does audio live" the same
 * question for an operator who has good reasons to answer them differently — different sizes,
 * different retention, different backup policy.
 */
export const CDR_EXPORT_STORE = Symbol("CDR_EXPORT_STORE");
