# FIX — AREA = tenant-prompts (the "Remaining gap" of FIX-default-media)

**No tenant-uploaded prompt had ever been playable on `mediad`.** A plan node names a prompt by its
`prompt` ROW id; the audio lives at `prompts/<org>/<fileId>.wav` under a _different_ UUID minted at
upload; the engine rendered the row id as `sound:<rowId>` and `mediad` answered
`no such prompt: sound:01a0871d-a0d8-…`. Voicemail greetings never had the problem because they
already travel as `object://<objectKey>`.

Closed end to end by giving the artifact the same kind of table `phrases` uses, so a plan node keeps
its bare `…PromptId` and the reader looks the file up. That is the shape the brief asked for
("mirror phrases exactly"), and it is why nothing about the 12 prompt-id emit sites changed: they
already emit the id, and the id is now resolvable.

## The four steps

### 1. `packages/routing` — the table

| File                     | Change                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/snapshot.ts`        | `PromptInput.objectKey?: string \| null` (additive; `undefined` = a loader that does not project the column, `null` = a row with no file — a phrase).                                                                    |
| `src/artifact.ts`        | New optional `RoutingArtifact.prompts?: Record<promptId, mediaRef>`, documented beside `phrases` and read the same way.                                                                                                  |
| `src/compile.ts`         | New `compilePrompts()` — every enabled non-phrase prompt with a key becomes `object://<objectKey>` through the existing `objectMediaRef` helper. Emitted next to `phrases` and omitted entirely when empty.              |
| `src/compile.ts`         | `promptRef()` now also warns `dangling-prompt` when the named prompt EXISTS but has no audio behind it (`objectKey === null`) — the diagnostic half of the same gap. `undefined` stays silent (rollout rule, unchanged). |
| `src/fixtures.ts`        | `aPrompt()` carries a default object key.                                                                                                                                                                                |
| `src/embeddings.spec.ts` | New `describe` — 6 cases: the mapping, phrases excluded, table omitted when empty, the new warning, silence for an unprojecting loader, and the snapshot hash changing on re-upload.                                     |

**No artifact-version bump.** `parseRoutingArtifact` is a shape check over required fields only, and
an old reader ignores an unknown key exactly as it ignores `phrases` — the same
old-reader-compatibility argument `artifact.ts` already makes for a new TABLE.

### 2. `apps/api` — the snapshot loader

`src/pbx/routing/snapshot-loader.ts`: projects `prompt.object_key` (one column) and its comment now
says four columns and why the key is one of them. No test: the loader has no harness in
`apps/api/test` (it needs a live database); it is covered live in §4.

### 3. `apps/engine` — resolution

| File                                        | Change                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routing/media-refs.ts`                 | `MediaRefSettings.prompts: Record<promptId, mediaRef>` (default `{}`). New `promptMedia()`: the table first, the deployment-wide prefix second. Both `resolveMediaRef`'s promptId branch and `translateMediaRef`'s `prompt://` branch go through it. A table entry that cannot be rendered (an `object://` key with no mount) falls THROUGH to the prefix, so the refusal and its reason stay byte-identical to the pre-table behaviour. |
| `src/routing/media-refs.spec.ts`            | 4 new cases: table hit, `prompt://` through the table, a bare stem falling back (`unavailable` is never a row), and the unmounted deployment.                                                                                                                                                                                                                                                                                            |
| `src/calls/channel-orchestrator.service.ts` | `walkerFor`'s `extra` gains `prompts`, passed to `walkerSettings` and into `mediaRefs`. Both call sites pass `artifact.prompts` — they already read `artifact.settings.realm` on the same line, for the same reason (per-org, in hand, no database handle).                                                                                                                                                                              |

The brief scoped me to `media-refs.ts` in the engine, but nothing else can POPULATE the table: the
settings are assembled in `walkerSettings` and only the two `walkerFor` callers hold the artifact.
The diff there is four lines plus a doc block, in the shape of the `realm` argument immediately
above it; `plan-walker.ts` and call-control were not touched.

## 4. Live proof (standing stack, STACK.md)

1. Uploaded a prompt as the smoke-org owner: `POST /api/v1/prompts` (multipart) →
   row `01a08755-8e5f-70bc-8a88-13eb202444f0`, object
   `prompts/01a08708-4cd4-76b9-b56d-d26ebf326b0a/01a08755-8e5a-7013-9816-cde18e6a86a9.wav`,
   `durationMs: 6000`. **Two different UUIDs — the bug, reproduced.**
2. **api restarted** 18:02 UTC (logged in STACK.md), `/api/auth/ok` 200 in ~1 s.
3. Attached it to IVR `4020`'s greeting (`PATCH /api/v1/ivr-menus/01a0870c-dab2-…`). Compile-on-write
   returned no `dangling-prompt`.
