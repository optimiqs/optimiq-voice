# AREA: api-core — audit report

Scope: `apps/api` excluding `src/pbx`. Read: `src/auth/**`, `src/cdr/**`, `src/live/**`, `src/session/**`,
`src/mail/**`, `src/media/**`, `src/storage/**`, `src/transcription/**`, `src/provisioning/**`, `src/core/**`,
`src/main.ts`, `src/app.module.ts`, `src/envs.ts`, `Dockerfile`, `package.json`, `tsconfig*.json`, `.mocharc`,
plus the `packages/db` and `packages/auth` functions these call.

Counts: **P0 × 2, P1 × 6, P2 × 8.**

---

## P0

### [P0] An unmatched WebSocket upgrade is never destroyed — unauthenticated fd exhaustion (confidence: high)

- Where: `apps/api/src/live/live-gateway.ts:156-160`, `apps/api/src/session/session-gateway.ts:152-158`,
  `apps/api/src/session/session-bootstrap.ts:17-23`, `apps/api/src/live/live-bootstrap.ts:37-45`
- Code:
  ```ts
  if (pathOf(url) !== LIVE_PATH) {
  	// Not ours. Left alone rather than destroyed: another feature may own this path…
  	return;
  }
  ```
  and in `session-bootstrap.ts`: _"Node destroys an upgrade nothing answered, which is the correct default"_.
- Problem: that premise is false. Node's `http.Server` destroys an upgrade socket **only when there is no
  `'upgrade'` listener at all**. Once `registerLiveTransport` / `registerSessionTransport` attach one, Node hands
  the socket to userland and never closes it. Both gateways then `return` without touching it, so a request to any
  path other than `LIVE_PATH` / `SESSION_PATH` leaves a fully-established TCP socket open with nothing referencing
  it and no timeout.
- Failure scenario / cost: `curl -H 'Upgrade: websocket' -H 'Connection: Upgrade' http://api/x` in a loop, with no
  session and no credentials, leaks one fd + one socket per request until the process hits `EMFILE`. It also
  bypasses every guard, because this path is reached before origin, session and permission checks. On a public
  deployment this is a trivial remote DoS.
- Fix: register ONE `'upgrade'` listener (in `main.ts`, or a small `registerUpgradeRouter`) that dispatches by
  path to the live and session gateways and calls `socket.destroy()` when no gateway claims the path. Minimal
  alternative: keep both listeners but have the bootstrap wrap them — `const claimed = await live.handleUpgrade(...)
|| await session.handleUpgrade(...)` with each returning a boolean, and `socket.destroy()` when neither claims.
  Delete the incorrect comments in both bootstraps.
- Cross-area: none (both gateways are in this area). `main.ts` is the natural place for the router.

### [P0] Provisioning rate limit is bypassed by every invalid-secret request — unbounded DB writes and broker publishes (confidence: high)

- Where: `apps/api/src/provisioning/render/provision.service.ts:141-179` and `:406-464`
- Code:
  ```ts
  // --- 3. verify the secret ---
  if (!verifySecret(found, parsed.secret)) {
      await this.reject(request, found, "invalid-token", "secret mismatch");   // publishes + DB insert
      throw new ProvisionRefusedException({ reason: "invalid-token", … });
  }
  …
  // --- 5. rate limit (after authentication — see the class comment) ---
  const verdict = this.limiter.consume(parsed.reference);
  ```
- Problem: the limiter is consulted at step 5, but step 3 rejects (and `reject()` writes a `sip_auth_event` row via
  `SipAuthEventService.record` **and** publishes a `device.rejected` NATS event) and throws before ever reaching it.
  So a caller holding only the _reference_ half — which is stored in plaintext in `device.provisioning_token`, is
  explicitly documented as "not a secret", and is visible in any leaked backup or admin screenshot — can drive
  unlimited rejections. The same is true one step earlier for an unknown reference: step 2's `adminDb` lookup runs
  on every request with no limiting at all.
