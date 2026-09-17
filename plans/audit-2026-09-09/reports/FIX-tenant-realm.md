# FIX — the per-tenant SIP realm (E2E-sip F4, E2E-records scope note)

Branch `feat/optimiq-pbx-phase0`, working tree only, nothing committed.

## What was actually broken

Not sipd. `registrar.Authenticator.ForRequest` (`apps/sipd/internal/registrar/auth.go`) already
challenges for the domain the request **names** — the To host on a REGISTER, the From host otherwise
— derives a per-realm nonce key from it, and looks the credential up under that realm
(`registrar.go:279`). One sipd process has always been able to serve many tenants. `SIPD_REALM` is
consulted only when a request names no domain at all.

The break was entirely **upstream, in the API and the engine**, and it was one conflation:

> the SIP **server address** a phone sends packets to (legitimately deployment-wide) was being used
> as the SIP **realm/domain** an account registers into (a per-tenant claim that
> `SipCredentialsService.resolveOrganizationForRealm` maps to exactly one organization).

Three places substituted a deployment default for a tenant's realm:

| Place                                | Was                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `softphone.service.ts:94`            | `resolved.realm ?? env.PROVISION_SIP_SERVER`                                                   |
| `provision.service.ts:261`           | `snapshot.sipRealm ?? env.PROVISION_SIP_SERVER`, used for BOTH `sipDomain` and `serverAddress` |
| `channel-orchestrator.service.ts` ×2 | `artifact.settings.realm ?? env.ENGINE_SIP_REALM`                                              |

Consequences, exactly as F4 reported: an org with no domain got `local.test`, which resolves to a
different tenant; two tenants sharing an extension number would authenticate against the first
tenant's account.

## The fix

**(a) refuse by name — no realm without a configured domain**

- `apps/api/src/provisioning/softphone/softphone.service.ts` — the realm is the organization's and
  nothing else. `503 SOFTPHONE_NO_REALM`, message _"SIP domain not configured for this organization.
  Set the calling domain in Settings before using a softphone."_
- `apps/api/src/provisioning/render/provision.service.ts` — `authorizeAndBuild` resolves the org's
  `sip/realm` and refuses `not-configured` (detail `"SIP domain not configured"`, in the log and the
  `device.rejected` event) before rendering. `buildContext` now takes the checked `sipDomain` as a
  parameter, and `serverAddress` keeps `PROVISION_SIP_SERVER` as its fallback — the two facts are now
  separated rather than conflated.
- `apps/web/lib/softphone/credentials.ts` — new pure `softphoneUnavailability({status, code,
hasCredentials, resolved})` mapping the API's `code` (never its prose) to a sentence plus a
  fix-it href. `SOFTPHONE_NO_REALM` → the sentence above + `/settings`.
- `apps/web/app/(app)/_context/softphone-context.tsx` — uses it; exposes `unavailableHref`.
- `apps/web/app/(app)/_components/softphone/softphone-dialer.tsx` — renders an "Open settings" link
  in both unavailable states. The dialer is shared by the `/softphone` route and the docked widget,
  which is present on every authenticated page including `/extensions`, so both surfaces say it.

**(b) two orgs, one deployment — proven live** (see Evidence)

**(c) the deployment-wide default: decided with evidence**

- **api**: `PROVISION_SIP_SERVER` **survives, narrowed to what it actually is** — the SIP edge a
  packet is sent to (`RenderLine.serverAddress`) and the deployment description
  `GET /provisioning/catalog`. It is never a realm again. Removing it would have been wrong: a
  fleet does share one edge FQDN.
- **engine**: `ENGINE_SIP_REALM` **removed outright**. It had exactly one job — stand in for a
  tenant's realm — and that job is illegitimate. Gone from `engine-env.ts`, `compose.voice.yaml`,
  `.scripts/local-stack/render-env.sh`, `.scripts/verify-platform-stack.mjs`. A tenant with no realm
  now refuses `originate` by name ("the organization has no SIP realm"), which the engine already
  did for the _neither-set_ case.
- **sipd**: `SIPD_REALM` **survives, scoped and logged**. It is genuinely needed: an edge asked to
  challenge a request that names no domain must challenge with something. It is now documented as
  the "no tenant matched" default in `config.go`, `auth.go`, the sipd README and
  `.env.voice.example`, and `registrar.authorize` logs `"challenging with the deployment default
realm: the request named no domain"` every time it is used — a fleet serving several tenants
  should see none of these.

## Files changed

```
apps/api/src/provisioning/render/provision.service.ts
apps/api/src/provisioning/softphone/softphone.service.ts
apps/api/test/provisioning/renderRealmRefusal.test.ts        (new)
apps/api/test/provisioning/sharedLineDerivation.test.ts
apps/api/test/provisioning/softphone.test.ts
apps/engine/src/calls/channel-orchestrator.service.ts
apps/engine/src/calls/channel-orchestrator-routing.spec.ts
apps/engine/src/config/engine-env.ts
apps/sipd/internal/registrar/auth.go                          (+ RequestRealm, docs)
apps/sipd/internal/registrar/registrar.go                     (+ the "no tenant matched" log)
apps/sipd/internal/registrar/auth_test.go
apps/sipd/internal/config/config.go                           (comment)
apps/sipd/e2e_tenancy_test.go                                 (new, //go:build e2e)
apps/sipd/README.md
apps/web/lib/softphone/credentials.ts
apps/web/lib/softphone/credentials.spec.ts
apps/web/app/(app)/_context/softphone-context.tsx
apps/web/app/(app)/_components/softphone/softphone-dialer.tsx
packages/routing/src/artifact.ts, snapshot.ts                 (stale comments only)
compose.voice.yaml, .env.voice.example,
.scripts/local-stack/render-env.sh, .scripts/local-stack/README.md,
.scripts/verify-platform-stack.mjs
```

