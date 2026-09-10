# GAP2026 — AREA=survey-final

Branch `feat/optimiq-pbx-phase0`. Nothing committed, staged or stashed.

Two tasks. Both **PASS**, both live-proved end to end with real browser softphones.

| #   | Task                                                                           | Code | Tests                                                                  | Live proof                                                                      |
| --- | ------------------------------------------------------------------------------ | ---- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | DTMF from a detached browser leg reaches the survey collector                  | done | 3 new engine specs + a harness that models the digit source's lifetime | **PASS** — `queue_survey_response` has `q1=5, q2=4` from two browser softphones |
| 2   | Survey summary + per-call answers on the reports, through a cross-DB read port | done | 7 mocha + 8 bun                                                        | **PASS** — the row from step 1 renders on `/reports`                            |

---

## 1. Why the digits went nowhere — and it was neither hypothesis

Both hypotheses in the brief pointed at the media plane or at a wrong leg id. **Neither is what
happened, and both were ruled out by reading rather than by guessing:**

- **`apps/mediad` is innocent.** `internal/rtp/dtmfdetect.go` is a **tap on the receive path**
  (`session.go:538`, ahead of the suppression gate and ahead of the relay), so a digit is detected
  whether or not the leg is bridged — the file says so itself, for the IVR case. `Manager.Unbridge`
  (`manager.go:597`) clears the two peer pointers and the transcoders and **leaves both sessions
  alive**; the read loop is untouched. `LifecycleAnnouncer.DtmfReceived` (`lifecycle.go:363`)
  publishes `media.dtmf.received` unconditionally. **No Go change was needed and none was made.**
- **The engine's subscription was on the right leg.** `ChannelOrchestrator.onDtmf`
  (`channel-orchestrator.service.ts:3756`) emits `legSignalKey(mediaChannelId)` before anything can
  consume the digit, and the queue's port watches exactly that key for the caller's own leg.

**The true cause is a LIFETIME, and it is one `finally`.**

`PlanWalker.queueNode` closed the queued caller's DTMF watch in a `finally` around
`QueueSession.run()`:

```ts
} finally {
    this.queueDigitUnwatch?.();      // plan-walker.ts, before this pass
    this.queueDigitUnwatch = undefined;
}
```

`run()` returns **the moment the caller is bridged to an agent** — that is what `answered` means.
The survey runs from the bridge's `onEnded` callback, minutes later. So by the time
`runQueueSurvey` first called `pollDigit()`, the signal-bus subscription had already been dropped
and the array behind it had no writer. Every keypress a surveyed caller made was emitted onto a key
nobody was watching, silently, and the survey timed out on every question. That is why
`queue_survey_response` had **zero rows for the feature's entire history** while nine unit specs
passed: the fake `pollDigit` in `queue-session.spec.ts` had no lifetime at all, so it answered
happily from a source the real implementation had closed.

It also explains the two symptoms exactly: mid-bridge digits work (the watch is still open), and an
IVR works (a different node, a different watch, still open when it polls).

### The fix — the session owns the digit source, because only it knows when digits stop being wanted

- **`QueueCallPort.releaseDigits?(): void`** (`apps/engine/src/queue/queue-session.ts`) — a new
  optional member. The walker implements it as the idempotent unwatch plus emptying the buffered
  array, so a stale keypress cannot answer a later question.
- **`QueueSession.run`** now wraps its body and releases the source in a `finally` **unless a survey
  is still owed**. `surveyPending` is set only when `bridge` with `keepCallerOnPeerEnd` actually
  succeeded — a failed bridge produces no `onEnded` to run a survey from, and a source left open
  with nothing to close it would be a real leak.
- **`QueueSession.runSurvey`** wraps `askSurvey` and releases the source in its own `finally` — on
  every exit, including the ones that never ask a question (`survey === undefined`, the caller went
  with the agent, the leg is tearing down). It is the last reader, so it is the closer.
- **`PlanWalker.queueNode`**'s `finally` became a `catch`: the net for a session that threw before it
  could release, and nothing more. `releaseQueueDigits()` is idempotent for that reason.

Files: `apps/engine/src/queue/queue-session.ts`, `apps/engine/src/routing/plan-walker.ts`.

### The specs — and the harness change that is the real regression guard

`queue-session.spec.ts`'s fake now **models the source's lifetime**: `pollDigit` answers `undefined`
once `releaseDigits` has been called, and the release empties the pressed queue. That single change
makes the pre-existing spec _"asks the caller once the agent's leg has gone and reports what they
pressed"_ fail against the old code — which is the property a unit test for this feature should
always have had.

Three specs added on top:

- `keeps the caller's digit source open past `run`, and closes it once the survey is over` — asserts
  `{open: true, released: 0}` with the call still up, and `{open: false, released: 1}` after the
  survey, with the answer reported.
