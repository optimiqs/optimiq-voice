# FIX — api follow-ups (SIP realm uniqueness, the softphone contract, cross-area sweep)

Branch `feat/optimiq-pbx-phase0`, working tree only. Nothing committed, staged or stashed.

---

## Task 1 — `org_setting sip/realm` uniqueness · **the finding is MOSTLY WRONG**

`FIX-tenant-realm.md`'s "left open" says the realm is "not unique-checked on write" and that a
write-time check "or a `sip_domain` table with a unique index" is needed. **Both halves of that
already exist and are live.** Evidence, in the order I checked it:

**The DB-level guarantee exists — no migration was needed.** It is not a separate `sip_domain`
table; it is a _partial expression_ unique index on `org_setting` itself, declared in
`packages/pbx-db/src/schema/settings-schema.ts:79` and shipped by migration
`20260908000024_pbx_sip_realm_ownership` (committed in `724d9f1`), alongside a check constraint
bounding the value:

```sql
CREATE UNIQUE INDEX org_setting_sip_realm_global_key
  ON org_setting (lower(btrim(value #>> '{}')))
  WHERE category = 'sip' AND name = 'realm' AND enabled;
```

Confirmed present on the running `optimiq_pbx` database (`\d org_setting`). This is why the earlier
work's phrase "global domain uniqueness migration" was ambiguous: the DID one
(`phone_number_e164_global_key`) is a different index on a different table; this is its own.

**The 409 exists.** `toPbxFailure` maps SQLSTATE 23505 to `PbxConflictFailure`, and
`PLATFORM_WIDE_CONSTRAINTS` already carried the disclosure-safe sentence for this constraint. Live,
before any change of mine, Tenant B trying to claim the smoke org's domain:

```
PATCH /api/v1/org-settings/categories/sip  {"realm":"LOCAL.TEST"}
409 {"code":"PBX_CONFLICT","message":"This SIP domain is already assigned to another organization.",
     "kind":"org-setting","field":""}
```

**Case-insensitivity is enforced three times over and they agree**: the catalogue schema
`.trim().toLowerCase()`s on write, the index lowercases, and `sip-credentials.service.ts:80`
lowercases the realm a REGISTER names. `LOCAL.TEST` above was normalised and still collided.

**Domain shape validation exists** — `SIP_SETTINGS` in `org-settings.catalog.ts` rejects a scheme, a
port, a trailing dot and a malformed label. Live: `sip://tenb.local.test:5060` → 400
`SETTING_PATCH_INVALID`, `issues[0].field = "realm"`.

### What was actually broken, and is now FIXED

`field: ""` on that 409. The index is on an EXPRESSION, so `constraintField` finds no column and
answered `""` — the settings form got a 409 it could not attach to an input, which is the difference
between "your SIP domain is taken" appearing under the field and appearing as an anonymous toast.

- `apps/api/src/pbx/shared/pbx.errors.ts` — `PLATFORM_WIDE_CONSTRAINTS` values became
  `{ detail, field? }`; the sip-realm entry states `field: "realm"` (the catalogue's name, i.e. the
  key the patch body carries). `phone_number_e164_global_key` keeps deriving its field from the
  column, unchanged. Two-line change at the call site.

Live after the restart:

```
409 {"code":"PBX_CONFLICT","message":"This SIP domain is already assigned to another organization.",
     "kind":"org-setting","field":"realm"}
```

### Deliberately NOT added: a pre-flight SELECT

A read-then-write uniqueness check would need `adminDb` (RLS hides the other tenant's row, which is
the point), would have a race under it, and would produce a _worse_ answer than the index already
produces — the index is the thing that is actually true. The 409 it raises is the write-time refusal
the finding asked for; it simply arrives from the constraint rather than from a query. Same status,
same code, same sentence, no TOCTOU window.

### Tests

- `apps/api/test/pbx/pbxErrors.test.ts` — a 23505 on `org_setting_sip_realm_global_key` is a 409
  with `field: "realm"`, the platform-wide sentence, and **no** disclosure of the other tenant or
  the index name.
- `apps/api/test/pbx/orgSettings.test.ts` — new `describe("the SIP realm setting's shape")`: it is
  catalogued as an org-scoped nullable string; `  ACME.Example.COM  ` normalises to
  `acme.example.com` (the two-casings-are-one-claim case); eleven malformed domains are refused
  (scheme, https, port, trailing dot, leading dot, space, empty label, leading hyphen, empty,
  64-char label, 254 chars); four good ones and `null` are accepted; a bad domain is blamed on the
  `realm` field. Its header states where each of the three enforcement points is tested.

The two-tenant conflict and same-tenant-update cases are asserted **live** rather than in mocha —
they are properties of a database index, and a unit test with a fake `withTenantScope` would assert
only that the fake was called. Both are recorded above and reproducible against the standing stack.

---

## Task 2 — `GET /api/v1/me/softphone` · **FIXED, contract changed**

