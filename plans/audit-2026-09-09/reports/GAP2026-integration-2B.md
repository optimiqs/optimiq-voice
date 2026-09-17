# GAP2026 — AREA=integration-2B

Owned: `apps/sipd/**`, `packages/cdr-db/**`, `apps/api` queue-agents + recordings/erasure retention,
`apps/web` queue / agent-console / wallboard-agent screens. Nothing committed, staged or stashed.

---

## Task 1 — sipd TLS certificate watcher

### What was actually wrong

`Reloader.Watch` had **no filesystem watch at all**. Its two triggers were SIGHUP and a 30 s
`os.Stat` poll, and the poll's change test was `(size, mtime)` of the two files. So the integration-1
finding ("the file-watch reload did NOT fire on a rename+copy replacement; SIGHUP did") was accurate
in substance: what exists is a stat poll, ACME tooling replaces by rename or by re-pointing a
symlink, and a poll on `(size, mtime)` is exactly the test a rename can slip past — a certbot archive
file renamed into place carries the mtime it was _written_ with, and a symlink re-point leaves the
name's own stat looking however the new target looks.

### Changed

- **`apps/sipd/internal/siptls/watch.go`** — rewritten around `fsnotify` on the **parent
  directories** of `cert.pem` and `key.pem` (plus, when either path is a symlink, the directory its
  target resolves into). Events arm a **250 ms debounce**, so the burst an atomic renewal produces —
  the staging write, the cert rename, the key rename — collapses into **one** re-read of the pair.
  The watch set is **re-armed after every reload**, so an ACME swap whose new generation lives in a
  directory that did not exist at boot keeps being watched. The 30 s poll is kept as a backstop for
  filesystems where kqueue/inotify sees nothing; a watcher that cannot be created logs and falls back
  to it rather than failing the boot. `Watch` still never returns an error and never drops the
  serving certificate.
- **`apps/sipd/internal/siptls/siptls.go`** — `Reload()` now delegates to `reload(force bool)`.
  A filesystem-driven reload passes `force`, which **skips the stat fast path**: the whole point is
  that a rename can land a file whose `(size, mtime)` matches the one it replaced. "Changed" is now
  decided on the **DER chain**, not on stat, so a rewrite that changed nothing is not logged as a
  reload and the log stays honest. Both files are still read in one pass by `tls.LoadX509KeyPair`,
  which is also what proves the **pair matches** — a cert read against the previous key fails there
  and the previous generation keeps serving until the next trigger.
- `go.mod` / `go.sum` — `github.com/fsnotify/fsnotify v1.9.0` (already in the module cache; resolved
  with `GOPROXY=off`).

Ran the modern-go-guidelines CLI on `watch.go` before editing and applied what fits: `slices.Contains`
for the watch-set diff, `min`-style channel-nil idioms unchanged, `errors_is`/`atomic_types` already
in place. Nothing was reformatted for taste.

### Tests (Go)

`apps/sipd/internal/siptls/siptls_test.go`, both with the **poll disabled** (`interval 0`), so a pass
proves the filesystem watch fired and not the backstop:

- `TestWatchReloadsWhenTheFilesAreRenamedOverAtomically` — writes the next generation beside the
  target _in the watched directory_ (so the staging files are part of the event stream too), then
  renames each over the live name. Serial 51 → 52.
- `TestWatchReloadsWhenASymlinkedPairIsRepointed` — a certbot layout (`live/cert.pem` →
  `archive/gen1.crt`), then a new generation in `archive` and both live symlinks re-pointed by
  renaming a staged link over each. The inode behind `cert.pem` never changes, so only a directory
  watch sees this. Serial 61 → 62.

The symlink case **failed on the first implementation** and that is worth recording: the first cut
filtered directory events down to the two PEM names, and fsnotify's kqueue backend reports a
symlink re-point as activity on the staged name, not the live one. Filtering by name is therefore
backend-dependent; any event in a watched directory now arms the debounce. That is safe precisely
because a reload is atomic-or-nothing — a half-written pair fails `LoadX509KeyPair` and installs
nothing — and the debounce keeps the cost to one read per burst.

### Live proof (stack, no SIGHUP)

sipd restarted once onto the new build (`down.sh sipd && up.sh sipd`; `e2e/LOAD-RUNNING` absent;
logged in `STACK.md`). Served certificate on **5161** sampled once a second:

