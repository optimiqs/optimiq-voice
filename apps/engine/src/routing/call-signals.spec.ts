import { describe, expect, it } from "bun:test";
import { CallSignalBus, legSignalKey, recordingSignalKey } from "./call-signals";
import type { CallSignal } from "./call-signals";

describe("call signal keys", () => {
	it("namespaces legs and recordings so the two can never collide", () => {
		expect(legSignalKey("1754400000.1")).toBe("leg:1754400000.1");
		expect(recordingSignalKey("1754400000.1")).toBe("recording:1754400000.1");
		expect(legSignalKey("x")).not.toBe(recordingSignalKey("x"));
	});
});

describe("CallSignalBus", () => {
	it("delivers a signal to every waiter on the key", () => {
		const bus = new CallSignalBus();
		const seen: CallSignal[] = [];
		bus.watch("leg:a", (signal) => seen.push(signal));
		bus.watch("leg:a", (signal) => seen.push(signal));

		bus.emit("leg:a", { kind: "answered" });
		expect(seen).toEqual([{ kind: "answered" }, { kind: "answered" }]);
	});

	it("delivers nothing to another key", () => {
		const bus = new CallSignalBus();
		const seen: CallSignal[] = [];
		bus.watch("leg:a", (signal) => seen.push(signal));
		bus.emit("leg:b", { kind: "answered" });
		expect(seen).toEqual([]);
	});

	it("drops a signal nobody is waiting for, without complaint", () => {
		const bus = new CallSignalBus();
		expect(() => {
			bus.emit("leg:nobody", { kind: "answered" });
		}).not.toThrow();
	});

	it("reports whether a key is watched — how the orchestrator tells a B-leg from a new call", () => {
		const bus = new CallSignalBus();
		expect(bus.isWatched("leg:a")).toBe(false);
		const unwatch = bus.watch("leg:a", () => undefined);
		expect(bus.isWatched("leg:a")).toBe(true);
		unwatch();
		expect(bus.isWatched("leg:a")).toBe(false);
	});

	it("forgets the key once its last waiter unsubscribes", () => {
		const bus = new CallSignalBus();
		const first = bus.watch("leg:a", () => undefined);
		const second = bus.watch("leg:a", () => undefined);
		first();
		expect(bus.watchedKeyCount).toBe(1);
		second();
		expect(bus.watchedKeyCount).toBe(0);
	});

	it("tolerates an unsubscribe called more than once", () => {
		const bus = new CallSignalBus();
		const unwatch = bus.watch("leg:a", () => undefined);
		unwatch();
		expect(() => unwatch()).not.toThrow();
	});

	it("lets a listener unsubscribe itself mid-delivery without skipping the others", () => {
		// Every waiter does exactly this on a terminal signal, so it is the normal path.
		const bus = new CallSignalBus();
		const seen: string[] = [];
		const unwatch = bus.watch("leg:a", () => {
			seen.push("first");
			unwatch();
		});
		bus.watch("leg:a", () => seen.push("second"));

		bus.emit("leg:a", { kind: "ended", cause: "NORMAL_CLEARING", causeCode: 16 });
		expect(seen).toEqual(["first", "second"]);
	});

	it("ISOLATES a listener that throws, because the emitter is the ARI socket callback", () => {
		const bus = new CallSignalBus();
		const seen: string[] = [];
		bus.watch("leg:a", () => {
			throw new Error("waiter blew up");
		});
		bus.watch("leg:a", () => seen.push("second"));

		expect(() => {
			bus.emit("leg:a", { kind: "answered" });
		}).not.toThrow();
		expect(seen).toEqual(["second"]);
	});

	it("drops every waiter on clear, which is what lets a drain settle", () => {
		const bus = new CallSignalBus();
		bus.watch("leg:a", () => undefined);
		bus.watch("recording:r", () => undefined);
		bus.clear();
		expect(bus.watchedKeyCount).toBe(0);
	});
});
