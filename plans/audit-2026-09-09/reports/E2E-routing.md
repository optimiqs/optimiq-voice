# E2E — AREA = routing

Run: 2026-09-09 16:40–17:25 UTC against the standing stack (STACK.md). Harness, fixtures and every
script under `<scratchpad>/e2e/routing/`; artifacts under `<scratchpad>/e2e/artifacts/routing/`.

## Environment note read this first

**I could not create my own organization.** `org_setting (category='sip', name='realm')` carries a
GLOBAL unique index (`org_setting_sip_realm_global_key`) and sipd is single-realm by construction
(`SIPD_REALM`, `apps/sipd/internal/config/config.go:127`; `profile.go:8` — "one realm per process
still holds"). Exactly one organization in a deployment can own the realm a phone registers to, and
that org is the bring-up `Smoke Org` (`01a08708-4cd4-76b9-b56d-d26ebf326b0a`). Every agent asked to
"work in your own org" with real softphones is in the same position.

I therefore worked inside `Smoke Org` and added only objects prefixed `RT`/`routing-`, in an
unclaimed number range, and deleted nothing:

- users/extensions `1101`–`1104` (`routing-11xx@local.test`, password `[test-password]`), org role
  `agent`; caller is the smoke owner on `1001`
- ring groups `4001` (sequential) and `4002` (simultaneous), queue `4010`, IVR `4020` + submenu
  `4021`, MOH class `RT-Hold` (uploaded WAV), prompt `RT Greeting`

`2001`/`2002` were already claimed by another agent — the compiler refused the create with
`duplicate-internal-number` and rolled the write back. **That is compile-on-write's validation
working correctly, and it is the only part of compile-on-write that does work (see P0-1).**

## Scenario table

| #   | Scenario                                                           | Expected                                              | Observed                                                                                                                                                                   | Evidence                                            | Verdict            |
| --- | ------------------------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------ |
| 1   | Two softphones register, direct call 1101→1102                     | ring + two-way audio                                  | online in 824 ms; setup-to-ring 808 ms; ring-to-audio 2 450 ms; inbound audio both ends                                                                                    | `baseline.mjs`                                      | PASS               |
| 2   | Ring group `4001` sequential, nobody answers                       | 1101→1102→1103 in order, 8 s each, then fallback 1104 | ring at +0.5 s / +8.5 s / +16.5 s, fallback 1104 at +24.4 s                                                                                                                | `ringgroup.mjs seq`                                 | PASS               |
| 3   | Sequential with 1102 offline                                       | offline member skipped, no dead wait                  | 1101 +0.4 s, **1103 +8.4 s** (1102 skipped with no delay), 1104 +16.4 s                                                                                                    | `ringgroup.mjs seqoffline`                          | PASS               |
| 4   | Ring group `4002` simultaneous                                     | all three ring, first answer wins, losers stop        | all three ringing at +0.38 s; 1102 answered; 1101/1103 stopped within 450 ms; two-way audio                                                                                | `ringgroup.mjs sim`                                 | PASS               |
| 5   | Simultaneous CDR legs                                              | 1 A-leg + 3 B-legs, losers `no-answer`/`LOSE_RACE`    | **10 legs**; each member wrote 3 rows, 2 of them `disposition=answered`, `NORMAL_CLEARING`, never rang                                                                     | `call_legs` for `74b3503f-…`                        | FAIL (P1-1, P1-2)  |
| 6   | Ring-group `ring_group_ref` on the CDR                             | set on the group's legs                               | NULL on every leg although `destination_type='ring_group'`                                                                                                                 | same query                                          | FAIL (P2-1)        |
| 7   | Agent login/logout through the UI                                  | seat toggles, ACD sees it                             | `Log in` on `/queues` → `logged-out → available` on the live channel in **<100 ms**, both agents                                                                           | `queue.mjs`                                         | PASS               |
| 8   | Agent state transitions, live                                      | available→ringing→on-call→wrap-up                     | every transition on `agent-state` and `queue:<id>` within 100 ms, `availableAt` = +10 s wrap-up                                                                            | `queue.mjs`                                         | PASS               |
| 9   | Queue waiting list, live                                           | caller appears/leaves                                 | `entries[]` put on join, emptied on connect                                                                                                                                | `queue.mjs`                                         | PASS               |
| 10  | **Wallboard/queue panel updates live in the browser**              | tiles move                                            | **no live socket was ever opened by ANY page** — permanent "Reconnecting", "Waiting for the first frame…"                                                                  | `wsprobe.mjs`, `artifacts/routing/queues-owner.png` | FAIL (P0-2, fixed) |
| 11  | Caller hears MOH in the queue                                      | hold music                                            | 30 s of **silence**; engine: `mediad refused start-playback (bad_request): audio: no such prompt: sound:moh/default`                                                       | `ivr.mjs moh`, engine.log 17:01:39                  | FAIL (P1-3)        |
| 12  | Queue position/ETA announcements                                   | announced                                             | not reachable — same playback failure as #11                                                                                                                               | —                                                   | BLOCKED            |
| 13  | Round-robin across calls                                           | second call to the other agent                        | not reachable — the queue aborts once MOH fails and the artifact is stale                                                                                                  | —                                                   | BLOCKED            |
| 14  | IVR `4020`: greeting, options 1/2/4, direct dial, invalid, timeout | each branch routes                                    | **every** call fell to the timeout destination 1104 after 48 s; no greeting audio at all                                                                                   | `tasks/b6kkuacm4.output`, engine.log                | FAIL (P0-1 + P1-3) |
| 15  | **Compile-on-write** — edit a plan, next call uses it              | new plan on the next call                             | IVR timeout destination changed to 1103, `compile` returned `published:true`, next call still rang **1104**                                                                | `cow4.mjs`                                          | FAIL (P0-1, fixed) |
| 16  | Engine picks up any config edit                                    | artifact re-applied                                   | engine last applied an artifact at **16:44:40** and never again, through ~15 edits and 6 explicit compiles                                                                 | `cow.mjs`, `cow2.mjs`, engine.log                   | FAIL (P0-1)        |
| 17  | API latency (50 reqs each)                                         | —                                                     | `/queues` p50 6.9 / p99 14.6 ms · `/ring-groups` 6.1/13.4 · `/ivr-menus` 8.1/20.3 · `/queue-agents` 8.3/17.4 · `/cdr?limit=25` 7.8/9.5 · `POST /routing/compile` 15.5/23.0 | `perf.mjs`                                          | PASS               |
| 18  | Browser runtime errors across every scenario                       | none                                                  | none on any softphone, console or wallboard tab                                                                                                                            | all scripts                                         | PASS               |

Not attempted (budget, and blocked behind P0-1/P1-3): time conditions + night-mode feature code,
feature codes (DND/forward/voicemail/echo), dial-by-name, paging/intercom auto-answer, shared-line
appearance, 3-party conference, prompts playback node. All of them route through the same artifact
and the same `start-playback` that P0-1 and P1-3 break, so they would have measured those two bugs
again rather than themselves.

## Findings

### P0-1 — the engine serves a stale routing artifact forever after the API restarts (FIXED)

Config changes compile, store and never arrive. Evidence: the engine logged
`applied a routing artifact update from KV` for this org at 16:42/16:44 and **never again**, while
`POST /api/v1/routing/compile` kept answering `published: true`. Proven behaviourally: moving IVR
`4020`'s timeout destination from 1104 to 1103 and compiling still rang **1104** on the next call
(`cow4.mjs`). The API was restarted at 16:59:25 (`routing-cache KV bucket ready`, new pid); its
`PBX_ENSURE_KV_BUCKETS` boot re-makes the bucket, which orphans the engine's watch consumer — the
async iterator stays alive yielding nothing, so no error, so no reconnect, so `invalidateAll()`
never runs, and `CACHE_TTL_MS` (1 hour) is the only backstop.

`routing-artifact.source.ts` documents this exact mode ("`watching` can be true — the iterator is
alive and yielding nothing — while this timestamp stands still") and tracks `lastWatchEntryAt` for
it, but nothing read it.

**Fix applied** — `apps/engine/src/routing/routing-artifact.source.ts`: a memory copy is only served
while the watch has delivered something inside `WATCH_SILENCE_MS` (90 s), measured from the current
iterator's start so a fresh watch is not punished for silence. A silent watch costs one KV read per
call — the read the miss path already makes — instead of an hour of wrong routing. Spec:
`routing-artifact.source.spec.ts` → "stops trusting a memory copy once the watch has gone silent"
(23/23 pass). **Needs an engine restart to verify.**

Secondary, not fixed: `/healthz` does not expose `RoutingArtifactSource.stats`, so `watching` and
`lastWatchEntryAt` — the two fields that diagnose this in seconds — are unreachable in production.

### P0-2 — no page in the web app ever opens the live socket (FIXED)

Every live surface (wallboard tiles, queue panel, agent console status, registrations, active calls)
sat on "Reconnecting" / "Waiting for the first frame…" forever. Not a proxy problem — the client
never _created_ a socket (`wsprobe.mjs`: only the Next HMR socket exists).

Cause is a closed loop with nothing in it: `LiveClient.connect()` is called only from `subscribe()`
(lazy by design), while `useLiveTopic` refuses to subscribe until `welcomed === true`, and `welcome`
only arrives on an open socket.

**Fix applied** — `apps/web/app/(app)/_context/live-context.tsx`: a component that wants a topic but
has not been welcomed yet asks the client to connect, which keeps the laziness that matters (a page
with no live topic still opens nothing) while letting the handshake happen. Specs:
`apps/web/lib/live/client.spec.ts` → "opens a socket and delivers the welcome for a caller that
holds no lease" and "reuses the socket a lease-less connect opened" (21/21 pass). Verified live: the
app now opens `ws://…/api/v1/live` (`wsprobe.mjs`).

Separately, the local stack cannot carry that upgrade: Next `rewrites` (`apps/web/next.config.mjs`)
do not proxy WebSockets, so `/api/v1/live` from :3300 cannot reach the API on :3200. A real
deployment needs its reverse proxy to forward the upgrade, and
`docs/native-calling-deployment.md` does not say so. I verified the feed itself against the API
directly (`livefeed.mjs`) — welcome, subscribe, snapshot and every queue/agent frame land in
milliseconds — so the wallboard is correct behind a proxy that forwards upgrades.

### P1-1 — every call forks to dead WebSocket contacts (sipd)

A browser softphone that closes its tab leaves its AOR binding in place until expiry, and sipd forks
every later call to it. One simultaneous ring group to 3 members produced **9** INVITEs, 6 of them
`connect: connection refused` → `refusing an originate (no_route)` → `refusing a hangup
(unknown_dialog)`. A WS contact is reachable only over the connection that registered it, so the
binding should die with the transport. Costs: 6 wasted originates and 12 warning lines per call, and
the extra CDR legs in P1-2. Not fixed — it is a Go transport-lifecycle change in sipd, which another
agent is exercising heavily and which I must not restart.

### P1-2 — a refused originate is written to the CDR as an ANSWERED leg

Those dead forks each wrote a `call_legs` row with `disposition='answered'`,
`hangup_cause='NORMAL_CLEARING'`, `billsec_ms=0`, and no `answered_at`. `dispositionFor` classifies
an unanswered leg by its cause and `NORMAL_CLEARING` is in `ANSWERED_HANGUP_CAUSES`, so the teardown
default becomes "answered". A ring group nobody picked up reports three answered legs; ASR and
"answered calls" are wrong for every tenant with a stale binding.

**Already fixed in the working tree by another agent** — `plan-walker.ts` now stamps
`USER_NOT_REGISTERED` on the refused leg. The running engine `dist` predates it. Listed under
needs-restart; I did not duplicate the change.

### P1-3 — nothing plays: queue MOH and IVR prompts are refused by mediad

`mediad refused rpc.media.v1.start-playback (bad_request): audio: no such prompt:
sound:moh/default`. Two problems in one line:

1. The engine asked for `moh:default` even though queue `4010` has `mohClassId` → `RT-Hold`. The
   compiler does resolve the name (`compile.ts:1601`) and the loader does ship `mohClasses`
   (`snapshot-loader.ts:170`), so on this run the cause is P0-1 — the engine was walking the
   pre-MOH artifact. Re-test after the engine restart before treating it as a second bug.
2. `moh/default` — mediad's own documented default class — **does not exist in the media store**, so
   a tenant that configures no MOH class gets silence rather than default hold music, and the error
   is a warning the caller experiences as a dead line. The same store gap is why the IVR played no
   greeting and why every menu call fell to its timeout branch after 48 s of silence.

Consequence for IVR: I could not evaluate DTMF at all. With no greeting the A-leg produced no audio,
so the softphone's in-call keypad was never reachable, and every one of the six probes measured the
timeout branch. IVR digit handling is **untested**, not proven broken.

### P2-1 — `ring_group_ref` is NULL on ring-group CDR legs

`destination_type='ring_group'` with `ring_group_ref IS NULL` on all 9 B-legs, so no report can
attribute a call to the group that distributed it. Compare `queue_ref`, which the queue path does
set.

### P2-2 — a `delaySeconds` on a sequential ring-group member is dead air

`dialSequential` (`plan-walker.ts:5594`) sleeps the member's delay _in addition to_ the previous
member's timeout, while `dialParallel` treats it as an offset from the call's start. Measured: with
`delaySeconds: 8` and `timeoutSeconds: 8`, member 2 rang at **16.4 s**, not 8 s, with 8 seconds
where nobody rang. The DTO says "the delay is what makes `sequential` sequential"
(`ring-groups.dto.ts`), which is exactly the reading that produces silence — the ordering already
makes it sequential. Either zero the delay for sequential in the compiler or change the field's
documentation; the two meanings on one column will keep producing this.

### P2-3 — "Take a break" is offered to a logged-out agent

The agent console renders both `Log in` and `Take a break` while the seat is `logged-out`, against
its own stated rule that buttons the ACD would refuse are not offered.

### P2-4 — the live channel sends a queue snapshot twice on subscribe

`livefeed.mjs`: two identical `snapshot` frames for `queue:<id>` in the same millisecond. Harmless
with replace-not-merge semantics, but it is a doubled payload per tile per subscribe.

## Fixes applied

| File                                                      | Change                                                                      | Test                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ |
| `apps/web/app/(app)/_context/live-context.tsx`            | connect when a topic is wanted but the welcome has not landed               | `apps/web/lib/live/client.spec.ts` (+2 cases, 21 pass) |
| `apps/web/lib/live/client.spec.ts`                        | lease-less connect delivers the welcome; the socket is reused               | —                                                      |
| `apps/engine/src/routing/routing-artifact.source.ts`      | `WATCH_SILENCE_MS` + `watchIsCurrent()`; a silent watch stops being trusted | `routing-artifact.source.spec.ts` (+1 case, 23 pass)   |
| `apps/engine/src/routing/routing-artifact.source.spec.ts` | pins the stale-artifact failure                                             | —                                                      |

No Go touched, no service restarted, no git state changed.

## Needs restart to verify

1. **engine** — my `routing-artifact.source.ts` fix, and the pre-existing working-tree fix for P1-2
   (`plan-walker.ts` stamping `USER_NOT_REGISTERED`). Once the engine restarts it will also pick up
   the current artifact, which unblocks scenarios 11–14.
2. **web** — already hot-reloaded by `next dev`; verified live.
3. Re-run after the restart, in order: `ivr.mjs moh`, `ivr.mjs ivr`, `queue.mjs`, `cow4.mjs`,
   `ringgroup.mjs sim` (for the CDR leg count).

## Measurements

- Registration (browser → sipd over WSS): 824 ms for two phones.
- Setup-to-ring 808 ms; ring-to-audio 2 450 ms end to end (direct extension call).
- Ring-group timers honoured to ~±0.5 s over 24 s of laddering.
- Live channel: welcome + subscribe + snapshot in 9 ms; every ACD transition delivered <100 ms after
  the API accepted the write.
- API p50/p99 as in scenario 17; the heaviest route, `POST /routing/compile`, is p99 23 ms.
