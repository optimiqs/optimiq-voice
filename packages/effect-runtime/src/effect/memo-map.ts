import * as Layer from "effect/Layer";

/**
 * One process-wide MemoMap so shared layers (database pools, NATS connections, ARI clients)
 * are constructed exactly once no matter how many module runtimes reference them.
 */
export const sharedMemoMap = Layer.makeMemoMapUnsafe();
