import { contentRangeHeader, decideRange, unsatisfiedContentRangeHeader } from "./http-range";
import type { ObjectStore } from "../storage";
import type { Readable } from "node:stream";

/**
 * Turning "an object plus a `Range` header" into "a stream plus a status plus headers".
 *
 * Shared by the three routes that stream audio — call recordings, voicemail messages and the PBX
 * media library — for the reason `http-range.ts` gives at length: they are three copies of one
 * behaviour, and a scrub bar that works on two of them is a bug report.
 *
 * ## The seam, and why it is shaped like this
 *
 * A Nest controller that returns a stream from a `@Res({ passthrough: true })` handler can set
 * headers and a status code but cannot easily *not* return a body. So the decision has to happen
 * where both halves are available: this function produces the stream and the headers together, and
 * signals the one case that has no body — `416` — by returning `stream: undefined` alongside the
 * `content-range` the client needs in order to recover. The controller then throws the area's
 * range exception, which carries the size in its body too.
 *
 * ## It takes an {@link ObjectStore}, not a path, and that is the whole of the storage change
 *
 * This function used to take an absolute filesystem path and call `createReadStream` on it. It now
 * takes the store and the KEY, and asks the store to open the range. Everything above and below
 * that line is unchanged — the range arithmetic, the statuses, the header set — because the
 * decision "which bytes" has nothing to do with where the bytes are. The local driver still ends up
 * in `createReadStream(path, { start, end })`; an S3-backed one sends a `Range` header and the
 * store does the seeking. See `src/storage/object-store.ts`.
 *
 * ## `accept-ranges: bytes` is now unconditional, and that is a promise
 *
 * Every response from here — `200` and `206` alike — carries it. That is the header a media element
 * reads to decide whether the playhead is draggable at all, and it must be present on the FIRST
 * response, which is the one with no `Range` header on it. The three routes previously answered
 * `accept-ranges: none`, which was honest about what they did and is why seeking never worked.
 */

/** Everything a media controller needs to answer one request. */
export interface MediaResponse {
	readonly status: 200 | 206 | 416;
	/**
	 * Absent only for `416`, which has no body.
	 *
	 * A `Readable` rather than `node:fs`'s `ReadStream`: the bytes may come off a disk or off an
	 * object store, and Fastify wants the base interface either way.
	 */
	readonly stream?: Readable;
	/** Headers to set, in the order they should be set. `content-type` is the caller's business. */
	readonly headers: Readonly<Record<string, string>>;
	/** The object's full size, for the `416` body. */
	readonly sizeBytes: number;
}

/**
 * Opens one object for one request, honouring a single `Range`.
 *
 * A ranged open rather than reading the whole object and slicing: the object may be an hour of
 * audio, the point of a range request is to move a few hundred kilobytes, and both drivers are
 * better at seeking than this process is — the kernel does a `pread`, S3 does it server-side.
 *
 * `content-length` is set explicitly on both paths. For `206` it is the RANGE's length, not the
 * object's — the single most common way to get a partial response wrong, and the one that makes a
 * player buffer forever waiting for bytes that are never coming.
 *
 * `async` now, because opening an object on a remote store is a round trip. The `416` path still
 * opens nothing at all: a range past the end is decided from `sizeBytes` alone, so an unsatisfiable
 * request never reaches the store.
 */
export async function openMediaResponse(
	store: ObjectStore,
	objectKey: string,
	sizeBytes: number,
	options: {
		readonly contentType: string;
		readonly fileName: string;
		readonly rangeHeader?: string | undefined;
		/** `inline` for a player, `attachment` for a download. */
		readonly disposition?: "inline" | "attachment";
	},
): Promise<MediaResponse> {
	const disposition = options.disposition ?? "inline";
	const base: Record<string, string> = {
		"content-type": options.contentType,
		"content-disposition": `${disposition}; filename="${options.fileName}"`,
		// The promise. See the header: present on every response, including the one with no range.
		"accept-ranges": "bytes",
	};

	const decision = decideRange(options.rangeHeader, sizeBytes);

	if (decision.kind === "unsatisfiable") {
		return {
			status: 416,
			headers: { ...base, "content-range": unsatisfiedContentRangeHeader(sizeBytes) },
			sizeBytes,
		};
	}

	if (decision.kind === "partial") {
		return {
			status: 206,
			stream: await store.getStream(objectKey, { start: decision.start, end: decision.end }),
			headers: {
				...base,
				"content-range": contentRangeHeader(decision.start, decision.end, sizeBytes),
				"content-length": String(decision.length),
			},
			sizeBytes,
		};
	}

	return {
		status: 200,
		stream: await store.getStream(objectKey),
		headers: { ...base, "content-length": String(sizeBytes) },
		sizeBytes,
	};
}
