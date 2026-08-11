import { getLogger } from "@optimiq-voice/logging";
import { ObjectNotFoundError } from "./object-store";
import type {
	ArchivingObjectStore,
	ObjectRange,
	ObjectStat,
	ObjectStore,
	PutObjectOptions,
} from "./object-store";
import type { Readable } from "node:stream";

const logger = getLogger("api.storage");

/**
 * A filesystem that is the source of truth, plus an object store that keeps a durable copy.
 *
 * ## Why a composite rather than "use S3 instead"
 *
 * `object-store.ts`'s header states the constraint at length; the short form is that **Asterisk
 * opens these files off a bind mount and cannot be handed a bucket**. `apps/engine` renders a prompt
 * as `sound:<root>/<key>`, hold music as a `musiconhold.conf` `directory=`, and a recording as a
 * filesystem target. ARI has no HTTP media scheme. So an object that the call path touches has to
 * exist on the volume no matter what else is configured, and a driver that simply replaced the
 * filesystem would turn every tenant's prompts into silence — without failing a single test in this
 * repository, because nothing here plays audio.
 *
 * This composite is that constraint written as code:
 *
 * ```text
 * put      -> origin FIRST (Asterisk must be able to open it), then mirror
 * archive  -> origin -> mirror, for objects Asterisk wrote and this API only reads
 * head/get -> origin, falling back to mirror
 * delete   -> both
 * presign  -> mirror only
 * ```
 *
 * ## Reads prefer the filesystem, and that ordering is deliberate
 *
 * The volume is local, it is already warm, and it is what Asterisk is reading from the same second.
 * Going to the bucket first would add a network round trip to every scrub-bar drag in the admin UI
 * in exchange for nothing. The fallback is the interesting half: an API container whose volume was
 * replaced — the exact failure the audit named — still SERVES every archived recording and every
 * mirrored upload, because the mirror answers when the filesystem does not. What it cannot do is
 * make Asterisk play them; that needs `apps/mediad`, and it is the migration note in
 * `object-store.ts`.
 *
 * ## The mirror never fails a request
 *
 * A `put` whose mirror half fails still succeeded: the object is on the volume, Asterisk can play
 * it, the row will be written. Turning a working upload into a 500 because a bucket was briefly
 * unreachable would trade the audit's durability problem for an availability one, which is a worse
 * deal in both directions. The failure is logged with the key, and {@link archiveObject} exists so a
 * back-fill can re-run it. `archiveObject` itself DOES throw, because its caller (a durable NATS
 * consumer) has redelivery and can actually retry.
 */
export class MirroredObjectStore implements ArchivingObjectStore {
	readonly driver = "mirrored" as const;
	readonly origin: ObjectStore;
	readonly mirror: ObjectStore;

	constructor(origin: ObjectStore, mirror: ObjectStore) {
		this.origin = origin;
		this.mirror = mirror;
	}

	/** The filesystem path Asterisk would open — always the ORIGIN's, never the mirror's. */
	filesystemPath(objectKey: string): string | undefined {
		return this.origin.filesystemPath(objectKey);
	}

	/**
	 * The filesystem's answer, or the mirror's when the filesystem has nothing.
	 *
	 * An `ObjectKeyOutsideRootError` from the origin PROPAGATES rather than falling through to the
	 * mirror: a key that escapes the media root is a defect wherever it is looked up, and asking the
	 * bucket for it would turn "a database column is poisoned" into "the object is missing".
	 */
	async head(objectKey: string): Promise<ObjectStat | undefined> {
		const local = await this.origin.head(objectKey);
		if (local !== undefined) {
			return local;
		}
		return await this.mirror.head(objectKey).catch((cause: unknown) => {
			// A mirror that is down must not turn "the object is missing" into a 500 on a media route
			// whose local half already answered "not here". The caller's 410 is the right answer and
			// this log line is what says the answer might have been wrong.
			logger.error({ objectKey, err: cause }, "could not read the object mirror");
			return undefined;
		});
	}

	/** Whether {@link head} would answer with a stat. An escaping key is `false`, not a throw. */
	async exists(objectKey: string): Promise<boolean> {
		return (
			this.filesystemPath(objectKey) !== undefined && (await this.head(objectKey)) !== undefined
		);
	}

