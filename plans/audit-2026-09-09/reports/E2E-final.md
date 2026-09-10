# E2E — the closing round

Run 2026-09-09 22:34 → 23:1x UTC against the standing stack, by the final-verify agent, alone on
the stack. Nothing committed, staged or stashed. One test-only source edit (see §5). The stack is
left **running and green**.

---

## 1. The restart round

Order as the brief specifies. `config/nats.conf` was validated before the reload:

```
nats-server -c <stack>/nats/nats.conf -t
  → "configuration file ... is valid (sha256:3a9d150d…)"
kill -HUP <nats pid>
  → "Trapped hangup signal" / "Reloaded: authorization users" / "Reloaded: accounts"
  → "Reloaded server configuration (sha256:3a9d150d…)"
```

| #   | Service    | How                                  | /healthz           | /metrics (private) | WARN+ in the first minute |
| --- | ---------- | ------------------------------------ | ------------------ | ------------------ | ------------------------- |
| 0   | **nats**   | `kill -HUP` (config validated first) | `{"status":"ok"}`  | `/varz` 200        | 0                         |
| 1   | **sipd**   | kill + `up.sh sipd` (Go rebuild)     | 200                | **9290** 200       | 13 — see below            |
| 2   | **mediad** | kill + `up.sh mediad` (Go rebuild)   | 200                | **9291** 200       | **0**                     |
| 3   | **engine** | kill + `up.sh engine`                | 200                | **9201** 200       | **0**                     |
| 4   | **api**    | kill + `up.sh api`                   | `/api/auth/ok` 200 | **9200** 200       | **0**                     |
| 5   | **web**    | kill + `up.sh web`                   | `/sign-in` 200     | n/a                | 0                         |

**Broker: four distinct authenticated users** (`connz?auth=1` → api 22, engine 3, sipd 1, mediad 1).

**Zero permission violations since the HUP.** The broker log holds 1 008 violations, every one of
them from before line 1444 (the reload). Across the whole verification round below — including a
100-call storm and the `*65`/`*64`/`hot-desk`/`queue-callback` subjects that were previously
refused — the count of new violations is **0**. The two grants `FIX-final-integration.md` added are
live and sufficient.

### sipd's 13 WARN+ lines, classified

