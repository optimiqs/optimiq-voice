# GAP2026 — recording compliance, proved against the running stack

2026-09-10 06:00–06:20 UTC. Standing local stack (api 3200, engine 9300, sipd 9290, mediad 9291,
web 3300, Postgres 5533), org `01a08708-4cd4-76b9-b56d-d26ebf326b0a`, SIP realm `local.test`.
Everything below was configured through the real HTTP API and driven through the real browser
softphone at `http://127.0.0.1:3300/softphone` (Playwright, real WebRTC), reusing
`e2e/calling/harness.mjs` + `phones.mjs`.

| #   | Proof                                                   | Verdict                                                                                                                            |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Outbound recorded call announces, then records          | **PARTIAL FAIL** — announcement is issued to BOTH legs and the recording starts, but the play to the far end was discarded unheard |
| 2   | Declined keypress stops the recording; accept allows it | **PASS**                                                                                                                           |
| 3   | Erasure preview + apply + idempotence + audit + 403     | **PASS after two defects were fixed** (both 500s on first run)                                                                     |
| 4   | DTMF auto-pause yields a real silence gap               | **PASS**                                                                                                                           |

Scripts and raw output: `e2e/artifacts/recording/` (`rec-*.mjs` are the runners, `p*.log` / `p*.txt`
the captures).

## Test fixtures used

The concurrent agent driving 2001–2003 (queue 2910, click-to-call to PJSIP/1001) collided with the
first attempts — a consent gate cannot be proved on a leg something else answers. Two DEDICATED
extensions were created for this pass and deleted afterwards:

- `7001` "Recording Proof A" and `7002` "Recording Proof B", each with its own signed-up, verified
  user (`recmtv4dobr-7001@local.test`, `recmtv4dobr-7002@local.test`) — `rec-setup.mjs`.
- DID `+13125559911` "GAP2026 recording proof DID" → extension 7002. NPA 312 is **US-IL**, one of
  `DEFAULT_ALL_PARTY_REGIONS`; that is what makes the announcement owed to BOTH parties.
- A voicemail box `7002` for proof 3.

