# E2E — AREA = admin

Everything an administrator does through the web app and the API that is not a live call, exercised
against the running local stack (web 3300, api 3200, Postgres 5533, SMTP fixture 2625) on
2026-09-09.

**375 checks, 373 pass, 2 fail** — both failures are findings reported below (one is a missing UI
control, one is deliberate-but-noisy behaviour I chose not to change). Three defects were found and
two of them were fixed with tests; the third is reported.

Harness (re-runnable, in order): `<scratchpad>/e2e/artifacts/admin/`
`01-auth.mjs` (31) · `02-crud.mjs` (214) · `03-perms.mjs` (52) · `04-perf.mjs` (22) ·
`05-ui.mjs` (56, Playwright Chromium). Screenshots in `artifacts/admin/shots/`, timings in
`timings.json`, browser console capture in `ui-errors.json`.

Own tenants only: every organization, user, extension and DID is prefixed with a per-run id
(`adm<base36>`). Nothing belonging to another agent was read, written or deleted.

---

## 1. Scenario table

| #    | Scenario                                  | Steps                                                                                 | Expected                                        | Observed                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                          | Verdict |
| ---- | ----------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------- |
| 1.1  | Sign-up + email verification              | `POST /sign-up/email`, poll SMTP fixture, follow the link                             | 200, mail lands, link verifies                  | 200; mail `mail/00NN.eml`; `verify-email?token=…` → 302; `emailVerified: true` on next sign-in                                                                                                                                                                                                                                                                                                             | `01-auth.mjs`, `shots/01-sign-in.png`             | PASS    |
| 1.2  | Sign-in                                   | correct and wrong password                                                            | 200 / 401, session cookie first-party on :3300  | 200 sets `optimiq_voice_session-v1.session_token` + `.session_data` on the Next origin; wrong password 401                                                                                                                                                                                                                                                                                                 | `01-auth.mjs`                                     | PASS    |
| 1.3  | Sign-in through the UI                    | fill the form, submit                                                                 | error shown in place; success navigates         | wrong password stays on `/sign-in` with a message; correct navigates to `/`                                                                                                                                                                                                                                                                                                                                | `shots/02-bad-password.png`, `03-signed-in.png`   | PASS    |
| 1.4  | Password reset                            | request → mail → token → sign in                                                      | new password works, old does not                | reset mail delivered; link 302s to `/reset-password?token=`; reset 200; old password 401                                                                                                                                                                                                                                                                                                                   | `01-auth.mjs`                                     | PASS    |
| 1.5  | 2FA enable / verify / challenge / disable | enable, verify a generated TOTP, re-sign-in, disable                                  | second factor demanded then not                 | `totpURI` + 10 backup codes; verify 200; next sign-in returns `twoFactorRedirect: true`; wrong code 401; after disable, sign-in is 200 with no challenge                                                                                                                                                                                                                                                   | `01-auth.mjs`                                     | PASS    |
| 1.6  | Session expiry / sign-out                 | sign out, then call the API                                                           | 401 afterwards                                  | signed-out session, anonymous caller and a forged cookie all 401                                                                                                                                                                                                                                                                                                                                           | `01-auth.mjs`                                     | PASS    |
| 2.1  | Invitation → accept → right org           | invite, verify invitee, accept, read `/me`                                            | lands in the inviting org with the invited role | mail carries the invitation id; accept 200; `/me` shows the org and role (`user`, `agent`)                                                                                                                                                                                                                                                                                                                 | `03-perms.mjs`                                    | PASS    |
| 2.2  | `redirectTo` preserved                    | open `/accept-invitation/:id?redirectTo=/voicemail` signed out                        | the target survives the bounce                  | the accept page renders and keeps the id and target                                                                                                                                                                                                                                                                                                                                                        | `03-perms.mjs`                                    | PASS    |
| 2.3  | Reseller child org + owner seating        | flip `is_reseller`, create child naming an owner                                      | child created, named user seated as `owner`     | 201; child in `/reseller/children`; the named user signs in and `/me` reports `role: owner` on the child; unknown `ownerUserId` is a clean 4xx; a self-service member gets 403                                                                                                                                                                                                                             | `03-perms.mjs`                                    | PASS    |
| 3.1  | PBX CRUD, 24 resources                    | create → list → get → patch → delete → 404                                            | every step succeeds                             | extensions, ring groups, queues, IVR menus, time conditions, shared lines, paging groups, park lots, MOH classes, translation rulesets, pin sets, destination aliases, audio streams, directories, emergency addresses, conferences, voicemail boxes, SIP ACL, webhooks, call-block rules, feature codes, device profiles, phrases, trunks, DIDs, inbound/outbound routes, call flows, devices — all green | `02-crud.mjs`                                     | PASS    |
| 3.2  | Ordered child collections                 | create / list / reorder / delete                                                      | envelope and ordering hold                      | ring-group destinations, queue tiers, IVR options, time-condition rules, translation rules, pin-set entries, shared-line appearances, paging-group members                                                                                                                                                                                                                                                 | `02-crud.mjs`                                     | PASS    |
| 3.3  | Extension ↔ user assignment dialog        | assign, list, re-assign, unassign                                                     | duplicate refused                               | assignment created and listed; duplicate 4xx; delete 200                                                                                                                                                                                                                                                                                                                                                   | `02-crud.mjs`                                     | PASS    |
| 3.4  | Device provisioning URL                   | mint a token, fetch the config as a phone would                                       | config renders; unknown token refused           | `provisioning.token` + `configUrl` returned once; `GET /provision/<token>/config` on :3200 returns the vendor file; unknown token 404                                                                                                                                                                                                                                                                      | `02-crud.mjs`                                     | PASS    |
| 3.5  | Org settings incl. SIP realm              | read catalog, PATCH `sip`, read back, PATCH garbage                                   | writes, reads back, rejects                     | `realm` written and read back; `not a domain!!` → 400 `SETTING_PATCH_INVALID`                                                                                                                                                                                                                                                                                                                              | `02-crud.mjs`                                     | PASS    |
| 3.6  | Branding + logo upload                    | PATCH branding, multipart logo, read bytes back                                       | uploaded logo renders                           | upload 200, key under `branding/`; **the bytes were unreachable — see F-2** (now fixed and passing)                                                                                                                                                                                                                                                                                                        | `02-crud.mjs`                                     | FIXED   |
| 3.7  | API keys                                  | create, use, delete, re-use                                                           | key works then stops                            | org-scoped create needs `organizationId` (documented); key authenticates `/api/v1/*`; after delete 401; bogus key 401                                                                                                                                                                                                                                                                                      | `02-crud.mjs`                                     | PASS    |
| 3.8  | Audit log                                 | read after a run of writes                                                            | this run's writes are recorded                  | 200, 25 rows on page 1                                                                                                                                                                                                                                                                                                                                                                                     | `02-crud.mjs`                                     | PASS    |
| 3.9  | Every admin screen renders                | 35 routes, signed in                                                                  | 200, no error boundary                          | all 35 render; no uncaught page errors anywhere                                                                                                                                                                                                                                                                                                                                                            | `05-ui.mjs`                                       | PASS    |
| 3.10 | Real CRUD through the UI                  | create an extension in the dialog, find it in the table                               | row appears                                     | created and found via the table search                                                                                                                                                                                                                                                                                                                                                                     | `shots/05-extension-dialog.png`, `07-created.png` | PASS    |
| 4.1  | Permission enforcement — `.own`           | seat a `user`, assign one extension, hit 21 endpoints                                 | own only; everything else 403                   | reads/writes their own extension; another extension 403; **list narrowed to exactly 1 row**; own voicemail box readable, another 403; all 14 admin endpoints 403                                                                                                                                                                                                                                           | `03-perms.mjs`                                    | PASS    |
| 4.2  | `.own` in the UI                          | sign in as the `user`, check nav and deep links                                       | admin sections hidden and unreachable           | nav shows only Dashboard/Softphone/Extensions/Devices/Voicemail/Media/Recordings/Call history/Settings; `/trunks`, `/audit-log`, `/security`, `/webhooks` all blocked                                                                                                                                                                                                                                      | `shots/11-self-service.png`                       | PASS    |
| 4.3  | Read-mostly role cannot mutate            | seat an `agent`, 2 reads + 6 writes                                                   | reads 200, writes 403                           | exactly that                                                                                                                                                                                                                                                                                                                                                                                               | `03-perms.mjs`                                    | PASS    |
| 4.4  | API-key privilege escalation              | self-service member tries to mint an org key                                          | refused                                         | 403 `INSUFFICIENT_API_KEY_PERMISSIONS` on create and list — an org key acts with membership role `admin`, so this is the escalation that matters and it is closed                                                                                                                                                                                                                                          | ad-hoc probe                                      | PASS    |
| 4.5  | Cross-tenant isolation                    | a second org's owner reads our rows                                                   | 404/403                                         | extension 404 `PBX_NOT_FOUND`; member list 403                                                                                                                                                                                                                                                                                                                                                             | `03-perms.mjs`                                    | PASS    |
| 5.1  | Compile-on-write: dangling destination    | inbound route pointing at a non-existent extension                                    | 4xx blamed on `destinationRef`                  | 422 `PBX_INVALID_DESTINATION`, `issues[0].field = "destinationRef"`                                                                                                                                                                                                                                                                                                                                        | `02-crud.mjs`                                     | PASS    |
| 5.2  | Duplicate number                          | second extension on the same number                                                   | 4xx blamed on `number`                          | 409 `PBX_CONFLICT`, `field: "number"`                                                                                                                                                                                                                                                                                                                                                                      | `02-crud.mjs`                                     | PASS    |
| 5.3  | Duplicate DID                             | second phone number on the same E.164                                                 | 4xx blamed on `e164`                            | 400 with `issues[0].field = "e164"`                                                                                                                                                                                                                                                                                                                                                                        | `02-crud.mjs`                                     | PASS    |
| 5.4  | Bad regex                                 | translation rule with `^(unclosed`                                                    | 4xx blamed on `matchPattern`                    | rejected on that field                                                                                                                                                                                                                                                                                                                                                                                     | `02-crud.mjs`                                     | PASS    |
| 5.5  | Whole-org compile                         | `POST /routing/compile`                                                               | 200, published, warnings only                   | 200, `published: true`, warnings (empty time condition, extension with voicemail and no box) — no errors                                                                                                                                                                                                                                                                                                   | `02-crud.mjs`                                     | PASS    |
| 6.1  | Validation parity, UI vs API              | non-numeric extension number in the dialog                                            | UI refuses, matching `internalNumber`           | UI refuses before submit with the same message shape                                                                                                                                                                                                                                                                                                                                                       | `shots/06-validation.png`                         | PASS    |
| 6.2  | Validation parity, DTO edges              | `limit=1000`, `page=abc&limit=-3`, short PIN, malformed SIP domain, unrecognised keys | clean 400s, never 500                           | all 400 with `PBX_INVALID_BODY` / typed codes and a `field` on each issue                                                                                                                                                                                                                                                                                                                                  | `02-crud.mjs`, `04-perf.mjs`                      | PASS    |
| 7.1  | Pagination                                | 302 rows, pages 1 and 2, past the end, over the cap                                   | correct, non-overlapping, clean errors          | 25+25 with no overlap; `totalPages` = ceil(total/limit); a page past the end is an empty page not an error; `limit=1000` → 400 (MAX_LIMIT is 100 by design)                                                                                                                                                                                                                                                | `04-perf.mjs`                                     | PASS    |
| 7.2  | Debounced picker/table search             | label and number search, no-hit, metacharacters, whitespace                           | filters, escapes, degrades                      | filters on label and number; `total` reflects the filter; no-hit is an empty page; `100%_' or 1=1 --` matches nothing (LIKE metacharacters and quotes are literals); whitespace-only is no filter                                                                                                                                                                                                          | `04-perf.mjs`                                     | PASS    |
| 7.3  | Search in the UI                          | type into the table search                                                            | rows filter, empty state on no hits             | filters after the debounce; empty state rendered                                                                                                                                                                                                                                                                                                                                                           | `shots/08-search.png`, `09-empty-search.png`      | PASS    |
| 8.1  | API latency                               | 60 samples per endpoint, warm                                                         | p99 well inside budget                          | see §3                                                                                                                                                                                                                                                                                                                                                                                                     | `timings.json`                                    | PASS    |
| 8.2  | Latency creep                             | 200 consecutive list calls                                                            | no drift                                        | p50 6.9 ms → 5.6 ms                                                                                                                                                                                                                                                                                                                                                                                        | `04-perf.mjs`                                     | PASS    |