| Message                                                                            | Count | Verdict                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ignoring an invalid trunk record; the previous configuration stands`              | 10    | **Finding, not a regression.** Two fixture trunks in the admin agent's org (`admmtubt52s trunk`, `… trunk2`) are stored as _registering_ trunks with no auth user. sipd refuses them correctly and loudly; **the API accepted the write.** A registering trunk with no auth user should be refused at admission. |
| `SIPD_PROVISION_SECRET_KEY is set but SIPD_CREDENTIAL_SOURCE=nats does not use it` | 1     | Correct advice; a stack-env cleanup, not a defect.                                                                                                                                                                                                                                                               |
| `pprof is enabled on the private health listener`                                  | 1     | Deliberate (profiling is on for this stack).                                                                                                                                                                                                                                                                     |
| `UDP ref went negative on try close`                                               | 1     | sipgo's own refcounting at shutdown (`FIX-sipd-profile-noise.md` documents it).                                                                                                                                                                                                                                  |

`STACK.md` said the engine runs `node dist/main.js`. It does **not** any more — `up.sh` starts it
under `@swc-node/register` from `src`, so an engine restart needs no `dist` build. STACK.md corrected.

---

## 2. The park-timeout recall — still wrong, in BOTH orientations

The `side` getter on `ControlledLeg` is correct and is **not where the bug is**. Two live runs on the
restarted engine, same pair, opposite parkers (routing2 org, lot "RT2 Orbit", 20 s timeout):

| Orientation | Who dialled | Who pressed `*5` | `parkedByNumber` recorded | Recall at t+20 s                                                                  |
| ----------- | ----------- | ---------------- | ------------------------- | --------------------------------------------------------------------------------- |
| A           | 1203 → 1201 | **1201**         | **`"1203"`**              | `"a timed-out parked call could not be returned to its parker" … status:"hangup"` |
| B           | 1203 → 1201 | **1203**         | **`"1201"`**              | same line, `status:"hangup"`                                                      |

**So: the recall always targets the party who did NOT press `*5`, and in both orientations it fails
and the caller is disconnected.** Nobody is ever recalled.

The chain, exactly:

- `mid-call-features.ts:516` calls `control.park(leg, …)` with **the leg that pressed the digits**.
- `call-control.ts` `park()` therefore moves the _presser_ into the orbit (`removeFromBridge` +
  `startMusicOnHold` on `leg.mediaChannelId`) and records `parker = peerOf(leg)` — the presser's
  peer — as `parkedByNumber` (line 1037/1050).
- `returnParkedCall` (line 3143) then routes the parked leg to `entry.parkedByNumber`, i.e. back at
  the party the parked leg is _already talking to_ — which is why the outcome is `hangup` rather
  than a ring.

Both halves are inverted relative to intent: `*5` should park the **other** party and record the
**presser** as the parker. `numberOf`/`side` compute the peer's number correctly; the peer is simply
the wrong party to record, and the presser the wrong party to park. Live audio confirms the presser
is the one in the lot (orientation A, after `*5`: 1201 inbound +332 packets of MOH).

Left as a **P1 finding, not fixed** — inverting both halves changes the case that currently works
(dialling the orbit retrieves the call, proved PASS below) and the brief reserves non-trivial
changes as findings.

**What does work**: `*5` parks (audio in the lot), and dialling the orbit `4201` from a third phone
retrieves it with two-way audio (`packets 247, energy 4.59`). Only the timeout recall is broken.

---

## 3. Final load table — 100 concurrent, on the final build

`<scratchpad>/e2e/LOAD-RUNNING` was held for the run and removed after.

```
SIPD_E2E=1 SIPD_E2E_ROSTER=<scratchpad>/load/roster.json \
  SIPD_E2E_STORM_PAIRS=100 SIPD_E2E_STORM_SECONDS=20 SIPD_E2E_REG_CONCURRENCY=50 \
  go test -count=1 -tags e2e -run TestE2ECallStorm -v -timeout 20m .