## Tests added

- api mocha: `renderRealmRefusal.test.ts` — the same device renders with a domain and is refused
  `not-configured` (with the `device.rejected` event) without one, and `serverAddress` stays the
  deployment edge while `sipDomain` is the tenant's.
- api mocha: `softphone.test.ts` — the old _"falls back to PROVISION_SIP_SERVER as the realm"_ test
  asserted the bug; replaced by a refusal test (code + message) and a positive one.
- api mocha: `sharedLineDerivation.test.ts` — its assertion `serverAddress === "tenant-b.example"`
  was the conflation; it now asserts the two fields separately.
- engine bun: _"refuses to originate for a tenant that has configured no SIP realm"_; the
  click-to-call test now carries the realm on the artifact instead of in the environment.
- web bun: four cases over `softphoneUnavailability`, including the Settings link.
- sipd go: `TestTheDeploymentRealmIsOnlyTheNoTenantMatchedDefault` (unit) and
  `TestE2ETwoTenantsRegisterAtOnce` (`-tags e2e`, against the standing stack).

## Evidence from the live stack

api restarted at ~17:26 UTC (`/api/auth/ok` 200 after; logged in `STACK.md`). **sipd was not
restarted and needs no restart.**

New organization `01a08736-051c-76bd-8a88-5613d55fee69`, slug `tenbmtudfvz1`, domain
`tenbmtudfvz1.local.test` (the web form's DNS-label validation and sipd's realm resolution both
accept it unchanged), extensions 1001 and 1002.

1. **Refusal, before a domain was set** — `GET /api/v1/me/softphone`:
   ```
   503 {"statusCode":503,"code":"SOFTPHONE_NO_REALM",
        "message":"SIP domain not configured for this organization. Set the calling domain in Settings before using a softphone."}
   ```
   No realm string anywhere in the body. Before the fix this returned `"realm":"local.test"`.
2. **Its own realm, after** — `{"realm":"tenbmtudfvz1.local.test","user":"1001"}`.
3. **Both tenants register on one sipd, concurrently** (`TestE2ETwoTenantsRegisterAtOnce`, PASS):
   ```
   1001@tenbmtudfvz1.local.test → 200 OK; Contact: <sip:1001@127.0.0.1:56809;transport=udp>;expires=300
   1001@local.test              → 200 OK; Contact: <sip:1001@127.0.0.1:64211;transport=udp>, <sip:as6g2l8h@…;transport=ws>
   1001@local.test with tenant B's password → 403 Forbidden
   ```
   The smoke org's existing browser (WS) binding is still listed in its 200 — it was never displaced.
   The 403 is the isolation property: same extension number, different realm, not the same identity.
4. **Tenant B places a real internal call in its own realm.** sipd:
   ```
   call admitted … from 1001 to 1002 orgId 01a08736-051c-76bd-8a88-5613d55fee69 profile internal
   originated a call … targetKind aor requestUri sip:1002@127.0.0.1:54837;transport=udp
   ```
   and the engine logged `admitted a call arriving on the sip edge` for the same orgId. The full
   answer was not asserted because the throwaway callee UA in that probe did not answer the inbound
   INVITE — a harness limit, not a product one: admission, realm→org resolution, routing and the
   B-leg originate to the correct binding all happened, in tenant B's realm, while the smoke org was
   registered.

## Verification (exact)

| Check                                                            | Result                       |
| ---------------------------------------------------------------- | ---------------------------- |
| `apps/api` typecheck (`tsconfig` + `tsconfig.strict`)            | clean                        |
| `apps/api` mocha                                                 | **1227 passing, 0 failing**  |
| `apps/engine` `tsc --noEmit`                                     | clean                        |
| `apps/engine` bun test                                           | **1593 pass, 0 fail**        |
| `apps/web` bun test                                              | **794 pass, 0 fail**         |
| `packages/routing` typecheck / bun test                          | clean / **859 pass, 0 fail** |
| `apps/sipd` `gofmt -l`, `go vet ./...`, `go vet -tags e2e ./...` | clean                        |
| `apps/sipd` `go test -race ./...`                                | **18 packages ok, 0 fail**   |
| `oxlint` + `oxfmt` over every directory touched                  | clean                        |

`apps/web`'s `tsc --noEmit` reports one error in `lib/softphone/jssip-adapter.spec.ts`
(`reason_phrase` not in the mock's type) — a **pre-existing working-tree change by another agent**,
untouched by this work and unrelated to it.

## Needs restart

- **none for this fix.** api was already restarted (above); web is `next dev` and picked the
  TypeScript changes up live; sipd needed no change to its behaviour.
- `compose.voice.yaml` / `render-env.sh` no longer set `ENGINE_SIP_REALM`. The **running** engine
  still has it in its environment and now ignores it, which is harmless; a future engine restart
  simply will not receive it.

## Cross-area needed / left open

- **`org_setting sip/realm` is uncatalogued and not unique-checked on write.** The API refuses a
  realm two organizations claim only at _read_ time (`resolveOrganizationForRealm` returns
  `undefined` and logs), so two tenants can both save the same domain and then BOTH stop
  registering. A write-time uniqueness check (or a `sip_domain` table with a unique index) is the
  proper home; it is a settings-catalogue/migration change outside this fix's blast radius.
- `E2E-sip` F5 (`scope=registration` ACL enforced nowhere) and F6 (the `sip-acl` key carries no org)
  are untouched — separate findings, separate decisions.
