import { createHmac, randomUUID } from "node:crypto";
import { mintRecordingToken, verifyRecordingToken } from "../cdr/recordings/recording-token";
import type { RecordingTokenResult } from "../cdr/recordings/recording-token";

/**
 * MMS parts: object keys, signed links, and the content types this platform will store.
 *
 * The signing scheme is `recording-token.ts`, reused whole, for the reason `fax-media-token.ts`
 * gives: that module already binds the row id, the organization and an expiry inside one signed
 * blob, carries it in a query parameter, and accepts a second key during rotation. Re-deriving any
 * of it would be a second implementation of one security mechanism.
 *
 * The key is DERIVED from the configured secret under a messaging-specific label, so a token minted
 * for one family cannot verify in another even though the MAC and payload shape are identical:
 *
 * ```text
 * messagingKey = HMAC-SHA256(secret, "optimiq-messaging-media-v1")
 * ```
 *
 * # Why the token names the MESSAGE and the media INDEX
 *
 * A message can carry several parts, and a link has to name exactly one. Rather than signing an
 * object key — which would let anyone holding one link edit it into a link for another object, and
 * would put a store path in a URL — the token names the message id and the part is carried
 * alongside it, validated against the row's own `mediaKeys` array. The key never leaves the server.
 */

/** Domain-separation label. Changing it invalidates every outstanding messaging media link. */
const MESSAGING_MEDIA_LABEL = "optimiq-messaging-media-v1";

/** The messaging family's key, derived from the configured secret. */
export function messagingMediaKey(secret: string): string {
	return createHmac("sha256", secret).update(MESSAGING_MEDIA_LABEL).digest("base64url");
}

/** Mints a token naming one message, in one organization, until `expiresAtSeconds`. */
export function mintMessagingMediaToken(
	messageId: string,
	organizationId: string,
	expiresAtSeconds: number,
	secret: string,
): string {
	return mintRecordingToken(
		{ r: messageId, o: organizationId, e: expiresAtSeconds },
		messagingMediaKey(secret),
	);
}

/** Verifies one, against the current key and — during a rotation — the previous one. */
export function verifyMessagingMediaToken(
	token: string,
	keys: { readonly current: string; readonly previous?: string | undefined },
): RecordingTokenResult {
	return verifyRecordingToken(token, {
		current: messagingMediaKey(keys.current),
		...(keys.previous === undefined ? {} : { previous: messagingMediaKey(keys.previous) }),
	});
}

/** The route a minted token is served from. One place, so the minter and the route cannot drift. */
export function messagingMediaPath(token: string, part: number): string {
	return `/api/v1/messaging/media?token=${encodeURIComponent(token)}&part=${String(part)}`;
}

/**
 * The content types an MMS part may be stored as.
 *
 * An allow-list and not a block-list, and the difference matters more here than anywhere else in
 * this API: these bytes are uploaded by a user, handed to a carrier by URL, and rendered back into
 * a browser. Anything that a browser will EXECUTE — SVG most of all, which is an XML document that
 * can carry script — is absent, and `Content-Type` is served from this table rather than from
 * whatever the upload claimed, so a `.png` full of HTML is served as a PNG and not sniffed into a
 * document. The carriers accept roughly this set anyway; nothing is lost by refusing the rest.
 */
export const MESSAGING_MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
	"video/mp4": "mp4",
	"video/3gpp": "3gp",
	"audio/mpeg": "mp3",
	"audio/amr": "amr",
	"application/pdf": "pdf",
	"text/vcard": "vcf",
};

/** The stored extension for a content type, or `undefined` when the type is not allowed. */
export function messagingMediaExtension(contentType: string | undefined): string | undefined {
	if (contentType === undefined) {
		return undefined;
	}
	// `image/jpeg; charset=binary` — carriers send parameters, and the map is keyed by the essence.
	const essence = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
	return MESSAGING_MEDIA_CONTENT_TYPES[essence];
}

/** The content type for a stored key, resolved from its extension. Serves the download. */
export function messagingMediaContentType(objectKey: string): string {
	const extension = objectKey.slice(objectKey.lastIndexOf(".") + 1).toLowerCase();
	for (const [type, candidate] of Object.entries(MESSAGING_MEDIA_CONTENT_TYPES)) {
		if (candidate === extension) {
			return type;
		}
	}
	// Never `application/octet-stream` with an inline disposition — see `openMessagingMedia`, which
	// pairs this with `attachment` for anything it could not identify.
	return "application/octet-stream";
}

/**
 * The object-store key layout: `messaging/<orgId>/<yyyy>/<mm>/<uuid>.<ext>`.
 *
 * Dated directories rather than a flat organization folder, unlike fax. Fax volume is a handful of
 * documents a day; a busy messaging tenant produces thousands of parts a month, and a directory with
 * a million entries in it is a filesystem that takes seconds to list — which the retention sweeper
 * has to do. The date prefix also makes a coarse retention purge a directory removal rather than a
 * million unlinks.
 *
 * The filename is a fresh UUID and never the message id: a message can carry several parts, and
 * keying on the row id would need a suffix scheme that then has to be parsed back.
 */
export function buildMessagingObjectKey(
	organizationId: string,
	extension: string,
	at: Date = new Date(),
): string {
	const year = at.getUTCFullYear();
	const month = String(at.getUTCMonth() + 1).padStart(2, "0");
	return `messaging/${organizationId}/${String(year)}/${month}/${randomUUID()}.${extension}`;
}
