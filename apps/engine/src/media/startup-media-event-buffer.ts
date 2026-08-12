import type { MediaEvent } from "./media-event";

export const STARTUP_MEDIA_EVENT_BUFFER_LIMIT = 4_096;

export class StartupMediaEventBufferOverflowError extends Error {
	constructor(readonly limit: number) {
		super(`startup media event buffer exceeded its ${String(limit)} event limit`);
		this.name = "StartupMediaEventBufferOverflowError";
	}
}

/** Buffers source events during recovery, then drains them in arrival order before going live. */
export class StartupMediaEventBuffer {
	private readonly events: MediaEvent[] = [];
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
			void this.dispatch(event);
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