An outbound recorded call was expressed with the loopback that already exists on this stack:
outbound route "Compliance Proof Route" (prefix `9`, strip 1, prepend `+1`) → trunk
"Compliance Proof Trunk" (`127.0.0.1:5162`, sipd's own carrier profile) → the DID arrives back
inbound and routes to 7002. Dialling `93125559911` from 7001 is therefore a real outbound call over
a trunk whose far end is the recorded extension.

---

## Proof 1 — the announcement on an outbound recorded call: PARTIAL FAIL

### Commands

```sh
cd <S>/e2e/calling
REC_A=7001 REC_B=7002 REC_TARGET=93125559911 node rec-p1.mjs     # p1-run5.log
node rec-p1b.mjs                                                  # p1b-announce.log (tones muted)
```

Configuration, through the API:

```
PATCH /api/v1/org-settings/categories/recordings  {"consentPolicy":"announce"}
PATCH /api/v1/extensions/<7002>                   {"recordPolicy":"all"}
```

### What passed

**Both legs were played the prompt, on their own media channels, and the recorder started 1 ms
later.** mediad (`e2e/logs/mediad.log`, local time = UTC−05:00):

```
01:02:05.98784  "playback started"  sessionId 01a089e8-ba46-7340-a945-58efed94c093  playbackRef 01a089e8-bb22-76fe-9b3f-6d4813e4ff71  frames 52
01:02:05.988745 "playback started"  sessionId 01a089e8-ba48-761a-94cb-971cb0f109c4  playbackRef 01a089e8-bb24-709b-9960-49978717b00c  frames 52
01:02:05.989531 "recording started" sessionId 01a089e8-ba46-7340-a945-58efed94c093  recordingRef 01a089e8-bb24-709b-9960-4d80c9d1eabe  direction both
```

`...ba46` is the recorded (A) leg, `...ba48` is its bridge peer — the two sessions mediad had just
bridged (`01:02:05.985098 "sessions bridged" sessionIds [...ba46, ...ba48]`). 52 frames = 1.04 s of
prompt. The recording began 1 ms after the announcement was issued, never before it.

Engine (`e2e/logs/engine.log`) shows the call really did leave over the trunk and come back in:

```
06:02:05.761 "resolved a route" context "outbound" reason "matched outbound route \"Compliance Proof Route\"" from 7001 dialed 93125559911
06:02:05.766 "attributed an inbound call from the did-index bucket"
06:02:05.767 "resolved a route" context "inbound" entryNodeId "extension:01a089e8-6e42-7356-9dd7-ce5d4088d764" reason "matched the DID's own destination"
06:02:05.991 "the routing walk finished" status "bridged" destinationType "extension"
```

**The consent record travelled with `channel.record.started` and landed on `recordings.consent`**
(`optimiq_cdr`):

```
id      | 01a089e8-bb2e-700d-88c7-859671444f0d
consent | {"at": "2026-09-10T06:02:05.988Z", "method": "announcement", "policy": "announce",
           "outcome": "announced", "parties": ["caller", "callee"], "regions": ["US-IL"]}
```

`parties` names both sides and `regions` names the jurisdiction that forced it — the all-party
upgrade in `resolveRecordingConsent` fired off the DID's own NPA.

For contrast, the same call placed extension-to-extension (`rec-p1.mjs` without a DID, p1-run2.log)
produces `parties: ["caller"]` and no `regions`: two extension numbers touch no jurisdiction, so
only the recorded leg is told. That is the designed behaviour, and it means **a plain internal
recorded call never announces to the far end.**

### What failed

The play to the peer was **discarded unheard**. mediad, 20 ms after issuing it:

```
01:02:06.009036 WARN "a playback failed; the far end heard part of a prompt or none of it"
  sessionId 01a089e8-ba48-761a-94cb-971cb0f109c4  playbackRef 01a089e8-bb24-709b-9960-49978717b00c
  playedMs 0  detail "rtp: sending a playback frame to 127.0.0.1:9: WebRTC media is not connected"
```

The far end's audio energy agrees. `rec-p1b.mjs` zeroes both softphones' oscillators BEFORE the
answer, so the only audio either party can receive is the prompt itself; the callee's inbound
energy is **0.000000 in every one of the 23 consecutive ~150 ms windows** from answer to +3.6 s
(`p1b-announce.log`), including the window the prompt was played in.

Why: the recording (and therefore the gate) starts the instant the bridge exists — 157 ms after the
callee answered — and a browser far end has not finished ICE/DTLS by then. mediad had no RTP target
and dropped 52 frames on the floor. The play to the _other_ leg in the same run, `...ba46`, a plain
RTP trunk leg, logged no such warning: an RTP far end does hear it.

**The defect this exposes is not the race itself but the record.** `CallControl.announceConsent`
counts a party as having heard the prompt when `media.play` resolves, and `media.play` resolves on
acceptance, not on completion. The consent record above therefore states `outcome: "announced",
parties: ["caller","callee"]` for a call on which the callee heard nothing — the one claim the
record exists to be able to make. Closing it needs a playback-completion signal from mediad back
into `CallControl`, which is `apps/engine/src/media/**` and `apps/mediad/**` — outside the files
this pass may touch, and mediad may not be restarted. **Reported, not fixed.**

Verdict: **PARTIAL FAIL.** The mechanism is present and correct up to the media plane; the far end
did not hear the announcement, and the consent record says it did.

---

## Proof 2 — a declined keypress stops the recording: PASS

Direct internal call 7001 → 7002 (so the recorded A-leg is the browser that presses the digit).

```sh
REC_DIGIT=2 node rec-p2.mjs     # decline
REC_DIGIT=1 node rec-p2.mjs     # accept
```

```
PATCH /api/v1/org-settings/categories/recordings {"consentPolicy":"announce-and-require-keypress"}
PATCH /api/v1/extensions/<7002>                  {"recordPolicy":"all"}
```

Read back: `consentPolicy "announce-and-require-keypress"`, `consentAcceptDigit "1"`,
`consentDeclineDigit "2"`.

### Decline — `2` pressed at 06:04:39.004Z on the recorded leg

Engine refused the recording and named the decline:

```
06:04:39.129 "extension 7002 has a record policy of \"all\" and the recording was refused:
              the party declined to be recorded, so this call was not recorded;
              the call was connected without it"
06:04:39.131 "the routing walk finished" status "bridged" destinationType "extension"
             notes ["extension 7002 has a record policy of \"all\" and the recording was refused: ..."]
```

The call stayed up and **no recording object was written** — the newest `recordings` row at that
moment was still 06:03:43, from the previous proof:

```sql
select id, created_at, consent from recordings where created_at > '2026-09-10T06:03:00Z';
-- 01a089ea-38ed-73fe-b607-e2b279c90777 | 2026-09-10 06:03:43.724089+00 | {... "outcome": "announced" ...}
-- (1 row)  -- nothing at 06:04
```

The CDR leg carries the verdict (`optimiq_cdr.call_legs`):

```
id                        | 01a089eb-0a9b-7338-ba58-1b4dbba3fc88
from_number               | 7001
to_number                 | 7002
recording_consent         | declined
recording_consent_method  | keypress
recording_consent_at      | 2026-09-10 06:04:39.128+00
recording_consent_regions |
```

### Accept — `1` pressed at 06:05:10.017Z

A recording **was** written, and its consent says so:

```
id          | 01a089eb-8a84-761d-b817-68c8b4c18758
object_key  | .../5d5fb083-7100-3221-a53f-e94504296855/01a089eb-8a7b-73c2-b68d-4baaefc19046.wav
duration_ms | 5920
consent     | {"at": "2026-09-10T06:05:10.138Z", "method": "keypress",
               "policy": "announce-and-require-keypress", "outcome": "accepted", "parties": ["caller"]}
```

and the leg:

```
id                       | 01a089eb-83c4-7943-858e-2b9125669544
recording_consent        | accepted
recording_consent_method | keypress
recording_consent_at     | 2026-09-10 06:05:10.138+00
```

Verdict: **PASS**, both halves.

---

## Proof 3 — erasure preview and apply: PASS, after two defects

Subject: extension `7002` (an extension selector matches `call_legs.from_number`/`to_number`, the
voicemail box of that number, and every recording of a call one of whose legs touched it).
Fixtures: one live recorded call, one voicemail message left by 7001 in box 7002, 18 CDR legs.

```sh
node rec-p3-call.mjs   # a fresh recorded call, so the apply has a live object to destroy
node rec-p3-vm.mjs     # a real voicemail (no-answer -> greeting -> 15 s of tone)
node rec-p3.mjs        # preview x2, 403, apply x2, preview
```

### Defect A — the tombstone statement is not valid SQL for more than one id

First `POST /api/v1/erasure` returned **500**. `e2e/logs/api.log`:

```
DrizzleQueryError: Failed query:
  update "recordings"
  set "deleted_at" = $1::timestamptz, "updated_at" = $2::timestamptz
  where "id" = any(($3, $4, $5, $6, $7, $8, $9)::uuid[])
    and "deleted_at" is null
  returning "id"
code: '42846'   routine: 'transformTypeCast'
  at async CdrErasureService.eraseRecordings (apps/api/src/cdr/erasure/erasure.service.ts:135:22)
```

`42846` is _cannot cast type record to uuid[]_. The root cause is
`packages/cdr-db/src/retention.ts:111` `purgedRecordingSoftDeleteQuery`, which writes
`where "id" = any(${ids}::uuid[])`; drizzle expands a JS array bound there into a parenthesised
parameter LIST — a row constructor, not an array. One id survives by accident (`($1)::uuid[]` is a
cast of a scalar), which is why the retention sweeper's one-at-a-time caller never hit it and this
endpoint fails on its second row.

**It is worse than a 500.** The objects are deleted BEFORE the tombstone, so the failing statement
left seven recordings marked live with their audio already destroyed:

```
GONE    .../5613d662-.../01a089e8-bb24-709b-9960-4d80c9d1eabe.wav      (row still deleted_at IS NULL)
GONE    .../2f56b3cb-.../01a089ee-4c36-7018-ad0c-cd9e6820ec5e.wav
GONE    .../bdeee3c7-.../01a089f0-0582-716d-b090-2606ae11a20f.wav
```

`packages/cdr-db` is not a file this pass may edit, and the same broken helper is used by
`recording-retention-sweeper.service.ts:191` (which passes a whole batch — **that sweeper is broken
for any batch of two or more, and that is a live bug outside this feature; it is reported here for
whoever owns `packages/cdr-db`**). Fixed within scope by giving the erasure its own statement:
`apps/api/src/cdr/erasure/erasure.repository.ts` gains `erasureRecordingTombstoneQuery`, which
spells the ids out as individually cast values, and `erasure.service.ts` calls it.

### Defect B — `call_legs.raw` is NOT NULL

With A fixed, apply still 500'd, now later in the pipeline (recordings and voicemail were erased,
legs were not):

