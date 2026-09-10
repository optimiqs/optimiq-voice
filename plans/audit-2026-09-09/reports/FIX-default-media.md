# FIX — AREA = default-media (E2E-routing P1-3, "nothing plays")

## What was actually wrong

`mediad`'s prompt library **is** the object store (`MEDIAD_SOUNDS_DIR` = `PBX_MEDIA_OBJECT_ROOT` =
`ENGINE_MEDIA_OBJECT_ROOT`, one directory on the local stack). Three separate classes of media
reference reach it, and **none of the three had a file to land on**:

| ref the engine sends                                         | mediad resolves it to    | who was supposed to write that file                                  | reality |
| ------------------------------------------------------------ | ------------------------ | -------------------------------------------------------------------- | ------- |
| `moh:default` (queue with no class)                          | `<root>/moh/default.wav` | nobody                                                               | absent  |
| `moh:<class name>` (queue with a class)                      | `<root>/moh/<name>.wav`  | nobody — the upload path writes `moh/<org>/<classId>/<promptId>.wav` | absent  |
| `sound:<stem>` (`unavailable`, `digits/7`, `vm-password`, …) | `<root>/<stem>.wav`      | Asterisk's core sound package — which `mediad` does not have         | absent  |

On Asterisk all three resolved, so the gap was invisible until the `mediad` cutover. That is the
whole of P1-3, and it is also why P1-3's second half ("IVR greetings never play") was mis-attributed
to P0-1: see **Remaining gap** below, which is a fourth case I found and could not close inside this
area.

---

## (a) A fresh deployment now has the audio — FIXED

**`apps/api/src/pbx/media/system-media.ts`** (new) — the catalogue and the renderer.

- 34 assets: `moh/default`, the 23 bare stems `DEFAULT_PLAN_WALKER_SETTINGS` and
  `config/engine-env.ts` name (`unavailable`, `activated`, `de-activated`, `demo-echotest`,
  `vm-password`, `vm-incorrect`, `vm-rec-name`, `priv-callerintros`, `agent-pass`,
  `auth-incorrect`, `auth-thankyou`, `screen-callee-options`, `conf-*` ×6, `dir-*` ×5), and
  `digits/0`–`digits/9` (which every queue-position announcement and mailbox readback goes through).
- Rendered as **deterministic 8 kHz mono 16-bit PCM RIFF/WAVE** — `SAFE_SAMPLE_RATE_HZ` /
  `SAFE_CHANNELS`, the one row of `media-audio.ts`'s format table that is true of every deployment,
  the only container `mediad` reads, and G.711's rate with no resample. There is no vendored prompt
  pack and no TTS renderer on this platform, so the assets are **tones, not speech**: a rising pair
  for "activated", a falling pair for "de-activated", ten rising digits, an eight-second four-note
  hold loop. Every failure these prompts guard is a BRANCH, and a branch is only testable if the
  caller can hear it was taken; silence tells nobody anything. Edges are ramped 4 ms so G.711 does
  not click at each segment, and the hold loop starts and ends near zero so the loop point is silent.
- Byte-for-byte reproducible, which is what makes the checksum below meaningful.

**`apps/api/src/pbx/media/system-media.service.ts`** (new) — `OnModuleInit`, gated by the new
`PBX_ENSURE_SYSTEM_MEDIA` (default true, modelled on `PBX_ENSURE_KV_BUCKETS`).

Chosen over a migration because the files belong to the object store, and a migration runner has no
`ObjectStore`, no root and no S3 mirror; this process has all three wired already. The rule that
matters: a key holding bytes that are **not** something this seeder wrote is left alone and
reported, so an operator who drops a real voice-over at `unavailable.wav` keeps it across every
restart. A manifest (`system-media.json`) records our checksum per key so "ours, older" is
distinguishable from "theirs". Failure is logged per key and never fatal — an API that refuses to
boot takes down the admin UI, which is where the mount would be fixed.

**Tenant classes, `apps/api/src/pbx/media/moh-library.ts` (new) + the publish pass in the service.**
`mediad` addresses a class by bare name with no config file to consult, so each declarable
library class's audio is published a second time at `moh/<name>.wav`. This is the same delivery
`generate-musiconhold.ts` argues for at length (the API cannot reach the media plane's control port;
the mount is the interface). The gate is `renderMusicOnHoldConf(...).declared`, **reused rather than
re-decided**, so the two planes never disagree about which class a name means: a name two orgs claim
is published for neither, `default` can never be claimed by a tenant, and disabled / stream /
empty classes are skipped with the reason in the log.

**Local stack.** Both `up.sh` and `reset-db.sh` get the seed for free — it is an API boot step and
both start/restart the api last. A comment in `reset-db.sh` records the dependency, because the
`rm -rf "$STACK_HOME/objects"/*` immediately above it is what makes the restart load-bearing.

## (b) Compile-on-write names missing media — FIXED

