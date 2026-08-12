import { describe, expect, it } from "bun:test";
import { StartupMediaEventBuffer } from "./startup-media-event-buffer";
import type { MediaEvent } from "./media-event";

function event(channelId: string): MediaEvent {
	return { type: "leg-left", channelId };
}

describe("StartupMediaEventBuffer", () => {
	it("replays serially in arrival order, including events received during replay", async () => {
		const calls: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const buffer = new StartupMediaEventBuffer(async (mediaEvent) => {
			if (mediaEvent.type !== "leg-left") {
				return;
			}
			calls.push(`start:${mediaEvent.channelId}`);
			if (mediaEvent.channelId === "one") {
				await firstBlocked;
			}
			calls.push(`end:${mediaEvent.channelId}`);
		});
		buffer.push(event("one"));
		buffer.push(event("two"));

		const replay = buffer.replay();
		await Promise.resolve();
		buffer.push(event("three"));
		expect(calls).toEqual(["start:one"]);

		releaseFirst?.();
		await replay;
		expect(calls).toEqual([
			"start:one",
			"end:one",
			"start:two",
			"end:two",
			"start:three",
			"end:three",
		]);
	});

	it("fails startup when events exceed the buffer bound", async () => {
		const calls: string[] = [];
		const buffer = new StartupMediaEventBuffer(async (mediaEvent) => {
			if (mediaEvent.type === "leg-left") {
				calls.push(mediaEvent.channelId);
			}
		}, 2);
		buffer.push(event("one"));
		buffer.push(event("two"));
		buffer.push(event("three"));

		expect(buffer.bufferedCount).toBe(2);
		await expect(buffer.replay()).rejects.toThrow(
			"startup media event buffer exceeded its 2 event limit",
		);
		expect(calls).toEqual([]);
	});

	it("dispatches directly after replay completes", async () => {
		const calls: string[] = [];
		const buffer = new StartupMediaEventBuffer(async (mediaEvent) => {
			if (mediaEvent.type === "leg-left") {
				calls.push(mediaEvent.channelId);
			}
		});

		await buffer.replay();
		buffer.push(event("live"));
		expect(calls).toEqual(["live"]);
	});
});
