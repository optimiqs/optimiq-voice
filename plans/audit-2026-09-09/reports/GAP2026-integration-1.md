# GAP2026 — AREA=integration-1

Four items, all done. Three cross-area leftovers from `GAP2026-INTEGRATION-TODO.md` are closed
(E911 on devices, the platform-operator UI, and the broker-grant gate the infra line asked for).
No commits. Nothing owned by the recording or contact-centre packs was touched — `apps/engine/src/{calls,media,queue}`,
`apps/api/src/{cdr,pbx/voicemail-*,pbx/queues,pbx/org-settings}`, `packages/routing`, and the web
recordings/queues/wallboard/agent-console/softphone screens are all unmodified.

---

## 1 — E911 gate on devices · DONE

`GAP2026-compliance.md` left this as a one-line follow-up: a DID refuses an unvalidated emergency
address (`PhoneNumbersService.create/update` → `EmergencyAddressesService.assertAssignable`) and a
handset did not, so the DID gate was bypassable by attaching the address to the phone instead.

**`apps/api/src/provisioning/devices/devices.service.ts`** — `DevicesService` now injects
`EmergencyAddressesService` and overrides `create`/`update` with
`assertEmergencyAddressAssignable`, the same shape and the same rule as the phone-number path:

- only when the write NAMES `emergencyAddressId` (an unrelated rename must not fail over a
  grandfathered address);
