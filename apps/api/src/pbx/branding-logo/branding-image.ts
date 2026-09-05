import { MediaUploadRejectedException, MediaUploadTooLargeException } from "../media/media.errors";
import type { MultipartRequest } from "../media/media-upload";

/**
 * What a white-label logo upload accepts, and how it decides.
 *
 * ## The rule is the same one the audio path follows: sniff the bytes, do not trust the name
 *
 * `media-audio.ts` sets the precedent this file copies — the browser's `Content-Type` on a
 * multipart part comes from the operating system's extension table, so `payload.exe` renamed to
 * `logo.png` arrives claiming `image/png`. The declared type is therefore a courtesy check taken
 * before the bytes are buffered, and the MAGIC BYTES below are the rule. A logo is served back to
 * every unauthenticated visitor of a tenant's login page (`branding-logo.controller.ts`), so an
 * upload that is not the image it claims to be must not be stored.
 *
 * ## The allowlist, and why SVG is on it
 *
 * PNG, JPEG and WebP are raster formats a browser renders from an `<img>`/background with no
 * ceremony. SVG is included because a vector logo is exactly what a white-label customer ships, and
 * it is safe HERE for one specific reason: the logo is consumed as an IMAGE SOURCE
 * (`<img src>` / CSS `background-image`), and a browser does not execute script embedded in an SVG
 * loaded that way — script in an SVG only runs when the document is navigated to or inlined, neither
 * of which the login lockup does. Serving it with `image/svg+xml` and `Content-Disposition: inline`
 * (the serving route's default) keeps it an image. If a future surface ever inlines tenant SVG into
 * the DOM, that surface — not this upload — is where sanitisation would belong, and this note is the
 * breadcrumb for it.
 *
 * GIF is deliberately NOT accepted even though the serving route can name its content type: an
 * animated brand mark is a support burden, not a feature, and the four formats above cover every
 * logo anyone actually ships.
 */

/** The formats accepted, each with the extension stored and the content type served. */
export interface LogoImageFormat {
	readonly kind: "png" | "jpeg" | "webp" | "svg";
	readonly extension: string;
	readonly contentType: string;
}

/** The cap on a logo upload. A brand mark is kilobytes; two mebibytes is generous and bounded. */
export const BRANDING_LOGO_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** How many leading bytes the sniffer needs to decide every format above. */
const IMAGE_PROBE_BYTES = 64;

/** The result of a successful read: the bytes and what they were proved to be. */
export interface UploadedImage {
	readonly bytes: Buffer;
	readonly format: LogoImageFormat;
	readonly fileName: string;
	readonly sizeBytes: number;
}

/**
 * The declared content types this endpoint treats as plausibly an image, checked before buffering.
 *
 * Lenient, exactly as the audio path is: an absent type and `application/octet-stream` pass (curl
 * and several HTTP clients send one of those), because the magic-byte check below is what actually
 * decides. What is refused early is a part that AFFIRMATIVELY claims to be something non-image.
 */
function isPlausibleImageContentType(declared: string | undefined): boolean {
	if (declared === undefined) {
		return true;
	}
	const type = declared.split(";")[0]?.trim().toLowerCase() ?? "";
	if (type === "" || type === "application/octet-stream") {
		return true;
	}
	return type.startsWith("image/");
}

/**
 * Reads the single image file out of a multipart request, or refuses it with a reason.
 *
 * The same shape as `readUploadedAudio`: exactly one file part is consumed, a second is drained and
 * refused rather than silently ignored, the cap is enforced while buffering, and the magic bytes are
 * the last and load-bearing check.
 */
