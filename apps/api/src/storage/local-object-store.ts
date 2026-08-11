import { createReadStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveObjectPath } from "./object-path";
import { ObjectKeyOutsideRootError, ObjectNotFoundError } from "./object-store";
import type { ObjectRange, ObjectStat, ObjectStore, PutObjectOptions } from "./object-store";
import type { Readable } from "node:stream";

/**
 * The filesystem driver — what this API did before the seam existed, moved behind it unchanged.
 *
 * ## Byte-compatibility is the whole requirement
 *
 * Every method here produces exactly the syscalls the code it replaced produced, against exactly
 * the same paths:
 *
 * | this store        | what it replaced                                                    |
 * | ----------------- | ------------------------------------------------------------------- |
 * | `put`             | `media-storage.ts` `writeMediaObject` — `mkdir -p` then `writeFile`  |
 * | `delete`          | `media-storage.ts` `deleteMediaObject` — `rm(force: true)`           |
 * | `head`            | `media-storage.ts` `mediaObjectSize` — `stat`, regular files only    |
 * | `getStream`       | `media-response.ts` `createReadStream(path[, {start, end}])`         |
 * | `filesystemPath`  | `resolveMediaObjectPath` / `resolveRecordingObjectPath`              |
 *
 * That is not a nice-to-have. `apps/engine` renders a stored greeting as
 * `sound:<ENGINE_MEDIA_OBJECT_ROOT>/<key>` and Asterisk opens that path off a bind mount; a driver
 * that moved a byte would turn every prompt in every tenant into silence on a call, and would do it
 * without a single failing test in this repository. The paths are the contract.
 *
 * ## The containment check runs on WRITES too
 *
 * `resolveObjectPath` is applied on every operation, not just on the read paths that take a key out
 * of a database column. On the read side it answers "did a key out of the database address a file
 * outside the root"; on the write side it answers "is the key this process just built one it is
 * allowed to create" — a weaker question today, because every segment of every key is a UUID this
 * server minted, and exactly the check that keeps it weak if that ever stops being true.
 *
 * ## Buffers, not streams, on the way in
 *
 * `put` takes a `Buffer` because the only writer is the media upload path, which has the whole
 * object in memory by the time it knows the object is acceptable: the size cap is enforced during
 * the multipart read and the magic-byte probe runs on the buffered head. A streaming `put` would buy
 * nothing but a partially-written object on a mid-write failure. See `media-upload.ts`.
 */
export class LocalObjectStore implements ObjectStore {
	readonly driver = "local" as const;
	readonly root: string;

	constructor(root: string) {
		this.root = root;
	}

	filesystemPath(objectKey: string): string | undefined {
		return resolveObjectPath(this.root, objectKey);
	}

	/**
	 * The object's size, or `undefined` when it is not there.
	 *
	 * A key that escapes the root THROWS rather than answering `undefined`, and the difference
	 * matters to every caller: "this object is gone" is a `410` an operator can ignore, while "a
	 * database column addressed something outside the media root" is a defect worth a stack trace and
	 * an investigation. Collapsing them would hide the second inside the noise of the first.
	 */
	async head(objectKey: string): Promise<ObjectStat | undefined> {
		const path = this.filesystemPath(objectKey);
		if (path === undefined) {
			throw new ObjectKeyOutsideRootError(objectKey, this.root);
		}
		try {
			const info = await stat(path);
			// Not `isFile()` means a directory, a socket or a device: none of them is an object, and
			// streaming any of them would hang a response rather than 410 it.
			return info.isFile() ? { sizeBytes: info.size, updatedAt: info.mtime } : undefined;
		} catch {
			return undefined;
		}
	}

	/** Whether {@link head} would answer with a stat. An escaping key is `false`, not a throw. */
	async exists(objectKey: string): Promise<boolean> {
		const path = this.filesystemPath(objectKey);
		return path !== undefined && (await this.head(objectKey)) !== undefined;
	}

	async getStream(objectKey: string, range?: ObjectRange): Promise<Readable> {
		const path = this.filesystemPath(objectKey);
		if (path === undefined) {
			throw new ObjectKeyOutsideRootError(objectKey, this.root);
		}
		// `head` first rather than letting the stream emit ENOENT asynchronously: a caller awaiting
		// this promise can handle a rejection, whereas an `error` event on a stream already handed to
		// Fastify is a truncated response with a 200 status on it.
		if ((await this.head(objectKey)) === undefined) {
			throw new ObjectNotFoundError(objectKey);
		}
		return range === undefined
			? createReadStream(path)
			: createReadStream(path, { start: range.start, end: range.end });
	}

	async put(objectKey: string, bytes: Buffer, _options?: PutObjectOptions): Promise<void> {
		const path = this.filesystemPath(objectKey);
		if (path === undefined) {
			throw new ObjectKeyOutsideRootError(objectKey, this.root);
		}
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, bytes);
	}

	/**
	 * Deletes an object, tolerating its absence.
	 *
	 * `force: true` makes "already gone" the success it is. The asymmetry with the CDR area is
	 * deliberate and lives at the CALLER: `voicemail-messages.service.ts` does not unlink audio when
	 * a message row is purged, because retention owns a recording's lifecycle, while the media
	 * library does unlink, because the row IS the reason the file exists. This method has no opinion.
	 */
	async delete(objectKey: string): Promise<void> {
		const path = this.filesystemPath(objectKey);
		if (path === undefined) {
			// Refusing to delete outside the root is the point; a throw here would let a malformed key
			// turn a best-effort cleanup into a 500 on a request that already succeeded.
			return;
		}
		await rm(path, { force: true });
	}

	/**
	 * A filesystem cannot mint a URL.
	 *
	 * `undefined` rather than a `file://` path, which would be a URL that works on exactly one
	 * machine and looks like it works everywhere. The signed-URL routes already handle `undefined` by
	 * streaming through the API, which is what they do today for every driver — see
	 * `object-store.factory.ts` for why that stayed true even for S3.
	 */
	async presign(_objectKey: string, _ttlSeconds: number): Promise<string | undefined> {
		return undefined;
	}
}
