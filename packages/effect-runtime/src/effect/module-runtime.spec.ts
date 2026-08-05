import { describe, expect, it } from "bun:test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeTestModuleRuntime, ModuleEffectRuntime } from "./module-runtime";

interface RegistryInterface {
	readonly ping: () => Effect.Effect<"pong">;
}

class Registry extends Context.Service<Registry, RegistryInterface>()(
	"@optimiq-voice/test/Registry",
) {}

function makeCountingLayer(counters: { acquired: number; released: number }) {
	return Layer.effect(
		Registry,
		Effect.acquireRelease(
			Effect.sync(() => {
				counters.acquired += 1;
				return Registry.of({ ping: () => Effect.succeed("pong" as const) });
			}),
			() =>
				Effect.sync(() => {
					counters.released += 1;
				}),
		),
	);
}

describe("ModuleEffectRuntime lifecycle", () => {
	it("does not acquire an unused layer during application shutdown", async () => {
		const counters = { acquired: 0, released: 0 };
		const runtime = makeTestModuleRuntime(Registry, makeCountingLayer(counters));

		await runtime.onApplicationShutdown();

		expect(counters.acquired).toBe(0);
		expect(counters.released).toBe(0);
	});

	it("releases an initialized layer once when Nest shuts down", async () => {
		const counters = { acquired: 0, released: 0 };
		const runtime = makeTestModuleRuntime(Registry, makeCountingLayer(counters));

		expect(await runtime.runPromise((service) => service.ping())).toBe("pong");
		await runtime.onApplicationShutdown();
		await runtime.onApplicationShutdown();

		expect(counters.acquired).toBe(1);
		expect(counters.released).toBe(1);
		expect(() => runtime.runPromise((service) => service.ping())).toThrow(
			"Effect runtime has been disposed",
		);
	});

	it("makes every concurrent shutdown caller await the same layer release", async () => {
		const counters = { acquired: 0, released: 0 };
		const runtime = makeTestModuleRuntime(Registry, makeCountingLayer(counters));

		await runtime.runPromise((service) => service.ping());
		await Promise.all([
			runtime.onApplicationShutdown(),
			runtime.onApplicationShutdown(),
			runtime.onApplicationShutdown(),
		]);

		expect(counters.released).toBe(1);
	});
});

describe("test runtime isolation", () => {
	it("gives each test runtime its own MemoMap", async () => {
		const counters = { acquired: 0, released: 0 };
		const layer = makeCountingLayer(counters);

		const first = makeTestModuleRuntime(Registry, layer);
		const second = makeTestModuleRuntime(Registry, layer);

		await first.runPromise((service) => service.ping());
		await second.runPromise((service) => service.ping());

		// Isolated MemoMaps mean the shared layer is built once per runtime, not once per process.
		expect(counters.acquired).toBe(2);

		await first.onApplicationShutdown();
		await second.onApplicationShutdown();
		expect(counters.released).toBe(2);
	});

	it("shares the process-wide MemoMap when none is supplied", async () => {
		const counters = { acquired: 0, released: 0 };
		const layer = makeCountingLayer(counters);

		const first = new ModuleEffectRuntime(Registry, layer);
		const second = new ModuleEffectRuntime(Registry, layer);

		await first.runPromise((service) => service.ping());
		await second.runPromise((service) => service.ping());

		expect(counters.acquired).toBe(1);

		await first.onApplicationShutdown();
		await second.onApplicationShutdown();
	});
});
