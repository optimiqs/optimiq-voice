# E2E — records (voicemail, recording, CDR, live dashboard, webhooks, audit, mail)

Run 2026-09-09 16:40–17:15 UTC against the standing stack (HEAD `3bd98f2` + working-tree fixes).
Artifacts: `<scratchpad>/e2e/artifacts/records/`. Harness: `<scratchpad>/records/` (`lib.mjs`,
`setup.mjs`, `voicemail.mjs`, `recording.mjs`, `exports.mjs`, `page.mjs`, `live.mjs`, `mwi.mjs`,
`watchdog.mjs`, `perms.mjs`, `scope.mjs`, `ui.mjs`, `kv.mjs`, `watch.mjs`, `receiver*.mjs`),
modelled on `.scripts/local-stack/smoke-call.mjs`.

**Result: 31 scenarios pass, 5 fail, 4 blocked.** P0 ×1, P1 ×3, P2 ×5.

## Where the tests live (a deviation worth stating first)

The brief asks for an own organization. **That is not possible for anything that places a call.**
`org_setting sip/realm` is a deployment-wide unique claim (`SipCredentialsService.resolve` →
`resolveOrganizationForRealm`, `apps/api/src/pbx/sip-credentials/sip-credentials.service.ts:90`),
`sipd` challenges with a single `SIPD_REALM=local.test`, and the smoke organization already owns it.
A second organization can be created but none of its extensions can ever register. So this slice
runs inside `01a08708-4cd4-76b9-b56d-d26ebf326b0a` on its **own** objects, all prefixed or
numbered out of everyone else's way, and touched nothing it did not create:

- extensions `1710` (Records A, `recordPolicy: "all"`) and `1711` (Records B, voicemail, 8 s ring)
- mailbox `1711` (`01a0870c-7a19-…`), its greeting, its PIN
- users `recmtubun8t-a@local.test` / `recmtubun8t-b@local.test`
- webhook subscription `01a08718-2c8a-…`, one CDR export job, one mail-template override (left disabled)

Three shared-stack actions are logged in `STACK.md`: the authorised 60 s `SIGSTOP` of `api`, one
NATS permission violation from my own diagnostic client, and one webhook row whose `url` I rewrote
in Postgres (see §Webhooks for why).

## Scenario table