```
DrizzleQueryError: Failed query:
  update "call_legs" set ... "raw" = null where "organization_id" = $5::uuid and (...)
code: '23502'   routine: 'ExecConstraints'
detail: 'Failing row contains (01a089e8-ba48-..., ... )'
```

```sql
select column_name, is_nullable from information_schema.columns
where table_name='call_legs' and column_name in ('raw','sip_call_id',...);
-- raw | NO
```

The contract says "`raw` → null"; the column is `jsonb NOT NULL`, so that statement can never
succeed — and it fails _after_ the audio has been destroyed, which is the same partial-erasure
hazard as A. Fixed in `erasure.repository.ts` (`erasureLegRewriteQuery`) by writing `'{}'::jsonb`:
no signalling payload, satisfies the column, still distinguishable from a leg that was never
populated.

`apps/api` unit tests after both fixes: `cd apps/api && npx mocha test/cdr/erasure.test.ts` — **15
passing**, including "deletes the object before it tombstones the row, and keeps the leg" and
"reports zeroes on a second apply". `tsc --noEmit -p apps/api/tsconfig.json` reports nothing in
`erasure`. api restarted (see the restart log).

### The clean run — `p3-erasure-final.log`, `p3-before.txt`, `p3-after.txt`

Preview, twice, identical, and nothing moved between them:

```
POST /api/v1/erasure/preview {"extension":"7002"}
  -> {"recordings":2,"voicemailMessages":1,"callLegs":18,"objects":3}      (twice)
```

Permission gate — the same body from extension 7001's own user (org role `user`):

```
POST /api/v1/erasure -> 403
  {"message":"Missing required permission(s): recordings.delete.","error":"Forbidden","statusCode":403}
```

Apply:

```
POST /api/v1/erasure -> {"recordings":2,"voicemailMessages":1,"callLegs":18,"objects":3}
```

Objects **gone**, rows **kept and tombstoned**:

```
BEFORE  PRESENT 109804 bytes  .../e08cd766-.../01a089f4-92fa-766d-9c36-1fc99e40901d.wav
BEFORE  PRESENT 348204 bytes  .../35b97f3a-.../01a089f4-cd45-77eb-9c91-decf8ee40e9d.wav
AFTER   GONE                  (both)

id                                   | object_key            | deleted_at
01a089f4-9303-753d-bea9-945cab91bbd7 | .../01a089f4-92fa-... | 2026-09-10 06:16:00.421+00
01a089f4-cd48-733f-bab4-c2abf9c63b1a | .../01a089f4-cd45-... | 2026-09-10 06:16:00.421+00
```

Voicemail row **gone** (`01a089f5-225e-70ef-bcb4-c7038beaec19` → `count 0`).

CDR legs **kept**, numbers hashed, PII columns nulled, billing intact:

```
select count(*) from call_legs where from_number='sha256:2378926a9bcc79f385034655'
                                  or to_number='sha256:2378926a9bcc79f385034655';   -- 18
select count(*) from call_legs where from_number='7002' or to_number='7002';        --  0

id                   | 01a089f4-cd3c-7b04-b0aa-853f73f57de5
from_number          | 7001                                  <- the other party, untouched
to_number            | sha256:2378926a9bcc79f385034655
from_name            |            (null)
sip_call_id          |            (null)
account_code         |            (null)
remote_media_address |            (null)
raw                  | {}
billsec_ms           | 21787
duration_ms          | 21794
disposition          | answered
```

Idempotent — a second apply, and a third preview:

```
POST /api/v1/erasure         -> {"recordings":0,"voicemailMessages":0,"callLegs":0,"objects":0}
POST /api/v1/erasure/preview -> {"recordings":0,"voicemailMessages":0,"callLegs":0,"objects":0}
```

Audit (`optimiq_pbx.audit_log`), carrying the HASH and never the number:

```
action        | recording.erasure
actor_type    | user
actor_user_id | 01a08708-4c91-76bd-8093-951d38ba46f8
resource_type | recordings
before        | {"objects": 3, "subject": "sha256:2378926a9bcc79f385034655", "callLegs": 18,
                 "selector": "extension", "recordings": 2, "voicemailMessages": 1}
occurred_at   | 2026-09-10 06:16:00.433+00
```

```sql
select count(*) from audit_log where action='recording.erasure'
  and (before::text like '%7002%' or coalesce(after::text,'') like '%7002%');   -- 0
```

Verdict: **PASS** (after the two fixes above).

---

## Proof 4 — DTMF auto-pause is a real silence gap: PASS

```sh
REC_PAN="41112222" REC_TAIL=15000 node rec-p4.mjs
node rec-rms.mjs <objects>/.../01a089ee-4c36-7018-ad0c-cd9e6820ec5e.wav 4940 15740   # p4-rms.txt
```

```
PATCH /api/v1/org-settings/categories/recordings {"consentPolicy":"none","autoPauseOnDtmf":true}
PATCH /api/v1/extensions/<7002>                  {"recordPolicy":"all"}
```

Read back: `autoPauseOnDtmf: true`.

Call 7001 → 7002, answered, 5 s of two-way tone, then eight digits (`4 1 1 1 2 2 2 2`) at 250 ms as
if a card number were being keyed, then 15 s more audio, then hang up.

