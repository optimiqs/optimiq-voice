import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { sharedMemoMap } from "./memo-map";
import { Observability } from "./observability";
import type * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { Exit } from "effect/Exit";
import type { Fiber } from "effect/Fiber";

/**
 * Lazily builds a ManagedRuntime for one service layer, merged with the observability layer.
 * The runtime is only constructed on first use so an unused module never acquires resources,
 * and using it after `dispose()` is a hard error rather than a silent re-acquisition.
 */
export function makeRuntime<I, S, E>(
	service: Context.Service<I, S>,
	layer: Layer.Layer<I, E>,
	memoMap: Layer.MemoMap = sharedMemoMap,
): {
	runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => A;
	runPromise: <A, Err>(
		fn: (svc: S) => Effect.Effect<A, Err, I>,
		options?: Effect.RunOptions,
	) => Promise<A>;
	runPromiseExit: <A, Err>(
		fn: (svc: S) => Effect.Effect<A, Err, I>,
		options?: Effect.RunOptions,
	) => Promise<Exit<A, E | Err>>;
	runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>) => Fiber<A, E | Err>;
	dispose: () => Promise<void>;
} {
	let rt: ManagedRuntime.ManagedRuntime<I, E> | undefined;
	let isDisposed = false;
	let disposePromise: Promise<void> | undefined;

	const getRuntime = () => {
		if (isDisposed) {
			throw new Error("Effect runtime has been disposed");
		}
		if (rt === undefined) {
			rt = ManagedRuntime.make(Layer.provideMerge(layer, Observability.layer), { memoMap });
		}
		return rt;
	};

	const dispose = (): Promise<void> => {
		if (disposePromise !== undefined) {
			return disposePromise;
		}
		isDisposed = true;
		const currentRuntime = rt;
		rt = undefined;
		if (currentRuntime === undefined) {
			disposePromise = Promise.resolve();
			return disposePromise;
		}
		disposePromise = currentRuntime.dispose();
		return disposePromise;
	};

	return {
		runSync: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>): A =>
			getRuntime().runSync(service.use(fn)),
		runPromise: <A, Err>(
			fn: (svc: S) => Effect.Effect<A, Err, I>,
			options?: Effect.RunOptions,
		): Promise<A> => getRuntime().runPromise(service.use(fn), options),
		runPromiseExit: <A, Err>(
			fn: (svc: S) => Effect.Effect<A, Err, I>,
			options?: Effect.RunOptions,
		): Promise<Exit<A, E | Err>> => getRuntime().runPromiseExit(service.use(fn), options),
		runFork: <A, Err>(fn: (svc: S) => Effect.Effect<A, Err, I>): Fiber<A, E | Err> =>
			getRuntime().runFork(service.use(fn)),
		dispose,
	};
}

export type Runtime<I, S, E> = ReturnType<typeof makeRuntime<I, S, E>>;
