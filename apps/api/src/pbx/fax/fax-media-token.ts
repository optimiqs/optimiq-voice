import { createHmac } from "node:crypto";
import {
	mintRecordingToken,
	resolveRecordingObjectPath,
	verifyRecordingToken,
} from "../../cdr/recordings/recording-token";
import type { RecordingTokenResult } from "../../cdr/recordings/recording-token";

/**
 * Signed, expiring links for fax documents.
 *
 * The voicemail media scheme, reused down to the last byte, for the reason `voicemail-media-token.ts`
 * gives: `recording-token.ts` already binds the row id, the organization and an expiry inside the
 * signed blob, carries the token in a query parameter, and accepts a second key during rotation.
 * Re-deriving any of that would be a second implementation of one security mechanism. That module is
 * a pure function of `node:crypto`/`node:path`, so importing it here mounts nothing.
 *
 * The key is DERIVED from the configured secret under a fax-specific label, so a token minted for one
 * family cannot verify in another even though the MAC and payload shape are identical:
 *
 * ```text
 * faxKey = HMAC-SHA256(secret, "optimiq-fax-media-v1")
 * ```
 */

/** Domain-separation label. Changing it invalidates every outstanding fax link. */
const FAX_MEDIA_LABEL = "optimiq-fax-media-v1";

/** The fax family's key, derived from the configured secret. */
export function faxMediaKey(secret: string): string {
	return createHmac("sha256", secret).update(FAX_MEDIA_LABEL).digest("base64url");
}

/** Mints a token naming one fax message, in one organization, until `expiresAtSeconds`. */
export function mintFaxMediaToken(
	messageId: string,
	organizationId: string,
	expiresAtSeconds: number,
	secret: string,
): string {
	return mintRecordingToken(
		{ r: messageId, o: organizationId, e: expiresAtSeconds },
		faxMediaKey(secret),
	);
}

/** Verifies one, against the current key and — during a rotation — the previous one. */
export function verifyFaxMediaToken(
	token: string,
	keys: { readonly current: string; readonly previous?: string | undefined },
): RecordingTokenResult {
	return verifyRecordingToken(token, {
		current: faxMediaKey(keys.current),
		...(keys.previous === undefined ? {} : { previous: faxMediaKey(keys.previous) }),
	});
}

/** The route a minted token is served from. One place, so the minter and the route cannot drift. */
export function faxMediaPath(token: string): string {
	return `/api/v1/faxes/media?token=${encodeURIComponent(token)}`;
}

/**
 * The object path for a fax document key, resolved under `root` and proved to stay there — the same
 * containment check the recordings route applies, guarding a key that came out of the database
 * against addressing a file outside the fax root.
 */
export const resolveFaxObjectPath = resolveRecordingObjectPath;