`recordings` row `01a089ee-4c3d-76fd-afed-01a6f54d9d36`, `duration_ms 22060`:

```
pauses | [{"endMs": 15740, "startMs": 4940}]
```

One interval, opened by the first digit (pressed at +5.00 s; the recorder paused at +4.94 s) and
closed by the quiet window after the entry stopped — exactly the "one window, refreshed by every
digit" shape the design argues for, not eight intervals. `channel.record.stopped` is what carries
it: the `pauses` column is written by the recording writer from that event, and the column was
empty on every other recording in this pass.

**The audio itself.** 8 kHz mono PCM16, RMS per 100 ms window (`p4-rms.txt`):

```
BEFORE the pause  {"fromMs":0,    "toMs":4940,  "windows":50,  "min":0.441664,"max":0.735955,"mean":0.722068}
INSIDE the pause  {"fromMs":4940, "toMs":15740, "windows":108, "min":0,       "max":0.567699,"mean":0.005256}
AFTER  the pause  {"fromMs":15740,"toMs":22000, "windows":62,  "min":0.735791,"max":0.735846,"mean":0.735821}
```

Per-window, at the boundaries: `... 0.735897, 0.717093, 0.441664, 0, 0, 0, ...` (106 consecutive
windows of exact `0.000000`) `... 0, 0.567699, 0.735807, 0.735807, ...`. Ten and a half seconds of
digital silence where the digits were, full-level audio either side of it, in one file with one
object key.

A control run with a single digit (`REC_PAN=5`) resumed on its own after exactly 3.00 s —
`pauses [{"startMs": 4980, "endMs": 7980}]` — which is `recordingAutoResumeMs`'s default.

One observation, not a failure: on a 16-digit run the interval ran to the end of the recording
(`[{"startMs":4960,"endMs":18220}]`, `duration_ms 18220`) even though the last button was clicked
9 s before hangup. The digits reach the engine noticeably later than the browser clicks them, so
the quiet window kept being refreshed past the hang-up. Worth knowing if a PCI window is ever tuned
below the DTMF delivery latency, but the pause covered the entry — which is the requirement.

Verdict: **PASS**.

---

## Defects found

1. **`packages/cdr-db/src/retention.ts:111` `purgedRecordingSoftDeleteQuery` builds invalid SQL for
   more than one id** (`any((...)::uuid[])` → Postgres `42846`). Broke `POST /api/v1/erasure`
   outright, and — because the objects are deleted first — destroyed the audio of seven recordings
   while leaving their rows marked live. It equally breaks
   `recording-retention-sweeper.service.ts:191`, which passes a whole batch. **NOT FIXED — another
   area's file.** Worked around inside `apps/api/src/cdr/erasure/` with a correct statement.
2. **`erasureLegRewriteQuery` sets `call_legs.raw = null` on a `jsonb NOT NULL` column** (`23502`),
   failing the leg rewrite after the media was already destroyed. **FIXED** in
   `apps/api/src/cdr/erasure/erasure.repository.ts` → `'{}'::jsonb`.
3. **A consent record can claim a party was announced to when the prompt was demonstrably never
   delivered.** `CallControl.announceConsent` treats `media.play` resolving as "heard"; mediad
   reported `playedMs 0 / WebRTC media is not connected` 20 ms later, and the far end's audio energy
   was zero across the whole announcement. **NOT FIXED** — the completion signal would have to come
   from `apps/engine/src/media/**` / mediad, which are out of scope and must not be restarted.

Files changed (uncommitted, unstaged — both are new-in-this-feature files):

- `apps/api/src/cdr/erasure/erasure.repository.ts` — new `erasureRecordingTombstoneQuery`;
  `raw = '{}'::jsonb` in `erasureLegRewriteQuery`.
- `apps/api/src/cdr/erasure/erasure.service.ts` — calls the new query instead of the cdr-db helper.

## Restarts

`api` only, twice, both after changing `apps/api/src/cdr/erasure/**`. Logged in `STACK.md`.
sipd and mediad were not restarted. engine was not restarted (it already carried the new code).

## Data touched, and how it was restored

| Touched                                                                                                                                                 | Restored                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| org setting `recordings.consentPolicy` (`none` → `announce` → `announce-and-require-keypress` → `none`)                                                 | back to `"none"`                                                                                 |
| org setting `recordings.autoPauseOnDtmf` (`false` → `true`)                                                                                             | back to `false`                                                                                  |
| org settings `consentPromptId` / `consentAcceptDigit` / `consentDeclineDigit` / `allPartyRegions`                                                       | never changed; re-asserted at their original values (`null`, `"1"`, `"2"`, the 14 defaults)      |
| extension `2002.recordPolicy` (`none` → `all`) — the first two runs, before the dedicated pair existed                                                  | back to `"none"`                                                                                 |
| extension `2001.callerIdNumber` (`null` → `+13125557001`) — an experiment that proved caller ID is not what carries the jurisdiction on an internal leg | back to `null`                                                                                   |
| extensions `7001` / `7002` + their users, created for this pass                                                                                         | extensions DELETED; the two `local.test` user accounts remain (there is no delete-user endpoint) |
| voicemail box `7002`, created for this pass                                                                                                             | DELETED                                                                                          |
| phone number `+13125559911`, created for this pass                                                                                                      | DELETED                                                                                          |
| `e2e/calling/world.json` (7001/7002 merged in)                                                                                                          | restored from `e2e/artifacts/recording/world.json.backup`                                        |

Verified after cleanup: `recordings` category reads exactly its pre-run values; 2001/2002 read
`record_policy none`, `record_auto_pause_on_dtmf false`, `caller_id_number null`; no `+13125559911`;
no mailbox `7002`; no extension labelled "Recording Proof".

**Destroyed and not recoverable, by design:** the recordings, the voicemail and the CDR-leg numbers
of the 7001↔7002 calls this pass itself created — that is what proof 3 does. Nothing belonging to
another agent's extensions was in the erasure subject (`7002` matched only rows this pass made).
Seven of those recordings' objects were destroyed by defect 1's partial failure before their rows
were tombstoned; they were this pass's own calls, and the rows were tombstoned by the clean run.

---