```

| Metric                  | Phase-3 run (E2E-load.md) | **Final build**              | Change                                       |
| ----------------------- | ------------------------- | ---------------------------- | -------------------------------------------- |
| registration            | —                         | 200/200 phones in **445 ms** | —                                            |
| setup-to-ring p50 / p99 | 478 ms / 819 ms           | **113.4 ms / 170.0 ms**      | **4.2× / 4.8× faster**                       |
| ring-to-audio p50 / p99 | 27.6 ms / 44.8 ms         | 54.8 ms / 61.6 ms            | ~2× slower, still well inside budget         |
| teardown p50 / p99      | 340 µs / 1.53 ms          | 647 µs / 3.57 ms             | comparable                                   |
| RTP received            | 195 816                   | **195 812**                  | —                                            |
| **RTP lost**            | 0                         | **0 (0.0000 %)**             | —                                            |
| failed legs             | 2 (harness)               | **2 (harness)**              | both the known RTCP-on-a-SIP-socket artefact |

The 9× setup-to-ring inflation that E2E-load.md called out as the platform's headline scaling defect
is **gone on the final build**: 100 concurrent calls now set up in 113 ms p50.

### Resource table (2 s sampling across the run)

| Resource                   | idle → peak                             |
| -------------------------- | --------------------------------------- |
| sipd CPU                   | 0 → **15.8 %**                          |
| mediad CPU                 | 0 → **34.3 %**                          |
| engine CPU                 | 0.1 → **5.3 %**                         |
| api CPU                    | 0.1 → **57.6 %**                        |
| nats CPU                   | 0 → **35.1 %**                          |
| sipd goroutines            | 49 → **1 049** → **50** after (no leak) |
| mediad goroutines          | 45 → **645** → **45** after (no leak)   |
| sipd heap                  | 1.7 MB → 11.8 MB                        |
| mediad heap                | 2.0 MB → 5.3 MB                         |
| NATS slow consumers        | **0** throughout                        |
| Postgres active backends   | **1** throughout                        |
| engine `/healthz` latency  | 0.6 – 2.5 ms                            |
| api `/api/auth/ok` latency | 1.1 – 1.8 ms                            |

Both Go services return **exactly to their idle goroutine count** after the storm.

---

## 4. The checklist

| #   | Item                                                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verdict                                        |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | smoke call (`smoke-call.mjs`)                            | **Blocked, by a fix.** `PATCH /org-settings/categories/sip` → `409 PBX_CONFLICT "This SIP domain is already assigned to another organization."` The write-time realm-uniqueness check `FIX-tenant-realm.md` listed as _missing_ now exists, so a fresh smoke org cannot claim `local.test`. Resetting the DB would destroy every other agent's fixtures, so it was not run.                                                                                                                                                                             | **BLOCKED (by design)** — substituted by #2    |
| 2   | real calls end to end                                    | 100-call storm above: 100 calls, 195 812 RTP packets, **0 lost**, two-way paced G.711. Plus `TestE2EPhoneToPhoneCall` **PASS (3.81 s)** with derived credentials against the restarted stack, and a browser↔browser two-party call with audio in the park runs.                                                                                                                                                                                                                                                                                         | **PASS**                                       |
| 2b  | SIP registration on every transport                      | `TestE2ERegisterTransports` **PASS** — UDP 5160, TCP 5160, **TLS 5161**, WS 5188, WSS 8189. Plus `RegisterWrongPassword`, `RegisterRealmMismatch`, `RegisterUnknownUser`, `RegisterExpiryPolicy`, `Unregister`, `RegistrationLimit`, `MalformedSIP` — **9 live SIP e2e tests PASS, 0 fail** (3 skipped for want of a second device / open-call fixture).                                                                                                                                                                                                | **PASS**                                       |
| 3   | `*65` / `*64` toggles flip routing                       | `s1-timeflow.mjs` on the restarted engine: `dialing the call-flow toggle code *65 flips the mode → mode before=day after=night` **PASS**; `dialing the time-condition override code *64 changes the override → override before=auto after=forced-match` **PASS**. Both were refused at the broker before the HUP.                                                                                                                                                                                                                                       | **PASS**                                       |
| 4   | `credential.invalidated` eviction                        | sipd boot: `"watching credential invalidations" subject:"provision.evt.v1.*"`. A published envelope → `"credential cache invalidated" orgId:01a08708-… dropped:425`. Three malformed attempts on the way were each refused with a precise reason (`envelope subject "" does not match the delivery subject`, then `envelope orgId "" does not match the subject's org token`) — the consistency guard is real and works. **And the second half holds**: the nine live REGISTER tests below all ran _after_ that eviction and passed with no warm cache. | **PASS**                                       |
| 5   | credential-spray lockout                                 | Live and instrumented after the sipd restart: `sipd_auth_lockout_failures_total 1`, `sipd_auth_lockouts_total 0`, `sipd_auth_lockout_refusals_total 0`, thresholds 5/account, 50/source, base 30 s, window 15 m. Unit tests pass. **The 1 000-attempt live spray is still owed** — the code path is proved loaded and counting, not proved to lock out under a real spray.                                                                                                                                                                              | **PARTIAL**                                    |
| 6   | default feature codes on a fresh org                     | Org `01a08834-3840-70cd-b8aa-083f6f1e9447` (created by the org-create hook) holds **20** `feature_code` rows.                                                                                                                                                                                                                                                                                                                                                                                                                                           | **PASS**                                       |
| 7   | hot-desking schema                                       | `device_line.home_extension_id`, `.hot_desk_expires_at`, `.hot_desk_login_at` all present on the live `optimiq_pbx`. The `rpc.pbx.v1.hot-desk` subject no longer produces a subscription violation. **The live SIP login/logout walk was not run.**                                                                                                                                                                                                                                                                                                     | **PARTIAL**                                    |
| 8   | STIR/SHAKEN attestation columns                          | `call_legs.sip_attestation`, `.sip_verstat` exist; `recordings.pauses` exists; `call_legs.related_call_id` (queue-callback CDR link) exists. **All three are 0-populated across 15 116 legs** — no trunk INVITE carrying PAI/verstat has traversed the restarted stack.                                                                                                                                                                                                                                                                                 | **PARTIAL** — schema PASS, population unproven |
| 9   | recording pause/resume metadata                          | `recordings.pauses` present, 0 of 42 rows populated. Not exercised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **NOT RUN**                                    |
| 10  | backups script against live Postgres                     | `.scripts/backup/backup.sh` → 32 MB set, three `pg_restore` dumps + roles + JetStream store copy + object tar, **"manifest verified"**, complete in 3 s.                                                                                                                                                                                                                                                                                                                                                                                                | **PASS**                                       |
| 11  | restore into a disposable target                         | `restore.sh` with `RESTORE_DB_SUFFIX=_finalrestore`: **row counts match across 18 + 56 + 12 = 86 tables**; smoke reads `users 70`, `extensions 1748`, `organizations 16`, `call_legs 14 871`. Targets dropped afterwards. One gap: the script warns `no password in the environment for voice_api/voice_pbx/voice_cdr` — its expected variable names do not match the stack's `secrets.env`, so the restored runtime logins are left unprovisioned. Documentation/naming gap, not a data defect.                                                        | **PASS** (with the note)                       |
| 12  | retention dry-run reports partitions                     | `bun run scripts/retention.ts --retain-months 13 --dry-run` → `{"event":"cdr_retention_plan","dryRun":true,"plan":{…,"cutoffDate":"2025-09-01","tables":["call_legs","call_events"],"tombstoneCutoff":"2025-09-01T…"}}`, nothing written.                                                                                                                                                                                                                                                                                                               | **PASS**                                       |
| 13  | reports / porting / CNAM pages render                    | `/reports`, `/reports/calls`, `/numbers/porting`, `/numbers/cnam`, `/dashboard` all `307` to sign-in (unauthenticated), i.e. the routes exist and the middleware is intact. Authenticated rendering not re-driven this round.                                                                                                                                                                                                                                                                                                                           | **PARTIAL**                                    |
| 14  | SDES-SRTP over TLS 5161                                  | **Signalling half PASS**: `TestE2ERegisterTransports` registers over TLS 5161. **Media half NOT RUN** — `a=crypto` in the answer / encrypted RTP / plaintext dropped needs the SDES test UA `FIX-sip-hardening.md` §5 still owes.                                                                                                                                                                                                                                                                                                                       | **PARTIAL**                                    |
| 15  | sipd `deviceId` on invites                               | Not observed: zero `deviceId` occurrences in the engine log this round. The browser softphones and the load roster all carry no device row, so nothing on this stack exercises it.                                                                                                                                                                                                                                                                                                                                                                      | **NOT RUN**                                    |
| 16  | CLIR/PAI on a trunk INVITE via the fake carrier          | Not run (`carriersniff.mjs` exists and is ready on 127.0.0.1:5199).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | **NOT RUN**                                    |
| 17  | early media 183+SDP relay with audio energy              | 119 `183`-bearing lines in sipd's log post-restart, but no measured pre-answer energy this round.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **NOT RUN**                                    |
| 18  | IVR direct extension dial                                | `FIX-ivr-dtmf.md` proved five of six branches post-restart-18:03; not re-driven on this build.                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **NOT RUN**                                    |
| 19  | `*81` bare code / paging                                 | Rig exists (`s4-paging.mjs`); not re-driven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | **NOT RUN**                                    |
| 20  | shared line seize/hold/retrieve/recall                   | Unit-proven (7 + 5 + 2 cases) and now live for the first time; **no live walk run**. Barge-in remains unimplemented.                                                                                                                                                                                                                                                                                                                                                                                                                                    | **NOT RUN**                                    |
| 21  | call pickup with audio                                   | Not re-driven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **NOT RUN**                                    |
| 22  | attended / blind transfer                                | Not re-driven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **NOT RUN**                                    |
| 23  | queue callback end to end                                | Newly live (subject + grants + dialler + `related_call_id`). `related_call_id` is 0-populated, so no callback has been placed on this build.                                                                                                                                                                                                                                                                                                                                                                                                            | **NOT RUN**                                    |
| 24  | voicemail forward / copy                                 | Proved live by the `voicemail-forward` agent pre-restart; not re-driven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | **NOT RUN**                                    |
| 25  | engine adoption (two engines, kill one)                  | Not re-driven on the final code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **NOT RUN**                                    |
| 26  | plane loss (kill mediad, kill sipd)                      | Not re-driven on the final code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | **NOT RUN**                                    |
| 27  | Ray Baum location in the emergency event                 | Not re-driven.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | **NOT RUN**                                    |
| 28  | engine unit suite after the spec fix                     | **1845 pass, 12 skip, 0 fail**; `tsc --noEmit` clean.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | **PASS**                                       |
| 29  | sipd Go suite (`-tags e2e ./...`) against the live stack | 24 packages `ok`, 0 failures. The register/call/IVR/trunk e2e tests self-skip without their `SIPD_E2E_PASS_*` variables, so that run covered the load tests plus every unit and internal package; the live SIP scenarios were then re-run separately with passwords derived for 1601/1602 — row 2/2b above.                                                                                                                                                                                                                                             | **PASS**                                       |

