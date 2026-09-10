# FIX — the four closing defects from E2E-final.md

Area: `apps/engine/src/calls` + `packages/telephony` (park path), `apps/api` trunks,
`.scripts/backup/restore.sh`, `.scripts/local-stack/smoke-call.mjs`. Nothing committed, staged or
stashed. No service restarted.

---

## 1. P1 — `*5` parked the presser and recalled nobody — FIXED

**Diagnosis confirmed.** `park(leg)` is internally consistent: it parks `leg` and records
`peerOf(leg)` as the parker. Three of its four callers (the `park` verb, the `park` plan node, the
orchestrator's walker seam) pass the leg that is meant to go into the orbit, and are correct. Only
the mid-call feature code passed the PRESSER, which inverts both halves at once — presser into the
lot, presser's peer recorded as parker, recall routed at the party the parked leg is already on.

Fixed at the call-control seam, as briefed, not at the call site:

- `apps/engine/src/calls/call-control.ts` — new `parkPeer(leg, request)` on `CallControl` and on
  `CallControlPort`: resolves `peerOf(leg)`, parks THAT, and passes `parkedBy: leg` so
  `parkedByNumber` is the presser's number through the existing `numberOf`. Refuses with
  `"this leg has nobody on the other side to park"` when the leg is unbridged.
- `apps/engine/src/calls/mid-call-features.ts` — the `park` action calls `control.parkPeer`;
  `MidCallFeatureControl.park` renamed to `parkPeer` (this port is used by nothing else).
- `side` getter, `numberOf`, `park()` and orbit retrieval are all **unchanged** — the case that
  passes live (dial the orbit to retrieve) is untouched.

`packages/telephony` needed no change: its mid-call machine is digit-collection only and its header
already documents `park` as "put the other party in an orbit slot".

**Regression tests** (`call-control.spec.ts`): one case loops BOTH orientations over the live shape
(1203 arrived, originated leg dialled to reach 1201) and asserts, per orientation, which channel is
in the orbit, that the presser is not, the recorded `parkedByNumber`, and the destination the
timeout actually routes to. Plus a refusal case for a peerless leg. `mid-call-features.spec.ts`
updated to the renamed port method.

## 2. API accepted a registering trunk with no auth user — FIXED

`apps/api/src/pbx/trunks/trunks.service.ts`: `registrationIssue()` refuses, at admission, a trunk
whose effective `kind` is `register` (absent `kind` counts — the column defaults to it) and whose
`authUser` is missing/blank, or whose `sipSecretRef` is missing/blank. Empty strings count as
missing, which is exactly the shape on the live rows. **422**
`code: "PBX_INVALID_TRUNK_REGISTRATION"` with `field` and an `issues[]` entry naming it.

`update` is overridden too: the stored row is read UNREDACTED through the repository (the public
`get` strips `sipSecretRef`, so checking the redacted shape would refuse every patch of a valid
trunk) and the patch merged over it, so a PATCH that only flips `kind` or only clears `authUser` is
refused. Carrier provisioning (`carrier.service.ts`) writes both fields, so it is unaffected.

No migration; validation only. DTO untouched (the rule is cross-field, and `kind` may be absent).

**Live DB, read-only** (`optimiq_pbx`, nothing mutated): 12 trunks, 10 registering, **10 invalid** —
all 10 have `auth_user = ''` and `sip_secret_ref = ''`, and all 10 are `enabled`. 0 rows have a
username but no secret ref. The ids/orgs are the `admmtub*/admmtuc*` fixture trunks.

Tests: `apps/api/test/pbx/trunkRegistration.test.ts`, 8 cases (create missing user; absent `kind`;
missing secret ref; `ip-auth` with no credential accepted; valid create accepted; patch clearing the
user refused; patch flipping to `register` refused; unrelated patch passes through untouched). Each
refusal also asserts the repository was never called.

## 3. `restore.sh` looked for role passwords under names nothing writes — FIXED

`render-env.sh`/`secrets.env` write `API_DB_PASSWORD` / `PBX_DB_PASSWORD` / `CDR_DB_PASSWORD`; the
script read only `RESTORE_*`-prefixed copies, found none, warned, and left `voice_api`/`voice_pbx`/
`voice_cdr` unprovisioned — and then the runtime-login smoke reads silently returned early too, so
the drill reported green on a cluster no service could log in to.

- new `db_password_for <role>` resolves `RESTORE_<X>_DB_PASSWORD` first (kept as an explicit
  override for restoring into a cluster with different passwords), then the plain name.
- a missing password is now **fatal** (`die`), not a warning, unless
  `RESTORE_ALLOW_UNPROVISIONED=yes` is set for a cluster whose roles are managed elsewhere.
- both the provisioning loop and the runtime-smoke loop use the resolver, so the smoke read can no
  longer be skipped by accident.
- header §4 updated with the real variable names.

**Drill re-run** into disposable `*_roledrill` targets from `backup-final/20260909T225056Z`:
row counts match across 18 + 56 + 12 tables; `provisioned voice_api/voice_pbx/voice_cdr`; and the
three runtime-login reads that used to be skipped now run — `voice_api = 70`, `voice_pbx = 1748`,
`voice_cdr = 14871`. `restore complete and verified`. All three databases dropped afterwards.
The fail-loud path was proved separately with the passwords unset (`ERROR: no password in the
environment for voice_api …`); its `*_faildrill` targets were dropped too. Nothing else on the
cluster was touched — the provisioning re-applied the SAME passwords the stack already uses.

## 4. `smoke-call.mjs` 409 on a populated stack — FIXED

- the run mints its own realm: `STACK_REALM ?? \`${run}.local.test\``(e.g.`smokemtv1x9.local.test`). Per-tenant realms are supported, and the softphone takes its domain
from `/me/softphone` (the org's own setting), not from a deployment-wide constant.
- the failure text no longer advises `reset-db.sh`; it says the realm is per-run, so a 409 is a real
  failure and the database must NOT be reset.
- best-effort cleanup at the end deletes the two extensions and prints what is deliberately left:
  the organization, its two users and the call legs — a CDR row is this run's evidence and deleting
  the org would take it with it. Everything left is namespaced by the run id and its own realm.
  `SMOKE_KEEP=1` skips the cleanup.

Not executed: it drives two browsers and a real call, and another agent is running live proofs on
this stack. `node --check` passes; the changed logic is realm derivation, error text and a cleanup
block.

## Cross-area needed

None.

## Marker

`<scratchpad>/e2e/PARK-FIX-READY` written — the engine can be restarted and park re-tested.

## Verification (exact)

- `apps/engine`: `tsc --noEmit` clean; `bun test` → **1847 pass, 26 skip, 0 fail**, 4161 expect(),
  82 files (was 1845/12/0 — +2 park cases; the skip delta is other agents' concurrent edits).
- `packages/telephony`: `bun test` → **259 pass, 0 fail**, 13 files.
- `apps/api`: `tsc --noEmit` clean; `pnpm run test` → **1437 passing, 0 failing**.
- `bash -n .scripts/backup/restore.sh` → ok. `node --check .scripts/local-stack/smoke-call.mjs` → ok.
- `oxlint` on `apps/engine/src/calls`, `apps/api/src/pbx/trunks`, the new test and the smoke script →
  0 findings, exit 0. `oxfmt` applied to the same set (29 files, no other file rewritten).