# Re-proof — proof 1, after the announcement-delivery fix

2026-09-10 06:25–06:45 UTC, same stack, same org, same loopback topology (outbound route
"Compliance Proof Route" → trunk "Compliance Proof Trunk" → DID `+13125559911` → extension 7002).
Fixtures 7001 / 7002 and the DID were recreated for this pass and deleted again afterwards.

**The PARTIAL FAIL above stands as the record of the defect. This section supersedes its verdict.**

| #   | Proof                                          | Verdict then                                                         | Verdict now                                                               |
| --- | ---------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Outbound recorded call announces, then records | **PARTIAL FAIL** — prompt discarded unheard, record said "announced" | **PASS** — the far end hears the prompt and the record names both parties |

## What was wrong, precisely

Three things, and only the first was the one originally reported:

1. `announceConsent` played the prompt the instant the legs bridged. A WebRTC party has signalled
   `200 OK` by then and has NOT finished ICE/DTLS, so `mediad` wrote 52 frames into a transport with
   no peer (`playedMs 0`, `WebRTC media is not connected`) and the record still said `announced`.
2. The record's own wording claimed more than the engine can know. There is no playback-completion
   event anywhere above the media seam (`verb-executor.ts:240`; `MediaEvent` has no playback member),
   so `announced` can only ever mean "the media plane accepted this prompt for this party".
3. `resolveRecordingConsent` announced to the recorded leg ALONE on an outbound call with no
   jurisdiction match — i.e. it told the tenant's own agent and told the far end nothing, on exactly
   the call shape §6 of the contract says the announcement exists for.

## The fix — `apps/engine/src/calls/` only

`call-control.ts`:

- **Readiness gate.** Before playing at a party, `announceConsent` requires that party's leg to be
  answered: `host.legFor(id)?.isAnswered`, and when that is not yet true, a bounded wait on
  `legSignalKey(id)` for the `answered` signal the orchestrator's `emitLegProgress` publishes off
  `call-state-changed: active` — the same signal the walker's `ensureAnswered` waits on. Bounded by
  the new `CallControlSettings.consentPeerReadyTimeoutMs` (2 000 ms). Both parties are waited for
  concurrently, so a bridged pair costs one budget, not two.
- **A party with no evidence is left out.** Budget expired, leg ended, or `media.play` threw → that
  party is absent from `parties`. No party at all → the recording is refused, as the contract already
  required; that path is now exercised by the readiness failure too.
- **`consentMediaSettleMs` (1 500 ms), a declared stopgap.** Readiness alone was **measured live and
  found insufficient** — see the numbers below. `active` is a SIGNALLING fact and the WebRTC media
  path comes up after it, so the `active` wait returned in 0 ms and the prompt was still dropped.
  With no media-connected or playback-completion signal available above the seam, the gate waits on
  the clock once for the whole announcement before playing. It is paid only on announcing calls, only
  when at least one party is reachable, and it is that much conversation happening before the
  recorder starts. It becomes dead code the day the media plane reports delivery (below).
- **Honest wording** on `runConsentGate` and `announceConsent`, and in `docs/recording-compliance.md`:
  `announced` = the media plane accepted the prompt for that party on a leg that was carrying media.
  Never "the party heard it".

`recording-consent.ts`: `RecordingConsentCall` gains `direction`, and `announce` on an **outbound**
recorded call now reaches both sides regardless of jurisdiction. Inbound is deliberately unchanged —
there the recorded leg already is the member of the public and the jurisdiction upgrade is what adds
the tenant's side. `channel-orchestrator.service.ts` passes `aggregate.snapshot.direction`.

## The energy numbers — the callee's inbound audio, both softphone tones muted

`rec-p1b.mjs`, unchanged from the original run: 23 consecutive ~150 ms windows from the moment the
callee answers, measuring the **callee's** inbound RTP energy (`far`).

| Run                                          | Settle   | mediad                                   | far-end total energy | far-end per-window during the prompt |
| -------------------------------------------- | -------- | ---------------------------------------- | -------------------- | ------------------------------------ |
| original (`p1b-announce.log`)                | —        | `playedMs 0`, WebRTC media not connected | **0.000000**         | `0.000000` in all 23 windows         |
| readiness gate only (`p1b-announce-fix.log`) | 0 ms     | `playedMs 0`, same failure               | **0.000000**         | `0.000000` in all 23 windows         |
| + 758 ms settle (`p1b-announce-fix2.log`)    | 750 ms   | `playedMs 0`, same failure               | **0.000000**         | `0.000000` in all 23 windows         |
| + 1 509 ms settle (`p1b-announce-fix3.log`)  | 1 500 ms | **no playback failure at all**           | **0.100104**         | see below                            |

The passing run's windows, `msAfterAnswer → far ΔE`:

```
 152 0        1088 0          2021 0.013560     2955 0.005989
 307 0        1245 0          2177 0.014464     3110 0.000096
 464 0        1402 0          2331 0.013560     3265 0.000002
 621 0        1557 0          2486 0.014464     3422 0
 777 0        1711 0          2643 0.014464     3578 0
 932 0        1865 0.009944   2799 0.013560
```

