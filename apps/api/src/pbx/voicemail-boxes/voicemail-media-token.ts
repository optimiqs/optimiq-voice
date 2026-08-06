import { createHmac } from "node:crypto";
import {
	mintRecordingToken,
	resolveRecordingObjectPath,
	verifyRecordingToken,
} from "../../cdr/recordings/recording-token";
import type { RecordingTokenResult } from "../../cdr/recordings/recording-token";

/**
 * Signed, expiring playback URLs for voicemail message audio.
 *
 * ## It is the CDR scheme, deliberately, down to the last byte
 *
 * `recording-token.ts` already answers every question this needs answered: the payload binds the
 * row id, the organization and an expiry; the id is INSIDE the signed blob so there is no address
 * to enumerate; the token rides in a query parameter because Fastify caps a route PARAMETER at 100
 * characters and a token is around 165; rotation is a second key accepted for verification only.
 * Re-deriving any of that here would be a second implementation of a security mechanism, which is
 * how two implementations end up disagreeing about which one got the constant-time compare right.
 *
 * So this module imports it. `recording-token.ts` is a pure function module — `node:crypto` and
 * `node:path`, no Nest, no environment, no database — so importing it from the PBX area does not
 * mount the CDR area or require it to be configured. What the PBX area supplies is its own key,
 * its own object root and its own route.
 *
 * ## Why the key is DERIVED rather than shared
 *
 * The two token families would otherwise be interchangeable: same MAC, same payload shape, same
 * secret. Today that is harmless — a voicemail token presented to the recordings route names a
 * `voicemail_message` id, which is not a `recordings` id, so the lookup finds nothing and answers
 * `CDR_LINK_INVALID` — but "harmless because two UUID spaces happen not to overlap" is a property
 * of the data, not of the design, and it stops being true the first time either route learns to
 * look somewhere else.
 *
 * One HMAC of a fixed label fixes it for good:
 *
 * ```text
 * voicemailKey = HMAC-SHA256(secret, "optimiq-voicemail-media-v1")
 * ```
 *
 * A token minted for one family cannot verify in the other, at all, and the operator still
 * configures one secret. The label carries a version so a future re-derivation is a label change
 * rather than a key change — old links die on their own within the TTL, which is minutes.
 */

/** Domain-separation label. Changing it invalidates every outstanding voicemail link. */
const VOICEMAIL_MEDIA_LABEL = "optimiq-voicemail-media-v1";

/** The voicemail family's key, derived from the configured secret. */
export function voicemailMediaKey(secret: string): string {
	return createHmac("sha256", secret).update(VOICEMAIL_MEDIA_LABEL).digest("base64url");
}

/** Mints a token naming one message, in one organization, until `expiresAtSeconds`. */
export function mintVoicemailMediaToken(
	messageId: string,
	organizationId: string,
	expiresAtSeconds: number,
	secret: string,
): string {
	return mintRecordingToken(
		{ r: messageId, o: organizationId, e: expiresAtSeconds },
		voicemailMediaKey(secret),
	);
}

/** Verifies one, against the current key and — during a rotation — the previous one. */
export function verifyVoicemailMediaToken(
	token: string,
	keys: { readonly current: string; readonly previous?: string | undefined },
): RecordingTokenResult {
	return verifyRecordingToken(token, {
		current: voicemailMediaKey(keys.current),
		...(keys.previous === undefined ? {} : { previous: voicemailMediaKey(keys.previous) }),
	});
}

/**
 * The route a minted token is served from. One place, so the minter and the route cannot drift.
 *
 * Under `/api/v1/voicemail-boxes/` rather than a sibling of `/recordings/media`, because that is
 * where the resource lives and because the two families are now cryptographically distinct: a
 * shared media route would have to guess which table to look in.
 */
export function voicemailMediaPath(token: string): string {
	return `/api/v1/voicemail-boxes/media?token=${encodeURIComponent(token)}`;
}

/**
 * The object path for a message key, resolved under `root` and proved to stay there.
 *
 * The same containment check the recordings route applies, and for the same reason: the signature
 * establishes that the CALLER may read this message, and this establishes that the KEY — which
 * came out of the database, written by the engine — addresses a file inside the media root and not
 * `../../etc/passwd`. Two different threats, two different checks.
 */
export const resolveVoicemailObjectPath = resolveRecordingObjectPath;
