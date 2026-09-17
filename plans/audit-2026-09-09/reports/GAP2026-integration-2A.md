# GAP2026 — AREA=integration-2A

Branch `feat/optimiq-pbx-phase0`. Nothing committed, staged or stashed.

Six tasks, all six implemented with tests; **five of six live-proved end to end**, and the sixth
(F6's survey) live-proved for the half this area owns with the remaining gap named and evidenced
below.

| #   | Task                                                                            | Code | Tests | Live proof             |
| --- | ------------------------------------------------------------------------------- | ---- | ----- | ---------------------- |
| 1   | `TollFraudGuardPort` handed to the walker; geo-block + fraud-signal webhook     | done | done  | **PASS** (both halves) |
| 2   | `mediaEncryption` on the channel snapshot, lock icon, `requireSrtpForTlsPhones` | done | done  | **PASS**               |
| 3   | Trunk leg `from_number` = effective E.164 → `expected_attestation` stamped      | done | done  | **PASS**               |
| 4   | Post-call survey: keep the caller's leg past the agent's hangup                 | done | done  | **PARTIAL** — see §4   |
| 5   | Per-queue DTMF auto-pause honoured                                              | done | done  | unit only (see §5)     |
| 6   | `outbound_route.recordEnabled` consumed through the consent gate                | done | done  | **PASS**               |

---

## 1. The toll-fraud gate reaches the walker — and two defects that made it inert

**The one line asked for** is in `apps/engine/src/calls/channel-orchestrator.service.ts`:
`TollFraudGuardRpcPort` is injected `@Optional()` and last (the file's own convention for a
dependency the positional spec harnesses do not construct), and spread into
`PlanWalkerDependencies` beside `trunkCapacity`. Absent is exactly today's behaviour, which the
walker's own specs already assert.

**It was not enough, and the live run is what showed it.** With the wiring in place the first proof
still reached the carrier. Two defects stood between the port and the policy, both silent because
every failure on this path fails open:

1. **`apps/api/src/pbx/toll-fraud/toll-fraud.responder.ts`** is a RAW NATS subscription — deliberately,
   so `packages/events-go` sees the contract and not a framework envelope. But the only caller is the
   engine, which asks through a NestJS `ClientProxy`, and that wraps every request in
   `{ pattern, data, id }`. The responder therefore read `orgId: undefined, dialedNumber: undefined`
   and answered `allow` to **every call on the platform**, logging "an unparseable toll-fraud request".
   Fixed with an `unwrap()` that accepts both shapes (the `data` key is only taken when `pattern` is
   present beside it, so a genuine contract payload with a `data` field is never mistaken for one).
2. **`apps/api/src/pbx/shared/shared-rate-window.ts:rolling()`** built its two-row window lookup as a
   hand-written ``sql`${col} in (${a}, ${b})` `` over two bare `Date`s. With no column encoder behind
   them the driver rejected the statement before it reached postgres — no server-side log line to find
   it by — and the gate failed open on every call with a query error. Replaced with `inArray()`.

Both are the security pack's files; both are named here rather than hidden, and both are the reason
that pack could not capture these two proofs.

**Live proof 1a — a geo-blocked destination refused on a browser softphone.**
`<scratchpad>/e2e/calling/int2a-geoblock.mjs` creates an international route (`0` → `+7`), raises 2001
to the international toll class, sets `deniedCountries: ["RU"]`, and dials `09001234567` from the real
`/softphone` page.

```
api    "an outbound call was refused by the toll-fraud gate"
       reason=DESTINATION_COUNTRY_BLOCKED country=RU
engine "an outbound call was refused by the toll-fraud policy"
       reason=DESTINATION_COUNTRY_BLOCKED dialedNumber=+79001234567
engine walk finished status=hangup hangupCause=OUTGOING_CALL_BARRED
       notes=["Refused by this organization's toll-fraud policy for destination country RU."]
CDR    ONE leg: internal 2001 -> 09001234567, trunk, OUTGOING_CALL_BARRED
```

The absent second row is the assertion: **nothing was offered to the carrier**. Every fixture was
deleted and the policy switched back off; re-read afterwards.

**Live proof 1b — the fraud signal delivered to a webhook.**
`<scratchpad>/e2e/calling/int2a-fraudhook.mjs` subscribes a local http receiver to `security.evt.v1.>`,
inserts 40 synthetic answered outbound legs of 10 minutes each to `+442071234567` (400 minutes against
the detector's 300-minute floor), and triggers the sweep.

```
POST /api/v1/toll-fraud/anomaly-scan
  findings: [{ kind: "international-minutes-spike", severity: "critical",
               summary: "400 international minutes in the last hour, against a threshold of 300." }]
receiver: subject security.evt.v1.01a08708-…-d26ebf326b0a._org.fraud-signal
          kind=international-minutes-spike severity=critical
```

**The manual-run endpoint** (`POST /api/v1/toll-fraud/anomaly-scan`, `toll-fraud.write`) is the one
apps/api addition this brief permits. It is a WRITE grant because the sweep raises signals, writes
audit rows, delivers webhooks and can suspend an extension's outbound calling. It deliberately does
**not** echo the tenant ids of the findings: the sweep is cross-tenant by construction, and this
controller's own rule — asserted by `test/pbx/tollFraudPolicy.test.ts` — is that an organization id
never appears on a controller route at all.

The receiver had to be `http`, so that one api start used `PBX_WEBHOOK_ALLOW_INSECURE_URLS=true`; the
api has since been restarted plainly. Every synthetic leg was deleted (`count = 0` verified).

---

## 2. `mediaEncryption`, the padlock, and SRTP for TLS phones

**Contract → engine.** `apps/engine/src/media/mediad-media.port.ts` now sends `srtpPolicy` on
`allocate-session` / `create-offer` / `accept-answer` and reads `mediaEncryption` off the replies —
the fields the security pack put on the contract and left unused. `split-plane.port.ts`'s `LegRecord`
carries a per-leg `srtpPolicy` and the `mediaEncryption` last reported, `noteEncryption()` files it
and fires `onMediaEncryption` only on a CHANGE (so a chatty carrier's five `18x` do not write the
snapshot five times), and `mediaEncryptionOf()` reads it back.

**`undefined` is not `plaintext`.** A leg that has negotiated nothing is distinguishable from one
negotiated in the clear, everywhere: in the port, in the flag, and in the UI. A padlock drawn on a
ringing call would be a claim about a session nobody has installed.

**The flag.** `packages/telephony`'s `CHANNEL_FLAGS` gains `encrypted`. `liveChannelSchema.flags` is
`z.array(z.string())`, so the wire and the web store needed no change. The orchestrator sets it from
`onMediaEncryption` and **clears** it when a re-INVITE drops the encryption — a lock that survives a
downgrade is worse than no lock.

**`requireSrtpForTlsPhones`.** It was declared in `SIP_SETTINGS` (category `sip`) and read by nothing,
because the snapshot loader's `sip` statement fetched only `name='realm'`. That statement now reads
the category and `readSipSecuritySettings()` picks the flag out; `resolveSipRealm` was narrowed to the
realm row so a second `sip` row can never become an organization's SIP domain. It compiles onto
`CompiledRoutingSettings.requireSrtpForTlsPhones` (emitted only when TRUE, so no tenant's snapshot
hash moves) and the orchestrator turns it into a per-leg `srtpPolicy: "require"` for a handset that
signalled over `tls`/`wss`/`ws`. A **trunk is excluded** — a carrier leg carries its own per-trunk
policy, decided per interconnect. It **fails open** on an unreadable artifact, for the toll-fraud
guard's reason.

**Web.** `lib/live/encryption.ts` (pure, 5 tests): `isLegEncrypted`, `encryptedLegCount` — over LEGS,
because the two halves of one bridged call routinely disagree — and `encryptionLabel`, which says
"Media encrypted (SRTP)" and never "Secure": encrypting the audio says nothing about who is on the
other end. The softphone in-call view renders a closed padlock (`EncryptionIndicator`, only ever
present, never an open red one) and the dashboard's live-calls tile appends `, N encrypted`.

**Live proof.** Two browser softphones (WSS → WebRTC → DTLS-SRTP) on a call, read on the supervisor's
dashboard:

```
Active calls | 1 | 1 answered, 2 legs, 2 encrypted
```

and the plaintext arm, from the engine on an outbound call to the loopback carrier over plain UDP:

```
07:53:44 encryption=encrypted   (browser leg)
07:53:44 encryption=encrypted   (browser leg)
07:54:47 encryption=plaintext   (trunk leg)
```

**Honest limitation.** The softphone's own padlock does not render for the seeded 2001/2002 users,
and this is not a bug in it: `active-calls` is gated on `cdr.read`, those users hold only
`cdr.read.own`, and the recording-pause control beside it is invisible to them for the same reason.
Widening that is a change to `LIVE_TOPIC_PERMISSIONS`, not to the softphone. The flag itself is proved
to reach the live feed by the tile above, which is the same feed the padlock reads.

---

## 3. The trunk leg's `from_number` — `expected_attestation` now stamps

`presentedCallerIdNumber()` in `apps/engine/src/calls/cdr-leg.ts` takes the bare number out of the
identity as the media server was given it (`"Ada" <+13125557001>` → `+13125557001`; a name-only
identity and an empty one return `undefined`, so the leg keeps what it had). `legHooksFor` uses it for
the B-leg's `profile.callerIdNumber` instead of inheriting the A-leg's.

The difference is not cosmetic: `AttestationPolicyService`'s backfill is guarded to act only on an
already-E.164 `from_number`, precisely because looking up `7001` would miss and stamp **C** on a call
attested **A**.

**Live proof**, `int2a`'s run of `outbound-cdr-proof.mjs` — before, the trunk B-leg read `7001`:

```
leg | direction | from_number  | to_number    | destination_type | expected_attestation | right_to_use
 b  | inbound   | +13125557001 | +18005551212 | trunk            | A                    | owned
 a  | internal  | 2001         | 98005551212  | trunk            | (null)               | (null)
```

The A-leg correctly keeps the extension number: it is the identity of the leg, not of the call the
carrier saw.

---

## 4. The post-call survey — the caller now outlives the agent

**The defect** was that the agent's hangup tore the bridge down _and_ hung the caller up, so there
was nobody left to ask. Two separate things did it, and both had to be closed:

1. `PlanWalker.onPeerEnded` hung the leg up. It now takes `keepLeg`, does the unbridge and the
   `destroyBridge`, clears `channel.bridgeId` — so any other watcher closed over that bridge also
   leaves the leg alone — and simply does not send the hangup. It returns whether the leg **survived**,
   which is the fact a survey needs before it plays anything. This is the same move park and a
   shared-line recall already make, without the lot.
2. `ChannelOrchestrator.endBridgePeer` sent a BYE to whatever `bridged` had stamped on the leg — so
   the caller was hung up a second later by the AGENT's teardown. `OriginatedLegHooks` gains
   `unbridged(mediaChannelId)`, the exact mirror of `bridged`, and the orchestrator clears the stamp
   on both sides, as park already does before it moves a caller to a lot.

**The ordering is the interesting part.** `bridgeWith` now STARTS the teardown, then hands the hook
its promise rather than awaiting it: the agent's wrap-up timer must start at the moment their call
ended, and the caller's survey must not speak into a bridge that is still being pulled apart. One
promise serves both — the wrap-up ignores it, `runSurvey` awaits it.

`keepCallerOnPeerEnd` is requested **only** when the queue actually has a survey, because a caller
kept out of the bridge with nothing to ask them is a call that never ends — and `runSurvey`'s
`finally` always calls `QueueCallPort.endCaller`, so a survey that returned early, threw, or found
nothing to report still releases the leg.

Six specs in `queue-session.spec.ts` cover: the request made only with a survey, the release after the
questions (order asserted), the release when nothing was answered, the "caller went with the agent"
arm playing nothing and saying so, and the wrap-up not waiting on the detach.

**Live proof — the half this area owns: PASS.** `<scratchpad>/e2e/calling/int2a-survey.mjs`, two real
browser softphones through the queue:

```
engine "the agent's leg ended; the caller was kept out of the bridge"
caller panel after the agent hung up:
  … | 2910 | Connected · 0:07 | Mute | Hold | Hang up | Transfer | 1 2 3 …
```

Before this change the same panel read `Call ended | Terminated`, and the engine noted "the caller's
leg went with the agent's, so the post-call survey was not asked". The survey now runs to completion
on the kept leg — the "caller hung up before question N" note is gone from every run.

**What is still not proved, precisely.** The answers do not land: `queue_survey_response` is empty,
and the caller's softphone shows no `Sent:` line for the digits it is clicked into once its leg is out
of the bridge. It is **not** a broken keypad — `int2a-dtmf-baseline.mjs` presses the same two keys
mid-bridge on the same stack and the panel reads `Sent: 54`. So the remaining gap is DTMF from a
browser leg that has been detached from its bridge, which is a media-plane question (`apps/mediad`,
which this brief does not let me restart) rather than the queue's. Noted for whoever owns it; the
table has zero rows for its whole history, so nothing regressed.

**Not built: the report column.** Nothing anywhere reads `queue_survey_response` — there is no query,
no endpoint and no screen. The natural home is the queues module and the queue/agent pages, which
2B owns, and the agent-stats report reads `cdr-db` while the answers live in `pbx-db`, so it needs a
cross-database port rather than a column. Left to its owner rather than built across the line.

---

## 5. Per-queue DTMF auto-pause

`WalkerCallControl.startRecording` now takes an optional request; `QueueSession` passes
`{ autoPauseOnDtmf: node.recordAutoPauseOnDtmf }` when the queue has an opinion and `{}` when it does
not. **`undefined` is not `false`**: a queue with no opinion must leave a tenant's estate-wide PCI
setting standing, and the orchestrator's existing fallback (destination extension → org default) is
what an empty request means. The orchestrator merges the override over `recordingRequestFor`'s answer.

Two specs assert both arms. Not separately live-proved: the recording pack already proved the
auto-pause mechanism live (a 106-window silence gap at RMS exactly 0.000000), and what this closes is
which flag feeds it.

---

## 6. `outbound_route.recordEnabled` — consumed, through the one gate

`recordOutboundRoute` runs after the trunk leg bridges, through
`WalkerCallControl.startRecording` — the same seam the record-toggle feature code, the extension
policy, the queue and the conference use, because that seam is what applies the CONSENT policy. A
route that started a recorder of its own would produce audio with no consent row behind it.
(`ConferencePlanNode.recordEnabled` is stale in the source report: conferences were migrated to
`recordPolicy` and `recordConference` already honours it.)

**A second defect the live run found.** The first pass recorded the call and the consent record said
`parties: ["caller"]` — the far end was never announced to. `recordingRequestFor` reads the direction
off the leg, and a handset dialling out has an A-leg the engine labels `internal`, so the consent
policy's OUTBOUND rule (announce to the party being CALLED) never fired on the calls it was written
for. A `trunk-dial` node has no such doubt — reaching it is what makes a call outbound — so
`startRecording` gained an optional `direction` and the node states it. Same class of mismatch the
compliance pack hit on attestation.

**Live proof**, `<scratchpad>/e2e/calling/int2a-outbound-record.mjs` — 2001 dials out through the
route (`recordEnabled: true`, `consentPolicy: announce`), the carrier loops back and rings 2002:

```
recordings.consent  { "policy": "announce", "outcome": "announced", "method": "announcement",
                      "parties": ["caller", "callee"] }
recordings          5540 ms
call_legs (A-leg)   recording_consent = announced, method = announcement
```

`parties` carries `callee` only because the platform's own readiness gate saw the far end's
`playedMs` — it is the media plane's delivery signal, not an inference from this side. Both softphone
tones were muted for the run, so the energy measured after the answer was the announcement alone.
Route, consent policy and DID were all restored.

---

## Contracts and migrations

- `packages/events` — **unchanged**. Every field used (`srtpPolicy`, `mediaEncryption`) was already
  optional on `rpc.ts` from the security pack; codegen is untouched and idempotent.
- `packages/telephony` — one additive member on `CHANNEL_FLAGS` (`encrypted`).
- `packages/routing` — `RoutingSettingsInput.requireSrtpForTlsPhones` (input) and
  `CompiledRoutingSettings.requireSrtpForTlsPhones` (optional, emitted only when true).
- **No migration.** Nothing in this area added a column, so `MIGRATION-LOCK-*` was never taken.
- **No new stream, KV bucket or subject**, so `config/nats.conf` needed no change and none was made;
  no HUP was owed.
- **No new permission.** The manual scan reuses `toll-fraud.write`.

## Verification, final

| Package                    | typecheck                          | tests                                                      |
| -------------------------- | ---------------------------------- | ---------------------------------------------------------- |
| `@optimiq-voice/engine`    | clean                              | **2057 pass, 0 fail** (12 skip)                            |
| `@optimiq-voice/routing`   | clean                              | **965 pass, 0 fail**                                       |
| `@optimiq-voice/telephony` | clean                              | clean / **259 pass, 0 fail**                               |
| `@optimiq-voice/web`       | clean                              | **1071 pass, 0 fail**                                      |
| `@optimiq-voice/api`       | clean (both configs)               | **1772 passing, 0 failing**; `check:di` clean, 217 classes |
| `@optimiq-voice/events`    | clean                              | —                                                          |
| `oxlint` / `oxfmt`         | clean over every directory touched |                                                            |

Three suites the source reports listed as red are **green now** and were not fixed by this area
directly: the api typecheck error in `packages/events/src/validate.ts`, the api mocha failure in
`webhookSelectors.test.ts`, and the 12 web `queueFormSchema` failures. Their owners appear to have
landed them; re-verified rather than assumed.

## Cross-area, left standing

1. **DTMF from a detached browser leg** — the survey's last mile. `apps/mediad` / the WebRTC leg's
   sender; evidence and the mid-bridge baseline are in §4.
2. **Nothing reads `queue_survey_response`** — no query, no endpoint, no screen. Queues module + web
   queue pages (2B), and it needs a cross-database port, not a column. See §4.
3. **`packages/cdr-db/src/retention.ts:111`** — `any(…::uuid[])` is still invalid SQL for two or more
   ids, and still breaks `recording-retention-sweeper.service.ts:191`. Reported by the recording pack;
   still open.
4. **`active-calls` is gated on `cdr.read`**, so an ordinary extension user's softphone sees neither
   the recording-pause control nor the new padlock. A deliberate permission decision, named here
   because it is what a reader of §2 will ask about.