- `packages/routing/src/diagnostics.ts`: new code **`dangling-prompt`** (warning).
- `packages/routing/src/compile.ts`: new `promptRef(promptId, subject, path)`, applied at all 12
  sites that emit a prompt id — IVR (greeting / short greeting / invalid / timeout), queue (greeting
  / announce / agent whisper), ring group (confirm / ringback), dial-by-name (greeting / invalid),
  PIN set (prompt / failure).
- The id is still emitted: dropping it would silently change the plan's SHAPE (an IVR with no
  greeting gathers digits immediately). The point is to report the gap, not route around it.
- Warning, not error, and silent when the loader supplies no `prompts` collection at all — the same
  rollout rule `mohClassName` follows, and for the same reason.

It surfaces through the existing path with no new plumbing: `POST /api/v1/routing/compile` →
`RoutingService.compile` → `warnings` (`toWireDiagnostic`).

## (c) The refusal reaches the call notes — FIXED

The reason was being thrown away in one place: `ChannelOrchestrator.execute` collapsed every typed
failure to `undefined` with a log line, so a walk could only say "the verb did not run".

- `apps/engine/src/calls/channel-orchestrator.service.ts`: `execute` now returns
  `{ ok } | { failed: string }`; new `verbFailureDetail()` turns the typed failure into one sentence
  (`MediaCommandFailure.detail` verbatim for a media refusal). `walkerFor` collapses it back to
  `undefined` for the walk — a failed verb is still fatal — while keeping the sentence in a closure.
- `apps/engine/src/routing/plan-walker.ts`: new optional `verbFailure` dependency and a
  `noteVerbFailure(what)` helper; notes added on `playbackNode`, `playPrompt` and the IVR gather.
- **Behavioural fix found on the way.** A `gather` is a playback AND a collection in one verb, and
  the executor failed the whole verb when the playback was refused — so an unplayable greeting
  **hung up on the caller**. The collection is now retried once without the audio. A menu with no
  greeting is degraded; a menu that hangs up is broken, and it is the reason E2E scenario 14 could
  not evaluate DTMF at all.

The queue path already noted the refusal, and the live logs confirm it did:
`notes: ["music on hold could not be started: … no such prompt: sound:moh/RT-Hold"]`.

---

## Live verification (stack per STACK.md; api restarted twice, logged there)

- `system media: 34 written, 0 already current, 0 left as the deployment's own` — 34 files on the
  mount including `objects/moh/default.wav`.
- Second boot: `0 written, 34 already current` — idempotent, as designed.
- `music on hold: 1 class(es) playable by name, 0 not published` → `objects/moh/RT-Hold.wav`.
- Queue 4010, before (17:40): `mediad refusing a playback … media:["moh:RT-Hold"] … no such prompt`.
  After (17:46 and 17:50): **`playback started … playbackRef:"moh:<session>" frames:300`**, no send
  error over the full 30 s hold, and the refusal note is gone from the walk's notes.

**Not confirmed:** caller-side audio energy. `ivr.mjs moh` still reports
`Timed out: hold music for a queued caller` — its probe reads the browser's `inbound-rtp`
`totalAudioEnergy`. `mediad` reports the session latched a remote (a playback with nowhere to send
is refused before it starts), started, and logged no write error for 30 s, so the refusal that was
P1-3 is demonstrably gone at the media plane. Whether the frames reach that particular browser leg
is a `mediad`/RTP question I could not instrument without restarting `mediad` or `engine`, which the
brief forbids. **The engine also still runs a `dist` that predates the plan-walker changes**, so the
new notes and the IVR gather retry are unverified live.

IVR 4020 could not be verified at all, for the reason in the next section.

---

## Remaining gap — a fourth case, and the one that still breaks IVR greetings (NOT FIXED)

**A tenant prompt is unreachable on `mediad`, and always has been.** The compiler carries a prompt
as a row id; `media-refs.ts` renders it `sound:<promptId>`; the file is at
`prompts/<org>/<fileId>.wav`, where `fileId` is a _different_ UUID minted at upload. Live proof,
three separate calls:

```
refusing a playback  media:["sound:01a0871d-a0d8-723e-b1cb-d0f86a1f35ef"]
                     error:"audio: no such prompt: sound:01a0871d-a0d8-723e-b1cb-d0f86a1f35ef"
```

That is the queue's greeting and it is the same string an IVR greeting produces. So
**E2E-routing P1-3's "the engine was walking the pre-MOH artifact" explanation is incomplete** — no
tenant prompt has ever been playable on `mediad`, independent of P0-1, and no engine restart will
fix it. `ENGINE_PROMPT_MEDIA_PREFIX` cannot close it either: the key needs an organization id and
the prefix is deployment-wide.

The fix is a contract change across three areas, which the shared preamble puts off limits:

