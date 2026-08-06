/**
 * `Range: bytes=…` for the media routes.
 *
 * ## Why this exists at all
 *
 * Three routes in this API stream audio to an `<audio src>`: call recordings, voicemail messages,
 * and the PBX media library. All three used to answer `accept-ranges: none`, and the comment that
 * said so was honest about the consequence — "claiming range support would make a seeking audio
 * player ask for a range it never gets". The cost of that honesty is that **the scrub bar does not
 * work**. Chrome, Safari and Firefox all decide whether a media element is seekable from
 * `accept-ranges` and from whether a `Range` request comes back `206`; without both, dragging the
 * playhead either does nothing or restarts the file from zero. On a forty-minute call recording
 * that is the difference between a usable feature and a decorative one.
 *
 * So this module is the small, shared, dependency-free answer: parse one header, decide one of
 * three outcomes, and let each route turn that into a stream and a status line.
 *
 * ## Why a NEW top-level module rather than a helper next to one of the routes
 *
 * `recording-token.ts` set the precedent that a pure function module may be imported across area
 * boundaries — the PBX area imports the CDR area's token code rather than growing a second
 * implementation of an HMAC. The same argument applies here and points somewhere different: range
 * parsing belongs to neither area. Putting it under `cdr/` would make the media library import the
 * CDR area to answer a question about an HTTP header, and putting it under `pbx/shared/` would do
 * the mirror image. `src/media/` is the honest home: no Nest, no environment, no database, no
 * filesystem — just bytes-in, decision-out, which is also what makes it testable without a server.
 *
 * ## What is deliberately NOT supported
 *
 * **Multipart ranges.** RFC 9110 §14.1.1 allows `bytes=0-99,200-299`, and a server that receives
 * one may answer with a single range, with `multipart/byteranges`, or with the whole
 * representation. No browser media element has ever sent one — they send exactly one range while
 * seeking and no range at all on the initial load — so implementing `multipart/byteranges` would
 * be a MIME multipart encoder written for no caller. A multi-range request is answered here as
 * {@link RangeDecision} `"unsatisfiable"`, which the routes render as `416` with a
 * `content-range: bytes * / <size>` so the client learns the size and can retry with one range.
 *
 * That is a deliberate reading of a "MAY": refusing loudly beats silently returning the first
 * range as though it were the whole answer, which is the failure mode that produces truncated
 * audio nobody can explain.
 */

/** The three things a `Range` header can mean once the object's size is known. */
export type RangeDecision =
	/** No `Range` header, or one this server ignores. Answer `200` with the whole object. */
	| { readonly kind: "full" }
	/** One satisfiable range. Answer `206` with `content-range` and the sliced stream. */
	| {
			readonly kind: "partial";
			readonly start: number;
			readonly end: number;
			readonly length: number;
	  }
	/** A syntactically valid `bytes=` range that cannot be served. Answer `416`. */
	| { readonly kind: "unsatisfiable" };

/** `content-range` for a `206`. */
export function contentRangeHeader(start: number, end: number, sizeBytes: number): string {
	return `bytes ${String(start)}-${String(end)}/${String(sizeBytes)}`;
}

/** `content-range` for a `416`: the size, so a client can retry with a range that fits. */
export function unsatisfiedContentRangeHeader(sizeBytes: number): string {
	return `bytes */${String(sizeBytes)}`;
}