Zero until 1 865 ms, materially non-zero for ~1.4 s, back to zero — the 1.04 s prompt (52 frames),
landing 1 509 ms after the bridge, on a call where the only possible source of audio at that ear is
the prompt itself (both oscillators muted; the caller's mute is confirmed in the log, and the
callee's own tone cannot reach the callee).

`mediad`, the passing run — two playbacks, no `WARN`:

```
01:36:10.522681 "sessions bridged"  bridgeId 01a08a07-ed9a-… sessionIds [01a08a07-eccc-…, 01a08a07-ecd0-…]
01:36:12.031546 "playback started"  sessionId 01a08a07-eccc-…  frames 52
01:36:12.033490 "playback started"  sessionId 01a08a07-ecd0-…  frames 52
01:36:12.034866 "recording started" sessionId 01a08a07-eccc-…  direction both
```

Compare the same three lines from the run 90 seconds earlier, with only the readiness gate:

```
01:34:16.673787 "sessions bridged"
01:34:17.431363 "playback started"  sessionId 01a08a06-2e37-…  frames 52
01:34:17.433162 "playback started"  sessionId 01a08a06-2e3b-…  frames 52
01:34:17.453505 WARN "a playback failed…" sessionId 01a08a06-2e3b-…  playedMs 0
                 detail "rtp: sending a playback frame to 127.0.0.1:9: WebRTC media is not connected"
```

`…2e3b` is the WebRTC callee leg — the peer of the recorded leg. **That is the measurement that
proves the readiness gate alone does not close it, and it is why the settle exists.** The browser's
media path came up between 830 ms and 1 260 ms after the answer on this machine.

## The consent record, from `optimiq_cdr.recordings`

```
01a08a07-f38e-7011-b51c-3714ffc8894e | 2026-09-10 06:36:12.043+00 |
  {"at":"2026-09-10T06:36:12.033Z","method":"announcement","policy":"announce",
   "outcome":"announced","parties":["caller","callee"],"regions":["US-IL"]}
```

Both parties, the jurisdiction that forced it, and — for the first time — **`mediad` reported no
failed playback on either leg for that call**, so the claim the record makes is true of the call it
describes. A full `rec-p1.mjs` run 23 s later (`p1-fix-run.log`, recording
`01a08a08-4db2-741f-93a1-c23bd076cf4a`, 06:36:35) is identical in shape.

Verdict: **PASS.** The far end's energy is materially non-zero across the announcement window, and
the recording starts afterwards with a consent record naming both parties.

## The outbound-direction change is NOT proved live, and here is why

It is proved in `recording-consent.spec.ts` (5 cases: inbound and unstated direction stay one-party,
outbound widens to both, an outbound keypress policy widens its announcement and not its question,
and `none` stays silent on an outbound call). It could not be exercised on this stack because
**there is no live path that puts the recorder on an outbound leg**: `recordPolicy` is a property of
the extension being REACHED, and `outbound_routes.recordEnabled` is read by nothing in the engine —

```
$ grep -rn "recordEnabled" apps/engine/src/routing apps/engine/src/calls | grep -v spec
apps/engine/src/routing/plan-fixtures.fake.ts:111:  recordEnabled: false,
apps/engine/src/routing/plan-walker.ts:109: * (`ConferencePlanNode.recordEnabled` is read by nothing) …
```

Two live attempts with the route's `recordEnabled` flipped to `true` (`p1-outbound-direction.log`,
`p1-outbound-direction2.log`) recorded the INBOUND leg only, exactly as before the flag was set.
**`outbound_routes.recordEnabled` and `ConferencePlanNode.recordEnabled` are settings the API accepts
and the engine ignores.** That is a separate gap, outside `apps/engine/src/calls/`, and it is
reported here rather than fixed.

## Still needs a media-plane change — the exact one

`consentMediaSettleMs` is a clock where a fact belongs. The fact already exists and is already on the
wire: `apps/mediad/internal/control/lifecycle.go:231` publishes **`playback.finished`** carrying
`playbackRef`, `reason` and `playedMs` — `apps/mediad/internal/rtp/manager.go:687` is the very line
that logs `playedMs 0`. The engine drops it: `apps/engine/src/media/mediad-event-mapping.ts` maps
only `session.ended`, `dtmf.received` and `recording.finished`.

Four steps, the first two outside this pass's files:

1. `apps/engine/src/media/media-event.ts` — add
   `MediaPlaybackFinishedEvent { type: "playback-finished"; playbackRef: string; playedMs: number;
reason: "completed" | "interrupted" | "error"; detail?: string }` to `MediaEvent` and to
   `MEDIA_EVENT_TYPES`.
2. `apps/engine/src/media/mediad-event-mapping.ts` — map `envelope.type === "playback.finished"` onto
   it (the payload fields already line up one for one).
3. `apps/engine/src/calls/channel-orchestrator.service.ts` — republish it on the signal bus under a
   new `playbackSignalKey(playbackRef)` (`call-signals.ts` gains the key and a `PlaybackSignal`).
4. `apps/engine/src/calls/call-control.ts` — `announceConsent` subscribes to that key BEFORE calling
   `media.play` (same subscribe-first race as `awaitLegEntered`), waits for the finish, and counts a
   party only when `playedMs > 0`. Then `consentMediaSettleMs` can be deleted, `announced` can
   honestly mean "delivered", and a party the prompt did not reach is refused rather than settled for.

Nothing in mediad needs to change; it is already saying it.

## Verification

```
pnpm --filter @optimiq-voice/engine run typecheck   # clean
pnpm --filter @optimiq-voice/engine run test        # 2025 pass, 12 skip, 0 fail (2037 across 87 files)
pnpm exec oxlint apps/engine/src/calls              # no findings
pnpm exec oxfmt apps/engine/src/calls               # 26 files, no rewrite needed
```

11 tests added (7 in `call-control.spec.ts`, 4 net in `recording-consent.spec.ts`); the suite was
2 014 before.

## Files changed by this pass (uncommitted, unstaged)

- `apps/engine/src/calls/call-control.ts` — readiness gate, settle, honest doc wording, two settings.
- `apps/engine/src/calls/recording-consent.ts` — `direction`, outbound widening.
- `apps/engine/src/calls/channel-orchestrator.service.ts` — passes the recorded leg's direction.
- `apps/engine/src/calls/call-control.spec.ts`, `recording-consent.spec.ts` — the cases above.
- `docs/recording-compliance.md` — what `announced` means, the readiness gate, the settle.

## Data touched, and how it was restored

| Touched                                                                           | Restored                                                                                                 |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| extensions `7001` / `7002` recreated for this pass                                | **DELETED** (their `local.test` users remain — no delete-user endpoint)                                  |
| DID `+13125559911` recreated; DID `+12125559912` created for the outbound attempt | **both DELETED**                                                                                         |
| org setting `recordings.consentPolicy` (`none` → `announce`)                      | back to `"none"`; the whole category re-read and matches its pre-run values field for field              |
| `7001` / `7002` `recordPolicy`, `recordAutoPauseOnDtmf`                           | moot — the extensions are gone                                                                           |
| outbound route "Compliance Proof Route" `recordEnabled` (`false` → `true`)        | back to `false`; the route and its trunk were pre-existing and are left as found                         |
| `e2e/calling/world.json`                                                          | restored to the `2001/2002/2003` baseline (pre-run copy at `e2e/artifacts/recording/world.json.prefix2`) |

