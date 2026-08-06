import { createHmac, timingSafeEqual } from "node:crypto";
import { resolve as resolvePath, sep as pathSeparator } from "node:path";

/**
 * Signed, expiring download URLs for recording media.
 *
 * ## The problem this replaces
 *
 * `src/http/recordings.controller.ts` serves `/api/recordings/:id` anonymously, and its own comment
 * says why that is not safe: `apps/autopilot` posts a recording URL to a customer's `eventsHook`,
 * so the fetcher is a third party with no session, so the route cannot sit behind the guard. Path
 * traversal is blocked; ENUMERATION is not. Anyone who can guess a file name can read a stranger's
 * call audio. That controller records the fix as "a signed, expiring URL minted alongside the
 * recording"; this is that fix.
 *
 * ## The scheme
 *
 * ```text
 * <base64url(payload JSON)>.<base64url(HMAC-SHA256(payload, key))>
 * ```
 *
 * and the URL is `GET /api/v1/recordings/media?token=<token>` (see {@link recordingMediaPath} for
 * why the token is a query parameter rather than a path segment).
 *
 * The recording id is INSIDE the token, and nowhere else in the URL. That is the difference between
 * "signed" and "unguessable": with `/recordings/:id?sig=…` an attacker still learns which ids exist
 * by watching which ones 403 versus 404, and every id in the system remains a valid target to
 * attack. With the id inside the signed blob there is no address to enumerate at all — the only
 * route in requires a forgery.
 *
 * The payload binds three things the verifier must not have to look up:
 *
 * - `r` the recording id — what may be read.
 * - `o` the organization id — WHO it belongs to. The lookup then runs inside
 *   `withTenantScope(o)`, so a token that named a real recording and a foreign organization
 *   returns nothing: the RLS policy, not this signature, is the last line.
 * - `e` the expiry, as epoch seconds.
 *
 * ## What it is NOT
 *
 * Not a session, not a capability that can be widened, and not a JWT. A JWT here would bring an
 * algorithm field, a library, and the `alg: none` family of mistakes, in exchange for structure
 * this payload does not need. The whole grammar is three keys and one MAC.
 *
 * ## Key management
 *
 * `CDR_RECORDING_URL_SECRET` mints and verifies; `CDR_RECORDING_URL_SECRET_PREVIOUS` verifies only.
 * Rotation is therefore: put the new key in the first variable, the old one in the second, deploy,
 * and drop the second after the TTL has elapsed — which is minutes, so rotation is same-day rather
 * than a migration. Nothing is ever minted with the previous key, so removing it revokes it.
 *
 * There is no default key and no unsigned fallback. Without a key configured the mint endpoint
 * answers `CDR_SIGNING_UNAVAILABLE` and the media route answers `CDR_LINK_INVALID`; a deployment
 * that has not decided on a key does not accidentally serve media to the world.
 */

const TOKEN_SEPARATOR = ".";
const MAX_TOKEN_LENGTH = 1024;

export interface RecordingTokenPayload {
	/** Recording id. */
	readonly r: string;
	/** Organization id — the scope the lookup will run under. */
	readonly o: string;
	/** Expiry, epoch SECONDS (not millis: it halves the token length and one second is plenty). */
	readonly e: number;
}

export type RecordingTokenFailure = "malformed" | "bad-signature" | "expired";

/**
 * Verification's answer.
 *
 * A flat record with both fields optional, rather than a discriminated union on `ok`. The union
 * would read better and it does not narrow here: `apps/api`'s tooling tsconfig still relaxes
 * `strictNullChecks` for its legacy files, and without it TypeScript will not narrow a union by a
 * boolean discriminant — the same collision `voicemail-consumer.service.ts` records when it
 * declares its envelope structurally instead of importing the inferred type. Flat costs one
 * `undefined` check at the call site and compiles under both projects.
 */
export interface RecordingTokenResult {
	readonly ok: boolean;
	readonly payload?: RecordingTokenPayload;
	readonly failure?: RecordingTokenFailure;
}