| #   | Scenario                                    | Expected                                             | Observed                                                                                                                  | Evidence                                                   | Verdict               |
| --- | ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | --------------------- |
| 1   | No-answer → mailbox                         | Ring times out, walk opens the box, message filed    | Filed, `destinationType: "voicemail"`, walk `visited: [extension…, voicemail…:leave]`                                     | `engine.log` "filed a voicemail message" `durationMs 8320` | PASS                  |
| 2   | Message audio is real                       | WAV with energy > 0                                  | 133 164 B RIFF/WAVE, 66 560 samples @8 k, RMS 22 880, peak 32 124                                                         | `wav.mjs`                                                  | PASS                  |
| 3   | Message list (`.own`, owner)                | 200 with rows + `newCount`                           | 200, 5 rows, `newCount 3`                                                                                                 | `voicemail.mjs`                                            | PASS                  |
| 4   | Message list (`.own`, other user)           | 403                                                  | 403 `SELF_SERVICE_SCOPE_FORBIDDEN`                                                                                        | `voicemail.mjs`                                            | PASS                  |
| 5   | Mailbox list is `.own`-scoped               | Each user sees only their own                        | A: `[]`; B: `["1711"]`                                                                                                    | `scope.mjs`                                                | PASS                  |
| 6   | Mark read / unread                          | `newCount` drops                                     | 3 → 2                                                                                                                     | `voicemail.mjs`                                            | PASS                  |
| 7   | Play via signed URL                         | 200 `audio/wav`, Range-aware                         | 200, `inline; filename="voicemail-…wav"`, TTL 300 s                                                                       | `wav.mjs`                                                  | PASS                  |
| 8   | Greeting upload                             | 201 with `object://` key, recompile                  | 201, `objectKey greetings/<org>/<box>/<id>.wav`, `durationMs 2000`                                                        | `ui`/curl                                                  | PASS                  |
| 9   | Greeting list / play-url / label edit       | 200 each                                             | 200, 32 044 B audio                                                                                                       | shell                                                      | PASS                  |
| 10  | **Uploaded greeting is played to a caller** | Caller hears it                                      | **`sound:unavailable` requested; caller hears nothing**                                                                   | `mediad.log` "no such prompt: sound:unavailable"           | **FAIL — F1**         |
| 11  | PIN policy                                  | Weak PINs refused, good one set, clearable           | `1234`→400 "counts up or down", `1111`→400 "one repeated digit", `7391`→`pinSet:true`, DELETE→`pinSet:false`              | shell                                                      | PASS                  |
| 12  | Voicemail-to-email                          | Mail at the SMTP fixture, tenant product name        | `Subject: New voicemail from 1710 (Records A) (0:08)`, "Optimiq Voice" in body, link not attachment                       | `<scratchpad>/e2e/mail`                                    | PASS                  |
| 13  | Mail template override                      | Subject replaced, intro prepended, product name kept | `Subject: [Records QA] message waiting`, intro present, "Optimiq Voice" still present                                     | `.eml`                                                     | PASS                  |
| 14  | MWI on the live channel                     | `voicemail.mwi.updated`                              | Delivered ~15 s after hangup                                                                                              | `mwi.mjs`                                                  | PASS                  |
| 15  | MWI on the softphone                        | Message-waiting shown                                | Shown                                                                                                                     | `mwi.mjs`                                                  | PASS                  |
| 16  | **Extension record policy**                 | `1710` is `"all"`; a call to it is recorded          | **0 recordings; no note; the field is read by nothing**                                                                   | `recording.mjs`, code                                      | **FAIL — F2 (fixed)** |
| 17  | Queue record policy                         | Recorded at the answer                               | **Blocked** — a new queue never reaches the engine (F4)                                                                   | —                                                          | BLOCKED               |
| 18  | Recording on the call detail                | `recordings[]` on the leg/call                       | `[]` (consequence of F2)                                                                                                  | `recording.mjs`                                            | BLOCKED               |
| 19  | Signed WAV download, energy > 0             | Plays back                                           | Verified on an existing recording: 200, RIFF, Range headers; tampered token → 403                                         | `recording.mjs`, `exports.mjs`                             | PASS                  |
| 20  | Stop recording mid-call                     | Call survives                                        | **Blocked** — no HTTP route; it is the `record-toggle` feature code, and nothing was recording                            | —                                                          | BLOCKED               |
| 21  | `recordings.read` gate                      | 403 without the grant                                | 403 for both members; `download-url` 403                                                                                  | `perms.mjs`                                                | PASS                  |
| 22  | Legs of one call under one `callId`         | 2 legs, right dispositions                           | 4 legs; **2 spurious `disposition: "answered"` legs with `answeredAt: null`, `billsecMs 0`**                              | `cdr/calls/6e687c94…`                                      | **FAIL — F3 (fixed)** |
| 23  | CDR filters                                 | Each narrows                                         | `direction`, `disposition`, `hangupCause`, `leg`, `extension`, `recorded`, `search` all work                              | `c.sh` sweep                                               | PASS                  |
| 24  | CDR time range                              | Default 24 h, cap 92 d                               | Echoed range; 2 444 d → 400 `CDR_RANGE_TOO_WIDE`                                                                          | `page.mjs`                                                 | PASS                  |
| 25  | Pagination past the last page               | No dupes, clean end                                  | 147 rows / 30 pages, 0 duplicates, `nextCursor: null`, re-using the last cursor returns the tail and stops                | `page.mjs`                                                 | PASS                  |
| 26  | Bad cursor                                  | 400, not 500                                         | 400 `CDR_INVALID_CURSOR`                                                                                                  | `page.mjs`                                                 | PASS                  |
| 27  | Export create → download                    | 202 → succeeded → CSV                                | `rowCount 13`, `sizeBytes 4233`, 200 `text/csv`, `attachment; filename="cdr-…csv"`, tampered token → 403                  | `exports.mjs`                                              | PASS                  |
| 28  | Live: active calls                          | Appear and disappear                                 | `snapshot` then `channel.created/ringing/answered/bridged/hangup/destroyed` + KV put/delete, real time                    | `live.mjs`                                                 | PASS                  |
| 29  | Live: registrations                         | Reflects register within one refresh                 | `snapshot:registrations` + 2 `event:registrations` as the softphones came online                                          | `live.mjs`                                                 | PASS                  |
| 30  | Live: topic gating                          | `denied` names what is refused                       | `denied: []` for the owner; welcome lists the 7 grantable kinds                                                           | `live.mjs`                                                 | PASS                  |
| 31  | Live: watchdog after a 60 s API pause       | Reconnect + full resync                              | Socket closed and a second opened; a fresh browser socket resyncs `welcome/subscribed/snapshot`                           | `watchdog.mjs`, `wsclose.mjs`                              | PARTIAL — F7          |
| 32  | Webhook CRUD + secret hygiene               | Secret returned once, never again                    | Returned on create, redacted on every read                                                                                | `c.sh`                                                     | PASS                  |
| 33  | Webhook delivery + signature                | Stripe-scheme HMAC                                   | 25/25 deliveries verified `HMAC-SHA256(secret, "<t>.<body>")`; headers `x-optimiq-{signature,event,subscription,attempt}` | `receiver-http.log`                                        | PASS                  |
| 34  | Webhook retries with backoff on 500         | 3 attempts, doubling                                 | 72 requests = 24 events × 3; one event at +0 / +1003 ms / +3004 ms                                                        | `receiver-http.log`                                        | PASS                  |
| 35  | Auto-disable on repeated failure            | Off after 20 consecutive                             | `enabled=f`, `consecutive_failures=24`, `auto_disabled_at` set, `last_failure_reason "HTTP 500"`                          | Postgres                                                   | PASS                  |
| 36  | Secret rotation invalidates the signer      | Next delivery uses the new key                       | 26/26 signed with the NEW secret, 0 with the old, on the very next call                                                   | `receiver-http.log`                                        | PASS                  |
| 37  | Webhook URL admission                       | http refused                                         | 400 `PBX_INVALID_BODY` "A webhook endpoint must be https."                                                                | `c.sh`                                                     | PASS                  |
| 38  | Audit entries for my changes                | Config writes recorded                               | `webhook.create`, `webhook.update`, `extension.create`, `voicemail-box.create`, `extension-user.create`                   | `/audit-log`                                               | PASS                  |
| 39  | Audit filters                               | `action`, `actorUserId`, range                       | All work; range echoed; 30 d default, 366 d cap                                                                           | `c.sh`                                                     | PASS                  |
| 40  | Permission gates                            | 403 without the grant                                | `recordings`/`cdr`/`cdr/exports`/`audit-log`/`webhooks` all 403 for a plain member                                        | `perms.mjs`                                                | PASS                  |
| 41  | UI pages render                             | No page errors                                       | `/cdr`, `/recordings`, `/voicemail`, `/webhooks`, `/audit-log` all render, 0 page errors                                  | screenshots                                                | PASS                  |

