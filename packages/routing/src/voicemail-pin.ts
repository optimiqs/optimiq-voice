/**
 * The voicemail PIN digest format — a contract this package defines because nobody else had.
 *
 * # Why it is defined here
 *
 * `pbx-db`'s `voicemail_box.pin_hash` is a nullable `text` column with no stated format, and the
 * API deliberately excludes PIN fields from every DTO ("a PIN is set through a dedicated endpoint
 * that hashes it") — an endpoint that does not exist yet. So the column has, so far, only ever
 * been read as `pinHash !== null`.
 *
 * The moment the compiler embeds that digest into an artifact and the engine verifies a caller's
 * digits against it, "whatever the writer happened to produce" stops being adequate: two processes
 * in different languages, released independently, have to agree on how to check a secret. That
 * agreement is a *format*, and a format with no owner is a format that drifts. `packages/routing`
 * owns it for the same reason it owns the artifact: it is the one place both sides already depend
 * on, and it depends on nothing itself.
 *
 * # The format
 *
 * ```
 * scrypt$N=<cost>,r=<block>,p=<parallelism>$<salt-base64>$<hash-base64>
 * ```
 *
 * - four `$`-separated fields, no whitespace, no trailing separator;
 * - the parameters are **in the string**, so raising the cost is a re-hash on next set rather than
 *   a migration and a flag day — a digest written under the old parameters keeps verifying;
 * - `salt` and `hash` are standard base64 (`+/=`), because that is what `Buffer.toString("base64")`
 *   and `btoa` both produce and neither side should have to reach for a URL-safe variant;
 * - the salt is at least {@link MIN_SALT_BYTES} bytes and the derived key exactly
 *   {@link DERIVED_KEY_BYTES}.
 *
 * scrypt rather than bcrypt or argon2 for one boring, decisive reason: `node:crypto.scrypt` is in
 * the standard library of every runtime in this repo (Node, Bun) and of the Go data plane
 * (`golang.org/x/crypto/scrypt`), so verification needs no dependency in a process that is on the
 * call path. It is also what better-auth — the only other password hasher in this monorepo — uses
 * internally, so the operational story is one algorithm rather than two.
 *
 * # What this module does and does not do
 *
 * It **parses and validates**. It does not hash and it does not verify: this package is a pure
 * compiler with no cryptographic dependency, and giving it one so that a *test* could hash a PIN
 * would put a KDF on the import graph of the resolver. Hashing belongs to the API's set-PIN
 * endpoint and verification to `apps/engine`, both of which reach for `node:crypto` directly and
 * read the parameters out of {@link parseVoicemailPinHash}.
 *
 * # What the compiler does with an unparseable digest
 *
 * It raises an `invalid-pin-hash` **warning** and omits the field, so the mailbox falls back to the
 * authentication it had before (the calling extension). Failing the compile was the other
 * candidate and was rejected: a malformed digest is a bug in whatever wrote it, and refusing to
 * compile would take the tenant's entire call routing down over one mailbox. Omitting it silently
 * was the third and is worse than either — a warning is surfaced in the admin UI by the same
 * machinery that surfaces every other diagnostic, so "the PIN you set is not being enforced" is
 * something an operator can see rather than something they discover.
 */

/** The only digest algorithm this contract admits. */
export const VOICEMAIL_PIN_HASH_SCHEME = "scrypt";

/** Length of the derived key, in bytes. */
export const DERIVED_KEY_BYTES = 32;

/** Shortest salt a digest may carry, in bytes. */
export const MIN_SALT_BYTES = 16;

/**
 * Parameters a *new* digest should be written with.
 *
 * Verification never consults these — it reads the parameters out of the digest — so raising them
 * costs nothing to anything already stored.
 */
export const DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS: VoicemailPinScryptParams = {
	cost: 16_384,
	blockSize: 8,
	parallelism: 1,
} as const;

/**
 * Bounds on the parameters a digest may declare.
 *
 * The per-parameter bounds are the cheap check. The one that actually protects the process is
 * {@link MAX_MEMORY_BYTES}, because scrypt's working set is `128 · N · r` and the two bounds
 * MULTIPLY: `N = 2²⁰` and `r = 32` are each individually plausible and together are a request for
 * four gigabytes of allocation, on the call path, triggered by a row somebody wrote.
 *
 * A digest outside any of these is refused at parse time, so it never reaches the KDF at all. 64
 * MiB is four times the working set of the recommended parameters, which leaves room to raise the
 * cost twice before anyone has to think about this number again.
 */
export const MAX_COST = 1 << 20;
export const MAX_BLOCK_SIZE = 32;
export const MAX_PARALLELISM = 16;
export const MAX_MEMORY_BYTES = 64 * 1024 * 1024;

/** scrypt's working set for a parameter set, in bytes: `128 · N · r`. */
export function scryptMemoryBytes(params: VoicemailPinScryptParams): number {
	return 128 * params.cost * params.blockSize;
}

export interface VoicemailPinScryptParams {
	/** scrypt's `N`. A power of two. */
	readonly cost: number;
	/** scrypt's `r`. */
	readonly blockSize: number;
	/** scrypt's `p`. */
	readonly parallelism: number;
}

/** A digest, taken apart. Base64 stays base64 — decoding is the verifier's business. */
export interface ParsedVoicemailPinHash {
	readonly scheme: typeof VOICEMAIL_PIN_HASH_SCHEME;
	readonly params: VoicemailPinScryptParams;
	readonly saltBase64: string;
	readonly hashBase64: string;
}