Recordings and CDR legs created by this pass's own calls remain; nothing belonging to another agent
was touched, and nothing was erased.

---

# Re-proof 2 — proof 1, after the announcement became EVENT-DRIVEN

2026-09-10 06:55–07:10 UTC, same stack, same org, same loopback topology (outbound route
"Compliance Proof Route" → trunk "Compliance Proof Trunk" → DID `+13125559911` → extension 7002).
Fixtures 7001 / 7002 and the DID were recreated for this pass and deleted again afterwards.

**Both sections above stand as the record. This section supersedes the re-proof's mechanism: the
1500 ms `consentMediaSettleMs` sleep it introduced is DELETED.**

| #   | Proof                                          | Then (stopgap)                     | Now (event-driven)                                 |
| --- | ---------------------------------------------- | ---------------------------------- | -------------------------------------------------- |
| 1   | Outbound recorded call announces, then records | **PASS**, on a fixed 1500 ms sleep | **PASS**, on the media plane's own delivery report |

## What changed

`mediad` has always published `playback.finished` carrying `playedMs` — the milliseconds it actually
wrote to that leg's transport — and a reason (`apps/mediad/internal/control/lifecycle.go:231`).
`mediad-event-mapping.ts` dropped it, so the engine never saw it. It does not drop it any more.
**No change was made under `apps/mediad/**`, and mediad was not restarted.** No `packages/events`
schema change was needed either: `mediaPlaybackFinishedDataSchema` already carried every field.

- `apps/engine/src/media/media-event.ts` — new `MediaPlaybackFinishedEvent` member
  (`channelId`, `playbackRef`, `playedMs?`, `reason`, `detail?`), added to `MEDIA_EVENT_TYPES`.
  `playedMs` is OPTIONAL because ARI cannot measure it (below); `mediad` always sends it.
- `apps/engine/src/media/mediad-event-mapping.ts` — maps `playback.finished` → `playback-finished`,
  `playedMs` verbatim, including `0`.
- `apps/engine/src/calls/ari-mapping.ts` — ARI **does** have an equivalent, `PlaybackFinished`, and
  it is now mapped too: `playbackRef` from `playback.id`, `channelId` parsed out of
  `target_uri` (`channel:<id>`; a `bridge:<id>` playback names no party and still drops), `reason`
  from `playback.state`. It carries **no duration**, so no `playedMs` — on an ARI deployment
  `announced` falls back to "the playback ended without failing".
- `apps/engine/src/media/playback-signals.ts` (new) — `PlaybackSignalBus` + `playbackSignalKey`,
  keyed by the playback REFERENCE so an announcement and the music behind it on one leg never see
  each other's completion. It is a bus of its own rather than a new member of `CallSignalBus`
  because `apps/engine/src/routing/**` is owned by another agent this pass; the orchestrator
  constructs it and hands it to the `CallControl` it builds, so there is one instance and no Nest
  provider.
- `channel-orchestrator.service.ts` — the exhaustive `dispatch` republishes it on that key, beside
  the `recordingSignalKey` republishes, and `drain()` clears it.
