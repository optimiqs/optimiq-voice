import { describe, expect, it } from "bun:test";
import {
	DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS,
	DERIVED_KEY_BYTES,
	formatVoicemailPinHash,
	isVoicemailPinHash,
	MAX_COST,
	MAX_MEMORY_BYTES,
	MIN_SALT_BYTES,
	parseVoicemailPinHash,
	readVoicemailPinHash,
	scryptMemoryBytes,
	VOICEMAIL_PIN_HASH_SCHEME,
} from "./voicemail-pin";

/**
 * The PIN digest format is a cross-process, cross-language contract: the API writes it, the
 * compiler validates it, the engine verifies a caller's digits against it. These specs are what
 * make "we all agree on the format" a checked claim rather than a shared assumption, so they pin
 * the accepted string exactly and pin every reason a string is rejected.
 */

/** Base64 of exactly `bytes` bytes. `A` decodes to zeroes, which is all these specs need. */
function base64Of(bytes: number): string {
	const groups = Math.ceil(bytes / 3);
	const padding = groups * 3 - bytes;
	return "A".repeat(groups * 4 - padding) + "=".repeat(padding);
}

const SALT = base64Of(MIN_SALT_BYTES);
const KEY = base64Of(DERIVED_KEY_BYTES);
const VALID = formatVoicemailPinHash(DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS, SALT, KEY);

describe("voicemail pin hash — the format", () => {
	it("renders the four documented fields", () => {
		expect(VALID).toBe(`scrypt$N=16384,r=8,p=1$${SALT}$${KEY}`);
	});

	it("names scrypt as the only scheme", () => {
		expect(VOICEMAIL_PIN_HASH_SCHEME).toBe("scrypt");
	});

	it("round-trips its own output", () => {
		const parsed = parseVoicemailPinHash(VALID);
		expect(parsed?.params).toEqual(DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS);
		expect(parsed?.saltBase64).toBe(SALT);
		expect(parsed?.hashBase64).toBe(KEY);
	});

	it("carries the parameters in the string, so a cost rise is not a migration", () => {
		const legacy = formatVoicemailPinHash({ cost: 1024, blockSize: 8, parallelism: 1 }, SALT, KEY);
		expect(parseVoicemailPinHash(legacy)?.params.cost).toBe(1024);
	});

	it("tolerates surrounding whitespace, which is how a digest survives a copy-paste", () => {
		expect(isVoicemailPinHash(`  ${VALID}\n`)).toBe(true);
	});
});

describe("voicemail pin hash — rejection", () => {
	const cases: readonly (readonly [string, string | null | undefined, string])[] = [
		["null", null, "empty"],
		["undefined", undefined, "empty"],
		["an empty string", "", "empty"],
		["whitespace only", "   ", "empty"],
		["too few fields", `scrypt$N=16384,r=8,p=1$${SALT}`, "malformed"],
		["too many fields", `${VALID}$extra`, "malformed"],
		["another algorithm", `bcrypt$N=16384,r=8,p=1$${SALT}$${KEY}`, "unknown-scheme"],
		["a bare bcrypt digest", "$2b$12$abcdefghijklmnopqrstuv", "unknown-scheme"],
		["unlabelled parameters", `scrypt$16384,8,1$${SALT}$${KEY}`, "invalid-params"],
		["reordered parameters", `scrypt$r=8,N=16384,p=1$${SALT}$${KEY}`, "invalid-params"],
		["a non-power-of-two cost", `scrypt$N=16000,r=8,p=1$${SALT}$${KEY}`, "params-out-of-range"],
		[
			"a cost above the bound",
			`scrypt$N=${MAX_COST * 2},r=8,p=1$${SALT}$${KEY}`,
			"params-out-of-range",
		],
		["a zero block size", `scrypt$N=16384,r=0,p=1$${SALT}$${KEY}`, "params-out-of-range"],
		["a short salt", `scrypt$N=16384,r=8,p=1$${base64Of(8)}$${KEY}`, "invalid-salt"],
		["a non-base64 salt", `scrypt$N=16384,r=8,p=1$not*base64!!$${KEY}`, "invalid-salt"],
		["a short key", `scrypt$N=16384,r=8,p=1$${SALT}$${base64Of(16)}`, "invalid-hash"],
		["a long key", `scrypt$N=16384,r=8,p=1$${SALT}$${base64Of(64)}`, "invalid-hash"],
	];

	for (const [label, value, issue] of cases) {
		it(`rejects ${label} as ${issue}`, () => {
			const result = readVoicemailPinHash(value);
			expect(result.ok).toBe(false);
			expect(result.ok ? undefined : result.issue).toBe(issue as never);
			expect(parseVoicemailPinHash(value)).toBeUndefined();
			expect(isVoicemailPinHash(value)).toBe(false);
		});
	}

	it("refuses a memory-cost bomb before it can reach a KDF", () => {
		// The point of the bound: `N=2^30, r=32` is a request for gigabytes of allocation, and on the
		// call path the difference between "refused at parse" and "refused by the allocator" is the
		// difference between one failed login and one dead engine process.
		expect(isVoicemailPinHash(`scrypt$N=1073741824,r=32,p=16$${SALT}$${KEY}`)).toBe(false);
	});

	it("refuses parameters that are each in range but multiply out of it", () => {
		// The bound that actually protects the process. `N = 2^20` is at the per-parameter ceiling and
		// `r = 32` is at its own, and together they are 4 GiB — so checking them one at a time would
		// wave through exactly the digest the ceilings exist to stop.
		expect(scryptMemoryBytes({ cost: MAX_COST, blockSize: 32, parallelism: 1 })).toBeGreaterThan(
			MAX_MEMORY_BYTES,
		);
		expect(isVoicemailPinHash(`scrypt$N=${MAX_COST},r=32,p=1$${SALT}$${KEY}`)).toBe(false);
	});

	it("admits parameters four times the recommended working set", () => {
		// Headroom to raise the cost twice before anyone has to revisit MAX_MEMORY_BYTES.
		expect(isVoicemailPinHash(`scrypt$N=65536,r=8,p=1$${SALT}$${KEY}`)).toBe(true);
	});

	it("sizes the recommended parameters well inside the bound", () => {
		expect(scryptMemoryBytes(DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS)).toBe(16 * 1024 * 1024);
		expect(scryptMemoryBytes(DEFAULT_VOICEMAIL_PIN_SCRYPT_PARAMS)).toBeLessThan(MAX_MEMORY_BYTES);
	});
});
