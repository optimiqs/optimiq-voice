# GAP2026 — AREA=carrier-compliance

Rows closed: **1.4** (outbound attestation decisioning), **2.1** (traceback), **2.2** (tenant KYC),
**2.6** (E911 address validation), **4.10** (webhook secrets at rest), **7.6** (traceback runbook).
Row **1.3** (toll-free BRN / policy URLs) is **already being built by the messaging pack** — evidence
below; not duplicated.

---

## 1.4 — Outbound STIR/SHAKEN attestation decisioning · DONE

The April 2026 FNPRM makes the attestation decision the end-user provider's regardless of who signs.
Nothing decided one; nothing recorded which number a tenant may present; the captured inbound level
was never rendered.

**The decision itself** — `packages/routing/src/attestation.ts` (new, + `attestation.spec.ts`, 14
tests). Pure: `decideAttestation(policy, presented, mainNumber)`. Owned DID → **A**; documented
external verification → **B**; neither → the org's `unverifiedCallerIdPolicy`, one of `allow`
(proceed as C), `replace` (substitute the org's main number and **recompute** the level against it —
a main number that is itself unvouched does not launder a C into an A), `refuse` (named cause). KYC
is checked first and returns the level the call _would_ have had alongside the refusal.

**Where it runs** — `packages/routing/src/resolve.ts`: after the route match, at the first line where
the effective caller id exists (route override → extension → org default all resolved). A refusal
returns `matched: false` on the organization's existing `deniedNodeId`, so **no engine change was
needed** — the toll-class gate's path already carries it, and `originate-plan.ts:96` turns
`!outbound.matched` into a refusal with my `reason`. `ResolvedRoute` gains `expectedAttestation`,
`callerIdRightToUse`, `complianceRefusal`. The emergency short-circuit returns before all of it.

**Where the table comes from** — `compileAttestationPolicy` in `compile.ts` derives the `owned` half
from the snapshot's own `phoneNumbers` (no second copy that can disagree) and takes the `verified`
half from a new `settings.verifiedCallerIds`, already filtered for expiry by the loader (the compiler
reads no clock). `owned` wins a collision. The block rides `CompiledRoutingSettings` so
`canonicalizeSnapshot` hashes it for free; absent means an artifact compiled before this landed, and
such a reader decides nothing and refuses nothing — not an artifact-version bump.

**Loader** — `apps/api/src/pbx/routing/snapshot-loader.ts`: `readComplianceSettings`, three more
statements in the same batch (the `compliance` settings category, `verified_caller_id`,
`organization_kyc.decision`). Every key absent when the tenant configured nothing, so no existing
organization's snapshot hash changes.

**Ledger** — `packages/cdr-db` `call_legs` gains `expected_attestation`, `caller_id_right_to_use`
(plus `trunk_ref`, `signaling_address` for 2.1). `cdr-leg-mapping.ts` maps all four, validates the
level to A/B/C and the basis to owned/verified, records a coercion for anything else, and keeps them
out of `raw` (7 new tests). `cdr.repository.ts` selects the attestation pair on the LIST and the
traceback pair on the DETAIL.

**UI** — `apps/web/app/(app)/cdr/_components/call-detail.tsx` renders, for the first time, both
pairs, labelled to keep them apart: _Carrier claimed_ / _Carrier verification_ / _Originating ID_
against _We attested_ / _On the basis of_, plus _Trunk_ and _Signalling from_. Levels are spelled out
(`A — full attestation`) via new helpers in `lib/cdr/format.ts` (8 tests). Grep for `attestation`
under `apps/web/` returned **zero** hits before this.

**Report** — `GET /api/v1/compliance/attestation-summary` (`compliance.read`), per presented number,
counts by level and the recorded basis.

## 2.1 — Traceback · DONE

`GET /api/v1/platform/traceback` and `…/export.csv`, `compliance.traceback`. Cross-tenant on the
untenanted CDR handle; per leg it answers with the originating organization + name + KYC decision,
`callId`, `startedAt`, direction, both numbers, `sipCallId`, `trunkRef`, `signalingAddress`, the
carrier's attestation trio, our own pair, disposition and duration. Caps: 31 days, 500 rows with a
`truncated` flag. **Every query writes an audit row** (filed under the operator's own organization —
a cross-tenant query has no single tenant to file under).