/**
 * Decides what a `Range` header means for an object of `sizeBytes`.
 *
 * The grammar implemented is RFC 9110 §14.1.1 `byte-ranges-specifier`, restricted to a single
 * `byte-range-spec` or a single `suffix-byte-range-spec`:
 *
 * ```text
 * bytes=<first>-<last>     both bounds, inclusive
 * bytes=<first>-           from <first> to the end
 * bytes=-<suffix-length>   the LAST <suffix-length> bytes
 * ```
 *
 * ### The rules, and why each one is where it is
 *
 * **An absent, empty or non-`bytes=` header is `"full"`, never an error.** §14.2 is explicit that a
 * server must ignore a `Range` it does not understand and answer the whole representation. A `416`
 * for `Range: seconds=0-10` would break a client that was allowed to ask.
 *
 * **A syntactically malformed `bytes=` header is also `"full"`.** `bytes=abc`, `bytes=`,
 * `bytes=5-3` (last before first) — the specifier is invalid, not unsatisfiable, and §14.1.1 says
 * an invalid ranges-specifier must be ignored. The distinction matters: `416` means "I understood
 * you and there is nothing there", and answering it for a typo tells the client something untrue.
 *
 * **A range that starts at or past the end IS `"unsatisfiable"`.** `bytes=500-` on a 100-byte
 * object is well-formed and asks for bytes that do not exist, which is exactly what §15.5.17 is
 * for. This is the one case a media element can actually provoke — by seeking in a file that was
 * replaced underneath it — and answering `200` with the whole file would hand the player audio it
 * would then render at the wrong offset.
 *
 * **A zero-byte object is `"unsatisfiable"` for every range.** There is no byte to return, and
 * `bytes 0-0/0` would be a lie about a file that has no byte zero. `"full"` still applies when
 * there is no `Range` at all, so an empty object still answers `200` with an empty body.
 *
 * **`end` is clamped to the last byte, `suffix` is clamped to the whole object.** `bytes=0-999999`
 * on a 100-byte object is satisfiable — §14.1.1 says a last-byte-pos greater than the current
 * length is taken to be the length minus one — and `bytes=-999999` means "the last 999999 bytes",
 * of which there are only 100. Both are what a player sends when it does not know the size yet.
 */
export function decideRange(header: string | undefined, sizeBytes: number): RangeDecision {
	const raw = header?.trim();
	if (raw === undefined || raw === "") {
		return { kind: "full" };
	}
	// Case-insensitive on the unit, because the header is a token and `Bytes=0-` is legal.
	if (!raw.toLowerCase().startsWith("bytes=")) {
		return { kind: "full" };
	}

	const spec = raw.slice("bytes=".length).trim();
	if (spec === "") {
		return { kind: "full" };
	}
	// A multi-range request. See the header: refused loudly rather than half-answered.
	if (spec.includes(",")) {
		return { kind: "unsatisfiable" };
	}

	const separator = spec.indexOf("-");
	if (separator === -1) {
		return { kind: "full" };
	}

	const firstText = spec.slice(0, separator).trim();
	const lastText = spec.slice(separator + 1).trim();

	// `bytes=-N` — the suffix form. N is a LENGTH, not an offset, and `bytes=-0` asks for the last
	// zero bytes, which is unsatisfiable rather than "the whole object".
	if (firstText === "") {
		const suffix = parseNonNegativeInteger(lastText);
		if (suffix === undefined) {
			return { kind: "full" };
		}
		if (suffix === 0 || sizeBytes === 0) {
			return { kind: "unsatisfiable" };
		}
		const start = Math.max(0, sizeBytes - suffix);
		return partial(start, sizeBytes - 1);
	}

	const start = parseNonNegativeInteger(firstText);
	if (start === undefined) {
		return { kind: "full" };
	}
	if (sizeBytes === 0 || start >= sizeBytes) {
		return { kind: "unsatisfiable" };
	}

	// `bytes=N-` — open-ended, to the last byte.
	if (lastText === "") {
		return partial(start, sizeBytes - 1);
	}

	const requestedEnd = parseNonNegativeInteger(lastText);
	if (requestedEnd === undefined) {
		return { kind: "full" };
	}
	if (requestedEnd < start) {
		// An invalid specifier, not an unsatisfiable one. Ignored, per §14.1.1.
		return { kind: "full" };
	}
	return partial(start, Math.min(requestedEnd, sizeBytes - 1));
}

function partial(start: number, end: number): RangeDecision {
	return { kind: "partial", start, end, length: end - start + 1 };
}

/**
 * A decimal integer with no sign, no whitespace and no exponent, or `undefined`.
 *
 * Hand-rolled rather than `Number.parseInt`, which accepts `"12abc"` as `12` and `"0x10"` as `16`.
 * A `Range` header is attacker-reachable on a route with no session (both media routes are
 * `@PublicRoute()`), so "what did the client actually write" has to be answered exactly.
 */
function parseNonNegativeInteger(text: string): number | undefined {
	if (!/^\d+$/u.test(text)) {
		return undefined;
	}
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : undefined;
}
