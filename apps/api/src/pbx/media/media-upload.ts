import {
	ACCEPTED_AUDIO_EXTENSIONS,
	AUDIO_PROBE_BYTES,
	isPlausibleAudioContentType,
	probeAudio,
} from "./media-audio";
import { MediaUploadRejectedException, MediaUploadTooLargeException } from "./media.errors";
import type { AudioFormat } from "./media-audio";

/**
 * Reading one audio file out of a `multipart/form-data` request.
 *
 * ## Why multipart, and why it is the only upload encoding here
 *
 * This is the platform's first upload path, so the encoding was a real choice rather than an
 * inheritance. `multipart/form-data` won on one property the alternatives do not have: **it is what
 * a browser produces from a `<form>` and from `new FormData()`, with the boundary and the file name
 * handled by the browser rather than by us.** A raw-body `PUT` with the bytes and the metadata in
 * the query string is simpler on the server and worse everywhere else — the file name has to be URL
 * encoded by hand, a second field means a second round trip or a second encoding, and the request
 * stops being something `curl -F` can produce.
 *
 * `@fastify/multipart` rather than a hand-rolled `addContentTypeParser`: boundary parsing, per-part
 * limits and stream backpressure are exactly the kind of code that looks finished and is not. It is
 * registered once, in `pbx-bootstrap.ts`, with the limits this module then re-checks.
 *
 * ## The size cap is enforced twice, and the second one is the one that matters
 *
 * `@fastify/multipart` is configured with `limits.fileSize`, which makes the underlying stream stop
 * and raise once the cap is passed — that is the enforcement, and it is what keeps a 4 GiB upload
 * from becoming 4 GiB of resident memory. `part.file.truncated` is then checked HERE, because the
 * plugin's default behaviour on hitting the limit is to truncate the stream rather than to throw,
 * and a caller that only looked at the buffer would happily store the first N bytes of a file as
 * though they were the file. The buffered length is compared as well, so a limit that was
 * mis-configured to something enormous still cannot get past this function.
 *
 * ## Order of checks, and why it is this order
 *
 * ```text
 * 1. is this even a multipart request        -> 400, before any body is read
 * 2. declared content type / extension       -> 400, before the bytes are buffered
 * 3. buffer, with the cap enforced           -> 413 the moment it is exceeded
 * 4. magic bytes                             -> 400, and this is the check that means something
 * ```
 *
 * Step 2 is a courtesy and step 4 is the rule. The browser's `Content-Type` on a part comes from the
 * operating system's extension table, so `payload.exe` renamed to `hold-music.wav` produces a part
 * that says `audio/wav`. See `media-audio.ts`.
 */

/** What the multipart request yielded. */
export interface UploadedAudio {
	readonly bytes: Buffer;
	readonly format: AudioFormat;
	/** The name the uploader's file had. Kept as DATA on the row, never as a path segment. */
	readonly fileName: string;
	readonly sizeBytes: number;
	readonly sampleRateHz?: number;
	readonly channels?: number;
	readonly durationMs?: number;
	/** Non-fatal observations from the sniffer, surfaced in the mutation envelope's `warnings`. */
	readonly warnings: readonly string[];
	/** The non-file parts of the form, as strings. Empty values are dropped. */
	readonly fields: Readonly<Record<string, string>>;
}

/**
 * The two methods of a Fastify request this module uses, declared structurally.
 *
 * Not `FastifyRequest` imported from `fastify`, for the reason `recordings.controller.ts` records:
 * `fastify` arrives here transitively under `@nestjs/platform-fastify`, and adding it as a direct
 * dependency to name a type in one signature would be a dependency taken on for a type import.
 * `@fastify/multipart` decorates the request with `isMultipart()` and `parts()`; those two, and the
 * shape of a part, are the entire surface.
 */
export interface MultipartRequest {
	isMultipart?: () => boolean;
	parts?: () => AsyncIterableIterator<MultipartPart>;
}

interface MultipartFilePart {
	readonly type: "file";
	readonly fieldname: string;
	readonly filename?: string;
	readonly mimetype?: string;
	readonly file: AsyncIterable<Buffer> & { readonly truncated?: boolean };
}

interface MultipartFieldPart {
	readonly type: "field";
	readonly fieldname: string;
	readonly value: unknown;
}

type MultipartPart = MultipartFilePart | MultipartFieldPart;

/**
 * Reads the single audio file out of a multipart request, or refuses it with a reason.
 *
 * Exactly one file part is consumed: the first one. A second file part is refused rather than
 * ignored, because "I uploaded two and only one appeared" is a silent data-loss bug and the
 * endpoints in this area each own one object.
 */
