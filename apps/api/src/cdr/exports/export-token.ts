import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The signed, expiring handle that reaches an export's bytes.
 *
 * ## Why this is not `recording-token.ts` with a wider type
 *
 * The obvious move is to generalize the recording token — same HMAC, same base64url envelope, same
 * expiry check — by adding a `kind` field and switching on it. It was drafted and dropped for one
 * reason that is not about taste: **every recording link already minted would stop verifying.** The
 * payload is signed, so adding a required field changes what a valid payload looks like, and the
 * tokens in flight (they live for five minutes, but they also live in the `<audio src>` of every
 * open browser tab and in every voicemail notification email sent in that window) carry the old
 * shape. A migration for a five-minute credential is possible; it is not free, and it buys a
 * shared forty lines.
 *
 * What it would have bought is also less than it looks, because the duplication is not the risky
 * part. The risky part is the *verification order*, and that is identical here on purpose:
 * length-bounded, then split, then HMAC over every candidate key without short-circuiting, then
 * parse, then expiry. Two copies of a rule stated once in prose are safer than one copy behind a
 * discriminator that a future caller can pass the wrong value for.
 *
 * ## The payload shape IS the type discriminator
 *
 * A recording token's payload is `{ r, o, e }`; an export token's is `{ x, o, e }`. Neither
 * verifier accepts the other's shape, so a recording link cannot open an export and an export link
 * cannot open a recording — even though both are signed with the same secret. That property comes
 * from the shape check rather than from a separate key, which is deliberate: one secret means one
 * rotation, and `CDR_RECORDING_URL_SECRET_PREVIOUS` keeps working for both during it.
 *
 * ## What the token does NOT do
 *
 * It does not authorize. It NAMES a job and an organization, and the service still reads the row
 * under `withTenantScope` before it opens anything — so a job that has been deleted, or whose file
 * has been purged, answers 404/410 for the lifetime of a token that is otherwise perfectly valid.
 * That is the same reason `object-store.factory.ts` gives for not redirecting recording downloads
 * to a presigned URL: the check has to happen on this side of the link.
 */

const TOKEN_SEPARATOR = ".";

/**
 * The longest token this will look at before rejecting it.
 *
 * A real one is around 170 characters. The bound exists so an oversized query string is refused
 * before any HMAC work happens, which is what stops a trivially cheap request from buying an
 * arbitrarily expensive one.
 */
const MAX_TOKEN_LENGTH = 512;

/** `{ x: exportJobId, o: organizationId, e: expiryEpochSeconds }`. */
export interface ExportTokenPayload {
	readonly x: string;
	readonly o: string;
	readonly e: number;
}

export interface ExportTokenKeys {
	readonly current: string;
	/** Verify-only, so a secret rotation does not invalidate links already handed out. */
	readonly previous?: string | undefined;
}

export type ExportTokenFailure = "malformed" | "bad-signature" | "expired";

/**
 * A flat result rather than a discriminated union, which is a concession to this app's tsconfig.
 *
 * `{ ok: true; payload } | { ok: false; failure }` is the shape this wants to be, and it does not
 * narrow here: `apps/api`'s tooling tsconfig still relaxes `strictNullChecks` for its legacy
 * surface, and without it TypeScript will not discriminate a union on a boolean literal. The
 * caller would have to cast, which is strictly worse than the optional fields.
 *
 * `recording-token.ts` reached the same shape by the same route and its callers check
 * `!result.ok || result.payload === undefined` for exactly this reason. Kept identical so the two
 * verifiers are read the same way.
 */
export interface ExportTokenResult {
	readonly ok: boolean;
	readonly payload?: ExportTokenPayload;
	readonly failure?: ExportTokenFailure;
}

function sign(encodedPayload: string, key: string): string {
	return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

function macsMatch(expected: string, actual: string): boolean {
	if (expected.length !== actual.length) {
		return false;
	}
	return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(actual, "utf8"));
}

export function mintExportToken(payload: ExportTokenPayload, key: string): string {
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	return `${encoded}${TOKEN_SEPARATOR}${sign(encoded, key)}`;
}

export function verifyExportToken(token: string, keys: ExportTokenKeys): ExportTokenResult {
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
	// taken does not reveal WHICH key verified — the same rule `recording-token.ts` follows, and
	// the reason both loops look wasteful and are not.
	let verified = false;
	for (const candidate of candidates) {
		if (macsMatch(sign(encoded, candidate), provided)) {
			verified = true;
		}
	}
	if (!verified) {
		return { ok: false, failure: "bad-signature" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
	} catch {
		// A signature that verified over bytes that are not our JSON means the secret is shared with
		// something else that mints tokens. Refusing is the only safe reading.
		return { ok: false, failure: "malformed" };
	}
	if (!isExportTokenPayload(parsed)) {
		return { ok: false, failure: "malformed" };
	}
	if (parsed.e * 1000 <= Date.now()) {
		return { ok: false, failure: "expired" };
	}
	return { ok: true, payload: parsed };
}

/** The shape check that also keeps a recording token (`{ r, o, e }`) from opening an export. */
function isExportTokenPayload(value: unknown): value is ExportTokenPayload {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const candidate = value as Partial<ExportTokenPayload>;
	return (
		typeof candidate.x === "string" &&
		candidate.x.length > 0 &&
		typeof candidate.o === "string" &&
		candidate.o.length > 0 &&
		typeof candidate.e === "number" &&
		Number.isFinite(candidate.e)
	);
}

/**
 * Where the token is redeemed.
 *
 * A QUERY parameter, not a path segment, for the reason `recordingMediaPath` records: Fastify caps
 * a single route parameter at 100 characters by default and a token is longer than that, so the
 * path form fails as a 404 that looks like a routing bug rather than as a length error.
 */
export function exportMediaPath(token: string): string {
	return `/api/v1/cdr/exports/media?token=${encodeURIComponent(token)}`;
}

/** `exports/<organizationId>/<jobId>.csv` — tenant-prefixed, derived, never client-supplied. */
export function exportObjectKey(organizationId: string, jobId: string): string {
	return `exports/${organizationId}/${jobId}.csv`;
}