export async function readUploadedImage(
	request: MultipartRequest,
	maxBytes: number,
): Promise<UploadedImage> {
	if (typeof request.isMultipart !== "function" || !request.isMultipart()) {
		throw new MediaUploadRejectedException(
			"Send the logo as multipart/form-data with the file in a `file` part.",
		);
	}
	if (typeof request.parts !== "function") {
		throw new Error("@fastify/multipart is not registered on this Fastify instance");
	}

	let chunks: Buffer[] | undefined;
	let total = 0;
	let fileName = "logo";
	let declaredType: string | undefined;
	let truncated = false;

	for await (const part of request.parts()) {
		if (part.type === "field") {
			continue;
		}
		if (chunks !== undefined) {
			for await (const _ignored of part.file) {
				void _ignored;
			}
			throw new MediaUploadRejectedException(
				"Upload one file at a time: this endpoint stores a single logo.",
			);
		}

		fileName = sanitizeFileName(part.filename);
		declaredType = part.mimetype;
		if (!isPlausibleImageContentType(declaredType)) {
			throw new MediaUploadRejectedException(
				`This endpoint stores PNG, JPEG, WebP and SVG images; the file was sent as ${String(
					declaredType,
				)}.`,
			);
		}

		chunks = [];
		for await (const chunk of part.file) {
			total += chunk.length;
			if (total > maxBytes) {
				truncated = true;
				break;
			}
			chunks.push(chunk);
		}
		if (part.file.truncated === true) {
			truncated = true;
		}
	}

	if (truncated) {
		throw new MediaUploadTooLargeException(maxBytes);
	}
	if (chunks === undefined) {
		throw new MediaUploadRejectedException(
			"No image file was attached. Send the file in a multipart part named `file`.",
		);
	}

	const bytes = Buffer.concat(chunks);
	if (bytes.length === 0) {
		throw new MediaUploadRejectedException("The attached file is empty.");
	}

	const format = probeImage(bytes.subarray(0, IMAGE_PROBE_BYTES));
	if (format === undefined) {
		throw new MediaUploadRejectedException(
			"This file is not a PNG, JPEG, WebP or SVG image we can store as a logo.",
		);
	}

	return { bytes, format, fileName, sizeBytes: bytes.length };
}

/**
 * Sniffs the first bytes of a file and names the image format, or `undefined` for anything else.
 *
 * Signatures:
 *   - PNG  — `89 50 4E 47 0D 0A 1A 0A`
 *   - JPEG — `FF D8 FF`
 *   - WebP — `RIFF` at 0, `WEBP` at 8 (a RIFF container whose form type is WEBP)
 *   - SVG  — text: after an optional UTF-8 BOM and leading whitespace, an XML prolog, a comment or a
 *            doctype, and an `<svg` root somewhere in the head window.
 */
export function probeImage(head: Buffer): LogoImageFormat | undefined {
	if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) {
		return { kind: "png", extension: "png", contentType: "image/png" };
	}
	if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
		return { kind: "jpeg", extension: "jpg", contentType: "image/jpeg" };
	}
	if (
		head.length >= 12 &&
		head.subarray(0, 4).toString("latin1") === "RIFF" &&
		head.subarray(8, 12).toString("latin1") === "WEBP"
	) {
		return { kind: "webp", extension: "webp", contentType: "image/webp" };
	}
	if (looksLikeSvg(head)) {
		return { kind: "svg", extension: "svg", contentType: "image/svg+xml" };
	}
	return undefined;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Whether the head reads as the start of an SVG document.
 *
 * SVG is XML and carries no binary magic, so the test is structural: strip a UTF-8 BOM and leading
 * whitespace, require the first non-space byte to open a tag (`<`), and require an `<svg` token
 * within the probe window. A prolog (`<?xml`), a comment (`<!--`) or a doctype (`<!DOCTYPE`) may
 * precede the root, so the `<svg` check scans the window rather than anchoring at the front.
 */
function looksLikeSvg(head: Buffer): boolean {
	let start = 0;
	if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
		start = 3;
	}
	const text = head.subarray(start).toString("utf8").trimStart();
	if (!text.startsWith("<")) {
		return false;
	}
	return text.toLowerCase().includes("<svg");
}

/**
 * The uploader's file name, made safe to STORE (not to use as a path).
 *
 * Never a path segment — the object key is built from a minted UUID — so this is hygiene for a text
 * value, not a traversal defence: strip directories, drop control characters, bound the length. The
 * same reasoning `media-upload.ts` sets out for audio.
 */
function sanitizeFileName(raw: string | undefined): string {
	const base = (raw ?? "logo").split(/[\\/]/u).pop() ?? "logo";
	const cleaned = [...base]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.trim();
	return cleaned.length === 0 ? "logo" : cleaned.slice(0, 128);
}