export async function readUploadedAudio(
	request: MultipartRequest,
	maxBytes: number,
): Promise<UploadedAudio> {
	if (typeof request.isMultipart !== "function" || !request.isMultipart()) {
		throw new MediaUploadRejectedException(
			"Send the audio as multipart/form-data with the file in a `file` part.",
		);
	}
	if (typeof request.parts !== "function") {
		// The plugin is not registered. A defect rather than a client error, and it must not read
		// as "your file was wrong".
		throw new Error("@fastify/multipart is not registered on this Fastify instance");
	}

	const fields: Record<string, string> = {};
	let chunks: Buffer[] | undefined;
	let total = 0;
	let fileName = "upload";
	let declaredType: string | undefined;
	let truncated = false;

	for await (const part of request.parts()) {
		if (part.type === "field") {
			// Only scalar fields; a `FormData` never produces anything else, and coercing an object
			// into a string here would put `[object Object]` in a database column.
			if (typeof part.value === "string" && part.value.length > 0) {
				fields[part.fieldname] = part.value;
			}
			continue;
		}

		if (chunks !== undefined) {
			// Drain it so the request finishes rather than hanging on an unconsumed stream, then
			// refuse. Draining first is what makes the 400 reach the client at all.
			for await (const _ignored of part.file) {
				void _ignored;
			}
			throw new MediaUploadRejectedException(
				"Upload one file at a time: this endpoint stores a single audio object.",
			);
		}

		fileName = sanitizeFileName(part.filename);
		declaredType = part.mimetype;
		assertPlausible(declaredType, fileName);

		chunks = [];
		for await (const chunk of part.file) {
			total += chunk.length;
			if (total > maxBytes) {
				truncated = true;
				break;
			}
			chunks.push(chunk);
		}
		// The plugin's own limit truncates rather than throwing; either signal means the same thing.
		if (part.file.truncated === true) {
			truncated = true;
		}
	}

	if (truncated) {
		throw new MediaUploadTooLargeException(maxBytes);
	}
	if (chunks === undefined) {
		throw new MediaUploadRejectedException(
			"No audio file was attached. Send the file in a multipart part named `file`.",
		);
	}

	const bytes = Buffer.concat(chunks);
	if (bytes.length === 0) {
		throw new MediaUploadRejectedException("The attached file is empty.");
	}

	const probe = probeAudio(bytes.subarray(0, AUDIO_PROBE_BYTES));
	if (probe.format === undefined) {
		throw new MediaUploadRejectedException(probe.issue ?? "This file is not audio we can store.");
	}

	return {
		bytes,
		format: probe.format,
		fileName,
		sizeBytes: bytes.length,
		...(probe.sampleRateHz === undefined ? {} : { sampleRateHz: probe.sampleRateHz }),
		...(probe.channels === undefined ? {} : { channels: probe.channels }),
		...(probe.durationMs === undefined ? {} : { durationMs: probe.durationMs }),
		warnings: probe.warnings,
		fields,
	};
}

/**
 * The declared type and the extension, checked before a single byte is buffered.
 *
 * Both are advisory — the sniffer is the rule — so both are checked leniently: a part with no
 * declared type or `application/octet-stream` passes (curl and several HTTP clients send exactly
 * that), and a file with no extension passes too. What is refused here is an upload that
 * AFFIRMATIVELY claims to be something else, which is the case worth catching early because the
 * client already knows it is wrong.
 */
function assertPlausible(declaredType: string | undefined, fileName: string): void {
	if (!isPlausibleAudioContentType(declaredType)) {
		throw new MediaUploadRejectedException(
			`This endpoint stores WAV and MP3 audio; the file was sent as ${String(declaredType)}.`,
		);
	}
	const dot = fileName.lastIndexOf(".");
	if (dot === -1) {
		return;
	}
	const extension = fileName.slice(dot + 1).toLowerCase();
	if (extension !== "" && !ACCEPTED_AUDIO_EXTENSIONS.includes(extension)) {
		throw new MediaUploadRejectedException(
			`This endpoint stores ${ACCEPTED_AUDIO_EXTENSIONS.map((value) => `.${value}`).join(" and ")} ` +
				`files; the file was named ".${extension}".`,
		);
	}
}

/**
 * The uploader's file name, made safe to STORE (not to use as a path).
 *
 * It never becomes a path segment — `media-storage.ts` builds keys out of minted UUIDs — so this is
 * not a path-traversal defence and must not be mistaken for one. It is the ordinary hygiene any
 * user string gets before it lands in a text column and is rendered in a table: strip the
 * directories a browser sometimes includes, drop control characters, and bound the length.
 */
function sanitizeFileName(raw: string | undefined): string {
	const base = (raw ?? "upload").split(/[\\/]/u).pop() ?? "upload";
	// A code-point filter rather than a regex: `no-control-regex` refuses a character class over
	// C0/DEL however it is escaped, and the lint rule is right that such a class is usually a bug.
	// Here it is not — dropping control characters from a name that lands in a text column and is
	// rendered in a table is the point — so the check is written as the loop the rule cannot
	// mistake for an accident.
	const cleaned = [...base]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.trim();
	return cleaned.length === 0 ? "upload" : cleaned.slice(0, 128);
}