4. Artifact in the `routing-cache` KV (`01a08708-….artifact`, rev 1704, `compiledAt`
   `2026-09-09T18:02:32.686Z`) now carries:

   ```json
   "prompts": {
     "01a0871d-a0b5-74aa-9ebc-31b44206b4f3": "object://moh/01a08708-…/01a0871d-a088-…/01a0871d-a0b4-….wav",
     "01a0871d-a0d8-723e-b1cb-d0f86a1f35ef": "object://prompts/01a08708-…/01a0871d-a0d6-7108-a449-4d6de2b9a4ac.wav",
     "01a08755-8e5f-70bc-8a88-13eb202444f0": "object://prompts/01a08708-…/01a08755-8e5a-7013-9816-cde18e6a86a9.wav"
   }
   ```

   The middle row is **the exact id `mediad` had been refusing**, now paired with its file.

5. **engine restarted** 18:03 UTC (`dist` rebuilt; no agent listed the engine as in use in STACK.md,
   and both `typecheck` and the 1600-test engine suite were green on the tree at build time).
6. Called `4020` with the browser softphone harness (`<scratchpad>/e2e/routing/ivr.mjs ivr`).
   `mediad`, on every call since the restart:

   ```
   13:03:35  playback started  sessionId:01a08756-eaf6-…  frames:300
   13:06:00  playback started  sessionId:01a08759-1f35-…  frames:300
   13:09:53  playback started  sessionId:01a0875c-b03a-…  frames:300   (+ a second at 13:09:55)
   13:13:19  playback started  sessionId:01a0875f-d2f8-…  frames:300
   13:17:16  playback started  sessionId:01a08763-739b-…  frames:300   (×6 — the re-prompt loop)
   ```

   **17 playbacks across the full run, and not one `refusing a playback` line after
   13:03:35-05:00.** 300 frames = 6.00 s = the uploaded prompt's `durationMs` exactly. The same
   call at 12:50 produced
   `refusing a playback media:["sound:01a0871d-a0d8-…"] error:"audio: no such prompt"`.

   The harness also measured the CALLER's side, which is what `FIX-default-media` could not confirm
   for MOH: `greeting={"packets":22,"energy":0.048}` on three of the probes — non-zero inbound audio
   energy in the browser leg, so the frames do not just leave `mediad`, they arrive.

   **What still fails, and is NOT mine.** Every DTMF branch probe timed out: no phone rang for
   option 2 / option 4 / direct dial / invalid 7, and the digit presses themselves failed with
   `locator.click: Timeout 10000ms exceeded` on the softphone keypad. That is E2E-routing scenario
   14 still failing for a reason downstream of the greeting — the audio now plays, the menu still
   does not route — and it needs its own investigation (the harness's own `IVR PASS option 2` line
   is a harness bug: it computes `ok` as `typeof rang === "string"` and `rang` is the FAIL _string_).
   I am claiming only what the media plane shows: the prompt is playable and audible.

   Session `01a08763-739b-…` replays a 300-frame prompt six times at ~6 s intervals: that is the IVR
   re-prompting on invalid input and timeout, so `invalidPromptId` and `timeoutPromptId` — still
   pointed at the routing agent's `RT Greeting` row `01a0871d-a0d8-…`, **the exact id mediad used to
   refuse** — now resolve as well. The four 400-frame `moh:` playbacks in the same window are the
   queue's hold music from `FIX-default-media`, unaffected.

## Verification

| Check                                                                         | Result                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/routing run typecheck`                          | pass                                                          |
| `pnpm --filter @optimiq-voice/routing run test`                               | **871 pass, 0 fail**, 2047 expect() calls, 22 files (was 865) |
| `pnpm --filter @optimiq-voice/api run typecheck`                              | pass (both tsconfigs)                                         |
| `pnpm --filter @optimiq-voice/api run test`                                   | **1261 passing, 0 failing**                                   |
| `pnpm --filter @optimiq-voice/engine run typecheck`                           | pass                                                          |
| `pnpm --filter @optimiq-voice/engine run test`                                | **1600 pass, 6 skip, 0 fail**, 3587 expect() calls, 72 files  |
| `pnpm exec turbo run build --filter=...@optimiq-voice/routing`                | **16/16 successful** (web included)                           |
| `pnpm exec oxlint` / `oxfmt` (routing, engine routing+calls, api pbx/routing) | clean, exit 0                                                 |

No Go touched. No git state touched. Services restarted: **api** (18:02) and **engine** (18:03),
both logged in STACK.md.

## Cross-area needed

- None outstanding for this gap. The one thing left is operational, inherited from
  `FIX-default-media`: the MOH publish pass still runs at API boot only, so hold music uploaded
  mid-day needs an API restart. Prompts do NOT have that problem any more — compile-on-write
  republishes the artifact and the table with it.

## Notes for the reviewer

- Restarting the engine also activated the plan-walker/orchestrator changes other agents had left in
  the tree (the verb-failure notes, the IVR gather retry, the caller-hangup abort). They were green
  on typecheck and tests at build time, but they went live with this restart rather than one of
  their own.
- `snapshotHash` now moves when a prompt is re-uploaded under a new key, which is correct: the audio
  behind a routing decision changed, and the cached artifact must not survive it.
