import { isDtmfDigit } from "@optimiq-voice/telephony";
import type { DtmfCollection, DtmfDigit, GatherVerb } from "@optimiq-voice/telephony";

/**
 * The digit-collection state machine behind the `gather` verb.
 *
 * Pure and synchronous on purpose. Collection has six ways to end (`packages/telephony`'s
 * `DTMF_COLLECTION_END_REASONS`) and the interesting ones are all timing-related, so they are
 * modelled as METHOD CALLS (`timeout()`, `interDigitTimeout()`) rather than as timers. The async
 * driver owns the clock; this owns the rules. That is what makes "the caller pressed nothing" and
 * "the caller pressed # immediately" testable without a `setTimeout`.
 *
 * The regex is what makes variable-length input work: an extension that may be 3 or 4 digits ends
 * on a match, not on a terminator the caller has to know about.
 */

export type AccumulatorStep =
	| { readonly done: false }
	| { readonly done: true; readonly collection: DtmfCollection };

export class DtmfAccumulator {
	private readonly digits: DtmfDigit[] = [];
	private readonly terminators: ReadonlySet<string>;
	private readonly pattern: RegExp | undefined;
	private finished: DtmfCollection | undefined;

	constructor(private readonly verb: Pick<GatherVerb, "maxDigits" | "terminators" | "regex">) {
		this.terminators = new Set<string>(verb.terminators);
		this.pattern = compilePattern(verb.regex);
	}

	/** Digits collected so far. Never includes a terminator. */
	get collected(): readonly DtmfDigit[] {
		return this.digits;
	}

	/** Whether collection has already ended. Further pushes are ignored. */
	get isDone(): boolean {
		return this.finished !== undefined;
	}

	/** The outcome, once collection has ended. */
	get result(): DtmfCollection | undefined {
		return this.finished;
	}

	/**
	 * Offers one digit.
	 *
	 * A character that is not a DTMF symbol is ignored rather than treated as an error: the
	 * source is a media server's inband detector, and a spurious character must not fail a call.
	 */
	push(raw: string): AccumulatorStep {
		if (this.finished !== undefined) {
			return { done: true, collection: this.finished };
		}

		const digit = raw.toUpperCase();
		if (!isDtmfDigit(digit)) {
			return { done: false };
		}

		if (this.terminators.has(digit)) {
			return this.finish({
				digits: [...this.digits],
				endReason: "terminator",
				terminator: digit,
			});
		}

		this.digits.push(digit);

		// The pattern is checked before the digit cap so a 3-digit extension ends on the match
		// rather than waiting for a 4th digit that will never come.
		if (this.pattern?.test(this.digits.join("")) === true) {
			return this.finish({ digits: [...this.digits], endReason: "pattern" });
		}

		if (this.digits.length >= this.verb.maxDigits) {
			return this.finish({ digits: [...this.digits], endReason: "max-digits" });
		}

		return { done: false };
	}

	/** The overall timeout elapsed. Ends as `timeout` before the first digit, otherwise as a gap. */
	timeout(): DtmfCollection {
		return this.end(this.digits.length === 0 ? "timeout" : "inter-digit-timeout");
	}

	/** The gap between digits elapsed. */
	interDigitTimeout(): DtmfCollection {
		return this.end("inter-digit-timeout");
	}

	/** The engine abandoned the collection (a transfer, a new verb, a drain). */
	cancel(): DtmfCollection {
		return this.end("cancelled");
	}

	/** The channel went away mid-collection. */
	hangup(): DtmfCollection {
		return this.end("hangup");
	}

	private end(endReason: DtmfCollection["endReason"]): DtmfCollection {
		if (this.finished !== undefined) {
			return this.finished;
		}
		return this.finish({ digits: [...this.digits], endReason }).collection;
	}

	private finish(collection: DtmfCollection): {
		readonly done: true;
		readonly collection: DtmfCollection;
	} {
		this.finished = collection;
		return { done: true, collection };
	}
}

/**
 * Compiles a gather pattern, anchored at both ends.
 *
 * Anchoring is not cosmetic: an unanchored `\d{3}` matches the first three digits of a 10-digit
 * number, so an IVR would accept a partial input as complete. An invalid pattern is treated as no
 * pattern — a malformed route definition must not make every call to that IVR fail.
 */
function compilePattern(regex: string | undefined): RegExp | undefined {
	if (regex === undefined || regex === "") {
		return undefined;
	}
	const anchored = `^(?:${regex})$`;
	try {
		return new RegExp(anchored, "u");
	} catch {
		return undefined;
	}
}
