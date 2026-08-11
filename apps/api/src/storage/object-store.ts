import type { Readable } from "node:stream";

/**
 * The object-store seam: one interface, two drivers, and one constraint that shapes both.
 *
 * ## What this replaces
 *
 * Every audio object this API touches — call recordings, voicemail message audio, MOH files,
 * prompts, voicemail greetings — lived on a filesystem root reached by `node:fs` calls scattered
 * across four services (`media-storage.ts`, `prompts.service.ts`, `voicemail-messages.service.ts`,
 * `recordings.service.ts`). That is fine on one box and wrong everywhere else: a replaced container
 * loses every recording it has not been given a volume for, and two API replicas behind a load
 * balancer each serve a different half of the library unless an operator arranges shared storage
 * underneath them. The audit that produced this module named both.
 *
 * ## THE CONSTRAINT: Asterisk shares the filesystem, and cannot be given a bucket
 *
 * This is the reason the seam is shaped the way it is rather than being a straight swap, and it is
 * worth stating before the interface:
 *
 * `apps/engine` never opens media. It hands Asterisk a path — `sound:<ENGINE_MEDIA_OBJECT_ROOT>/<key>`
 * for a prompt or a greeting, a `musiconhold.conf` `directory=` for hold music, and a target path for
 * a recording — and **Asterisk opens the file itself, off a bind-mounted volume**
 * (`compose.dev.yaml`'s `asterisk` service, `:/var/lib/optimiq/objects:ro`). ARI has no HTTP media
 * scheme; there is nothing to hand it but a path. So an object that Asterisk reads or writes MUST
 * exist on that shared filesystem, whatever else is also true of it.
 *
 * That splits every object this API knows about into two classes:
 *
 * | class                              | who writes            | who reads                     | filesystem required |
 * | ---------------------------------- | --------------------- | ----------------------------- | ------------------- |
 * | MOH files, prompts, greetings      | this API (upload)     | **Asterisk** + this API       | **yes**             |
 * | voicemail message audio            | **Asterisk**          | **Asterisk** (`*97`) + API    | **yes**             |
 * | call recordings                    | **Asterisk**          | this API only                 | at write time only  |
 *
 * There is no row in that table for which the filesystem can simply be deleted today. What the
 * object store buys, therefore, is DURABILITY and a read path that survives the volume — not the
 * removal of the volume. {@link ObjectStore} is consequently implemented three ways:
 *
 * - `LocalObjectStore` — the filesystem, byte-for-byte what this API did before. The default.
 * - `S3ObjectStore` — an S3-compatible bucket (AWS, MinIO, R2, Ceph…).
 * - `MirroredObjectStore` — a local store that is the SOURCE OF TRUTH, plus an S3 store that
 *   receives a copy. Reads prefer the filesystem (it is what Asterisk has, and it is faster) and
 *   fall back to the bucket, so a replaced container with an empty volume still SERVES the archive
 *   even though Asterisk can no longer play it. That fallback is the audit's finding, closed as far
 *   as it can be closed while Asterisk is on the other end of a mount.
 *
 * ## The mediad-era migration note
 *
 * `apps/mediad` is where this constraint goes to die. Once a media daemon owns playback and
 * recording — fetching an object by key over HTTP and streaming it into the channel, and streaming
 * a recording back out to the store — nothing on the call path needs a shared filesystem, and
 * `MirroredObjectStore` collapses into a plain `S3ObjectStore` with no local half. The migration is
 * then: point `STORAGE_DRIVER=s3` (already possible), let the mirror run long enough to back-fill,
 * switch `apps/engine`'s media vocabulary from `sound:<path>` to a mediad reference, and drop the
 * `origin` from the factory. Nothing in this interface changes; one composite disappears.
 *
 * ## Why the interface is this small
 *
 * `put` / `getStream` / `head` / `delete` / `exists` / `presign` / `filesystemPath` and nothing else.
 * Every one of them is called by code in this app today. There is no `list`, no `copy`, no
 * multipart-upload seam and no bucket lifecycle: the media library is enumerated from Postgres rows
 * (which is what makes an orphaned object findable at all), objects are capped at
 * `PBX_MEDIA_MAX_UPLOAD_BYTES`, and retention is a policy nothing in this process owns. Adding a
 * method here means finding a caller for it first.
 */

/** Which implementation is behind a store. Surfaced for boot logs and for tests. */
export type ObjectStoreDriver = "local" | "s3" | "mirrored";

/** What `head` answers: enough to write a `content-length` and decide a `Range`. */
export interface ObjectStat {
	readonly sizeBytes: number;
	/** The store's own idea of the type, when it has one. S3 keeps it; a filesystem does not. */
	readonly contentType?: string | undefined;
	readonly updatedAt?: Date | undefined;
}

/** A closed byte range, inclusive at both ends — the same shape `http-range.ts` decides. */
export interface ObjectRange {
	readonly start: number;
	readonly end: number;
}

/** Options for a write. Both are advisory: a filesystem store ignores them. */
export interface PutObjectOptions {
	readonly contentType?: string | undefined;
	/** Opaque key/value pairs stored beside the object where the driver supports them. */
	readonly metadata?: Readonly<Record<string, string>> | undefined;
}