**Decision: fold all three refusals into one 200 shape.** Not "keep the 503 and add a 200 for the
404" — two vocabularies for one question is how a client ends up with three branches for one idea.

```
{ "configured": true,  "extension": {…}, "account": {…}, "transport": {…}, "media": {…} }
{ "configured": false, "reason": "no-extension" | "no-realm" | "not-provisioned",
  "code": "SOFTPHONE_NO_EXTENSION" | "SOFTPHONE_NO_REALM" | "SOFTPHONE_NOT_CONFIGURED",
  "message": "…" }
```

The argument, recorded in the service header and restated in the controller header where a client
reader lands first: **none of the three is a failure of the request.** "You hold no extension" is a
fact about the caller; "this organization set no SIP domain" and "this deployment has no
`PROVISION_SIP_SECRET_KEY`" are facts about the configuration. All three are the honest ANSWER to
"what is my softphone?". Only a genuine failure (no session, database down) remains non-200.

**Backward compatibility.** Each unavailable body carries the `code` that state used to be refused
with, marked `@deprecated`. `apps/web`'s `softphoneUnavailability` already branches on
`code === "SOFTPHONE_NO_REALM"` (never on prose), so **that branch keeps working unchanged across
the status change** — the two deploys are independent. The `no-extension` branch does not, because
it keys on `status === 404`; see cross-area below. Degraded, not broken: an un-updated web client
shows the wrong _sentence_ ("no browser SIP transport configured") to a user with no extension, and
shows it without a console error, which is still strictly better than today.

- `apps/api/src/provisioning/softphone/softphone.service.ts` — three `throw`s became
  `return unavailable(...)`; `SoftphoneCredentialsResponse` is now a union discriminated on
  `configured`, with `SoftphoneConfiguredResponse` / `SoftphoneUnavailableResponse`,
  `SOFTPHONE_UNAVAILABLE_REASONS` and a `LEGACY_CODES` map. `NotFoundException` /
  `ServiceUnavailableException` imports dropped.
- `apps/api/src/provisioning/softphone/softphone.controller.ts` — the contract stated in the header,
  both body shapes shown, with the reason it is a 200.
- `apps/api/test/provisioning/softphone.test.ts` — `asConfigured` / `asUnavailable` narrowing
  helpers; the three ex-throwing tests rewritten to assert `reason` **and** the legacy `code`; a new
  test asserting the unavailable arm's keys are exactly `code, configured, message, reason`, so no
  account material can ever ride along on it; the no-realm test additionally asserts the deployment
  edge (`sip.fallback.test`) appears nowhere in the body.
- `.scripts/verify-platform-stack.mjs` — its two `status, 404` assertions on this route would have
  failed the platform verifier the moment this shipped, so they now assert the
  `{configured:false, reason:"no-extension"}` body, and the positive case asserts
  `configured === true`. Outside my directories strictly speaking, but it is _this endpoint's_
  verifier and leaving it red would be worse than touching it. Flagged here rather than done
  silently.

### Live proof (api restarted, logged in `STACK.md`)

| State                               | Body                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| holds an extension, org has a realm | `{"configured":true,"extension":{…"number":"1001"},"account":{…,"realm":"tenbmtudfvz1.local.test"},…}` 200                                        |
| holds no extension                  | `{"configured":false,"reason":"no-extension","code":"SOFTPHONE_NO_EXTENSION","message":"You do not hold an extension on this organization."}` 200 |

The no-extension arm was observed by deleting Tenant B's owner's two `extension_user` rows and
re-creating them immediately; both are restored and verified (`STACK.md` records it). `no-realm` and
`not-provisioned` are unit-tested; `no-realm`'s branch was already proven live by the tenant-realm
agent before the status changed.

---

## Task 3 — the cross-area sweep

