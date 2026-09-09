import type { MediaEvent } from "./media-event";

export const STARTUP_MEDIA_EVENT_BUFFER_LIMIT = 4_096;

export class StartupMediaEventBufferOverflowError extends Error {
	constructor(readonly limit: number) {
		super(`startup media event buffer exceeded its ${String(limit)} event limit`);
		this.name = "StartupMediaEventBufferOverflowError";
	}
}

/**
 * The key a live event is ORDERED by.
 *
 * Per leg, because that is the scope the ordering guarantee is about: a `dialog.answered` from
 * `sipd` and a `session.ended` from `mediad` for the same leg must not interleave, while two
 * unrelated calls have no reason to wait on each other. The members that name no channel are
 * keyed by what they do name, so a slow recording callback cannot stall a call either.
 */
function orderingKeyOf(event: MediaEvent): string {
	switch (event.type) {
		case "leg-arrived":
			return event.channel.id;
		case "recording-started":
		case "recording-finished":
		case "recording-failed":
			return `recording:${event.recordingName}`;
		case "trunk-endpoint-status":
			return `endpoint:${event.endpoint}`;
		default:
			return event.channelId;
	}
}

/**
 * Buffers source events during recovery, then drains them in arrival order before going live.
 *
 * Going live does NOT mean going unordered. During recovery the drain awaits each dispatch, and the
 * same guarantee has to hold afterwards or the whole point of the buffer is lost the moment it
 * empties: `onCallStateChanged` for a leg awaits KV round trips and an event publish, and an
 * `onLegEnded` for that same leg starting underneath it deletes the channel key the first call is
 * still about to write. So live events are chained per leg — the shape
 * `JetStreamService.serializeChannelOperation` already uses for KV writes.
 */
export class StartupMediaEventBuffer {
	private readonly events: MediaEvent[] = [];
	private readonly chains = new Map<string, Promise<void>>();
	private replaying: Promise<void> | undefined;
	private direct = false;
	private overflow: StartupMediaEventBufferOverflowError | undefined;

	constructor(
		private readonly dispatch: (event: MediaEvent) => Promise<void>,
		private readonly limit = STARTUP_MEDIA_EVENT_BUFFER_LIMIT,
	) {
		if (!Number.isInteger(limit) || limit < 1) {
			throw new RangeError("the startup media event buffer limit must be a positive integer");
		}
	}

	get bufferedCount(): number {
		return this.events.length;
	}

	push(event: MediaEvent): void {
		if (this.direct) {
			this.dispatchInOrder(event);
			return;
		}
		if (this.events.length === this.limit) {
			this.overflow ??= new StartupMediaEventBufferOverflowError(this.limit);
			return;
		}
		this.events.push(event);
	}

	async replay(): Promise<void> {
		this.throwIfOverflowed();
		if (this.direct) {
			return;
		}
		if (this.replaying !== undefined) {
			await this.replaying;
			return;
		}

		const replaying = this.drain();
		this.replaying = replaying;
		try {
			await replaying;
		} finally {
			if (this.replaying === replaying) {
				this.replaying = undefined;
			}
		}
	}

	/** Settles once every live dispatch chained so far has finished. */
	async settle(): Promise<void> {
		while (this.chains.size > 0) {
			await Promise.all(
				[...this.chains.values()].map(async (chain) => await chain.catch(() => undefined)),
			);
		}
	}

	private dispatchInOrder(event: MediaEvent): void {
		const key = orderingKeyOf(event);
		const previous = this.chains.get(key) ?? Promise.resolve();
		// The `catch` is on the PREDECESSOR, not on the chain entry: one leg's failed dispatch must
		// not cancel the next event for that leg, which is usually the one that ends it.
		const next = previous
			.catch(() => undefined)
			.then(async () => {
				await this.dispatch(event);
			});
		this.chains.set(key, next);
		void next
			.catch(() => undefined)
			.then(() => {
				if (this.chains.get(key) === next) {
					this.chains.delete(key);
				}
			});
	}

	private async drain(): Promise<void> {
		while (this.events.length > 0) {
			this.throwIfOverflowed();
			const event = this.events.shift();
			if (event !== undefined) {
				await this.dispatch(event);
			}
		}
		this.throwIfOverflowed();
		this.direct = true;
	}

	private throwIfOverflowed(): void {
		if (this.overflow !== undefined) {
			throw this.overflow;
		}
	}
}