- `closes the digit source with the session when the queue has no survey` — no leak on the common path.
- `closes the digit source when the caller went with the agent` — a survey that never asks anything
  still closes what it was left open for.

`apps/engine`: **2060 pass, 12 skip, 0 fail** (87 files). Typecheck clean.

### Live proof — two browser softphones, a 2-question survey, answers stored

`<scratchpad>/e2e/calling/int2a-survey.mjs`, re-run unchanged after an engine restart. 2003 calls the
CC2026 queue on 2910, 2002 answers, 2002 hangs up, the caller stays up and presses **5** then **4**:

```
caller panel after the agent hung up
  … | 2910 | Connected · 0:07 | Mute | Hold | Hang up | Transfer | 1 2 3 4 5 …
digit 5   { keypadMatches: 1, clicked: "yes" }
digit 4   { keypadMatches: 1, clicked: "yes" }
queue_survey_response  [ "q1=5", "q2=4" ]
```

and the engine's own log for that call (`08:26:31`):

```
"the agent's leg ended; the caller was kept out of the bridge"
```

with **no** "the caller hung up before question 2 of the survey" line after it — the note that
appears on every earlier run in `logs/engine.log`. `queue_survey_response` went from **0 rows ever**
to two.

---

## 2. The survey on the reports — a cross-database read port, joined by call id

### The port, and why it is a port

The answers are in `pbx-db` and the calls are in `cdr-db`. There is no statement that can name both,
and the two areas are conditionally-composed siblings that must not import each other's database
package. So this follows the module's established shape exactly — declare in the consumer, implement
in the owner, bind in `pbx-cdr-ports.module.ts`, inject `@Optional()`:

- **`apps/api/src/cdr/query/queue-survey.port.ts`** (new) — `CDR_QUEUE_SURVEY`, `QueueSurveySource`
  with `summaries()` and `answersForCalls()`, and the three row shapes.
- **`apps/api/src/pbx/shared/queue-survey-source.service.ts`** (new) — the implementation, one
  tenant-scoped statement per call: `count(*) filter (where answer = n)` for each of 1-5 grouped by
  question, joined to `queue_survey_question` for the label and position **inside the same
  database**, which is the join that is allowed.
- **`apps/api/src/pbx/pbx-cdr-ports.module.ts`** — bound on `PBX_DATABASE`, exported.

**The join is in the service, by call id and by queue id**, exactly as the brief asked. Both reads
happen outside the CDR transaction, because it is a different pool with a different tenant scope.

### What the endpoints now carry

- `GET /api/v1/cdr/queue-stats` — each row gains **`survey?: QueueSurveySummary`** (per question:
  label, position, response count, a five-entry distribution, and an average to one decimal; plus a
  queue-level roll-up). Same route, same `queues.monitor` grant, same window — no new endpoint,
  because a second one would be a second window to keep in step.
- `GET /api/v1/cdr/calls/:callId` — gains **`survey: QueueSurveyCallAnswer[]`**, the caller's own
  answers, read only **after** the existing `.own` check has let this session see the call.

Three decisions worth naming:

1. **Absent, not empty.** A queue nobody rated carries no `survey` key at all. "No survey configured"
   and "a survey nobody answered" are different facts, and a panel that rendered zeros for both would
   report the second as the first.
2. **An unanswered question has no average.** `null`, never `0.0` — there is no row for a caller who
   pressed nothing, so nothing here invents one.
3. **Fail-soft.** An unreachable `pbx-db` costs the report its survey and nothing else: the service
   level is the answer the endpoint exists for, and a supervisor's screen must not 500 because the
   other database blinked. Both call sites log and carry on.

### The web

- `lib/cdr/contracts.ts` — `QueueSurveySummary`, `QueueSurveyQuestionSummary`,
  `QueueSurveyCallAnswer`; `QueueStatsRow.survey?`; `CallDetail.survey`.
- `lib/cdr/queue-survey.ts` (new, pure) — `surveyTone`, `formatSurveyAverage`, `surveyBarPct`,
  `surveyAnswerCount`, `ratedQueues`, `orderedCallAnswers`, `surveyResponseCount`.
- `app/(app)/reports/_components/queue-survey-panel.tsx` (new) — a **Survey panel** on the reports
  page: only queues somebody actually rated, **worst average first**, each question with its count,
  its average and its five score bars. A mean of five 4s and a mean of one 5 and four 3s are the same
  number and not the same queue, which is why the distribution is drawn beside the average. Queue
  names join from the roster this app already has, as the agent table's do.
- `app/(app)/reports/_components/reports-screen.tsx` — the section, on `queues.monitor` (the grant
  the endpoint carries), with its own permission fallback like the two beside it.
- `app/(app)/cdr/_components/call-detail.tsx` — a **Post-call survey** block under the leg tree,
  rendering nothing at all for the overwhelming majority of calls that were never surveyed.

### Tests

