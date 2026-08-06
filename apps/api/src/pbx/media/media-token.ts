import { createHmac } from "node:crypto";
import { mintRecordingToken, verifyRecordingToken } from "../../cdr/recordings/recording-token";
import type { RecordingTokenResult } from "../../cdr/recordings/recording-token";

/**
 * Signed, expiring playback URLs for the media library.
 *
 * ## The third member of a family that now has a rule
 *
 * `recording-token.ts` established the mechanism (payload binds row id + organization + expiry, the
 * id lives INSIDE the signed blob so there is nothing to enumerate, the token rides in a query
 * parameter because Fastify caps a route parameter at 100 characters and a token is around 165, and
 * rotation is a second key accepted for verification only). `voicemail-media-token.ts` established
 * the SEPARATION: the family's key is derived from the configured secret by one HMAC of a fixed
 * label, so a token minted for one family cannot verify in another, at all, while the operator
 * still configures one secret.
 *
 * This module generalises that second step rather than copying it a third time. Two families live
 * here, and adding a fourth is a label, not a file:
 *
 * ```text
 * promptKey   = HMAC-SHA256(secret, "optimiq-prompt-media-v1")
 * greetingKey = HMAC-SHA256(secret, "optimiq-greeting-media-v1")
 * ```
 *
 * Why they are separate at all, when both are "media library audio the admin may hear": because
 * they are rows in DIFFERENT TABLES, and the route that serves a token has to know which table to
 * look in. Deriving the answer from the key rather than from a field inside the payload means a
 * token cannot lie about it — a forged `{"t":"greeting"}` is a payload edit and would invalidate
 * the MAC, but so would nothing at all if the route simply trusted the field it read. Domain
 * separation is the cheaper and stricter of the two designs.
 *
 * The labels carry a version so a future re-derivation is a label change rather than a key change:
 * outstanding links die on their own within the TTL, which is minutes.
 */

/** Which table a token addresses. Encoded as a KEY, never as a field in the payload. */
export type MediaFamily = "prompt" | "greeting";

const MEDIA_LABELS: Readonly<Record<MediaFamily, string>> = {
	prompt: "optimiq-prompt-media-v1",
	greeting: "optimiq-greeting-media-v1",
};

/** One family's key, derived from the configured secret. */
export function mediaFamilyKey(family: MediaFamily, secret: string): string {
	return createHmac("sha256", secret).update(MEDIA_LABELS[family]).digest("base64url");
}

/** Mints a token naming one row, in one organization, until `expiresAtSeconds`. */
export function mintMediaToken(
	family: MediaFamily,
	rowId: string,
	organizationId: string,
	expiresAtSeconds: number,
	secret: string,
): string {
	return mintRecordingToken(
		{ r: rowId, o: organizationId, e: expiresAtSeconds },
		mediaFamilyKey(family, secret),
	);
}

/** Verifies one, against the current key and — during a rotation — the previous one. */
export function verifyMediaToken(
	family: MediaFamily,
	token: string,
	keys: { readonly current: string; readonly previous?: string | undefined },
): RecordingTokenResult {
	return verifyRecordingToken(token, {
		current: mediaFamilyKey(family, keys.current),
		...(keys.previous === undefined ? {} : { previous: mediaFamilyKey(family, keys.previous) }),
	});
}

/**
 * The routes a minted token is served from. One place, so the minter and the route cannot drift.
 *
 * Both are literal segments under a prefix that otherwise takes a `:id`, which works because
 * Fastify's router (`find-my-way`) is a radix tree that prefers a STATIC segment over a parametric
 * one regardless of declaration order — the same property `pbx.module.ts` relies on to let
 * `GET /voicemail-boxes/media` coexist with `GET /voicemail-boxes/:id`.
 */
export function promptMediaPath(token: string): string {
	return `/api/v1/prompts/media?token=${encodeURIComponent(token)}`;
}

export function greetingMediaPath(token: string): string {
	return `/api/v1/voicemail-boxes/greetings/media?token=${encodeURIComponent(token)}`;
}

export function mediaPathFor(family: MediaFamily, token: string): string {
	return family === "prompt" ? promptMediaPath(token) : greetingMediaPath(token);
}