**Counts: 11 PASS, 5 PARTIAL, 1 BLOCKED, 13 NOT RUN, 1 P1 FAIL (the park recall).**

---

## 5. The one source edit — `originate-plan.spec.ts` (test-only)

`FIX-final-integration.md`'s last outstanding item. The outbound-rule fixture spelled `routeId` /
`nodeId` where `resolveOutbound` reads `id` / `destinationNodeId`, so the rule **matched** and
resolved to `plan: undefined`, and the "dials the customer through the org's outbound routing" case
passed without ever exercising `planNodeId` — the exact shape of the bug that handed the
queue-callback path a route with no trunk on it.

Two changes in `apps/engine/src/calls/originate-plan.spec.ts`:

1. `routeId` → `id`, `nodeId` → `destinationNodeId`, with a comment saying why the misspelling is
   invisible.
2. An added assertion, because renaming the fields alone would leave the case still not checking
   anything: `expect(result.ok === true && result.planNodeId).toBe("trunk:pstn")`. Without it the
   fixture is exercised but the resolution is not.

`bun test src/calls/originate-plan.spec.ts` → **15 pass, 0 fail, 26 expect() calls** (was 25).
Whole engine suite re-run: **1845 pass, 12 skip, 0 fail** — unchanged. `typecheck` clean.