## Findings

### F4 — P0 — the engine stops applying routing-artifact updates; every tenant change silently does not take effect

The single most serious thing found. `apps/api` recompiles and writes the artifact correctly; the
engine never picks it up.

Evidence, in order:

1. A greeting was uploaded and activated at 17:00:04. The published artifact **does** carry it:
   reading `KV routing-cache` key `01a08708-….artifact` directly shows
   `"greetingMedia":"object://greetings/…","greetingKind":"unavailable"` on the `leave` node.
2. The engine kept asking `mediad` for `sound:unavailable` — i.e. its plan node had no
   `greetingMedia` — and emitted **no** "…this deployment cannot play…" note, which is the only
   other way that string is reached (`plan-walker.ts` `leaveGreetingFor`).
3. `engine.log` has 261 `applied a routing artifact update from KV` lines, the **last at 16:45:17**,
   and none for this organization after **16:44:40** — across 30 minutes in which five agents were
   saving configuration.
4. Forced test: KV revision `1623 → 1624` on a write; the engine's applied count stayed at 261.
5. Isolation: a fresh independent watcher on the same bucket with the same filter
   (`*.artifact`, `watch.mjs`) received **18 updates in 25 s**, including that write. The broker is
   fine. The engine's own watch is alive but has stopped yielding.