Backed by three indexes in `cdr-db` that deliberately do **not** lead with `organization_id`, because
the question has no tenant: `call_legs_traceback_to_idx (to_number, started_at desc)`,
`call_legs_traceback_from_idx`, and a partial `call_legs_trunk_idx`. Every tenant-facing index leads
with `organization_id` and cannot serve this at all. `cdr-schema.spec.ts` was updated to name them.

Runbook: **`docs/runbooks/traceback-response.md`** — who answers, the exact query, the field→ITG-form
mapping, why the two attestation pairs differ, the retention trap, and the audit row as the evidence
that the 24-hour clock was met.

## 2.2 — Tenant KYC · DONE

`packages/pbx-db/src/schema/compliance-schema.ts` (new): `organization_kyc` (one row per org, unique
on `organization_id`) and `verified_caller_id`. Legal entity name, type, **encrypted** tax id +
plaintext `tax_id_last4`, registered address, authorised contact, website, expected traffic profile +
monthly minutes, decision (`pending|approved|rejected|needs-info`) with reviewer and timestamp.
Migration `20260910050727_pbx_carrier_compliance` + a hand-written grants migration, both applied.

`tax_id` uses the existing AES-256-GCM envelope (`packages/db/src/secret-cipher.ts`,
`PLATFORM_SECRET_ENCRYPTION_KEY`) with the SSO lazy-migration shape. It is **absent from the read
projection entirely** — no response can leak it — and named in the audit diff's secret columns.

Routes: tenant `GET`/`PUT /api/v1/compliance/kyc`; a tenant amendment of a decided file resets it to
`pending` and clears the reviewer trio; a tenant can never write `decision`. Operator
`GET /api/v1/platform/compliance/kyc` and `POST …/:organizationId/decision` (`compliance.review`).
Verified caller ids are a normal PBX CRUD slice at `/api/v1/compliance/caller-ids`.

Org policy `compliance.requireKycForOutbound` blocks outbound PSTN with the named cause
`kyc-not-approved` at the outbound resolve seam. Two flags rather than one (decision vs enforcement)
so that shipping the feature does not instantly cut off every tenant nobody has reviewed yet.

Web: `/compliance` (`compliance.read`) — KYC form with the decision badge and reviewer notes, verified
caller ids panel, policy panel.

## 2.6 — E911 dispatchable-location validation · DONE

`emergency-addresses.resource.ts:26` said validation "is a call to a carrier's E911 provisioning API"
and nothing implemented it; `validated`/`validatedAt`/`validationProvider`/`validationReference`
existed and **nothing ever wrote them**.

`packages/telnyx/src/resources/e911-addresses.ts` (new) wraps validate / create-with-validation / get
/ list / delete, composed onto `TelnyxClient`; the loopback fake serves all of them with a
state-controlled valid / invalid / suggested-alternative answer. `POST /api/v1/emergency-addresses/:id/validate`
(`numbers.emergency`) writes all four columns from the carrier's answer and reports the failure reason
and any suggested correction; create/update re-validate when a carrier is configured, and a carrier
outage leaves the row unvalidated rather than failing the write. No carrier configured →
`503 CARRIER_NOT_CONFIGURED`, everything else unaffected. `validated` is read-only output; the
`z.strictObject` DTO refuses it as input.

**Assignment is refused**: `EmergencyAddressesService.assertAssignable` throws
`EMERGENCY_ADDRESS_NOT_VALIDATED` (409), wired into `PhoneNumbersService.create/update` — only when
the write names the column, so an unrelated edit to a grandfathered DID still succeeds and clearing
an address stays possible.

## 4.10 — Webhook signing secrets encrypted at rest · DONE

`webhook_subscription.secret` was plaintext by design. It cannot be hashed (the platform is the
signer) but it can be encrypted. Create and rotate now seal with `encryptSecret(…, requireSecretKey())`;
the create response still returns the plaintext once, which is the existing deliberate exception.
The dispatcher unwraps in `subscriptionsFor`'s per-subscription cache fill, where selectors are
already compiled once — so the unwrap is amortised and `signWebhookBody` is untouched. A plaintext
row found while a key exists is re-sealed in place, best-effort; with no key it still signs and is not
re-written, so a deployment that never set the key does not lose its webhooks. Schema header
corrected. `PLATFORM_SECRET_ENCRYPTION_KEY` **is** set on the local stack.