| t                               | served SHA-256 fingerprint     |
| ------------------------------- | ------------------------------ |
| before                          | `D7:D8:…:D5:9F` (the SAN pair) |
| rename-over with `*.reloadtest` | **`08:85:…:BE:8B` at t+1 s**   |
| rename-back to the SAN pair     | **`D7:D8:…:D5:9F` at t+1 s**   |

Two `SIP TLS certificate reloaded … trigger=file change` lines for two swaps — **no error line
between them**, i.e. the debounce collapsed each cert+key rename pair into one read rather than
briefly loading a mismatched pair. No SIGHUP was sent.

**Restored at hand-off**: `cert.pem` / `key.pem` are the SAN pair, served fingerprint
`D7:D8:C1:EF:…:D5:9F`, SAN `DNS:localhost, DNS:local.test, IP Address:127.0.0.1`. Browser softphones
are unaffected. No `.stage` files left behind; `cert.pem.orig` and `*.reloadtest` untouched.

**Verification**: `go vet ./...` clean, `go test -race ./...` **23 packages ok, 0 fail**,
`gofmt -l internal/siptls` empty.

---

## Task 2 — `packages/cdr-db/src/retention.ts:111`

`purgedRecordingSoftDeleteQuery` emitted `where "id" = any(${ids}::uuid[])`. Drizzle expands a JS
array bound there into a parenthesised parameter **list** `($1,$2,$3)` — a row constructor, not an
array — so Postgres refuses the cast with `42846: cannot cast type record to uuid[]` for two or more
ids. One id survived by accident.

