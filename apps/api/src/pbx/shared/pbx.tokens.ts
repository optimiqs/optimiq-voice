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

/**
 * The media LIBRARY's object store, rooted at `PBX_MEDIA_OBJECT_ROOT`.
 *
 * MOH files, prompts and voicemail greetings — everything this API uploads. Asterisk reads all of it
 * off the shared mount (`object://<key>` becomes `sound:<root>/<key>`), so the store behind this
 * token is always filesystem-backed; with `STORAGE_DRIVER=s3` it also mirrors. See
 * `src/storage/object-store.factory.ts` for the object-class map.
 */
export const PBX_MEDIA_STORE = Symbol("api/pbx/MediaStore");

/**
 * Voicemail MESSAGE audio's object store, rooted at `PBX_VOICEMAIL_MEDIA_ROOT`.
 *
 * A separate token from {@link PBX_MEDIA_STORE} because the two ROOTS are separately nameable (they
 * default to the same directory, and `pbx-env.ts` explains at length why they should stay that way)
 * and because the two classes are written by different processes: the library by this API, message
 * audio by Asterisk. Nothing in this API ever `put`s through this store; it reads, and it archives.
 */
export const PBX_VOICEMAIL_STORE = Symbol("api/pbx/VoicemailStore");

/**
 * The selected `TranscriptionProvider` — `disabled` unless `TRANSCRIBE_BASE_URL` is set.
 *
 * A token rather than the service constructing its own driver, for the reason every other seam in
 * this area is injected: the mapping from environment to driver is one decision made in one factory
 * (`src/transcription/transcription-provider.factory.ts`), and a test swaps the provider without
 * touching `process.env`.
 */
export const PBX_TRANSCRIPTION_PROVIDER = Symbol("api/pbx/TranscriptionProvider");

/**
 * The parsed `TranscriptionEnv`, separate from the provider it selected.
 *
 * Separate because the two are read by different things: the PROVIDER holds the endpoint and the
 * credential, while the retry budget, the queue ceiling and the size cap belong to the PIPELINE and
 * are meaningful even when the driver is `disabled`. Folding them into the provider would mean the
 * pipeline reaching through a port to find a policy that is not the port's business.
 */
export const PBX_TRANSCRIPTION_SETTINGS = Symbol("api/pbx/TranscriptionSettings");