`runWatchLoop` handles a watch that _ends_ — it logs a WARN, drops the cache and reconnects — and
neither the WARN nor the "watching the routing-cache KV bucket" line ever reappeared, so the
iterator is hung, not closed. The only recovery is the 1 h `CACHE_TTL_MS` backstop, which the class
comment already names as being for "the window where the watch is nominally alive but has stopped
delivering". An hour of routing a tenant's calls by a plan they have edited is a very long window.

Impact: greetings, queues, ring groups, IVR trees, DND, forwarding, record policies — nothing saved
in the last hour is on the call path. It is silent from every angle: `/healthz` is `ok`, `watching`
is true, and no log line is emitted.

Root cause is in the NATS KV watcher (likely an ordered consumer that did not recover from a
connection blip). I did **not** attempt a fix: it is `apps/engine`'s NATS layer, another agent owns
that area, and a speculative change there is worse than a precise report.

**Fix applied (observability only, no behaviour change):** the routing source now records when the
watch last delivered anything and `/healthz` publishes it, so this failure is visible instead of
invisible. Reported, never status-deciding, on the same terms as `park` —
`apps/engine/src/routing/routing-artifact.source.ts` (`lastWatchEntryAt`),
`apps/engine/src/health/health.controller.ts`, tests in `health.controller.spec.ts` (3 new).
`invalidations` alone cannot do this job: a recompile with an unchanged hash is a delivered entry
that moves no counter, so a dead watch and a quiet tenant look identical through it.

### F2 — P1 — `extension.record_policy` is compiled and then read by nothing (FIXED)

Extension `1710` was set to `recordPolicy: "all"`. A four-way answered call produced **zero**
recordings, no note, and no error. The column exists (`extensions-schema.ts:88`), the compiler emits
it (`compile.ts:958`), `ExtensionPlanNode.recordPolicy` carries it (`plan.ts:116`) — and the walker
consults `recordPolicy` in exactly one place, `recordConference` (`plan-walker.ts:4069`). The queue's
policy and the conference's are honoured; the extension's never was. A tenant who ticks "record
everything" on a desk phone gets silence and no way to find out.

**Fix:** `apps/engine/src/routing/plan-walker.ts` — `extensionNode` now calls a new
`recordExtension(node)` after `settleDial` returns `bridged`. `all` and `inbound` record (a call
reaching an extension node is inbound to it — the same reading `QueueSession.startRecording`
documents); `outbound` belongs to the trunk half and `on-demand` means the user presses the record
key, so neither pre-empts. After the **bridge**, not the answer: recording is a tap on a bridged
conversation. Best-effort with a note on every failure path, exactly as the queue's is.
Tests: 5 new in `plan-walker.spec.ts` (records on `all`/`inbound`, does not on
`none`/`on-demand`/`outbound`, does not on a call that never bridged, notes a refusal, notes a
missing call-control port). The harness gained a `canRecord` option and a `legs` hook collector.

### F3 — P1 — a refused originate is filed in the CDR as an ANSWERED leg (FIXED)

Extension `1710` had a live registration and two stale ones. The fan-out produced three B-legs; the
two that could not be reached were filed as:

```
leg b, answeredAt null, billsecMs 0, hangupCause NORMAL_CLEARING, disposition "answered"
```

They also appear that way in the CSV export. The chain: `PlanWalker.originate` calls
`legs.originated()` **before** the originate, so the aggregate exists; when the INVITE is refused
(`SplitPlaneSignallingRefusedError … (no_route)`) the catch reported the failure to the dial loop
but never gave the leg a cause, so the teardown's default `NORMAL_CLEARING` stood — and
`dispositionFor` reads `NORMAL_CLEARING` on an unanswered leg as an _answered_ call whose answer
instant was lost (`cdr-leg.ts:65`, deliberate and correct for its intended case). Every call to an
extension with a stale contact therefore inflated the answered count.

