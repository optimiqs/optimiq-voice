# @optimiq-voice/effect-runtime

The seam between Effect and NestJS. Effect never leaks above a service: repositories and
domain logic return `Effect`, services call `runEffect` once, controllers see plain values or
`HttpException`s.

## Exports

```ts
import {
	ModuleEffectRuntime,
	makeTestModuleRuntime,
	makeRuntime,
	runEffect,
	sharedMemoMap,
	Observability,
} from "@optimiq-voice/effect-runtime";
import { testDouble } from "@optimiq-voice/effect-runtime/testing";
```

| Export                  | Role                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| `sharedMemoMap`         | One process-wide `Layer.MemoMap` — shared layers build exactly once.         |
| `makeRuntime`           | Lazy `ManagedRuntime` over `Layer.provideMerge(layer, Observability.layer)`. |
| `ModuleEffectRuntime`   | Per-Nest-module runtime; `OnApplicationShutdown` disposes its layers.        |
| `makeTestModuleRuntime` | Same, with an isolated MemoMap so tests never share layer instances.         |
| `runEffect`             | The single Effect→HTTP boundary.                                             |
| `Observability`         | Layer routing Effect logs into `@optimiq-voice/logging`.                     |

## Wiring a feature module

```ts
export const CALLS_RUNTIME = Symbol("CALLS_RUNTIME");

@Module({
	providers: [
		{
			provide: CALLS_RUNTIME,
			useFactory: () => new ModuleEffectRuntime(CallsRepository, CallsRepositoryLayer),
		},
		CallsService,
	],
})
export class CallsModule {}
```

The service injects the runtime and calls `runEffect(this.runtime, (repo) => repo.answer(id))`.
Run **one** `runEffect` per request path — combine parallel work inside the Effect with
`Effect.all` and bounded concurrency, never `Promise.all` over several `runEffect` calls.

## Failure mapping

`runEffect` inspects the `Exit`:

1. success → the value.
2. failure that is already an `HttpException` → rethrown as-is.
3. failure exposing `toHttpException()` → mapped (this is what `Schema.TaggedErrorClass`
   domain errors implement).
4. anything else → the full cause is logged against an opaque `err_xxxxxxxx` reference and the
   caller gets a 500 carrying only that reference.

Naming: `…Failure` for Effect-channel errors in apps, `…Exception` at the HTTP boundary,
`…Error` inside packages. Never throw a Nest exception below the service boundary.

## Rules

- Import Effect through granular paths (`effect/Layer`, `effect/Effect`). The barrel import
  `from "effect"` is banned — it defeats tree-shaking and slows type-checking.
- Consult `pnpm exec effect-solutions list|show <topic>` before writing new Effect code.

## Commands

```sh
pnpm --filter @optimiq-voice/effect-runtime build
pnpm --filter @optimiq-voice/effect-runtime typecheck
bun test packages/effect-runtime/src
```