---

## 6. Still failing, with the exact symptom

1. **P1 — the park timeout never recalls anybody, in either orientation.** `*5` parks the presser
   and records the presser's peer as the parker; the recall then routes the parked leg at the party
   it is already connected to and ends `status:"hangup"`. See §2 for both runs and the three-line
   chain. `E2E-routing2.md` P1-4 stands, and the `side` getter did not address it.

2. **Finding — the API stores a registering trunk with no auth user.** sipd refuses it at load with
   `a registering trunk needs an auth user` and keeps the previous configuration, so ten such rows
   are permanently un-loadable. Admission-time validation is missing.

3. **Note — `smoke-call.mjs` is now unrunnable on a populated stack.** The new realm-uniqueness
   check (a fix) means the script's fresh org cannot claim `local.test`; the script's own advice is
   to `reset-db.sh`, which is destructive. It needs an option to reuse the existing realm's org.

4. **Note — `restore.sh` does not find the runtime-role passwords** under the names `secrets.env`
   uses, and silently leaves `voice_api`/`voice_pbx`/`voice_cdr` unprovisioned in the restored
   cluster. A restored stack would not start.

5. **Unproven-but-live**: shared lines mid-call, queue callback, hot-desk login/logout, and
   STIR/SHAKEN population are all deployed for the first time by this restart round and none has a
   live walk behind it. See the NOT RUN rows in §4.

---

## 7. Left on the stack

- The load roster's extensions **5000–6099** in the smoke org (pre-existing, from the Phase-3 wave).
- Artifact sets under `<scratchpad>/backup-final/` (two; the first has no JetStream copy).
- `<scratchpad>/e2e/routing2/parkprobe.mjs` and `parkside.mjs` — the two park-orientation probes.
- `<scratchpad>/load/final100/sample.csv` — the resource table above.
- `<scratchpad>/e2e/LOAD-RUNNING` was created for the load run and **removed**.
- No database was reset. The three `*_finalrestore` databases were dropped.