- **Fixed** to the package's own idiom, `where "id" in (${sql.join(ids.map((id) => sql`${id}::uuid`),
sql`, `)})`. Empty-list branch, `deleted_at is null` guard and `returning "id"` untouched.
- **Audited**: `grep -rn "any(" packages/cdr-db/src` returns exactly the one line. No other
  `any(...)::<type>[]` anywhere in the package.
- **The real victim** was `apps/api/src/cdr/recordings/recording-retention-sweeper.service.ts:191`,
  which batches up to `CDR_RECORDING_SWEEP_BATCH` ids — so the recording retention sweep could not
  purge more than one recording per organization per pass. (The erasure workaround's comment claimed
  the sweeper was one-at-a-time; it is not.)
- **Regression test against the live Postgres**: a new
  `describe("purged recording tombstones")` block in
  `packages/cdr-db/src/cdr-partitioning.integration.spec.ts` — 3 recordings for one org, one call,
  all three returned and tombstoned, re-run returns 0. Its own org id and `deleteOrganizationRowsQuery`
  cleanup; kept out of the neighbouring `cdr retention` block because that block's `beforeAll` does
  partition DDL the local role does not own.

  - old expression, live PG: `PostgresError: cannot cast type record to uuid[] / code: "42846"` — **0 pass, 1 fail**
  - new expression, same target: **1 pass, 0 fail**

- **Workaround removed**: `erasureRecordingTombstoneQuery` in
  `apps/api/src/cdr/erasure/erasure.repository.ts` existed _solely_ for this bug (its doc comment said
  so). Verified semantically identical to the shared helper — same empty-list no-op, same `set`, same
  `where … and "deleted_at" is null`, same `returning` — then deleted; `erasure.service.ts` now
  imports `purgedRecordingSoftDeleteQuery` from `@optimiq-voice/cdr-db`.

`cdr-db` unit **79 pass / 38 skip / 0 fail**; integration run **105 pass, 3 fail** — the 3 are
pre-existing `42501: must be owner of table call_legs_2031_07` in the partition-DDL block, identical
with and without this change, because the local-stack role `voice_cdr` is not the schema owner.

---

## Task 3 — `GET /queue-agents/:id/session`

### API

`apps/api/src/pbx/queues/queue-agent-session.service.ts` — `AgentSessionView` gains
`callId`, `queueId`, `dispositionCallId`, `dispositionCode`, `dispositionRequired` and
`unavailableReason`, all read from the same `agent-state` KV entry the socket carries.

Two judgement calls, both worth flagging:

1. **There is no `state` field and no `unavailableReason` field on the bucket.** The brief asked for
   both. The entry's field is `status`, which the view already returned; I did not add a redundant
   `state` alias. `unavailableReason` is **derived**: `reason` is deliberately free text ("back at 3"
   is legitimate), and `ENGINE_UNAVAILABLE_REASONS` / `isEngineBenched` in `packages/events` is the
   existing narrowing to the two the _distributor_ writes (`max-no-answer`, `rona`). So
   `unavailableReason` is `reason` when the distributor benched the agent and `null` otherwise —
   which is the distinction a supervisor actually needs and is what the wallboard already branches on
   client-side.
2. **`queueId` was added although the brief did not list it.** Without it the wallboard's supervise
   button cannot work: it must refuse a call whose entry names a _different_ queue, and it already
   does that check against the socket entry.

**Permission**: the route's guard is `queues.read`, but the `agent-state` socket topic is gated on
`queues.monitor`. Repeating the live call over HTTP under `queues.read` would hand out what the
socket refuses, so the call/disposition fields are carried **only** for a caller holding
`queues.monitor` or for the agent asking about their own seat. `status`, `since`, `reason`,
`availableAt` are unchanged for everyone.

### Web

- `apps/web/lib/live/agent-session.ts` — the hand-mirrored `AgentSessionView` gains the same fields,
  plus an exported `agentStateFromSession()` that converts the endpoint's `null`s into the bucket's
  _absent keys_. A `null` left in place would read as a value to every `?? fallback` in the
  components.
- `apps/web/app/(app)/_hooks/use-agent-session.ts` — `useMyAgentSession(options)` takes an optional
  poll interval (default: none, the socket keeps it fresh); new `useAgentSessions(agentIds, options)`
  over `useQueries` for the wallboard.
- `apps/web/app/(app)/queues/_components/wrap-up-panel.tsx` — takes the socket entry **whole**, or
  the REST view **whole**, never a mix; polls the seat every 5 s only while the socket is cold or
  unpermitted. Mixing would let a REST answer fetched seconds earlier fill a call id back in on an
  agent whose entry says the wrap-up has ended.
- `apps/web/app/(app)/wallboard/_components/operator-panel.tsx` — when `agentStates.loaded` is false,
  fetches sessions for **only** the seats whose persisted column already says `on-call`, so a cold
  socket on a forty-seat wallboard is a handful of requests, not forty. The supervise call id is
  taken from the socket entry when there is one and from the seat otherwise, with the same
  "this queue distributed it" guard on both paths.
- `apps/web/lib/query-keys.ts` — `agentSession(orgId, agentId)`, in the same `pbx/queue-agents`
  subtree as `myAgentSession` so an agents-resource mutation already invalidates it.

### Tests

- mocha, `apps/api/test/pbx/queueAgentSession.test.ts` — four new cases: the fields are carried; they
  are `null`/`false` off a call; **another agent's call is withheld from a caller without
  `queues.monitor` while the agent's own seat still carries it**; and the bench-reason narrowing
  (`rona` → `unavailableReason`, `"Lunch"` → `null`). **26 passing** in that file.
- bun, `apps/web/lib/live/agent-session.spec.ts` — the mirror now asserts the shared
  `agentStateEntrySchema` still carries every field the fallback depends on (a field the bucket drops
  is a fallback that silently stops working), plus `agentStateFromSession` carrying the wrap-up call
  and dropping the endpoint's nulls. **9 passing** in that file.

### Live proof — a softphone in wrap-up

`<scratchpad>/e2e/calling/int2b-session.mjs` (new; modelled on `cc2026-after-call.mjs`). One real
answered queue call on the CC2026 queue, two browser softphones. At each moment the endpoint is
compared **field by field against the `agent-state` KV entry**, because the whole claim is that a
browser with no socket sees what the socket sees.

```
PASS: the session endpoint names the live call the socket names
      view callId=8afe496f-… queueId=01a089b2-… · kv callId=8afe496f-… queueId=01a089b2-… · drift=[]
PASS: the session endpoint carries the wrap-up call the panel opens on
      view status=wrap-up dispositionCallId=8afe496f-… required=true availableAt=2026-09-10T07:34:45.284Z · drift=[]
PASS: the endpoint and the bucket agree on the code the agent picked
      recorded=sale · view=sale kv=sale kvStatus=wrap-up
