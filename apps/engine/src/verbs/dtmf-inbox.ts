import { DEFAULT_DTMF_DURATION_MS } from "@optimiq-voice/telephony";
import { DtmfAccumulator } from "./dtmf-accumulator";
import type { DtmfCollection, DtmfEvent, GatherVerb } from "@optimiq-voice/telephony";

/**
 * The per-channel DTMF queue, and the async driver that turns it into a `gather` result.
 *
 * `packages/telephony` describes the model — "one ordered queue per channel, drained into whatever
 * is collecting" — and this is that queue. The rules live in the pure {@link DtmfAccumulator}; the
 * only thing here is the clock and the plumbing between the ARI event handler (which pushes) and
 * the verb executor (which awaits).
 *
 * ## Digits that arrive before the gather does
 *
 * They are BUFFERED, not dropped. A caller who knows the menu types their extension over the
 * greeting, and every one of those digits arrives before the IVR has asked for anything. Throwing
 * them away is the difference between a system that experienced users can type ahead in and one
 * they cannot. The buffer is bounded so a stuck channel cannot grow it without limit.
 */
const MAX_BUFFERED_DIGITS = 64;

export class DtmfInbox {
	private readonly buffer: DtmfEvent[] = [];
	private active: ActiveCollection | undefined;

	/** Digits waiting for the next collection to consume. */
	get bufferedCount(): number {
		return this.buffer.length;
	}

	/** Whether a collection is currently running. */
	get isCollecting(): boolean {
		return this.active !== undefined;
	}

	/** Offers a digit from the media server. */
	push(event: DtmfEvent): void {
		const active = this.active;
		if (active !== undefined) {
			active.offer(event.digit);
			return;
		}
		if (this.buffer.length >= MAX_BUFFERED_DIGITS) {
			this.buffer.shift();
		}
		this.buffer.push(event);
	}

	/**
	 * Runs one collection.
	 *
	 * Buffered digits are replayed first, so type-ahead works and a collection whose answer is
	 * already in the buffer resolves without waiting for a timer at all.
	 *
	 * @throws {Error} when a collection is already running on this channel — two concurrent
	 * gathers on one leg is an application bug, and silently interleaving their digits would make
	 * it undiagnosable.
	 */
	collect(
		verb: Pick<
			GatherVerb,
			"maxDigits" | "terminators" | "regex" | "timeoutMs" | "interDigitTimeoutMs"
		>,
	): Promise<DtmfCollection> {
		if (this.active !== undefined) {
			throw new Error("A DTMF collection is already running on this channel.");
		}

		return new Promise<DtmfCollection>((resolve) => {
			const accumulator = new DtmfAccumulator(verb);
			let overallTimer: ReturnType<typeof setTimeout> | undefined;
			let interDigitTimer: ReturnType<typeof setTimeout> | undefined;

			const settle = (collection: DtmfCollection): void => {
				if (overallTimer !== undefined) {
					clearTimeout(overallTimer);
				}
				if (interDigitTimer !== undefined) {
					clearTimeout(interDigitTimer);
				}
				this.active = undefined;
				resolve(collection);
			};

			const armInterDigit = (): void => {
				if (interDigitTimer !== undefined) {
					clearTimeout(interDigitTimer);
				}
				interDigitTimer = setTimeout(() => {
					settle(accumulator.interDigitTimeout());
				}, verb.interDigitTimeoutMs);
				interDigitTimer.unref?.();
			};

			const offer = (digit: string): void => {
				const step = accumulator.push(digit);
				if (step.done) {
					settle(step.collection);
					return;
				}
				// A digit landed but did not finish the collection: the overall timeout is no longer
				// the relevant deadline, the gap between digits is.
				if (overallTimer !== undefined) {
					clearTimeout(overallTimer);
					overallTimer = undefined;
				}
				armInterDigit();
			};

			this.active = {
				offer,
				cancel: () => {
					settle(accumulator.cancel());
				},
				hangup: () => {
					settle(accumulator.hangup());
				},
			};

			// Replay first: a buffered digit may end the collection before any timer is armed.
			const buffered = this.buffer.splice(0, this.buffer.length);
			for (const event of buffered) {
				if (this.active === undefined) {
					return;
				}
				offer(event.digit);
			}

			if (this.active === undefined) {
				return;
			}

			if (interDigitTimer === undefined) {
				overallTimer = setTimeout(() => {
					settle(accumulator.timeout());
				}, verb.timeoutMs);
				overallTimer.unref?.();
			}
		});
	}

	/** Abandons a running collection (a transfer, a new verb, a drain). */
	cancel(): void {
		this.active?.cancel();
	}

	/** Ends a running collection because the channel went away. */
	hangup(): void {
		this.active?.hangup();
		this.buffer.length = 0;
	}
}

interface ActiveCollection {
	readonly offer: (digit: string) => void;
	readonly cancel: () => void;
	readonly hangup: () => void;
}

/** Builds a `DtmfEvent` from what a media adapter reports. */
export function dtmfEventFrom(input: {
	readonly digit: string;
	readonly durationMs?: number;
	readonly source?: DtmfEvent["source"];
}): DtmfEvent {
	return {
		digit: input.digit as DtmfEvent["digit"],
		durationMs: input.durationMs ?? DEFAULT_DTMF_DURATION_MS,
		// RFC 2833 is the transport for essentially all SIP DTMF; a media server that knows better
		// says so, and this is the honest default when it does not.
		source: input.source ?? "rfc2833",
	};
}