/**
 * One object store.
 *
 * Keys are the SAME strings the database columns hold — `prompts/<org>/<id>.wav`,
 * `<org>/<call>/<recording>.wav` — with no leading slash and no driver-specific mangling. That is
 * what makes the local driver byte-compatible with the paths this API already writes, and what makes
 * an operator able to `aws s3 ls` a bucket and recognise what they are looking at.
 *
 * Every method treats a key that escapes the store's root as a REFUSAL rather than an access: see
 * {@link ObjectKeyOutsideRootError}. The check is meaningless for S3 (a key is a key) and load
 * bearing for the filesystem, so it lives in the local driver and every caller gets it for free.
 */
export interface ObjectStore {
	readonly driver: ObjectStoreDriver;

	/**
	 * The object's size and type, or `undefined` when it is not there.
	 *
	 * Never throws for ABSENCE — that is the ordinary answer for a row whose media has been reaped —
	 * but a key that escapes a filesystem-backed store's root DOES throw
	 * {@link ObjectKeyOutsideRootError}, because those are different facts with different responses
	 * (`410 gone` versus "a database column addressed something outside the media root").
	 */
	head(objectKey: string): Promise<ObjectStat | undefined>;

	/** Whether {@link head} would answer with a stat. An escaping key is `false`, not a throw. */
	exists(objectKey: string): Promise<boolean>;

	/**
	 * Opens the object for reading, optionally one byte range.
	 *
	 * A range rather than "read it and slice": the object may be an hour of audio and the point of a
	 * `Range` request is to move a few hundred kilobytes. The filesystem driver hands the kernel a
	 * `pread`; the S3 driver sends a `Range` header, which the store executes rather than this
	 * process.
	 *
	 * @throws when the object is absent. Callers `head` first — they need the size for
	 *   `content-length` anyway — so this throw is the race, not the normal path.
	 */
	getStream(objectKey: string, range?: ObjectRange): Promise<Readable>;

	/** Stores bytes under a key, creating whatever containment the driver needs. */
	put(objectKey: string, bytes: Buffer, options?: PutObjectOptions): Promise<void>;

	/** Removes an object. An object that is already gone is the state we wanted, not an error. */
	delete(objectKey: string): Promise<void>;

	/**
	 * A time-limited URL that reaches the object without this process in the path, or `undefined`
	 * when the driver cannot mint one.
	 *
	 * **Nothing in this API calls it on the request path, deliberately** — see
	 * `docs` in `recordings.service.ts` and the note in `object-store.factory.ts`. It exists because
	 * a bulk export or an out-of-band integration is the case where redirecting is obviously right,
	 * and because a seam that could not express presigning would have to be widened later by
	 * whoever needed it under time pressure.
	 */
	presign(objectKey: string, ttlSeconds: number): Promise<string | undefined>;

	/**
	 * The absolute filesystem path Asterisk would open for this key, or `undefined` when this store
	 * has no filesystem behind it.
	 *
	 * The constraint in this file's header, made answerable in code rather than in a comment. A
	 * caller that needs Asterisk to be able to reach an object asks this and refuses to proceed on
	 * `undefined`, instead of writing to a bucket and discovering at call time that the prompt plays
	 * as silence.
	 */
	filesystemPath(objectKey: string): string | undefined;
}

/**
 * A store that keeps a durable copy somewhere the filesystem is not.
 *
 * Separate from {@link ObjectStore} because only the composite has it, and because a caller that
 * archives (the CDR recording writer, the voicemail consumer) should have to ask for the capability
 * rather than assume it. `archiveObject` is a no-op on a store with no mirror, so the guard is
 * "is this an ArchivingObjectStore" and never "is the driver s3".
 */
export interface ArchivingObjectStore extends ObjectStore {
	/**
	 * Copies an object from the filesystem into the durable mirror.
	 *
	 * Returns `true` when a copy now exists in the mirror (including when one already did), `false`
	 * when there was nothing on the filesystem to copy. Never throws for absence; a real transport
	 * failure DOES throw, so the caller can decide whether to retry.
	 */
	archiveObject(objectKey: string): Promise<boolean>;
}

/** Narrowing helper, so a caller never has to switch on `driver` to find the capability. */
export function isArchivingObjectStore(store: ObjectStore): store is ArchivingObjectStore {
	return typeof (store as Partial<ArchivingObjectStore>).archiveObject === "function";
}

/**
 * A key that resolves outside the store's root.
 *
 * A DEFECT rather than a client error, and thrown rather than returned, because every key in this
 * system is built from UUIDs this server minted (`media-storage.ts` explains why). A caller that
 * reaches this has either been handed a key from somewhere it did not expect or has a bug in its key
 * builder, and both are worth a stack trace. The read paths that take a key out of a database column
 * catch it and answer with their area's "this link is invalid", because a row is not a stack trace.
 */
export class ObjectKeyOutsideRootError extends Error {
	readonly _tag = "ObjectKeyOutsideRootError" as const;
	readonly objectKey: string;

	constructor(objectKey: string, root: string) {
		super(`the object key ${objectKey} resolves outside the store root ${root}`);
		this.name = "ObjectKeyOutsideRootError";
		this.objectKey = objectKey;
	}
}

/** The object is not in the store. Thrown by `getStream` only; `head` answers `undefined`. */
export class ObjectNotFoundError extends Error {
	readonly _tag = "ObjectNotFoundError" as const;
	readonly objectKey: string;

	constructor(objectKey: string) {
		super(`no object at ${objectKey}`);
		this.name = "ObjectNotFoundError";
		this.objectKey = objectKey;
	}
}