- `apps/api/test/cdr/queueSurveyReport.test.ts` (new, **7 passing**): the aggregation (five counts,
  two questions, order by position, `null` for nobody), the empty-call-ids short circuit that asks
  the database nothing, the queue-id join with an unrated queue left without a `survey`, the two
  fail-soft arms (port throws / port absent), and the call-id join in both directions.
- `apps/web/lib/cdr/queue-survey.spec.ts` (new, **8 passing**): the null-is-not-zero trap, the two
  tone thresholds, a division by an empty distribution, a short distribution read as zeros, and the
  rated-queue filter and ordering.

### Live proof — the row from step 1, in the report and on the screen

`<scratchpad>/e2e/calling/survey-report.mjs` (new), against the running api:

```
GET /api/v1/cdr/queue-stats   → queue 01a089b2-… survey: responses 2, average 4.5
   "Was your problem solved?"  responses 1  distribution [0,0,0,0,1]  average 5
   "How was the agent?"        responses 1  distribution [0,0,0,1,0]  average 4
GET /api/v1/cdr/calls/3aaba8d6-4c59-339d-b1df-63b722c02b01
   → survey: [ {position 1, "Was your problem solved?", answer 5},
               {position 2, "How was the agent?",       answer 4} ]
```

`<scratchpad>/e2e/calling/survey-ui.mjs` (new), the real `/reports` page in Chromium as the org owner
— screenshot at `<scratchpad>/e2e/artifacts/calling/survey-report.png`:

```
Post-call survey
QUEUE                          QUESTION                    ANSWERS  AVERAGE   SCORES
CC2026 Queue  4.5 / 5 overall  Was your problem solved?    1        5.0 / 5   5 ▇ 1 (100%)
                               How was the agent?          1        4.0 / 5   4 ▇ 1 (100%)
```

The queue is named from the roster, the call id is the one the browser softphones produced, and the
answers are the two digits that were clicked. End to end.

---

## Contracts, migrations, permissions

- **`packages/events` — unchanged.** No wire contract moved; codegen untouched.
- **No migration.** `queue_survey_question` / `queue_survey_response` already exist from the
  contact-centre pack; nothing was added. `MIGRATION-LOCK-*` was never taken.
- **No new permission.** The summary rides `queues.monitor` (the endpoint's existing grant) and the
  per-call answers ride the call's own `cdr.read.own` check.
- **No new NATS subject, stream or KV bucket**, so `config/nats.conf` was not touched and no HUP was
  owed.
- **No Go change.** `apps/mediad` was read and cleared, not edited; mediad was never restarted.

## Verification

| Package                 | typecheck                          | tests                                                      |
| ----------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `@optimiq-voice/engine` | clean                              | **2060 pass, 12 skip, 0 fail** (87 files)                  |
| `@optimiq-voice/api`    | clean (both configs)               | **1779 passing, 0 failing**; `check:di` clean, 217 classes |
| `@optimiq-voice/web`    | clean                              | **1079 pass, 0 fail** (56 files)                           |
| `oxlint` / `oxfmt`      | clean over every directory touched |                                                            |

## Files touched (for re-verification)

**apps/engine**

- `src/queue/queue-session.ts`
- `src/queue/queue-session.spec.ts`
- `src/routing/plan-walker.ts`

**apps/api**

- `src/cdr/query/queue-survey.port.ts` _(new)_
- `src/cdr/query/cdr.service.ts`
- `src/pbx/shared/queue-survey-source.service.ts` _(new)_
- `src/pbx/pbx-cdr-ports.module.ts`
- `test/cdr/queueSurveyReport.test.ts` _(new)_

**apps/web**

- `lib/cdr/contracts.ts`
- `lib/cdr/queue-survey.ts` _(new)_
- `lib/cdr/queue-survey.spec.ts` _(new)_
- `app/(app)/reports/_components/queue-survey-panel.tsx` _(new)_
- `app/(app)/reports/_components/reports-screen.tsx`
- `app/(app)/cdr/_components/call-detail.tsx`

**scratchpad (not the repo)**

- `e2e/calling/survey-report.mjs` _(new)_, `e2e/calling/survey-ui.mjs` _(new)_,
  `e2e/artifacts/calling/survey-report.png`

## Cross-area, left standing

1. **The softphone's `Sent:` echo still does not appear for digits pressed on a detached leg.** The
   digits demonstrably ARRIVE — `queue_survey_response` proves it — so this is a display-only gap in
   `apps/web/lib/softphone/call-state.ts`'s `DTMF_SENT` guard (`status !== "active"` returns the
   state unchanged) rather than a media or signalling fault. Not fixed here: it is the softphone
   pack's file and the feature works without it.
2. **`packages/cdr-db/src/retention.ts:111`** — `any(…::uuid[])` still invalid SQL for two or more
   ids. Reported twice before this pass; still open, and not this area's.