1. `packages/routing/src/snapshot.ts` — add `objectKey?: string` to `PromptInput` (additive).
2. `apps/api/src/pbx/routing/snapshot-loader.ts` — project `prompt.object_key` (one column).
3. `packages/routing/src/compile.ts` — emit a `prompts` table beside the existing `phrases` one,
   mapping prompt id → `object://<objectKey>`, using the existing `objectMediaRef` helper.
4. `apps/engine` — `resolveMediaRef` consults that table before falling back to
   `promptPrefix + promptId`, so `object://` → `sound:<ENGINE_MEDIA_OBJECT_ROOT>/<key>` — exactly
   the path voicemail greetings already take and which already works.

`dangling-prompt` (b) is the diagnostic half of the same problem and is shipped; this is the
resolution half.

Related, smaller, also deferred: the MOH publish pass runs **at boot only**, the same cadence
`musiconhold.conf` documents ("the media server picks this up on restart"). An admin who uploads
hold music mid-day needs an API restart. The incremental hook belongs on
`MohClassesService`/`PromptsService`'s write paths, where the recompile already fires.

## Additional fixes noticed on the way

- The IVR gather no longer hangs up on an unplayable greeting (see (c)).
- `apps/api/scripts/verify-carrier.ts` — added the new env key to its inline `PbxEnv` literal.
- Stale comment corrected in `system-media.service.ts` after the size-check shortcut was dropped
  (authorship is decided on bytes, not size).

## Cross-area needed

- The four-step prompt-addressing change above (`packages/routing`, `apps/api/.../snapshot-loader.ts`,
  `apps/engine/src/routing/media-refs.ts`).
- Engine restart to activate the plan-walker notes, the gather retry, and the orchestrator change.

## Verification output (exact)

| Check                                                    | Result                                                                                                                                                                                                             |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm --filter @optimiq-voice/api run typecheck`         | pass (both tsconfigs)                                                                                                                                                                                              |
| `pnpm --filter @optimiq-voice/api run test`              | **1260 passing, 0 failing** (was 1246 before my 19 new cases; 5 pre-existing files unchanged)                                                                                                                      |
| `pnpm --filter @optimiq-voice/routing run typecheck`     | pass                                                                                                                                                                                                               |
| `pnpm --filter @optimiq-voice/routing run test`          | **865 pass, 0 fail**, 2039 expect() calls, 22 files (was 859)                                                                                                                                                      |
| `pnpm --filter @optimiq-voice/engine run typecheck`      | pass                                                                                                                                                                                                               |
| `pnpm --filter @optimiq-voice/engine run test`           | **1593 pass, 6 skip, 0 fail**, 3571 expect() calls, 72 files                                                                                                                                                       |
| `pnpm exec oxlint <my dirs>`                             | clean                                                                                                                                                                                                              |
| `pnpm exec oxfmt <my dirs>`                              | clean (124 + 56 files)                                                                                                                                                                                             |
| `turbo run typecheck --filter=...@optimiq-voice/routing` | `@optimiq-voice/web` fails on `reason_phrase` in `lib/softphone/jssip-adapter.ts` — **another agent's in-flight edit, not mine**; turbo cancelled engine/api as siblings, and both pass when run directly (above). |

No Go touched. No git state touched. Services restarted: **api only**, twice, logged in `STACK.md`.

## Files changed

| File                                                    | Change                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------ |
| `apps/api/src/pbx/media/system-media.ts`                | new — catalogue + deterministic 8 kHz PCM WAV renderer             |
| `apps/api/src/pbx/media/system-media.service.ts`        | new — boot seeder + the MOH-by-name publish pass                   |
| `apps/api/src/pbx/media/moh-library.ts`                 | new — which classes may claim a name, gated on the Asterisk render |
| `apps/api/src/pbx/shared/pbx-env.ts`                    | new `PBX_ENSURE_SYSTEM_MEDIA`                                      |
| `apps/api/src/pbx/pbx.module.ts`                        | provider registration                                              |
| `apps/api/scripts/verify-carrier.ts`                    | the new env key in its `PbxEnv` literal                            |
| `apps/api/test/pbx/systemMedia.test.ts`                 | new — 12 cases                                                     |
| `apps/api/test/pbx/mohLibrary.test.ts`                  | new — 7 cases                                                      |
| `packages/routing/src/diagnostics.ts`                   | `dangling-prompt`                                                  |
| `packages/routing/src/compile.ts`                       | `promptRef` + 12 call sites                                        |
| `packages/routing/src/embeddings.spec.ts`               | new — 6 cases pinning `dangling-prompt`                            |
| `apps/engine/src/calls/channel-orchestrator.service.ts` | failure detail survives `execute`                                  |
| `apps/engine/src/routing/plan-walker.ts`                | `verbFailure` dep, `noteVerbFailure`, gather retry                 |
| `apps/engine/src/routing/plan-walker.spec.ts`           | harness support + 3 cases                                          |
| `.scripts/local-stack/reset-db.sh`                      | comment recording the seed dependency on the api restart           |