function sign(encodedPayload: string, key: string): string {
	return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

/**
 * Constant-time comparison of two base64url MACs.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal AND a
 * crash, so the lengths are checked first and a mismatch is simply "not equal". Two MACs of
 * different lengths cannot be the same MAC, so nothing is lost.
 */
function macsMatch(expected: string, actual: string): boolean {
	if (expected.length !== actual.length) {
		return false;
	}
	return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

export interface RecordingTokenKeys {
	/** The key new tokens are signed with. */
	readonly current: string;
	/** Accepted for verification during a rotation window. Never used to mint. */
	readonly previous?: string | undefined;
}

/** Mints a token for `payload`, valid until `payload.e`. */
export function mintRecordingToken(payload: RecordingTokenPayload, key: string): string {
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${encoded}${TOKEN_SEPARATOR}${sign(encoded, key)}`;
}

/**
 * Verifies a token and returns its payload.
 *
 * Signature FIRST, expiry second, and the order is deliberate: reporting "expired" for a token
 * whose MAC does not verify would tell a forger that their guess was structurally right, which is
 * one bit more than they should get. A token only learns it is expired once it has proved it was
 * ours.
 */
export function verifyRecordingToken(
	token: string,
	keys: RecordingTokenKeys,
): RecordingTokenResult {
	if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
		return { ok: false, failure: "malformed" };
	}
	const separator = token.lastIndexOf(TOKEN_SEPARATOR);
	if (separator <= 0 || separator === token.length - 1) {
		return { ok: false, failure: "malformed" };
	}
	const encoded = token.slice(0, separator);
	const provided = token.slice(separator + 1);

	const candidates = [keys.current, keys.previous].filter(
		(candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
	);
	// Every candidate is evaluated rather than short-circuiting on the first match, so the time
	// taken does not reveal WHICH key verified — during a rotation that is the difference between
	// leaking "you are still on the old key" and leaking nothing.
	let verified = false;
	for (const candidate of candidates) {
		if (macsMatch(sign(encoded, candidate), provided)) {
			verified = true;
		}
	}
	if (!verified) {
		return { ok: false, failure: "bad-signature" };
	}

	let payload: RecordingTokenPayload;
	try {
		const parsed: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof (parsed as RecordingTokenPayload).r !== "string" ||
			typeof (parsed as RecordingTokenPayload).o !== "string" ||
			typeof (parsed as RecordingTokenPayload).e !== "number"
		) {
			return { ok: false, failure: "malformed" };
		}
		payload = parsed as RecordingTokenPayload;
	} catch {
		return { ok: false, failure: "malformed" };
	}

	if (payload.e * 1000 <= Date.now()) {
		return { ok: false, failure: "expired" };
	}
	return { ok: true, payload };
}

/**
 * The URL a minted token is served from. One place, so the minter and the route cannot drift.
 *
 * ## Why the token is a QUERY parameter and not a path segment
 *
 * The first version of this put it in the path — query strings are the part of a URL that reverse
 * proxies, CDNs and access logs record by default, so keeping a bearer credential out of one is
 * worth something. `verify-cdr.ts` then returned `414 URI Too Long` for every media request, and
 * the reason is structural rather than incidental: Fastify caps a single route PARAMETER at 100
 * characters by default (`maxParamLength`), and a token carrying two UUIDs, an expiry and a
 * SHA-256 MAC is around 165. The path form therefore only works if every `NestFactory.create` in
 * the repository passes a raised `maxParamLength` — which is a deployment footgun sitting a long
 * way from the route it breaks, and which fails as a confusing 414 rather than as anything that
 * names the cause.
 *
 * A query parameter has no such cap, and it is also what every object store does: S3, GCS and
 * CloudFront presigned URLs all carry the signature in the query string. The log-exposure concern
 * is answered by the TTL instead — the credential is dead in minutes, which is shorter than the
 * retention of any log it lands in matters for.
 */
export function recordingMediaPath(token: string): string {
	return `/api/v1/recordings/media?token=${encodeURIComponent(token)}`;
}

/**
 * The object path for a key, resolved under `root` and proved to stay there.
 *
 * The signature already establishes that the CALLER is allowed to read this recording; this
 * establishes that the KEY, which came out of the database, addresses a file inside the recording
 * root and not `../../etc/passwd`. Two different threats, two different checks: a signed token for
 * a row whose `object_key` was somehow poisoned must still not escape the root.
 */
export function resolveRecordingObjectPath(root: string, objectKey: string): string | undefined {
	const normalizedRoot = resolvePath(root);
	const candidate = resolvePath(normalizedRoot, objectKey);
	if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}${pathSeparator}`)) {
		return undefined;
	}
	return candidate;
}