Neither `E2E-admin.md` nor `E2E-records.md` uses the phrase "Cross-area needed" (that heading is the
`api-pbx-*` audits' convention); their equivalents are the unfixed findings and the two documents'
"left open" notes. I went through all of them. Inside `apps/api` and not already done:

| Source                             | Item                                                                                | Verdict                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2E-admin F-4                      | `/me/softphone` 404 noise                                                           | **DONE** (task 2)                                                                                                                                                                                                                                                                                                                              |
| FIX-tenant-realm left-open         | realm uniqueness                                                                    | **DONE / mostly already existed** (task 1)                                                                                                                                                                                                                                                                                                     |
| E2E-records F6                     | `cdr.repository.ts:129-137` — `did` and `extension` build byte-identical predicates | **Listed, not done.** Not small: narrowing `did` needs the `phone_number` table, which is in `optimiq_pbx` while `call_legs` is in `optimiq_cdr` — a cross-database join this layer cannot make, so the honest options are a pre-resolved DID list passed in or dropping a public query parameter. Both are decisions, and it is the CDR area. |
| E2E-records F9                     | voicemail message update/delete are not audited                                     | **Listed, not done.** It is a real gap, but it lands in `pbx/voicemail-*`, adjacent to the agent editing media/prompts, and needs an audit-ledger seam through a self-service (non-`PbxResourceService`) path.                                                                                                                                 |
| E2E-records F8                     | `GET /voicemail-boxes` carries no unread counts                                     | **Listed.** API half is a grouped count over the page's ids; the visible half is `apps/web`. Same area as F9.                                                                                                                                                                                                                                  |
| E2E-records F5                     | `voicemail.message.left` never sends `sizeBytes`                                    | Engine-side + `packages/events`. Not `apps/api`.                                                                                                                                                                                                                                                                                               |
| E2E-admin F-3, F-5; E2E-records F7 | logo upload control, `nuqs` inconsistency, live socket                              | `apps/web` only — out of bounds.                                                                                                                                                                                                                                                                                                               |
| E2E-sip F5, F6                     | `scope=registration` ACL enforced nowhere; `sip-acl` KV key carries no org          | `apps/sipd` + `packages/events` key shape. Explicitly "separate decisions" in the tenant-realm report; not small.                                                                                                                                                                                                                              |

### One additional defect found while verifying (not fixed — cross-area)

`GET /api/v1/me/softphone` (and, I expect, **every** `/api/v1/*` route) answers **500 Internal
server error** for an authenticated session with no active organization. `requireActiveOrganizationId`
throws `MissingActiveOrganizationError` (`packages/auth/src/session.ts:87`), which no exception
filter maps, so a caller mid-onboarding — signed up, no organization yet — gets a 500 with no code.
Reproduced live with a fresh unverified sign-up. The fix belongs in the global filter that maps
`packages/auth`'s domain errors (a 409/400 naming the state), not in any one controller, so it is
reported rather than patched here.

---

## Cross-area needed

1. **`apps/web` — the softphone hook must branch on the body, not the status.** Precisely:
   - `apps/web/lib/softphone/contracts.ts` — `SoftphoneCredentialsResponse` becomes the union
     (`configured: true` arm = today's interface; `configured: false` arm =
     `{ configured: false; reason: "no-extension" | "no-realm" | "not-provisioned"; code: string; message: string }`).
   - `apps/web/lib/softphone/credentials.ts` — `softphoneUnavailability` gains a `reason` input and
     branches on it first: `no-extension` → today's 404 sentence, `href: null`; `no-realm` → today's
     sentence + `/settings`; `not-provisioned` → "Browser calling is not configured on this
     deployment yet.", `href: null`. The existing `status === 404` and `code` branches can stay as
     the compatibility fallback. `shapeSoftphoneCredentials` should take the configured arm only.
   - `apps/web/app/(app)/_context/softphone-context.tsx` — `credentialsQuery.data.configured === false`
     is now a successful answer, so the `resolved` memo must return `null` for it _without_ entering
     the try/catch, and pass `reason` into `softphoneUnavailability`. The `retry` predicate's
     `status === 404` special case becomes dead and can go: there is no longer a 404 to not-retry.
   - Net effect once landed: **zero** `/me/softphone` console errors across all 35 admin screens
     (41 in the last audit pass), and the correct sentence for each of the three states.
2. **`packages/auth` + the API's exception filter** — map `MissingActiveOrganizationError` to a
   typed 4xx (see the additional defect above).
3. Everything in the Task 3 table marked "Listed".

**No `packages/pbx-db` change was needed** — the index and the check constraint the brief asked for
already exist and are applied on the running database. No migration was generated.

---

## Verification (exact output)

| Check                                                                             | Result                                  |
| --------------------------------------------------------------------------------- | --------------------------------------- |
| `pnpm --filter @optimiq-voice/api run typecheck` (`tsconfig` + `tsconfig.strict`) | clean                                   |
| `pnpm --filter @optimiq-voice/api run test`                                       | **1248 passing, 3 failing** — see below |
| the three files I touched, run alone (`orgSettings`, `pbxErrors`, `softphone`)    | **79 passing, 0 failing**               |
| `pnpm exec oxlint` over every directory touched                                   | clean (exit 0)                          |
| `pnpm exec oxfmt` over every file touched                                         | 6 files, clean                          |
| `packages/pbx-db`                                                                 | not touched, so not run                 |

**The 3 failures are not mine.** They are all in `describe("the sip auth event consumer")` in
`apps/api/test/pbx/sipAuthEventConsumer.test.ts` — an **untracked, brand-new file** (with
`apps/api/src/pbx/security/sip-auth-event-consumer.service.ts`, also untracked) belonging to the
agent explicitly named in my brief as owning the `sip_auth_event` consumer. Run in isolation that
file is **5 passing, 0 failing**; it only fails inside the whole-suite run, i.e. it is an ordering /
shared-state issue in work still in progress. Before their files appeared, my run of the same suite
was **1246 passing, 0 failing**.

`apps/api` was restarted once (~6 s) to verify against the live stack; logged in `STACK.md` together
with the two Tenant B assignment rows that were removed and restored.