- Failure scenario / cost: one known reference + a loop = unbounded inserts into `sip_acl`/`sip_auth_event` on
  `pbx-db` and unbounded publishes onto the broker, from an unauthenticated public endpoint. This fills a tenant's
  security ledger, saturates the PBX connection pool, and makes the attack log useless for the case it exists for.
- Fix: move `this.limiter.consume(parsed.reference)` to immediately after step 2 (the reference resolved), before
  the secret comparison — the limiter's own comment already says the key is the reference precisely so an unknown
  reference allocates nothing. Rate-limit `reject()`'s audit write and event publish along with the response.
- Cross-area: `SipAuthEventService` lives in `src/pbx/security` (another auditor's area); no change needed there,
  only in the call ordering here.

---

## P1

### [P1] A provisioning IP allowlist is silently skipped when the source IP cannot be parsed (confidence: high)

- Where: `apps/api/src/provisioning/render/provision.repository.ts:224-230`, consumed at
  `apps/api/src/provisioning/render/provision.service.ts:187-203`
- Code:
  ```ts
  if (isIP(sourceIp) === 0) {
      return { hasEntries: false, allowed: false, matched: undefined };   // ← hasEntries: false
  }
  …
  const allowlistApplies = allowlist.hasEntries || this.env.PROVISION_REQUIRE_IP_ALLOWLIST;
  if (allowlistApplies && !allowlist.allowed) { … refuse … }
  ```
- Problem: "I could not evaluate the ACL" is encoded as "this organization has no ACL entries". The service then
  computes `allowlistApplies === false` (with the default `PROVISION_REQUIRE_IP_ALLOWLIST=false`) and **allows**
  the render — even for an organization that has configured a strict provisioning allowlist. The repository's own
  comment says "the caller decides what an unmatched request means"; the caller cannot, because the two states are
  indistinguishable in the returned shape.
- Failure scenario / cost: any deployment where `socket.remoteAddress` is not a plain IP (unix-socket listener,
  a runtime that reports a hostname, an IPv6 form `isIP` rejects) hands out every phone's SIP password to a caller
  the tenant's ACL was written to exclude. Silent, and the tenant sees a control they believe is enforced.
- Fix: add a third state — return `{ evaluable: false }` (or `hasEntries: undefined`) — and in the service treat
  non-evaluable as a `ip-not-allowed` refusal whenever the organization has entries or
  `PROVISION_REQUIRE_IP_ALLOWLIST` is set. Cheapest correct version: split the entry-count query out of the
  `isIP` guard so `hasEntries` is always truthful, and only the `allowed` decision degrades.
- Cross-area: none.

### [P1] Both WebSocket gateways re-authenticate every connection every 25 s: 2 DB round trips per connection per tick (confidence: high)

- Where: `apps/api/src/live/live-gateway.ts:420-441` and `:443-465`;
  `apps/api/src/session/session-gateway.ts:500-515`; `LIVE_HEARTBEAT_MS = 25_000` (`live-protocol.ts:53`),
  `SESSION_HEARTBEAT_MS = 25_000` (`session-protocol.ts:56`)
- Code:
  ```ts
  connection.socket.ping();
  void this.revalidate(connection);   // for EVERY connection, every heartbeat
  …
  const resolved = await this.platform.auth.api.getSession({ headers: … });   // DB read
  const access = await this.authService.resolveAccess(session);              // second DB read
  ```
- Problem: `getSession` is a `session` + `user` table read and `resolveAccess` a `member` read (both on the auth
  pool, whose `maxConnections` is hard-coded to **10** in `auth.config.ts:80`). Revalidation is unconditional and
  unbatched, and the two gateways each run their own loop, so a browser tab holding both a live and a session
  socket costs 4 queries per 25 s.
- Failure scenario / cost: 500 concurrent dashboards → ~80 auth-DB queries/second of pure revalidation against a
  10-connection pool, permanently, independent of user activity. It will starve the pool that also serves `/me`,
  branding and sign-in long before the WebSocket layer itself becomes a bottleneck.
- Fix: revalidate on a slower cadence than the ping (e.g. every Nth sweep, or when
  `now - connection.lastRevalidatedAt > REVALIDATE_MS` with `REVALIDATE_MS` ≈ 5 min); cache the resolved access
  per `session.token` for a short TTL shared by both gateways. Session expiry is already enforced by the
  `expiresAt` on the session record, so the revalidation is a revocation-latency knob, not a correctness one.
- Cross-area: none. Raising `maxConnections` in `auth.config.ts` is a mitigation, not the fix.

### [P1] The Fastify HTTP logger reads `LOGS_LEVEL`, which nothing in the platform sets (confidence: high)

- Where: `apps/api/src/core/http/log-redaction.ts:76-87`
- Code:
  ```ts
  const level = (process.env.LOGS_LEVEL ?? "info").toLowerCase();
  ```
  with the header comment: _"it reads the same `LOGS_LEVEL` the winston logger reads so one variable still governs
  logging in this process"_ and _"`none` is what `package.json`'s `test` script sets"_.
- Problem: both claims are false. `packages/logging/src/logger.ts:15` reads `env.LOG_LEVEL`; `packages/config`
  declares `LOG_LEVEL` (and a separate `API_LOGS_LEVEL`), never `LOGS_LEVEL`. `apps/api/package.json`'s test script
  sets `LOG_LEVEL=silent`. So `httpLogLevel()` always falls through to its `"info"` default.
- Failure scenario / cost: the Fastify request logger is on at `info` in every process regardless of the operator's
  `LOG_LEVEL`, including `LOG_LEVEL=silent`; `pnpm --filter @optimiq-voice/api test` is not silent as its script
  intends; and an operator who turns logging down still pays pino's per-request serialization. Two variables govern
  logging, which is exactly the state the comment says is avoided.
- Fix: read `process.env.LOG_LEVEL ?? process.env.API_LOGS_LEVEL` (keeping `LOGS_LEVEL` as a deprecated third
  fallback if any deployment already sets it), and correct the two comments.
- Cross-area: none — the canonical name already exists in `packages/config/src/env.ts:179`.

### [P1] Per-organization SSO providers are a process-global namespace with no tenant binding at sign-in (confidence: high)

- Where: `apps/api/src/auth/auth.platform.ts:57-75` + `packages/db/src/platform-sso.ts:80-85`
  (`listEnabledSsoProviders` selects across **all** organizations); `apps/api/src/auth/sso/sso.service.ts:86-90`
- Code:
  ```ts
  // Every enabled provider across all organizations — what the auth boot feeds to `genericOAuth`.
  return await db
  	.select(COLUMNS)
  	.from(organizationSsoProvider)
  	.where(eq(organizationSsoProvider.enabled, true));
  ```
- Problem: three consequences the SSO service's own header does not name. (a) `providerId` carries a **global**
  unique index (`organization_sso_provider_provider_key`), so the first tenant to create `okta` owns that slug
  platform-wide and every other tenant's create fails as an unhandled unique-violation → 500, not a 409/422.
  (b) `/api/auth/sign-in/oauth2?providerId=okta` is not scoped to an organization, so any user of the deployment
  can authenticate through _another_ tenant's IdP and have an account auto-provisioned. (c) `emailDomain` is
  accepted, stored and indexed (`organization_sso_provider_email_domain_idx`) but is read by nothing — the column
  that would restrict (b) is dead.
- Failure scenario / cost: tenant B's employees can sign into the platform through tenant A's IdP. They land with
  no `member` row, so the guard denies them everything org-scoped — the blast radius is unauthorised account
  creation and an audit trail attributing a session to tenant A's IdP, not data access. Combined with the 500 on a
  duplicate slug, this is a feature that is not multi-tenant despite being sold per-organization.
- Fix: (1) catch the unique violation in `SsoService.create` and answer 409 naming the conflict; (2) make
  `providerId` tenant-scoped on the wire — register providers with a composite id (`<orgSlug>:<providerId>`) so the
  namespace is per-tenant; (3) enforce `emailDomain` in a better-auth sign-in hook, or delete the column and say
  in the header that domain restriction is not implemented. At minimum, (1) and (3)'s documentation half.
- Cross-area: `packages/db/src/platform-sso.ts` (the schema's unique index) and `packages/auth`'s `createAuth`
  provider wiring would both change for (2).

### [P1] Boot failure after `NestFactory.create` sets an exit code but never exits (confidence: medium)

- Where: `apps/api/src/main.ts:245-248`
- Code:
  ```ts
  bootstrap().catch((error) => {
  	logger.error({ err: error }, "failed to start API");
  	process.exitCode = 1;
  });
  ```
- Problem: `process.exitCode` only takes effect when the event loop drains. By the time `bootstrap()` can throw
  from `registerAuthTransport`, `registerPbxTransport`, `registerLiveTransport` or `app.listen`, the container has
  a Postgres pool (`createAuthPlatform`), possibly NATS connections (`LiveHub.onModuleInit`,
  `CdrLegWriter.onModuleInit`) and possibly a bound socket — all of which keep the loop alive indefinitely.
- Failure scenario / cost: `EADDRINUSE` on `HTTP_BRIDGE_PORT`, or a failed microservice connect, produces a
  process that logs one error and then sits forever holding DB and broker connections. Docker/Kubernetes see a
  healthy-looking container that serves nothing and never restarts. (The preflight failures before
  `NestFactory.create` do exit correctly, which is why this is easy to miss.)
- Fix: keep a reference to `app` and, in the catch, `await app?.close()` then `process.exit(1)` — or simply add
  `process.exit(1)` after a short `unref`'d grace timer.
- Cross-area: none.

### [P1] `x-api-key` sessions never check whether the key's organization is suspended or the key is expired past its stored date (confidence: medium)

- Where: `apps/api/src/auth/auth-http.plugin.ts:251-289`
- Code:
  ```ts
  const result = (await platform.auth.api.verifyApiKey({ body: { key: presented } })) as VerifyApiKeyResult;
  if (!result.valid || !result.key) { … }
  …
  expiresAt: result.key.expiresAt ?? new Date(Date.now() + API_KEY_SESSION_TTL_MS),
  ```
- Problem: the synthesised session's `expiresAt` is written but never read by anything downstream —
  `RequirePermissionsGuard` and `AuthService.resolveAccess` consult only `activeOrganizationId` and
  `activeOrganizationRole`. The freshness relies entirely on `verifyApiKey` honouring `expiresAt`, which is a
  behaviour of `@better-auth/api-key` this file already documents it cannot fully trust (it bypasses that plugin's
  session promotion for a different reason). Separately, `ResellerService.setSuspended` can suspend a child
  organization and nothing on this path consults `hierarchy.suspendedAt`, so an API key issued to a suspended
  tenant keeps full `admin` access.
- Failure scenario / cost: a reseller suspends a child for non-payment; the child's `x-api-key` integrations
  continue to read and write every PBX/CDR resource, because suspension is only enforced (if at all) on the
  interactive path. Also, an expired key whose `expiresAt` `verifyApiKey` did not enforce yields an unbounded
  session.
- Fix: after resolving the key, reject when `result.key.expiresAt !== null && result.key.expiresAt <= new Date()`;
  and make the guard (or `AuthService.resolveAccess`) consult `readHierarchy(...).suspendedAt` — cached with a
  short TTL — for every principal, not just API keys.
- Cross-area: `readHierarchy` is in `packages/db/src/platform-hierarchy.ts`; the suspension check would also want a
  decision recorded for the interactive path, which touches `RequirePermissionsGuard` (this area) only.

---

## P2

### [P2] `AuthService.resolveRoleIn`'s documented "re-read the member row" branch is unreachable on every permissioned route (confidence: high)

- Where: `apps/api/src/auth/auth.service.ts:167-185`, reached via
  `apps/api/src/auth/require-permissions.guard.ts:78`
- Code:
  ```ts
  // guard, before the handler runs:
  setSessionOnRequest(request, withResolvedAccess(session, access.role, access.permissions));
  // service, later, on the SAME session object:
  if (session.activeOrganizationRole) { … return session.activeOrganizationRole; }   // API-key branch
  const membership = await this.repository.findMembership(session.user.id, requested);  // dead
  ```
- Problem: the guard stamps `activeOrganizationRole` onto the request session for every route with at least one
  required permission, so by the time `@Session()` injects it, a cookie/bearer principal looks exactly like an
  API-key principal. The `findMembership` branch — whose comment is "re-read the `member` row, so a member removed
  from an organization loses access on the very next request" — is dead on every such route.
- Failure scenario / cost: no security regression today (the guard already read the member row this request, and
  the branch still requires `activeOrganizationId === requested`), but the code documents a guarantee it does not
  provide, and the _next_ caller of `resolveRoleIn` from a route with no `@RequirePermissions` args would get a
  different, silently weaker check.
- Fix: either mark the principal kind explicitly (`session.principal === "api-key"`) instead of overloading
  `activeOrganizationRole`, or stop having the guard mutate the session and pass `ResolvedAccess` separately.
- Cross-area: `withResolvedAccess` / `AppSession` shape is in `packages/auth`.

### [P2] `src/provisioning` and `src/session` are missing from `tsconfig.strict.json` (confidence: high)

- Where: `apps/api/tsconfig.strict.json:29-45`
- Code: `"include": ["src/auth/**/*", "src/cdr/**/*", "src/live/**/*", "src/mail/**/*", "src/media/**/*",
"src/pbx/**/*", "src/storage/**/*", "src/transcription/**/*", …]` — no `src/provisioning`, no `src/session`,
  no `test/provisioning`, no `test/session`.
- Problem: two of the newest areas — one of which owns the only unauthenticated route in the application and
  derives SIP passwords, the other a WebSocket gateway — are typechecked only under the relaxed project
  (`strict: false`, `strictNullChecks: false`, `noImplicitAny: false`). The file's own comment says the list exists
  "so that new code cannot quietly regress"; these two were added after it and were not added to it. The
  consequence is already visible: `provision.service.ts:250` and `:251` need
  `this.env.PROVISION_SIP_SERVER as string` / `PROVISION_SIP_SECRET_KEY as string` casts that strict null checking
  would have made the compiler prove instead.
- Fix: add `"src/provisioning/**/*"`, `"src/session/**/*"`, `"test/provisioning/**/*"`, `"test/session/**/*"` and
  fix what falls out (likely the two casts above and a handful of optional-chaining sites).
- Cross-area: none.

### [P2] A tenant-overridden mail subject can carry control characters into an SMTP header (confidence: medium)

- Where: `apps/api/src/auth/mail-templates/mail-template.dto.ts:18`, applied at
  `apps/api/src/mail/mail-template-resolution.ts:58-61` and sent at `apps/api/src/mail/mail-transport.ts:151`
- Code: `subject: z.string().trim().min(1).max(200).nullable().optional()` → `subject: override.subject` →
  `client.sendMail({ subject: message.subject, … })`
- Problem: the DTO bounds length but permits `\r`, `\n` and other control characters. `bodyIntro` is HTML-escaped
  on the HTML side, but `subject` is passed through verbatim to nodemailer as a header value. nodemailer does fold
  and encode headers, so this is defence-in-depth rather than a proven injection — but the boundary that should
  reject a newline in a header value is this schema, and it does not.
- Failure scenario / cost: a tenant admin holding `settings.write` (a low bar — it is the same grant as ordinary
  settings, by explicit design in `mail-template.controller.ts`) supplies the only untrusted string in the platform
  that reaches an SMTP header. If any transport in the chain is less careful than nodemailer, that is header
  injection on outbound mail bearing the platform's domain.
- Fix: `.regex(/^[^\r\n�-]+$/u)` on `subject`, and the same on `bodyIntro`'s control characters.
- Cross-area: none.

### [P2] `content-disposition` filename is interpolated without quoting (confidence: medium)

- Where: `apps/api/src/media/media-response.ts:84`
- Code: `"content-disposition": `${disposition}; filename="${options.fileName}"``
- Problem: `fileName` is embedded in a quoted-string with no escaping of `"` or `\`. Every caller in _this_ area
  passes a derived name (`csvFileName` — dates only; `downloadFileName` — kind + timestamp + hex), so the bug is
  latent here. The PBX media-library routes share this helper and are the ones most likely to pass a
  user-supplied display name.
- Failure scenario / cost: a filename containing `"` truncates or reshapes the header, producing a wrong download
  name or (with a `;`) an injected header parameter.
- Fix: strip/replace `"`, `\`, `;` and control characters, or use RFC 5987 `filename*=UTF-8''<pct-encoded>`
  alongside a sanitised ASCII `filename=`.
- Cross-area: the PBX media/voicemail routes call `openMediaResponse`; the fix is entirely in this file but the
  benefit lands there.

### [P2] `CdrExportWorker` double-counts failures and its `MAX_ATTEMPTS` check is off by one (confidence: medium)

- Where: `apps/api/src/cdr/exports/cdr-export-worker.service.ts:179-211` and `:299-309`
- Code:
  ```ts
  if (job.attempts > MAX_ATTEMPTS) { await this.fail(job, "internal", `…attempted ${job.attempts} times…`); }
  …
  } catch (error) { … this.failed += 1; return 0; }     // and fail() already did `this.failed += 1`
  ```
- Problem: `claimNextExportJob` increments `attempts` inside the claim, so the returned `attempts` is already
  1 on the first attempt. `> MAX_ATTEMPTS` (3) therefore abandons on the **fifth** claim, not the third, and the
  message says "attempted 4 times" when the job has had 4 real attempts and one abandonment pass — a fifth claim
  that does no work. Separately, `this.failed` is incremented both by `fail()` and by `runOne`'s catch, so the
  `stats.failed` gauge over-reports whenever `write()` throws _after_ calling `fail()` is not the path taken.
- Failure scenario / cost: a poisonous export costs two extra full-window scans before it is abandoned, and the
  operator-facing failure counter is wrong. Not data-corrupting; it is a metric and a budget that do not mean what
  they say.
- Fix: change to `if (job.attempts > MAX_ATTEMPTS)` → `>=`, and remove the `this.failed += 1` from `runOne`'s catch
  (or from `fail()`, but not both).
- Cross-area: none.

### [P2] `LiveConnection.alive` is written and never read; the topic cap double-counts re-subscribes (confidence: high)

- Where: `apps/api/src/live/live-gateway.ts:215, 233, 432` and `:290-302`
- Code:
  ```ts
  connection.alive = false;          // set every sweep, read nowhere
  connection.alive = true;           // set on pong, read nowhere
  …
  if (connection.topics.has(name)) { granted.push(name); … continue; }   // already-held pushed into `granted`
  if (connection.topics.size + granted.length >= LIVE_MAX_TOPICS_PER_CONNECTION) { … }
  ```
- Problem: (a) liveness is decided entirely from `lastPongAt`, so `alive` is dead state that reads like a second,
  contradictory mechanism. (b) `granted` accumulates topics the connection _already holds_, and those are also in
  `connection.topics.size`, so a client re-subscribing to its 10 existing topics plus 5 new ones is refused at
  `10 + 10 >= 20` rather than at `15 >= 20`. The session gateway has the identical shape at
  `session-gateway.ts:283`.
- Failure scenario / cost: a reconnecting dashboard that re-sends its full subscription set gets `too-many-topics`
  on topics it is entitled to, with no way to tell why.
- Fix: delete `alive` from `LiveConnection` and both gateways; count only newly-added topics against the cap
  (`connection.topics.size` after the loop, or a separate `added` counter).
- Cross-area: none (both files are in this area).

### [P2] `MirroredObjectStore.archiveObject` always mirrors with no content type (confidence: high)

- Where: `apps/api/src/storage/mirrored-object-store.ts:157-178`, against
  `apps/api/src/storage/local-object-store.ts:65-78`
- Code: `await this.mirror.put(objectKey, Buffer.concat(chunks), { contentType: local.contentType });` —
  but `LocalObjectStore.head` returns only `{ sizeBytes, updatedAt }` and never sets `contentType`.
- Problem: the origin is always a `LocalObjectStore` (that is the only shape `createObjectStore` builds), so
  `local.contentType` is always `undefined` and every archived recording and voicemail lands in S3 as
  `binary/octet-stream`.
- Failure scenario / cost: an operator browsing the bucket, or any consumer that reads the object directly
  (a presigned URL from `S3ObjectStore.presign`, a lifecycle rule keyed on type) sees no type. The API's own read
  path re-derives it from the extension, so nothing breaks today — it is a durable copy with lost metadata.
- Fix: derive the type from the key extension in `archiveObject` (the same one-line map
  `recordings.service.ts:317-326` already has), and pass it explicitly.
- Cross-area: none.

### [P2] `CdrService.get` silently ignores a malformed `startedAt`, widening a one-partition seek to a full range scan (confidence: medium)

- Where: `apps/api/src/cdr/query/cdr.service.ts:168-174`
- Code:
  ```ts
  const startedAt = query.startedAt === undefined ? undefined : new Date(query.startedAt);
  …
  ...(startedAt === undefined || Number.isNaN(startedAt.getTime()) ? {} : { startedAt }),
  ```
- Problem: the DTO validates `startedAt` as an ISO datetime, so the `Number.isNaN` branch is unreachable through
  the controller; but where it _would_ fire, the query silently degrades from an exact partition-key equality to a
  scan bounded only by the default 24-hour (or the caller's up-to-92-day) range — the exact cost
  `cdr.dto.ts:117-125` says the parameter exists to avoid. A defensive `NaN` check that changes a query plan
  without saying so is the kind of thing that hides a regression when the DTO is loosened.
- Failure scenario / cost: latent. If `startedAt` ever becomes a free-form string, one client's bad value turns a
  single-partition seek into a multi-partition scan on every detail open, with no error.
- Fix: since the DTO already guarantees a parseable value, drop the `Number.isNaN` fallback and let a malformed
  value be a 400 from the schema — or keep the check and throw `CdrInvalidCursorException`-style 400 rather than
  silently widening.
- Cross-area: none.

---

## Verified and dropped

- `auth-http.plugin.ts:93-98` builds a request origin from the untrusted `Host` header
  (`origin = host ? \`http://${host}\` : baseURL`). It looked like callback/reset-link poisoning, but better-auth
builds its one-time links from `config.baseURL`/`config.appURL`and validates against`trustedOrigins`
(`auth.platform.ts:66-69`), so the header only affects URL parsing, not link generation. Dropped.
- `partition()` in `authz.service.ts:228-239` passes a `Set` where `readonly Permission[]` is nominally expected;
  `hasPermission` in `packages/auth/src/permissions.ts:1918` takes `Iterable<string>` and handles a `Set`
  explicitly. Correct as written.
- `escapeLikeTerm` (`cdr.repository.ts:162`) escapes `\ % _` but the queries do not declare `ESCAPE '\'`;
  PostgreSQL's default `LIKE`/`ILIKE` escape character _is_ backslash, so this is correct.
- `LiveGateway.isTrustedOrigin` returns `true` for an absent `Origin` header. This is a genuine CSWSH gap for
  non-browser clients, but a non-browser client cannot be made to attach the victim's cookie, so it grants nothing
  a direct request would not. Dropped as not exploitable.
- `resolveRolePermissions` uses `template.permissions.length` as a privilege ordering. Fragile but documented, and
  `SYSTEM_ROLE_TEMPLATES` currently orders correctly. Dropped as a style judgement.