	/**
	 * Opens the object from the filesystem, falling back to the mirror.
	 *
	 * The two halves are asked in the same order `head` asks them, which matters more than it looks:
	 * a caller `head`s to learn the size for `content-length` and then `getStream`s for the bytes, and
	 * a store that answered the size from one half and the bytes from the other could serve a
	 * `content-length` that does not match the body. Both are origin-first, so both land on the same
	 * copy for every object that has one.
	 */
	async getStream(objectKey: string, range?: ObjectRange): Promise<Readable> {
		try {
			return await this.origin.getStream(objectKey, range);
		} catch (cause) {
			if (!(cause instanceof ObjectNotFoundError)) {
				throw cause;
			}
			return await this.mirror.getStream(objectKey, range);
		}
	}

	/**
	 * Writes to the filesystem first, then mirrors.
	 *
	 * The order is the constraint: the object has to be somewhere Asterisk can open it before this
	 * call returns, because the caller's next act is to insert the row that points at it. The mirror
	 * is a copy taken afterwards, and a failed copy is a log line rather than a failed upload — see
	 * this class's header.
	 */
	async put(objectKey: string, bytes: Buffer, options?: PutObjectOptions): Promise<void> {
		await this.origin.put(objectKey, bytes, options);
		await this.mirror.put(objectKey, bytes, options).catch((cause: unknown) => {
			logger.error(
				{ objectKey, err: cause },
				"stored an object on the filesystem but could not mirror it to the object store",
			);
		});
	}

	/**
	 * Copies an object Asterisk wrote into the durable mirror.
	 *
	 * This is the half of the seam that closes the audit's finding for CALL RECORDINGS and VOICEMAIL
	 * MESSAGE AUDIO, neither of which this API ever writes: Asterisk drops the file on the volume and
	 * publishes an event, and the consumer that files the metadata row calls this. Filing the row is
	 * the right moment because it is the first instant at which the object is FINAL — a recording
	 * mid-capture would archive a truncated file, and `channel.record.stopped` is precisely the event
	 * that says it is not mid-capture any more.
	 *
	 * Reads the whole object into memory rather than streaming it through. Recordings are minutes of
	 * 8 kHz WAV (a ten-minute call is under 10 MB) and voicemail messages are shorter still, the
	 * archive runs on a durable consumer rather than on a request, and a streaming upload would need
	 * a multipart seam in the interface for an object size that never needs one. If that stops being
	 * true — long-form recording, video — this is the method that grows an `upload` path, and it is
	 * the only one.
	 *
	 * Throws on a transport failure, unlike every other mirror write here, because the caller has
	 * redelivery: a NAK re-runs it in a few seconds instead of losing the copy silently.
	 */
	async archiveObject(objectKey: string): Promise<boolean> {
		const local = await this.origin.head(objectKey);
		if (local === undefined) {
			// Nothing on the volume. Either the file has already aged out under a retention policy or
			// this API does not share a mount with the media server — both are configuration, not a
			// transport failure, and neither is worth a redelivery loop.
			return false;
		}
		if (await this.mirror.exists(objectKey)) {
			// Already archived. `archiveObject` is called from at-least-once consumers, so this is the
			// ordinary redelivery path rather than an exception.
			return true;
		}

		const stream = await this.origin.getStream(objectKey);
		const chunks: Buffer[] = [];
		for await (const chunk of stream) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
		}
		await this.mirror.put(objectKey, Buffer.concat(chunks), { contentType: local.contentType });
		return true;
	}

	/**
	 * Deletes from both halves.
	 *
	 * The mirror's failure is swallowed for the reason every unlink in this codebase swallows one:
	 * it is always called AFTER the write that made the object unreachable has committed, so a
	 * failure is a leaked object with a log line rather than a caller told their delete failed when
	 * it did not.
	 */
	async delete(objectKey: string): Promise<void> {
		await this.origin.delete(objectKey);
		await this.mirror.delete(objectKey).catch((cause: unknown) => {
			logger.error({ objectKey, err: cause }, "could not delete an object from the mirror");
		});
	}

	/** Only the mirror can mint a URL; the filesystem half always answers `undefined`. */
	async presign(objectKey: string, ttlSeconds: number): Promise<string | undefined> {
		return await this.mirror.presign(objectKey, ttlSeconds);
	}
}