---

## 2. Findings

### F-1 · P1 — a forbidden better-auth read was retried with backoff, then reported as "no data"

**Where** `apps/web/lib/auth-client.ts`, `apps/web/lib/query-client.ts`,
`apps/web/app/(app)/_hooks/use-api-key-queries.ts`, `use-organization-queries.ts`,
`_components/organization-switcher.tsx`.

`query-client.ts` documents that "retrying a 4xx is always wrong — a 403 re-asks a question the
permission guard has already answered", and enforces it with `error instanceof ApiError`. Every
better-auth-backed query threw a bare `new Error(authErrorMessage(...))`, which that predicate does
not recognise — so a 403 fell through to the generic backoff.

Observed: a self-service member opening `/settings/api-keys` (the page **is** in their navigation —
the `user` role holds `api-keys.*.own`) sat on "Loading API keys" through three retries, then landed
on an **"No API keys"** empty state — telling them their organization has no keys when the truth is
that they may not see them. Evidence: `shots/12-self-api-keys.png` (before), `05-ui.mjs`.

**Fixed.** Added `authQueryError()`, which wraps a better-auth failure in `ApiError` carrying its
status, and used it at all 12 throw sites; added an explicit error branch to the API-keys page
("API keys are not visible to you" plus the server's message). Mutation/toast call sites keep
`authErrorMessage` — they render text and never retry.
Tests: `apps/web/lib/auth-client.spec.ts` (7, incl. a regression test asserting the bare `Error`
_would_ have retried). Re-verified live: the page now renders the explanation immediately.

### F-2 · P1 — an uploaded white-label logo could never be rendered by a tenant without a custom domain

**Where** `apps/api/src/pbx/branding-logo/branding-logo.controller.ts`,
`apps/web/lib/branding/contracts.ts`.

`GET /api/v1/branding/logo` required `?host=` and resolved it through
`organization_branding.custom_domain`. Only a tenant white-labelled onto its own login host has one.
So on the shared platform host: `POST /branding/logo` stored the bytes and wrote `logoObjectKey`
onto the row — and **no route in the product would ever serve them**. The signed-in shell made it
certain: `sidebar.tsx` calls `brandLogoSrc(brand)` with no host at all, and `brandLogoSrc` returned
`null` for a bare key with no host, so the logo was silently dropped and the product initial shown.
Reproduced: upload 200 with a `branding/<org>/<id>.png` key, then `GET /branding/logo?host=127.0.0.1:3300` → 404.

**Fixed.** `host` is now optional: named host = the anonymous pre-auth path (unchanged); omitted =
resolve the acting session's own organization. Neither path lets a caller name an object, and the
`branding/` prefix bound on read is still enforced on both. A caller with neither is a 400
(`BRANDING_LOGO_UNRESOLVABLE`) rather than a silent fall-through to the platform default. The
`Cache-Control` directive moved off the decorator and now follows the resolution — `public` for the
host answer, **`private`** for the session answer, so a shared cache cannot hand one tenant's logo to
the next caller of the same URL. `brandLogoSrc` returns the hostless route when it has no host.
Tests: 5 new controller tests in `apps/api/test/pbx/brandingLogo.test.ts`, 2 rewritten in
`apps/web/lib/branding/contracts.spec.ts`.
Re-verified live: `GET /api/v1/branding/logo` with a session → `200 image/png, private, max-age=300`;
anonymous with no host → 400; anonymous on the shared host → 404 (unchanged).

### F-3 · P1 — the branding screen has no logo upload control (not fixed)

`POST /api/v1/branding/logo` exists, works, sniffs magic bytes, namespaces the key and enforces the
storage quota. `/settings/branding` exposes **no file input at all** — only a raw text field labelled
"Logo" whose help text still says _"The logo's object-storage key, or an https/data: URL. Leave empty
for the built-in mark. (Upload-to-key is a pending media seam.)"_. That seam is no longer pending;
the endpoint shipped. An administrator can only set a logo by pasting an object key they have no way
to obtain through the product.

Evidence: `shots/10-branding.png`; `05-ui.mjs` — "branding screen offers a logo file upload —
file inputs=0" (the one remaining functional failure).

Not fixed: this is a new form control plus upload mutation and preview wiring on
`app/(app)/settings/branding/page.tsx`, which is a feature-sized change rather than the minimal local
diff this pass is scoped to. F-2 is its prerequisite and is now in place, so the control has
somewhere to render to.

### F-4 · P2 — every admin page logs a browser console error for an expected outcome

`GET /api/v1/me/softphone` answers **404** `SOFTPHONE_NO_EXTENSION` for a user who holds no
extension. The docked softphone provider fires it on every page, so every one of the 35 admin screens
emits `Failed to load resource: … 404` in the console (41 across the pass). The app handles it
correctly — `softphone-context.tsx` explicitly does not retry a 404 — but the browser logs the
network failure regardless, which buries any real console error in noise. `/sign-in` similarly logs a
401 from the pre-auth session probe.

Not changed: the 404 is a deliberate, documented contract ("a stable fact about the caller"), and
turning it into `200 { extension: null }` touches the response shape, the shaping code and its tests
— a contract change, not a local fix. Worth doing; flagging rather than doing it unilaterally.

### F-5 · P2 — table state is URL-synced on some screens and not others

`nuqs` drives the filter/page state on `/numbers`, `/recordings`, `/security`, `/audit-log`,
`/cdr`, `/queues`, `/wallboard`. `/extensions` (and the screens on the same shared hook) keep it in
`useState`, so `/extensions?search=X` is ignored, a filtered view cannot be linked or shared, and
browser Back does not restore it. Cosmetic per-screen, inconsistent across the product.

### Non-findings worth recording (each was suspected, then disproved)

- **`limit=1000` is refused.** `MAX_LIMIT = 100`, so the brief's 1000-row page size is a clean 400
  by design, not a bug. Measured 25 and 100.
- **Org-scoped API-key create requires `organizationId`.** `@better-auth/api-key` with
  `references: "organization"` 400s without it and `list` silently returns _user_-owned keys — both
  are documented at `use-api-key-queries.ts` and the web client passes it.
- **A stale `emailVerified: false` after verifying on another device** is the 5-minute
  `session.cookieCache`, not a bug.
- **`is_reseller` has no self-service API.** Correct: it is a platform capability. I set it on my own
  org row directly to exercise the reseller surface.

---

## 3. Measurements

60 samples each (25 for sign-in), through the Next proxy, warm, 302 extensions in the org.

| Endpoint                                              | p50     | p99     |
| ----------------------------------------------------- | ------- | ------- |
| `GET /api/v1/extensions?limit=25`                     | 6.5 ms  | 9.2 ms  |
| `GET /api/v1/extensions?limit=25&search=Zeta`         | 7.1 ms  | 23.0 ms |
| `GET /api/v1/extensions?limit=100`                    | 8.3 ms  | 12.8 ms |
| `GET /api/v1/extensions?limit=100&search=Zeta`        | 6.7 ms  | 15.6 ms |
| `GET /api/v1/queues?limit=25`                         | 5.4 ms  | 9.2 ms  |
| `GET /api/v1/audit-log?limit=25`                      | 6.8 ms  | 9.7 ms  |
| `GET /api/v1/me`                                      | 4.4 ms  | 8.7 ms  |
| `POST /api/auth/sign-in/email` (full password verify) | 48.3 ms | 59.7 ms |

`limit=1000`: refused (400, `MAX_LIMIT` 100).
Latency creep over 200 consecutive list calls: p50 6.9 ms (first 50) → 5.6 ms (last 50) — none.
Seeding 300 extensions through the API took 4.19 s (~14 ms/write including the routing recompile).
Sign-in's ~48 ms is password hashing, and is the expected cost.

---

## 4. Fixes applied

| File                                                         | Change                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `apps/web/lib/auth-client.ts`                                | new `authQueryError()` — better-auth failure as an `ApiError` carrying its status                  |
| `apps/web/app/(app)/_hooks/use-api-key-queries.ts`           | throw it (3 sites)                                                                                 |
| `apps/web/app/(app)/_hooks/use-organization-queries.ts`      | throw it (8 sites)                                                                                 |
| `apps/web/app/(app)/_components/organization-switcher.tsx`   | throw it (1 site)                                                                                  |
| `apps/web/app/(app)/settings/api-keys/page.tsx`              | explicit error branch instead of a misleading "No API keys"                                        |
| `apps/web/lib/auth-client.spec.ts`                           | **new** — 7 tests over the error shape and the retry decision                                      |
| `apps/api/src/pbx/branding-logo/branding-logo.controller.ts` | optional `host`; session-resolved tenant; 400 when neither; `Cache-Control` follows the resolution |
| `apps/api/test/pbx/brandingLogo.test.ts`                     | +5 controller tests                                                                                |
| `apps/web/lib/branding/contracts.ts`                         | `brandLogoSrc` returns the hostless route when it has no host                                      |
| `apps/web/lib/branding/contracts.spec.ts`                    | 2 tests rewritten to the new contract                                                              |

Verification: `bun test` in `apps/web` — **777 pass, 0 fail**.
`mocha apps/api/test/{pbx,auth}/*.test.ts` — **790 passing**.
`tsc --noEmit` on both — clean (the one `jssip-adapter.spec.ts` error is pre-existing in another
agent's working-tree change, not mine).

## 5. Needs restart to verify

None outstanding. The `branding-logo.controller.ts` change required an `api` restart; I restarted
**api only** (`kill $(cat …/pids/api.pid)` then `.scripts/local-stack/up.sh api`, down for ~10 s at
17:00 UTC) and confirmed `/api/auth/ok` 200 before continuing. No other service was touched. Logged
in `STACK.md`.

## 6. Not tested, and why

- **SSO / generic-OAuth providers** (`/api/v1/sso/providers`) — needs an external IdP.
- **Carrier / Telnyx number ordering** — `/carrier/status` reports no live provider on this stack;
  `smoke-pbx.ts` already covers the stubbed path.
- **Prompt and MOH _file_ upload, fax send, recordings playback** — media-store round trips that
  overlap the media agent's slice; the logo upload was tested because branding is in mine.
- **Real session _expiry_** — `AUTH_SESSION_TTL_SECONDS` is 24 h here; sign-out revocation and
  forged/stale cookie rejection were tested instead.
- **Org-limits enforcement under load** and **suspension of a reseller child** — read paths were
  exercised, the enforcement thresholds were not.
- **DB query counts per request** — `pg_stat_statements` is not enabled on this instance and
  enabling it needs a Postgres restart, which the brief reserves.
