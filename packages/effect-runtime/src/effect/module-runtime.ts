import * as Layer from "effect/Layer";
import { makeRuntime } from "./runtime";
import type { OnApplicationShutdown } from "@nestjs/common";
import type * as Context from "effect/Context";
import type { Effect, RunOptions } from "effect/Effect";
import type { Exit } from "effect/Exit";
import type { Fiber } from "effect/Fiber";

/**
 * The per-Nest-module Effect runtime. Provided under a Symbol token by the owning feature
 * module and disposed when Nest shuts down, so layer finalizers run exactly once.
 */
export class ModuleEffectRuntime<I, S, E> implements OnApplicationShutdown {
	private readonly runtime: ReturnType<typeof makeRuntime<I, S, E>>;

	constructor(service: Context.Service<I, S>, layer: Layer.Layer<I, E>, memoMap?: Layer.MemoMap) {
		this.runtime = makeRuntime(service, layer, memoMap);
	}

	get runPromise(): <A, Err>(
		fn: (svc: S) => Effect<A, Err, I>,
		options?: RunOptions,
	) => Promise<A> {
		return this.runtime.runPromise;
	}

	get runPromiseExit(): <A, Err>(
		fn: (svc: S) => Effect<A, Err, I>,
		options?: RunOptions,
	) => Promise<Exit<A, E | Err>> {
		return this.runtime.runPromiseExit;
	}

	get runFork(): <A, Err>(fn: (svc: S) => Effect<A, Err, I>) => Fiber<A, E | Err> {
		return this.runtime.runFork;
	}

	dispose(): Promise<void> {
		return this.runtime.dispose();
	}

	onApplicationShutdown(): Promise<void> {
		return this.dispose();
	}
}

/** An isolated runtime with its own MemoMap so one test can never reuse another's layers. */
export function makeTestModuleRuntime<I, S, E>(
	service: Context.Service<I, S>,
	layer: Layer.Layer<I, E>,
): ModuleEffectRuntime<I, S, E> {
	return new ModuleEffectRuntime(service, layer, Layer.makeMemoMapUnsafe());
}