- `call-control.ts` — `consentMediaSettleMs` **DELETED**. `announceConsent` now: waits readiness
  (unchanged, `consentPeerReadyTimeoutMs` 2000 ms) → subscribes to the playback ref → plays → waits
  for delivery → counts the party only when `playedMs > 0`. New `consentPlaybackTimeoutMs` (8000 ms,
  the whole announcement's ceiling) and `consentPlaybackRetryMs` (250 ms).

## Why a retry, and not just a wait

Deleting the sleep and waiting for the report was measured first, and it is not sufficient on its
own. `p1b-announce-eventdriven.log`, 07:00:46Z:

```
02:00:46.464 sessions bridged
02:00:46.468 playback started  ...7060 (the WebRTC callee)   frames 52
02:00:46.490 WARN a playback failed  playedMs 0  "WebRTC media is not connected"
engine 07:00:46.491  "a consent announcement was played but the media plane delivered no audio"
                     party callee  playedMs 0  reason error
```

far-end energy: **0.000000** in all 23 windows. The consent record for that call reads
`parties: ["caller"]` — the callee is correctly LEFT OUT, which is the honesty half of the fix
working exactly as intended. But the far end still heard nothing.

A playback written into a transport with no peer is not queued anywhere: `mediad` decodes the
frames, writes them, and they go nowhere. Nothing arrives late, so waiting longer cannot help. The
only way the party hears the disclosure is to **play it again once the path is up**, and the media
plane's own `playedMs` is what says when that is. That is the difference from the sleep: the sleep
ran on every announcing call whether or not anything was wrong and its length was a guess about
somebody else's network; the retry runs only when the media plane has said the far end got nothing,
and stops the instant it says otherwise. An RTP endpoint delivers first time and pays zero.

## The energy numbers — the callee's inbound audio, both softphone tones muted

`rec-p1b.mjs`, unchanged from every previous run: 23 consecutive ~150 ms windows from the moment the
callee answers, measuring the **callee's** inbound RTP energy (`far`).

| Run                                                              | Mechanism           | mediad             | far-end TOTAL energy |
| ---------------------------------------------------------------- | ------------------- | ------------------ | -------------------- |
| original (`p1b-announce.log`)                                    | play at bridge      | `playedMs 0`       | **0.000000**         |
| re-proof 1 (`p1b-announce-fix3.log`)                             | fixed 1509 ms sleep | clean              | 0.100104             |
| this pass, delivery report only (`p1b-announce-eventdriven.log`) | no sleep, no retry  | `playedMs 0`       | **0.000000**         |
| this pass, delivery + retry (`p1b-announce-eventdriven2.log`)    | **event-driven**    | clean on attempt 5 | **0.110049**         |

The passing run's windows, `msAfterAnswer → far ΔE` (07:05:47Z):

```
 155 0        1239 0            2323 0.013560
 311 0        1394 0.007232     2477 0.014464
 466 0        1549 0.013560     2633 0.005085
 621 0        1704 0.013560     2787 0.000096
 774 0        1859 0.014464     2942 0.000002
 929 0        2013 0.013560     3099 0
1084 0        2167 0.014464     3254 0  (and 0 to 3565)
```

Zero until 1394 ms, materially non-zero for ~1.5 s, back to zero — the 1.04 s prompt (52 frames) on
a call where the only possible source of audio at that ear is the prompt itself.

`mediad` for that call — the retry loop, visible:

```
02:05:47.902 sessions bridged
02:05:47.905 playback started  ...0bc1 (caller)   +  ...0bc6 (WebRTC callee)
02:05:47.925 WARN playback failed  ...0bc6  playedMs 0
02:05:48.180 playback started  ...0bc6      02:05:48.202 WARN  playedMs 0
02:05:48.457 playback started  ...0bc6      02:05:48.480 WARN  playedMs 0
02:05:48.734 playback started  ...0bc6      02:05:48.755 WARN  playedMs 0
02:05:49.010 playback started  ...0bc6      (no WARN — the path is up)
02:05:50.054 recording started ...0bc1  direction both
```

```
engine 07:05:50.052  "a consent announcement was delivered after the media path came up"
                     party callee  attempts 5  playedMs 1040
```

A full `rec-p1.mjs` run 44 s later (`p1-eventdriven-run.log`, 07:06:32Z) is identical in shape:
four `playedMs 0` attempts, the fifth delivered, `attempts 5  playedMs 1040`, far-end energy
non-zero from the second 750 ms window on.

## Bridge → recording start, before and after

| Run                                 | Bridge       | Recording started | Delay       | What the delay IS                                                                                                           |
| ----------------------------------- | ------------ | ----------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| re-proof 1, fixed sleep (06:36:10Z) | 01:36:10.522 | 01:36:12.034      | **1512 ms** | a constant, paid whether or not it was needed — and the recorder started 3 ms after the prompt STARTED, not after it played |
| delivery report only (07:00:46Z)    | 02:00:46.464 | 02:00:47.513      | **1049 ms** | one prompt's length; the far end heard none of it                                                                           |
| **event-driven (07:05:47Z)**        | 02:05:47.902 | 02:05:50.054      | **2152 ms** | ~1108 ms retrying until the browser's DTLS came up + **1044 ms of the prompt actually playing to both parties**             |
| **event-driven (07:06:32Z)**        | 02:06:32.368 | 02:06:34.512      | **2144 ms** | same shape, reproducibly                                                                                                    |

The delay is now driven by the prompt and by how long that particular far end took to come up, not
by a constant: the recorder starts only after the disclosure has demonstrably been heard, which is
the ordering the whole feature exists for. On an RTP-only deployment the first attempt delivers and
the delay is one prompt.

## The consent record, from `optimiq_cdr.recordings`

Three records from this pass tell the whole story in one query:

```
07:05:50  {"outcome":"announced","parties":["caller","callee"],"regions":["US-IL"], ...}  event-driven + retry
07:00:47  {"outcome":"announced","parties":["caller"],           "regions":["US-IL"], ...}  delivery report only
06:38:49  {"outcome":"announced","parties":["caller","callee"],"regions":["US-IL"], ...}  old fixed sleep
```

The middle one is the point: on a call where the callee provably heard nothing, the record now says
so, where every build before this one claimed both parties.

Verdict: **PASS.** Far-end energy 0.110049 against 0.000000 before, `consentMediaSettleMs` is gone
from the codebase entirely (`grep` across `apps/`, `packages/` and `docs/` returns nothing), and the
delay between bridge and recording is now the prompt plus the far end's own handshake rather than a
constant.

## What `announced` can and cannot mean now

`docs/recording-compliance.md` was rewritten to say it: `announced` means **the media plane reported
that it played audio to that party** — its own `playedMs`, greater than zero. That is materially
stronger than the old "the media plane accepted a playback". It still does **not** mean a human
heard it, and nothing in telephony can: audio reached the far end's transport, and whether a person
was in the room, had their handset muted, or understood the language is not observable. The doc says
that in those words rather than letting the record imply reception.

## Tests

`apps/engine`: **2035 pass / 0 fail** (2047 ran, 12 skipped), `typecheck` clean, `oxlint` clean,
`oxfmt` clean. New cases: three in `mediad-event-mapping.spec.ts` (the mapping, `playedMs 0` carried
through as zero with its detail, no `detail` key when none was sent) plus the decode case rewritten;
six in `call-control.spec.ts` (counted only on `playedMs > 0`; a party reporting 0 excluded; nobody
delivered to → the recording is refused; the retry that succeeds on the third attempt while the
first-time party is played at once; a playback that never finishes is bounded; every watcher cleared
on delivery, on silence, on a refused play and on the budget; and the subscribe-before-play race);
four in `channel-orchestrator.spec.ts` (the republish, a delivered zero, keyed on the reference not
the leg, and no cost with no waiter); two in `ari-mapping.spec.ts` (a bridge-target playback drops;
`PlaybackFinished` removed from the "no consumer" list).

## Data touched, and how it was restored

| Touched                                                                    | Restored                                                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| extensions `7001` / `7002` recreated for this pass                         | **DELETED** (their `local.test` users remain — no delete-user endpoint)             |
| DID `+13125559911` recreated                                               | **DELETED**                                                                         |
| org setting `recordings.consentPolicy` (`none` → `announce`)               | back to `"none"`; whole category re-read and matches pre-run values field for field |
| outbound route "Compliance Proof Route" `recordEnabled` (`false` → `true`) | back to `false`; the route and its trunk were pre-existing and are left as found    |
| `e2e/calling/world.json`                                                   | restored from `e2e/artifacts/recording/world.json.prefix3` (pre-run copy)           |
| engine restarts ×2                                                         | logged in `STACK.md`; sipd, mediad, api, web, NATS, Postgres untouched              |

Recordings and CDR legs from this pass's own calls remain; nothing belonging to another agent was
touched, and nothing was erased.