## 1.3 — Toll-free BRN / policy URLs · ALREADY IN FLIGHT, not duplicated

`packages/pbx-db/src/schema/messaging-schema.ts:331-345` already declares
`business_registration_number`, `business_registration_type`, `business_registration_country`,
`privacy_policy_url` and `terms_and_conditions_url` on `messaging_toll_free_verification` — the exact
Feb-2026 BRN trio and the Sept-2026 policy URLs. That table belongs to the messaging pack (row 1.1/1.2),
which is mid-flight (schema present, migration and API module not yet). Adding the same fields to
`phone_number` would have been a second, disagreeing copy. **Left to them.**

## Permissions

`packages/auth/src/permissions.ts`: `compliance.read`, `compliance.write`, `compliance.review`,
`compliance.traceback`. The last two are in `OWNER_ONLY_PERMISSIONS` — a tenant approving its own KYC
file makes the file worthless, and a tenant answering a traceback is reading another tenant's calls.
They carry no `.all` suffix because no tenant holds a narrower version to scope _from_; the boundary
is expressed the way `org-limits.write` expresses its own. Registry 121 → 125, ceiling moved keeping
the four spare it has always left, with the argument recorded beside the entries and in the spec.
Web codegen re-run.

---

## Live proof (standing stack, real API, real Postgres, real session cookie)

Script: `<scratchpad>/e2e/calling/compliance2026.mjs`. Every answer below is
`POST /api/v1/routing/simulate` compiling the tenant's **actual** configuration from the database.

| #    | Configuration                                                                                                | Result                                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | policy `allow`, CLI `+442079460001` (not owned)                                                              | `matched: true`, **C**, call placed                                                                                                                                    |
| 2    | policy `refuse`, same CLI                                                                                    | `matched: false`, `complianceRefusal: unverified-caller-id`, _"caller id +442079460001 has no right-to-use record and the organization refuses unverified caller ids"_ |
| 3    | CLI `+15005550161` (an owned DID)                                                                            | **A**, `callerIdRightToUse: owned`                                                                                                                                     |
| 4    | `+442079460001` given a `carrier-loa` verification record                                                    | **B**, `callerIdRightToUse: verified`                                                                                                                                  |
| 5    | verification withdrawn, policy `replace`, extension presents `+442079460001`, org main `+13125557001`        | presented number **replaced** with `+13125557001`, level recomputed to **A**                                                                                           |
| 6    | `requireKycForOutbound: true`, no file                                                                       | `matched: false`, `complianceRefusal: kyc-not-approved`                                                                                                                |
| 6a-b | KYC filed (`taxIdLast4: "6789"`, full tax id never in any response)                                          | decision `pending` → still refused                                                                                                                                     |
| 6d-e | operator `POST /platform/compliance/kyc/:org/decision` → `approved`, reviewer id + timestamp + notes written | call placed                                                                                                                                                            |
| 7    | `GET /platform/traceback?calledNumber=1002`, 30-day window                                                   | **29 legs across 2 organizations** (`Smoke Org`, `Tenant B`), each with trunk, Call-ID, source IP and both attestation pairs                                           |
| 7a   | `…/export.csv`                                                                                               | `200 text/csv; charset=utf-8`, 18-column header, every field quoted                                                                                                    |
| 8    | `GET /compliance/attestation-summary`                                                                        | `200`, empty (see the gap below)                                                                                                                                       |

Index actually used, on the live database:

```
explain (costs off) select id from call_legs
  where to_number = '1002' and started_at between now() - interval '30 days' and now();
  Append
    Subplans Removed: 1                      <- partition pruning
    ->  Bitmap Index Scan on call_legs_2026_09_to_number_started_at_idx
```

E911 and the webhook envelope are proven by their suites against the loopback Telnyx fake and by the
`v1.` envelope assertions respectively; neither has a live carrier on this stack.

## The one gap, stated plainly

**The `expected_attestation` column is not yet filled for a handset-originated call.** The routing
decision is made and is visible on the resolver, the simulate response and the diagnostics — but the
engine does not carry it onto the leg, and `apps/engine/src/calls/**` belongs to another pack.