/** Why a string is not a digest. One code per rule, so a caller can say which. */
export type VoicemailPinHashIssue =
	| "empty"
	| "malformed"
	| "unknown-scheme"
	| "invalid-params"
	| "params-out-of-range"
	| "invalid-salt"
	| "invalid-hash";

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const PARAMS_PATTERN = /^N=(\d{1,10}),r=(\d{1,4}),p=(\d{1,4})$/;

/** Renders a digest from its parts. The API's set-PIN endpoint is the intended caller. */
export function formatVoicemailPinHash(
	params: VoicemailPinScryptParams,
	saltBase64: string,
	hashBase64: string,
): string {
	return [
		VOICEMAIL_PIN_HASH_SCHEME,
		`N=${params.cost},r=${params.blockSize},p=${params.parallelism}`,
		saltBase64,
		hashBase64,
	].join("$");
}

/**
 * The digest, or the reason it is not one. Never throws.
 *
 * The discriminated union is the shape callers want; the single-object {@link inspect} below it is
 * what the module is actually built on, and the split is not stylistic. `apps/api` compiles this
 * package's SOURCE under a `tsconfig.json` that still has `strictNullChecks` off for its inherited
 * files, and **without that flag TypeScript does not narrow a discriminated union on a boolean
 * literal** — `true` and `false` are both just `boolean`. So any code that reads `result.issue`
 * after checking `!result.ok` compiles in this package and fails in that one, including the code
 * in this file. Keeping the union at the boundary and the flat shape underneath means the union is
 * only ever *constructed*, never destructured, and the difference cannot bite anyone.
 */
export function readVoicemailPinHash(value: string | null | undefined):
	| { readonly ok: true; readonly hash: ParsedVoicemailPinHash }
	| {
			readonly ok: false;
			readonly issue: VoicemailPinHashIssue;
	  } {
	const result = inspect(value);
	return result.hash === undefined
		? { ok: false, issue: result.issue ?? "malformed" }
		: { ok: true, hash: result.hash };
}

/** The digest, or `undefined`. The shape most callers want. */
export function parseVoicemailPinHash(
	value: string | null | undefined,
): ParsedVoicemailPinHash | undefined {
	return inspect(value).hash;
}

export function isVoicemailPinHash(value: string | null | undefined): boolean {
	return inspect(value).hash !== undefined;
}

/** Why a string is not a digest, or `undefined` when it is one. */
export function voicemailPinHashIssue(
	value: string | null | undefined,
): VoicemailPinHashIssue | undefined {
	return inspect(value).issue;
}

/** Exactly one of the two fields is set. A flat shape, so no narrowing is ever required. */
interface Inspection {
	readonly hash?: ParsedVoicemailPinHash;
	readonly issue?: VoicemailPinHashIssue;
}

function inspect(value: string | null | undefined): Inspection {
	const trimmed = value?.trim() ?? "";
	if (trimmed === "") {
		return { issue: "empty" };
	}
	const fields = trimmed.split("$");
	if (fields.length !== 4) {
		return { issue: "malformed" };
	}
	const [scheme, rawParams, saltBase64, hashBase64] = fields as [string, string, string, string];
	if (scheme !== VOICEMAIL_PIN_HASH_SCHEME) {
		return { issue: "unknown-scheme" };
	}

	const matched = PARAMS_PATTERN.exec(rawParams);
	if (matched === null) {
		return { issue: "invalid-params" };
	}
	const cost = Number(matched[1]);
	const blockSize = Number(matched[2]);
	const parallelism = Number(matched[3]);
	if (
		!isPowerOfTwo(cost) ||
		cost < 2 ||
		cost > MAX_COST ||
		blockSize < 1 ||
		blockSize > MAX_BLOCK_SIZE ||
		parallelism < 1 ||
		parallelism > MAX_PARALLELISM ||
		// The bound that actually matters. See MAX_MEMORY_BYTES: the two above multiply.
		scryptMemoryBytes({ cost, blockSize, parallelism }) > MAX_MEMORY_BYTES
	) {
		return { issue: "params-out-of-range" };
	}

	if (!isBase64OfAtLeast(saltBase64, MIN_SALT_BYTES)) {
		return { issue: "invalid-salt" };
	}
	if (!isBase64OfExactly(hashBase64, DERIVED_KEY_BYTES)) {
		return { issue: "invalid-hash" };
	}

	return {
		hash: {
			scheme: VOICEMAIL_PIN_HASH_SCHEME,
			params: { cost, blockSize, parallelism },
			saltBase64,
			hashBase64,
		},
	};
}

function isPowerOfTwo(value: number): boolean {
	return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

/**
 * Byte length of a base64 string, without decoding it.
 *
 * Decoding would mean `atob`/`Buffer` and a throw on bad input; the length is arithmetic and the
 * character-class test is the same validation the decode would have performed.
 */
function base64ByteLength(value: string): number | undefined {
	if (value.length === 0 || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
		return undefined;
	}
	const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
	return (value.length / 4) * 3 - padding;
}

function isBase64OfAtLeast(value: string, bytes: number): boolean {
	const length = base64ByteLength(value);
	return length !== undefined && length >= bytes;
}

function isBase64OfExactly(value: string, bytes: number): boolean {
	return base64ByteLength(value) === bytes;
}
