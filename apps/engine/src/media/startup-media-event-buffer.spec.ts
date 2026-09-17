import { describe, expect, it } from "bun:test";
import { StartupMediaEventBuffer } from "./startup-media-event-buffer";
import type { MediaEvent } from "./media-event";

function event(channelId: string): MediaEvent {
	return { type: "leg-left", channelId };
}

/** Lets every already-queued microtask and timer callback run. */
async function tick(): Promise<void> {
	await new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
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
		await buffer.settle();
		expect(calls).toEqual(["live"]);
	});

	it("serializes live events per leg, so a leg's end cannot overtake its own state change", async () => {
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
			if (calls.length === 1) {
				await firstBlocked;
			}
			calls.push(`end:${mediaEvent.channelId}`);
		});

		await buffer.replay();
		buffer.push(event("same"));
		buffer.push(event("same"));
		await tick();
		// The second event for the same leg has not started while the first is still in flight.
		expect(calls).toEqual(["start:same"]);

		releaseFirst?.();
		await buffer.settle();
		expect(calls).toEqual(["start:same", "end:same", "start:same", "end:same"]);
	});

	it("does not make two different legs wait on each other", async () => {
		const calls: string[] = [];
		let releaseOne: (() => void) | undefined;
		const oneBlocked = new Promise<void>((resolve) => {
			releaseOne = resolve;
		});
		const buffer = new StartupMediaEventBuffer(async (mediaEvent) => {
			if (mediaEvent.type !== "leg-left") {
				return;
			}
			calls.push(`start:${mediaEvent.channelId}`);
			if (mediaEvent.channelId === "one") {
				await oneBlocked;
			}
			calls.push(`end:${mediaEvent.channelId}`);
		});

		await buffer.replay();
		buffer.push(event("one"));
		buffer.push(event("two"));
		await tick();
		expect(calls).toContain("end:two");

		releaseOne?.();
		await buffer.settle();
		expect(calls).toContain("end:one");
	});

	it("keeps dispatching a leg's later events after one of them throws", async () => {
		const calls: string[] = [];
		const buffer = new StartupMediaEventBuffer(async (mediaEvent) => {
			if (mediaEvent.type !== "leg-left") {
				return;
			}
			calls.push(mediaEvent.channelId);
			if (calls.length === 1) {
				throw new Error("dispatch failed");
			}
		});

		await buffer.replay();
		buffer.push(event("leg"));
		buffer.push(event("leg"));
		await buffer.settle();
		expect(calls).toEqual(["leg", "leg"]);
	});
});