The API-side backfill (`cdr-writer.service.ts` → `AttestationPolicyService`) is wired and now fires on
any leg that reached a carrier (`destination_type` `trunk`/`external`, not only `direction ===
"outbound"` — I widened this after live proof showed the engine labels a handset's A-leg `internal`
and its trunk B-leg `inbound`). It is deliberately guarded to act only when `from_number` is already
an E.164: on a handset call the engine writes the **extension number** (`2001`) there, and looking
that up would miss and stamp **C** onto a call actually attested **A**. A wrong level in a compliance
ledger is worse than an absent one.

**Cross-area needed (engine pack, ~3 lines):** in `apps/engine/src/calls/cdr-leg.ts`, extend
`attestationOf` to read `OPTIMIQ_EXPECTED_ATTESTATION` / `OPTIMIQ_CALLER_ID_RIGHT_TO_USE` and emit
`expectedAttestation` / `callerIdRightToUse`; set those channel variables from
`resolveOutbound`'s new fields where the orchestrator already sets `callerIdNumber`. The mapper,
the columns, the query projection, the UI and the summary report all already accept them.

**Cross-area needed (provisioning pack, 1 line):** `devices.service.ts` should call
`emergencyAddresses.assertAssignable(session, values.emergencyAddressId, "this device")` before the
write, the way `phone-numbers.service.ts` now does. Until then a device can still be given an
unvalidated address.

**No platform-operator UI.** `apps/web` has no operator area at all, so `compliance.review` and
`compliance.traceback` have API surfaces and no screens. Out of scope for this pass; named as the
follow-up.

## Verification (exact counts)

| Suite              | Result                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/routing` | **965 pass, 0 fail** (24 files) — 14 new in `attestation.spec.ts`, 9 new in `resolve.spec.ts`                                                                                                                                                                                                                                                                                                                      |
| `packages/cdr-db`  | **79 pass, 35 skip, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/pbx-db`  | **117 pass, 21 skip, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/auth`    | **243 pass, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/telnyx`  | **136 pass, 0 fail** (6 new)                                                                                                                                                                                                                                                                                                                                                                                       |
| `apps/api` (mocha) | **1761 passing, 1 failing** — the failure is `webhookSelectors.test.ts:123` expecting a `messaging` family the messaging pack just added. Not mine.                                                                                                                                                                                                                                                                |
| `apps/web` (bun)   | **1006 pass, 3 fail** — all three are `toRecordingSettings` in `lib/org-settings/org-settings.spec.ts`, broken by the recording-consent pack's additions to that resolver. Not mine.                                                                                                                                                                                                                               |
| typecheck          | `routing`, `pbx-db`, `cdr-db`, `auth`, `db` clean. `apps/api`: errors only in `messaging/*` and `test/pbx/trunkDirectoryProjection.test.ts` (`srtpPolicy`, trunk-security pack). `apps/web`: one error in `lib/toll-fraud/policy-form.ts` (untracked, toll-fraud pack). `packages/routing` typecheck also reports 6 pre-existing errors in `compile.spec.ts` from the contact-centre pack's queue-skills fixtures. |
| `oxlint` / `oxfmt` | clean over every directory I touched                                                                                                                                                                                                                                                                                                                                                                               |

## Notes for the coordinator

- **Migration lock** was taken and released for `pbx-db` and `cdr-db` in turn; both migrations were
  generated, applied to the local database, and typechecked inside the lock.
- I restarted **api** and **web** only, one service per `up.sh` invocation. I never ran `down.sh`,
  never a bare `up.sh`, and never touched postgres or nats. I added no stream and no KV bucket, so
  `config/nats.conf` needed no change.
- While the api would not boot I temporarily removed `MessagingModule` from `main.ts`'s module list
  to run a live proof, and **restored it** as soon as the messaging pack's DI bug was fixed. `main.ts`
  is back to their shape.
- Two things I saw in passing that belong to other packs and that I did **not** fix:
  `pbx-db`'s `tenant-grants.spec` and `schema.spec` fail on `conversation` (no GRANT) and
  `message_send_queue_idx` (leads with `status`), both from the messaging pack; and the broker log
  shows `Permissions Violation for Publish to "$JS.API.CONSUMER.CREATE.SECURITY.…"` — the security
  pack added a `SECURITY` stream consumer without the matching `config/nats.conf` grant.