- never for a cleared one (detaching stays possible whatever the address's state);
- the same named error, `EMERGENCY_ADDRESS_NOT_VALIDATED` (409), with the subject rendered as
  `device <mac>` where the DID path renders `phone number <e164>`.

`createWithProvisioningToken` goes through `this.create`, so the only path that can create a device
is gated too — proven below rather than assumed.

**`apps/api/src/pbx/pbx.module.ts`** — one line: `EmergencyAddressesService` added to `exports` so
`ProvisioningModule` (which already `imports: [PbxModule]`) can inject it. No new provider, no second
instance. `pnpm --filter @optimiq-voice/api run check:di` still reports 217 injectable classes across
8 modules with every bare-class parameter resolvable.

**Tests** — `apps/api/test/provisioning/deviceEmergencyAddress.test.ts`, 6 new mocha tests against an
in-memory repository double behind the real `runEffect` seam, with `EmergencyAddressesService` doubled
(its own decision has its own suite against the carrier fake). They assert the refusal on create and
on update, that NOTHING reaches the repository when it refuses, the allow path, the clear path, the
"not named → not asked" path, and the create-with-token path.

### Live proof — real API, real Postgres, real session cookie

Script: `<scratchpad>/e2e/calling/integration1-e911-device.mjs`. api restarted first (single-service
`up.sh api`).

| #   | Request                                                  | Result                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `POST /emergency-addresses` (no carrier on this stack)   | created, `validated: false`                                                                                                                                                                                                            |
| 2   | `POST /devices` with that address                        | **409 `EMERGENCY_ADDRESS_NOT_VALIDATED`** — _"…cannot be attached to device aa89f2228901. Validate it first (POST /api/v1/emergency-addresses/…/validate); a 911 call carrying an unvalidated location may not reach the right PSAP."_ |
| 3   | `POST /devices` with no address                          | created                                                                                                                                                                                                                                |
| 4   | `PATCH /devices/:id` attaching the unvalidated address   | **409**, same code, subject _"this device"_                                                                                                                                                                                            |
| 5   | `PATCH /devices/:id { label }`                           | **200** — an unrelated edit still succeeds                                                                                                                                                                                             |
| 6   | `POST /emergency-addresses/:id/validate`                 | 503 `CARRIER_NOT_CONFIGURED` (no `TELNYX_API_KEY` on this stack)                                                                                                                                                                       |
| 7   | address marked validated in the database, `PATCH` re-run | **200**, `emergencyAddressId` set                                                                                                                                                                                                      |
| 8   | `PATCH { emergencyAddressId: null }`                     | **200** — clearing stays possible                                                                                                                                                                                                      |

The probe's device and address were deleted afterwards; no tenant state was left behind.

---

## 2 — Platform-operator UI · DONE

`compliance.review` and `compliance.traceback` had API surfaces and no screens — a decision could
only be recorded with a `POST` from a terminal, and `compliance.requireKycForOutbound` puts that
review on the critical path for a tenant being able to place a call at all.

**No new permission was invented.** Both grants already exist in `packages/auth`'s registry and in
`apps/web/lib/permissions.generated.ts`, both are in `OWNER_ONLY_PERMISSIONS`, and the web codegen was
NOT re-run because nothing was added to it.

### The gating, using the app's existing seams and no new ones

- `apps/web/lib/routes.ts` — `platformKyc: "/platform/kyc"`, `platformTraceback: "/platform/traceback"`.
  The `/platform` prefix mirrors the API's own segment: it is how "what in this product leaves the
  tenant?" is answered by grepping one segment rather than by knowing which permissions are owner-only.
  Two routes rather than one tabbed page, because this file's stated rule is that a page may only be a
  tab of another when both are gated by the SAME permission.
- `apps/web/lib/page-permissions.ts` — one entry each, `compliance.review` and `compliance.traceback`.
  That single map is what the `(app)` layout's route guard and the sidebar filter both read, so a
  visible nav entry and a 403ing page cannot disagree.
- `apps/web/app/(app)/_components/nav-config.ts` — a new `Platform` section with the two items. Nav
  items carry no permission of their own by design; `sidebar.tsx` filters on `canAccessPage` and drops
  a section with no reachable items, so for every customer role the section does not exist.

### The screens

`apps/web/app/(app)/platform/kyc/{page.tsx,_components/platform-kyc-screen.tsx}` — the review queue.
Filter by decision (defaulting to `pending`), `ListPagination` over the server's page/limit/total, a
row per file with the organization name and id, the legal entity, `••••<taxIdLast4>` and a decision
`Badge`. "View file" expands the row into two `Card`s (entity + contact/traffic + the last decision
and its note) rather than fetching a detail — there is no `GET /:id`, the row IS the file, and a
second read would be a second audit row for one act of reading. "Decide" opens a `Dialog` (not
`ConfirmDialog`, whose own header says it is confirmation and never a form) with the three reviewer
decisions and a note; `needs-info` is rendered `warning` and never `danger`.

**The tax id cannot be rendered.** The API's read projection does not name the column, so no response
this screen can make carries it; there is no reveal control and nothing to add one to.

`apps/web/app/(app)/platform/traceback/{page.tsx,_components/traceback-screen.tsx}` — the form
(from/to, called number, calling number, trunk) → results table → CSV. The table separates the two
attestation pairs under headings that say whose claim they are: **Carrier claimed**
(`sipAttestation`/`sipVerstat`) against **We attested** (`expectedAttestation`/`callerIdRightToUse`).
Each row also carries the originating tenant's KYC decision.

Two deliberate shapes:

- **It is a form with a submit, not a live-filtering table.** Every read of this endpoint is an
  unpoliced cross-tenant read and writes an audit row for exactly that reason; refetching per
  keystroke would fill the ledger with questions nobody asked. `useTraceback` takes `enabled` and the
  caller passes `submitted !== null`. The submitted query is held separately from the form's, so the
  CSV downloads the answer that is on the screen rather than whatever the boxes now say.
- **The CSV is a plain URL, not a minted one.** The two existing download paths in this app mint a
  signed URL because the object lives in a bucket. There is no object here — the endpoint renders the
  file in the request, on the same cookie, with `content-disposition: attachment` — so the download is
  `window.location.assign(tracebackCsvHref(submitted))` to a relative, same-origin route the caller is
  already entitled to.

### Supporting modules (the app's existing layering, one directory per area)

- `apps/web/lib/platform/contracts.ts` — the wire shapes, `KYC_DECISION_LABELS`/`_TONES`,
  `REVIEWER_DECISIONS`, and two pure rules: `decisionNoteIssue` (the nudge the API's own DTO comment
  says belongs in the UI — the server accepts a note-less rejection on purpose) and
  `tracebackQueryIssue` (mirrors the API's two refusals so a 400 does not empty the table and read as
  "there were no such calls").
- `apps/web/lib/platform/client.ts` — `platformSearchParams` (omit-empty, same rule as
  `cdrSearchParams`), `listPlatformKyc`, `decidePlatformKyc`, `fetchTraceback`, `tracebackCsvHref`.
- `apps/web/app/(app)/_hooks/use-platform-queries.ts` — `usePlatformKycQueue`, `useKycDecision`
  (invalidates the whole queue subtree, because a decision moves a row between filters), `useTraceback`.
- `apps/web/lib/query-keys.ts` — `platformKycQueue` / `platformTraceback`, deliberately NOT under an
  organization: these answers are cross-tenant and keying them by the operator's current tenant
  selection would cache the same answer several times over.

### Tests — 20 new bun specs, `apps/web` suite 1006 → **1063 pass, 0 fail**

`apps/web/lib/platform/{client,contracts}.spec.ts`. The web suite tests pure `lib/` logic and has no
DOM harness (zero `.tsx` tests exist), so the testable surface is the param serialization, the CSV
href, the label/tone maps and the two refusal rules — which is where the behaviour actually lives.
Highlights: omission ≠ empty; `+1…` survives serialization; the CSV href is relative (an absolute one
would download a 401 page); `needs-info` is never `danger`; `REVIEWER_DECISIONS` cannot un-decide a
file; the window ceiling accepts exactly 31 days and measures an inverted range by width, not sign.

`apps/web/lib/page-permissions.spec.ts` and `routes.spec.ts` — which assert that an owner reaches every
declared route — pass unchanged with the two new entries.

### Live proof — real Chromium, real web app, real API, real Postgres

Script: `<scratchpad>/e2e/calling/integration1-platform-ui.mjs`; screenshots and the downloaded file in
`<scratchpad>/e2e/artifacts/integration1/`. Signed in as the standing owner.

| #   | Action                                 | Result                                                                                                                                                                |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | sidebar                                | a **PLATFORM** section appears with _KYC review_ and _Traceback_, after ORGANIZATION                                                                                  |
| 2   | `/platform/kyc`                        | renders, default filter `pending`, empty state _"Nothing waiting here"_                                                                                               |
| 3   | filter → _Every file_                  | 1 row: `Smoke Org` / `Smoke Org Ltd` / `••••6789` / **Approved**, pager _1–1 of 1_                                                                                    |
| 4   | _View file_                            | expands: entity, type, _"Tax ID ends 6789"_, address, contact, traffic profile, expected minutes, last decision + reviewer note. **The full tax id appears nowhere.** |
| 5   | _Decide_ → `needs-info`, empty note    | refused client-side: _"Say what is missing. A “more information needed” with no note gives the tenant nothing to send."_ — no request sent                            |
| 6   | note typed, _Ask for more_             | **200**; the row re-reads as _More information needed_ with the note, `updatedAt` moved                                                                               |
| 7   | `/platform/traceback`                  | renders; empty state says nothing is queried and nothing is written to the ledger until you search                                                                    |
| 8   | _Search_ with no number                | refused client-side with the unbounded-query sentence; no request sent                                                                                                |
| 9   | called `1002`, 21-day window, _Search_ | **29 legs**, newest first, each with the originating customer, both numbers, both attestation pairs, the Call-ID and the outcome                                      |
| 10  | window widened to 253 days             | refused client-side: _"That window is 253 days. A traceback may scan at most 31; a wider question is a subpoena, not an API call."_                                   |
| 11  | _Download CSV_                         | `traceback-2026-08-20-2026-09-10.csv`, 18-column header + 29 rows, BOM, every field quoted — downloaded through the browser on the session cookie                     |
| —   | page errors / console errors           | **none**                                                                                                                                                              |

One real defect was found and fixed by this proof: the first run logged a React duplicate-key warning
because two legs of one call share `callId`, `startedAt` and both numbers, and the traceback projection
carries no leg id. The row is now keyed by position (with the reason written beside it — the list is a
frozen answer that is never sorted or appended in place). The re-run reports zero page errors.

The smoke org's KYC decision was **restored to `approved`** with its original reviewer note after the
proof; nothing else in any tenant was changed.

---

## 3 — Broker grant gate · DONE

**`.scripts/check-nats-grants.mjs`** (new), wired as root `pnpm run check:nats` and as a CI step in
`.github/workflows/ci.yaml` immediately after the `check:di` step, with the same offline argument
written beside it.

The problem it exists to stop: a permission the account lacks is refused on the connection's error
channel, not to the caller. A pack that adds a stream, bucket or durable consumer and forgets the
grant ships something that boots, logs _"applied JetStream definitions"_, and does not work — which is
what happened to `SECURITY` and `MESSAGING` on this tree.

**What it derives, from the code rather than a hand-kept list:**

- the catalogue from `@optimiq-voice/events` — `packages/events/dist/streams.js` when built, the source
  under `tsx` otherwise — so a new `EVENT_STREAMS`/`KV_BUCKETS` entry is picked up with no edit here;
- what each service ENSURES, by scanning `apps/{api,engine}/src` for `ensureStreams` / `ensureKvBuckets`
  and resolving the identifier list against the catalogue's exports. **An absent list means the whole
  catalogue** — that is the engine's boot path (`ensureStreams(manager)`), and an unresolvable
  identifier is an error rather than a silently skipped assertion;
- every durable consumer name, paired with its stream two ways: an object literal carrying both
  (`{ stream: "CALLS", durable: "pbx-webhook-calls" }`) and a module-level `const DURABLE = "…"` in a
  file naming exactly ONE catalogue stream. A file naming several is REPORTED, never guessed at — a
  wrong pairing would assert the wrong subject and pass.

**What it asserts**, against each user's `publish.allow` list in `config/nats.conf`, with real NATS
wildcard semantics so a `>`-terminated grant satisfies everything beneath it:

- `$JS.API.STREAM.{INFO,CREATE,UPDATE}.<stream>` — exactly the three requests `ensureStreams` makes;
- the same three on `KV_<bucket>` — a bucket is a stream to the JetStream API;
- `$JS.API.CONSUMER.{CREATE,INFO,MSG.NEXT}.<stream>.<durable>` — add it, read its backlog for the
  metrics gauges, pull from it.

Failure output is the exact missing lines, grouped by user, each annotated with what needs it:

```
  $NATS_API_USER (api) — add to its publish allow list:

      "$JS.API.STREAM.INFO.SECURITY"    # stream SECURITY
      "$JS.API.CONSUMER.CREATE.SECURITY.pbx-webhook-security"    # durable pbx-webhook-security on SECURITY (…/webhook-dispatcher.service.ts)
```

**On the current tree it passes, and `config/nats.conf` needed NO change.**

```
api ($NATS_API_USER): 8 streams, 10 buckets, 11 durable consumers, 197 publish grants
engine ($NATS_ENGINE_USER): 12 streams, 18 buckets, 0 durable consumers, 229 publish grants

OK — 177 required JetStream subjects are all granted.
```

That is the coordinator's 00:50 repair holding: the `SECURITY` and `MESSAGING` gaps this checker was
asked to find were already fixed before it existed. Rather than leave that unverified, the check was
driven **negatively** — two grant lines removed from a copy of the file — and it correctly named all
three missing subjects and exited 1 (transcript above).

Since the config did not change there was nothing to reload, but the file was validated anyway:
`nats-server -t -c <stack>/nats/nats.conf` with `<scratchpad>/e2e/env/nats.env` sourced →
_"configuration file … is valid"_. **The broker was not HUP'd** — a reload with no change would have
been a restart risk taken for nothing. Broker permission violations: **1018 before, 1018 after** —
zero new, across every step of this pass.

---

## 4 — Typecheck and lint

**`pnpm turbo run typecheck lint --filter=@optimiq-voice/api --filter=@optimiq-voice/web` cannot run
as written**: there is no `lint` task in `turbo.json` and neither app declares a `lint` script, so
turbo refuses the whole invocation with _"Could not find task `lint` in project"_ before running the
typecheck half. Linting in this repo is the root `oxlint .` over the whole tree. Both halves were run
separately, and a baseline was captured before any of my edits so pre-existing failures are
distinguishable.

| Command                                          | Before my changes                                                                                                                             | After                                                                                                                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `turbo run typecheck --filter=api --filter=web`  | 13/14 tasks pass; **1 error**, `packages/events/src/validate.ts(208,16) TS2339 Property 'error' does not exist on type 'ValidateEventResult'` | **identical** — same single pre-existing error, `@optimiq-voice/web` clean                                                                                                          |
| `oxlint apps/api apps/web`                       | —                                                                                                                                             | **0 errors, 0 warnings**                                                                                                                                                            |
| `oxfmt --check apps/api apps/web .scripts/*.mjs` | —                                                                                                                                             | 2 files unformatted: `apps/api/src/messaging/messaging.service.ts`, `apps/api/test/messaging/messaging.test.ts` — **messaging pack's, not mine**; everything I touched is formatted |
| `apps/api` mocha                                 | 1761 passing, 1 failing                                                                                                                       | **1767 passing, 1 failing** (+6, mine) — the failure is the same pre-existing `webhookSelectors.test.ts:123`, which expects a `messaging` webhook family the messaging pack added   |
| `apps/web` bun                                   | 1006 pass, 3 fail (recording pack's `toRecordingSettings`)                                                                                    | **1063 pass, 0 fail** — the recording pack's three failures are gone, +20 mine +34 theirs                                                                                           |
| `apps/api` `check:di`                            | —                                                                                                                                             | 217 injectable classes across 8 modules, all resolvable                                                                                                                             |
| `check:nats`                                     | —                                                                                                                                             | OK, 177 subjects                                                                                                                                                                    |

The `validate.ts` error and the `webhookSelectors` failure are both named as other packs' in
`GAP2026-security.md` and `GAP2026-compliance.md`; neither is touched by anything here.

---

## Files changed

```
apps/api/src/provisioning/devices/devices.service.ts      the E911 gate
apps/api/src/pbx/pbx.module.ts                            one export line
apps/api/test/provisioning/deviceEmergencyAddress.test.ts new, 6 tests
.scripts/check-nats-grants.mjs                            new, the grant gate
package.json                                              "check:nats"
.github/workflows/ci.yaml                                 the CI step
apps/web/lib/platform/contracts.ts                        new
apps/web/lib/platform/client.ts                           new
apps/web/lib/platform/contracts.spec.ts                   new, 14 tests
apps/web/lib/platform/client.spec.ts                      new, 6 tests
apps/web/lib/routes.ts                                    two routes
apps/web/lib/page-permissions.ts                          two entries
apps/web/lib/query-keys.ts                                two keys
apps/web/app/(app)/_components/nav-config.ts              the Platform section
apps/web/app/(app)/_hooks/use-platform-queries.ts         new
apps/web/app/(app)/platform/kyc/page.tsx                  new
apps/web/app/(app)/platform/kyc/_components/platform-kyc-screen.tsx      new
apps/web/app/(app)/platform/traceback/page.tsx            new
apps/web/app/(app)/platform/traceback/_components/traceback-screen.tsx  new
```

`config/nats.conf` is **unchanged**. No migration was generated, so no migration lock was taken. No
new permission, no codegen re-run, no additive contract change in `packages/events`.

## Stack

- **api restarted once** (`kill $(cat pids/api.pid)` then `up.sh api`), logged in `STACK.md`. web was
  not restarted — `next dev` picked the new routes up itself. engine, sipd, mediad, postgres and nats
  were not touched, and `down.sh` was never run.
- All eight services healthy at the end; engine `activeChannels` untouched; four distinct
  authenticated broker users; **1018 permission violations before and after**.
- Data left behind: none. The E911 probe's device and address were deleted; the smoke org's KYC
  decision was restored to `approved` with its original note.

## Two things for the coordinator

1. **`turbo run lint` does not exist.** If CI or a brief is meant to call it, either add a `lint` task
   to `turbo.json` with per-app `lint` scripts, or change the instruction to `pnpm run lint` (root
   `oxlint .`). I did not add one — it is a repo-wide convention decision, not this pass's.
2. **`apps/api/src/messaging/messaging.service.ts` and `apps/api/test/messaging/messaging.test.ts`
   fail `oxfmt --check`**, and `webhookSelectors.test.ts:123` still fails on the `messaging` family.
   Both are the messaging pack's to close.