```

Two things the live run taught, both recorded in the script:

- Submitting the code also **ends the wrap-up**, and the engine's rewrite of the entry drops the code
  within about a second — which `agent-state.publisher.ts` already documents as the harmless
  direction of that race. An earlier run read `view=null kv=undefined kvStatus=available` and that is
  the endpoint being _right_, not wrong. The assertion is therefore agreement between the two
  readers, not a fixed value.
- **The self path could not be live-proved with this fixture**: the `2002` softphone user does not
  hold `queues.read` at all, so the endpoint 403s for them before the row-level self rule is reached.
  That is a fixture-role gap, not a code one; the self branch is covered by the mocha case above. I
  did not grant a permission to make a proof pass.

**Fixtures restored**: all three CC2026 agents logged back out (as found). `wrapUpSeconds=60` on the
CC2026 queue was already 60 before this run (the contact-centre pack set it) and is left at 60. One
`queue_call_disposition` row for the proof call remains, as call history.

---

## Task 4 — suites, the pre-existing failure, and the oxfmt findings

### `webhookSelectors.test.ts` — the **selector** was wrong, not the test

```
AssertionError: expected [ 'audit','media','messaging',… ] to deeply equal [ 'audit','media','provision',… ]
+ expected - actual
-  "messaging"
```

Evidence that `messaging` belongs in the webhook registry rather than in the "deliberately unserved"
list: `EVENT_FAMILIES` already includes it with `SUBJECT_ROOTS.messaging = messaging.evt.v1`
(`packages/events/src/subjects.ts:825`); `MESSAGING_STREAM` already exists
(`packages/events/src/streams.ts:234`); and decisively, `apps/api/src/messaging/messaging-event.publisher.ts`'s
own header says it exists for _"the webhook dispatcher's `messaging` consumer, which is how a tenant's
integration gets a screen-pop when a customer texts"_ — a consumer that was never registered. Every
documented reason the other families are unserved (engine plumbing, a second vocabulary, a raw
transition, an audit loop) fails against messaging.

Fixed by adding it to the registry, not by weakening the assertion (the deep-equal is unchanged):
`apps/api/src/pbx/webhooks/webhook-selectors.ts` (`WEBHOOK_FAMILIES` + `WEBHOOK_FAMILY_ROOTS`, prose
count five→six) and `apps/api/src/pbx/webhooks/webhook-dispatcher.service.ts` (the sixth durable
consumer: stream `MESSAGING`, durable `pbx-webhook-messaging`, filter `messaging.evt.v1.>`).

### oxfmt

`pnpm exec oxfmt --check apps/api/src/messaging` → one file, `messaging.service.ts`, import ordering
only (`TELNYX_CLIENT` value import into the value block, `TelnyxClient` type import reordered). No
behavioural edit. `--check` clean afterwards; `oxlint apps/api/src/messaging` reports nothing.

### Final counts (exact, from the output)

| Suite                                                   | Result                                                              |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/api test`                 | **1772 passing, 0 failing**                                         |
| `pnpm --filter @optimiq-voice/web test`                 | **1066 pass, 0 fail** (54 files)                                    |
| `pnpm --filter @optimiq-voice/cdr-db test`              | **79 pass, 38 skip, 0 fail**                                        |
| cdr-db integration (live PG)                            | 105 pass, 3 fail — all pre-existing `42501` partition-DDL ownership |
| `cd apps/sipd && go vet ./... && go test -race ./...`   | vet clean, **23 packages ok, 0 fail**                               |
| typecheck: api / web / cdr-db                           | all clean                                                           |
| `oxlint` + `oxfmt --check` over every directory touched | clean                                                               |

The `packages/events/src/validate.ts:208` typecheck error the recording pack reported is **gone** —
api typecheck (both `tsconfig.json` and `tsconfig.strict.json`) is clean on the current tree.

---

## Cross-area / left for others

- **`apps/engine/src/queue/queue-session.ts`** — the per-queue `recordAutoPauseOnDtmf` flag is
  compiled but not honoured, because the queue owns its own `startRecording` path. Engine is agent
  2A's; the recording pack already spelled out the one-line change.
- **Fixture-role gap**: the `2002` softphone user holds no `queues.read`, so no live proof of the
  agent-console path (wrap-up panel, own seat) is possible with `e2e/calling/world.json` as it
  stands. Whoever owns the fixtures should grant the agent role `queues.read` + `queues.join.own`.
- **The `agent-state` bucket has no `state` or `unavailableReason` field**; the integration TODO's
  wording implies they exist. `status` and the derived narrowing above are what is actually there.

## Stack state at hand-off

All eight services healthy (`status.sh`: postgres/nats/smtp/mediad/sipd/engine/api/web, every health
check 200). Restarts performed by this area, both logged in `STACK.md`: **sipd ×1** (task 1, rebuild
via `up.sh sipd`, `LOAD-RUNNING` absent) and **api ×1** (to pick up the session endpoint). `down.sh`
was never run bare; mediad, engine, web, NATS and Postgres were not touched. Certificates restored to
the SAN pair and verified on the wire. No commits, no staging, no git state touched.