**Fix:** one line plus its reasoning in `plan-walker.ts` — `this.deps.legs?.hangingUp(channelId,
"USER_NOT_REGISTERED")` in the catch, first-wins, the same mechanism `hangupQuietly` already uses.
Test: `plan-walker.spec.ts`, "gives an unreachable leg a cause, so its CDR is not filed as
answered". The assertion checks the FIRST cause, because the simultaneous dial's cleanup pass
follows with `ORIGINATOR_CANCEL` and must not win.

### F1 — P1 — an active custom voicemail greeting is not played

Caller hears nothing where the greeting should be. This is a **symptom of F4**, not a separate
defect: the artifact carries the greeting, the engine is walking a stale copy. It is listed
separately because it is the user-visible half and because it needs re-testing after the restart.

Adjacent environment note: this deployment has **no prompt pack**, so `sound:unavailable`,
`sound:moh/default` and every built-in prompt are refused by `mediad`. Default greetings and hold
music therefore cannot be heard here at all, and the `play` verb fails loudly on each one
(`MediaCommandFailure`, one WARN per call). Not a code bug; it does mean any scenario that depends
on a stock prompt is untestable on this stack.

### F5 — P2 — voicemail messages are filed with `size_bytes` NULL

`durationMs 8320` but `sizeBytes null`, while the object is 133 164 bytes. The API's consumer
accepts `sizeBytes` (`voicemail-consumer.service.ts:365,403`) and the engine's
`voicemail.message.left` never sends it (`channel-orchestrator.service.ts:2153`). The transcription
service then works without a size hint (`voicemail-transcription.service.ts:420`). Not fixed: the
honest fix is engine-side and crosses the events contract; the cheap fix (stat the object in the
consumer) papers over a producer gap. Filed for the owner of `apps/engine`'s voicemail port.

### F6 — P2 — `did` and `extension` are the same filter

`cdr.repository.ts:129-137` builds byte-identical predicates for both
(`from = x OR to = x`). The DTO documents them as "same mechanism, different intent", and the web
UI only ever sends `extension`, so nothing is broken — but an API consumer filtering by `did` is
getting extension matches too, silently. Either narrow it (a DID is `numbers`-backed, so it can be)
or drop it.

### F7 — P2 — the app's live socket opens and closes without exchanging a frame

Under Playwright on `/wallboard`, the app's own `LiveClient` socket opened and closed immediately
with **no frames at all**, while a raw `new WebSocket()` from the _same page_ got
`welcome` → `subscribed` → `snapshot` correctly. So the server, the Next WS proxy and the cookie
session are all fine; something client-side is closing the lease. Most likely the wallboard holds no
lease until a queue is selected (`LiveClient` opens on the first lease and closes on the last), in
which case it is correct behaviour and not a bug. Not confirmed either way, and
`apps/web/app/(app)/_context/live-context.tsx` is being edited by another agent in this same working
tree right now — so it is reported rather than fixed. The watchdog half of the scenario did behave
correctly: after the 60 s pause the app closed its socket and opened a new one.

### F8 — P2 — the Voicemail screen's unread column reads "—" for a mailbox with 3 unread messages

Documented behaviour, not an accident: the column is fed only by live `voicemail.mwi.updated`
events, and `GET /api/v1/voicemail-boxes` carries no counts (the count exists, but only on
`GET /:id/messages` as `mailbox.newCount`). The reasoning in `voicemail-screen.tsx:38` is sound —
"I have not been told" and "there are none" are different facts. It still means the primary number
on that screen is blank on every page load until something happens while you watch. A single
grouped count over the page's 20 mailbox ids would fill it truthfully.

### F9 — P2 — a mailbox owner's message actions are not audited

`voicemail-message.update` and `voicemail-message.delete` produce no audit rows, while every
configuration write does. Deleting a customer's message is the one voicemail action somebody later
asks "who did that?" about.

