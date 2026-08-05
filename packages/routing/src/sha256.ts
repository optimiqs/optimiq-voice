/**
 * SHA-256 over UTF-8 text, in ~90 lines of arithmetic.
 *
 * # Why not `node:crypto`
 *
 * Because this package has no platform. It is imported by the API (Node), by the engine (Node),
 * by tests (Bun) and — the moment there is one — by anything that wants to explain a routing
 * decision without standing up a runtime. `@optimiq-voice/telephony` set the precedent: a pure
 * domain package imports nothing, not even a builtin. Ninety lines of well-known arithmetic pinned
 * by the NIST test vectors is a smaller liability than a platform assumption baked into the cache
 * key of every tenant's routing.
 *
 * This is **not** used for authentication or secrecy — it is content addressing. What is required
 * of it is that two different snapshots essentially never collide and that the same snapshot always
 * produces the same digest on every runtime, forever. SHA-256 supplies both, and the digest is
 * stable across releases in a way that a hand-rolled FNV would not be if it ever needed widening.
 *
 * Implementation follows FIPS 180-4 §6.2 directly. Pinned by `sha256.spec.ts` against the
 * published vectors, including the multi-block and length-boundary cases where an off-by-one in
 * the padding would otherwise hide.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes (FIPS 180-4). */
const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** First 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL_STATE = new Uint32Array([
	0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
	return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

const HEX = "0123456789abcdef";

function toHex(state: Uint32Array): string {
	let out = "";
	for (const word of state) {
		for (let shift = 28; shift >= 0; shift -= 4) {
			out += HEX[(word >>> shift) & 0xf];
		}
	}
	return out;
}

/** Pads per FIPS 180-4 §5.1.1: a `0x80` byte, zeroes, then the 64-bit big-endian bit length. */
function padded(bytes: Uint8Array): Uint8Array {
	const bitLength = bytes.length * 8;
	const blockCount = Math.floor((bytes.length + 8) / 64) + 1;
	const out = new Uint8Array(blockCount * 64);
	out.set(bytes);
	out[bytes.length] = 0x80;
	// Lengths beyond 2^53 bits are not reachable from a JS string, so a 53-bit write is exact.
	const high = Math.floor(bitLength / 0x1_0000_0000);
	const low = bitLength >>> 0;
	const tail = out.length - 8;
	out[tail] = (high >>> 24) & 0xff;
	out[tail + 1] = (high >>> 16) & 0xff;
	out[tail + 2] = (high >>> 8) & 0xff;
	out[tail + 3] = high & 0xff;
	out[tail + 4] = (low >>> 24) & 0xff;
	out[tail + 5] = (low >>> 16) & 0xff;
	out[tail + 6] = (low >>> 8) & 0xff;
	out[tail + 7] = low & 0xff;
	return out;
}

/** SHA-256 of raw bytes, as 64 lower-case hex characters. */
export function sha256Bytes(bytes: Uint8Array): string {
	const state = Uint32Array.from(INITIAL_STATE);
	const block = padded(bytes);
	const w = new Uint32Array(64);

	for (let offset = 0; offset < block.length; offset += 64) {
		for (let index = 0; index < 16; index += 1) {
			const at = offset + index * 4;
			w[index] =
				(((block[at] as number) << 24) |
					((block[at + 1] as number) << 16) |
					((block[at + 2] as number) << 8) |
					(block[at + 3] as number)) >>>
				0;
		}
		for (let index = 16; index < 64; index += 1) {
			const previous15 = w[index - 15] as number;
			const previous2 = w[index - 2] as number;
			const s0 = (rotr(previous15, 7) ^ rotr(previous15, 18) ^ (previous15 >>> 3)) >>> 0;
			const s1 = (rotr(previous2, 17) ^ rotr(previous2, 19) ^ (previous2 >>> 10)) >>> 0;
			w[index] = ((w[index - 16] as number) + s0 + (w[index - 7] as number) + s1) >>> 0;
		}

		let a = state[0] as number;
		let b = state[1] as number;
		let c = state[2] as number;
		let d = state[3] as number;
		let e = state[4] as number;
		let f = state[5] as number;
		let g = state[6] as number;
		let h = state[7] as number;

		for (let index = 0; index < 64; index += 1) {
			const sigma1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
			const choose = ((e & f) ^ (~e & g)) >>> 0;
			const temp1 = (h + sigma1 + choose + (K[index] as number) + (w[index] as number)) >>> 0;
			const sigma0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
			const majority = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
			const temp2 = (sigma0 + majority) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		state[0] = ((state[0] as number) + a) >>> 0;
		state[1] = ((state[1] as number) + b) >>> 0;
		state[2] = ((state[2] as number) + c) >>> 0;
		state[3] = ((state[3] as number) + d) >>> 0;
		state[4] = ((state[4] as number) + e) >>> 0;
		state[5] = ((state[5] as number) + f) >>> 0;
		state[6] = ((state[6] as number) + g) >>> 0;
		state[7] = ((state[7] as number) + h) >>> 0;
	}

	return toHex(state);
}

/** UTF-8 encodes `text` without assuming a platform `TextEncoder`. */
export function utf8Bytes(text: string): Uint8Array {
	const out: number[] = [];
	for (let index = 0; index < text.length; index += 1) {
		let code = text.codePointAt(index) as number;
		if (code > 0xffff) {
			// A surrogate pair contributes one code point; skip its low half.
			index += 1;
		}
		if (code < 0x80) {
			out.push(code);
		} else if (code < 0x800) {
			out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
		} else if (code < 0x1_0000) {
			out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
		} else {
			out.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			);
			code = 0;
		}
	}
	return Uint8Array.from(out);
}

/** SHA-256 of a UTF-8 string, as 64 lower-case hex characters. */
export function sha256(text: string): string {
	return sha256Bytes(utf8Bytes(text));
}