## Fixes applied

| File                                                 | Change                                                                                                                                  | Tests                                |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `apps/engine/src/routing/plan-walker.ts`             | `recordExtension` — honour `extension.record_policy` after the bridge                                                                   | 5 new in `plan-walker.spec.ts`       |
| `apps/engine/src/routing/plan-walker.ts`             | `originate` catch fixes the leg's cause to `USER_NOT_REGISTERED`                                                                        | 1 new in `plan-walker.spec.ts`       |
| `apps/engine/src/routing/routing-artifact.source.ts` | `lastWatchEntryAt` on `stats`                                                                                                           | covered via health                   |
| `apps/engine/src/health/health.controller.ts`        | `routing` section on `/healthz`, reported never status-deciding                                                                         | 3 new in `health.controller.spec.ts` |
| `apps/engine/src/routing/plan-walker.spec.ts`        | harness gained `canRecord` + a `legs.hangingUp` collector; added the missing `causeCode` on one pre-existing emit so the app typechecks | —                                    |

`bun test` in `apps/engine`: **1585 pass, 17 skip, 0 fail**. `tsc --noEmit`: clean.
Nothing was committed and no git state was changed.

## Needs restart to verify

`apps/engine` — all four engine changes. Until it restarts:

- extension record policy still records nothing (F2);
- refused legs are still filed as answered (F3);
- `/healthz` has no `routing` section;
- and, independently of my changes, **the engine is serving a routing artifact from ~16:44** (F4),
  so scenarios 10, 17, 18 and 20 cannot be re-run meaningfully until it does. A restart will also
  clear F4's symptom without fixing its cause — take the `lastWatchEntryAt` reading afterwards and
  watch whether it goes stale again.

## Measurements

- Ring latency (dial click → callee's Answer button): **301 / 811 / 849 ms** across three runs.
- Answer → two-way audio: under 1 s; 31–32 inbound packets and energy 0.53 within the first poll.
- Voicemail: hangup → row visible **< 15 s** (message filed within ~1 s; the mail and MWI follow).
- Webhook backoff: attempt 1 at +0, attempt 2 at **+1003 ms**, attempt 3 at **+3004 ms** —
  `1000 × 2^(n-1)`, exactly as `PBX_WEBHOOK_RETRY_BASE_MS` specifies.
- Webhook auto-disable: at **24** consecutive failures against a limit of 20 (the overshoot is the
  in-flight fan-out, not a counting error).
- CDR keyset paging: 147 rows over 30 pages of 5, **0 duplicates**, last page **6 ms**.
- CDR export: 13 rows / 4 233 B, queued → succeeded in **~13 s**.
- Live channel: `snapshot` within **8 ms** of `subscribe`; call events arrive **sub-millisecond**
  after the engine publishes them.
- 60 s API pause: socket closed and reopened; no data loss observed on resubscribe.

## Could not test, and why

- **Queue recording policy, recording on the call detail, stop-recording mid-call** — all blocked by
  F4 (a new queue never reaches the engine) and F2 (nothing records). Re-run after the restart.
- **Default voicemail greeting / hold music audio** — no prompt pack on this deployment; `mediad`
  refuses every `sound:` reference.
- **Webhook delivery over TLS** — the API process has no `NODE_EXTRA_CA_CERTS`, so it cannot trust
  the stack's self-signed cert, and the API refuses to _store_ an `http://` endpoint. Delivery,
  signature and retry were therefore measured against a plain-HTTP receiver after rewriting that one
  subscription's `url` directly in Postgres (logged in `STACK.md`). The admission rule itself was
  tested through the API and is intact; what is untested is a genuine TLS delivery.
- **`cdr.read.own`** — deliberately not implemented (`cdr.controller.ts` explains at length that
  `cdr-db` holds no user ids); a holder of only that grant gets a 403 naming what is missing, which
  is the documented behaviour.
- **CDR filter refetch in the browser** — my selector did not find the search input within the
  debounce window. The query key already carries the whole query object
  (`query-keys.ts:207`), so the keying half of the fixed bug is correct by inspection.
