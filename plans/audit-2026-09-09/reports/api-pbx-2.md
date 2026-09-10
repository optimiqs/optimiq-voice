# AREA api-pbx-2 — `apps/api/src/pbx`, subdirectories p–z

Owned subdirectories (from `ls apps/api/src/pbx`, names starting p–z, excluding `shared/` which another
agent owns): `paging-groups`, `park-lots`, `phone-numbers`, `phrases`, `pin-sets`, `prompts`, `queues`,
`reseller-usage`, `ring-groups`, `routing`, `security`, `shared-lines`, `sip-credentials`,
`time-conditions`, `translations`, `trunks`, `voicemail-boxes`, `webhooks`.
(`pbx-bootstrap.ts`, `pbx-cdr-ports.module.ts`, `pbx.module.ts` are files, not subdirectories; they are
referenced only where a fix must land there.)

Every `.ts` file in those directories was read in full (~19k lines), plus the matching tests under
`apps/api/test/pbx`. `shared/` was read for context only.

## Baseline that is CORRECT and was verified, not assumed

- **Every controller route in every owned subdirectory carries `@RequirePermissions`.** Checked
  mechanically over all `@Get/@Post/@Patch/@Put/@Delete` decorators: zero unguarded routes.
- **No endpoint accepts `organizationId` from a body or query.** The tenant is taken from the session
  in `PbxResourceService.organizationId` / `withTenantScope`, once, per the shared header's rule.
- **`secretColumns` is declared where it must be**: `trunk.sipSecretRef`, `webhook_subscription.secret`,
  `pin_set` `pinHash`. The one deliberate exception (the webhook secret returned once on create) is
  re-attached after redaction rather than being a hole in `redactRow`.
- **Webhook signing** (`webhook-signature.ts`) is Stripe-scheme HMAC-SHA256 with the timestamp inside
  the MAC, a length check before `timingSafeEqual`, and a 32-byte CSPRNG secret. No finding.
- **The webhook selector grammar cannot name an organization** — verified against
  `webhookSelectors.test.ts`, including the `calls.evt.v1.<otherOrg>.>` case.
- Dropped after verification: `SipCredentialsService.findExtension` returning a null `secretRef`
  (`extension.sip_secret_ref` is `notNull` in `packages/pbx-db/src/schema/extensions-schema.ts:62`);
  `isSameTrunkEntry`'s `JSON.stringify` comparison (the projector's literal key order matches
  `trunkDirectoryEntrySchema`'s field order exactly, so it does not spuriously differ).

---

# P0

### [P0] One tenant's first `allow` ACL entry denies every other tenant's phones (confidence: high)

- Where: `apps/api/src/pbx/security/acl-conf.ts:196-215`
- Code: `const hasAllow = scoped.some((row) => row.action === "allow"); const mode = hasAllow ? "allowlist" : …`
  then `lines.push("deny = 0.0.0.0/0.0.0.0", "deny = ::/0")`
- Problem: `renderSection` unions the rows of **every** tenant into one named ACL and then decides
  `mode` from that union. The file header claims "one tenant's allowlist does not exclude another
  tenant's addresses" — that is false. As soon as any single tenant creates one `allow` row in the
  `registration` scope the section flips from permit-all to allowlist and a global
  `deny = 0.0.0.0/0` is emitted. Every tenant with no ACL rows (the default, permit-all) is then
  denied. The existing multi-org warning only fires for `mode === "blocklist"`, so the dangerous
  direction is unwarned. `apps/api/test/pbx/sipAclConf.test.ts:192` covers only the deny-side union.
- Failure scenario: tenant A adds "HQ office 203.0.113.0/24" to allow their own phones. On the next
  `generate:sip-acl` + `res_pjsip` reload, every handset of every OTHER tenant on that media server
  fails to REGISTER — a platform-wide outage caused by one tenant exercising `security.write`.
- Fix: the implicit deny must be conditional on the whole platform being an allowlist, not on any
  row. Minimum viable: emit a hard warning (and a non-zero exit from `scripts/generate-sip-acl.ts`)
  whenever `mode === "allowlist"` and more than one organization has rows, and document that
  per-tenant registration ACLs require the `apps/sipd` path. The real fix is per-tenant named ACLs /
  the `sip-acl` KV bucket, which already exists.
- Cross-area: `scripts/generate-sip-acl.ts`, `apps/asterisk/*` consume the rendered sections.

### [P0] The projection outbox is discharged even when every KV write failed (confidence: high)

- Where: `queues/queue-membership.publisher.ts:265`, `routing/did-index.publisher.ts:244`,
  `security/sip-acl.publisher.ts:350`, `trunks/trunk-directory.publisher.ts:226-248`; consumed at
  `apps/api/src/pbx/pbx.module.ts:663-735` (trunks at `:698-704`).
- Code (trunks, representative):
  ```ts
  } catch (error) { this.failed += 1; logger.error({ key, organizationId, error }, "failed to write a trunks entry"); }
  …
  return { published, deleted, unchanged, skipped: false };
  ```
  and in `pbx.module.ts`: `.then((result) => { if (!result.skipped) { discharge(event.organizationId, "trunks", cutoff); } })`
- Problem: the sync result carries no failure signal, so a reconcile in which every `bucket.put`
  threw is indistinguishable from a clean one. The obligation is discharged and the sweeper never
  republishes — the exact opposite of all four publisher headers ("Swallowed is not the same as
  forgotten … a sweeper republishes whatever it failed to mark"). `RoutingCachePublisher.publish`
  gets this right (returns `false`, the module gates on it), which is what makes the other four an
  asymmetry rather than a decision.
- Failure scenario: NATS is briefly unwritable during an admin edit. For **trunks** specifically the
  carrier directory entry never reaches the edge, so `apps/sipd` has no proxy address and every
  outbound call for that tenant fails at the edge — permanently, until an unrelated successful write
  to the same tenant happens. Same shape for a stale queue roster, an unroutable new DID, and a
  missing ACL admission.
- Fix: add `failed: number` to `TrunkDirectorySyncResult`, `QueueMembershipSyncResult`,
  `DidIndexSyncResult` and `SipAclSyncResult`; increment it in each catch; change the four discharge
  guards to `if (!result.skipped && result.failed === 0 && result.conflicts.length === 0)`.
- Cross-area: `apps/api/src/pbx/pbx.module.ts` (shared wiring), and the three non-trunk publishers
  are in this area but the wiring line is shared with whoever owns the module file.

---

# P1

### [P1] `TrunkStatusConsumer` scopes the write to the PAYLOAD's `orgId`, not the subject's (confidence: high)

- Where: `apps/api/src/pbx/trunks/trunk-status-consumer.service.ts:236-256`
- Code:
  ```ts
  if (envelope.subject !== message.subject) { … message.term(); … }   // "The tenancy cross-check"
  const trunkId = message.subject.split(".")[4];
  const outcome = await this.write(envelope.orgId, trunkId, envelope);
  ```
- Problem: the comment says the check stops an event that "could scope a write to the wrong tenant's
  trunk", but the check only compares the envelope's subject with its own delivery subject. The
  organization actually used for `withTenantScope` comes from `envelope.orgId`, a payload field that
  is never compared to the subject's org token (`subject.split(".")[3]`). The webhook dispatcher one
  directory over does this correctly (`parsed.orgId` from the subject). The producer
  (`apps/engine/src/routing/trunk-status.publisher.ts:117`) calls `validateEvent`, which DOES perform
  the orgId↔subject cross-check (`packages/events/src/validate.ts:94-100`) — so this is a missing
  defence-in-depth check on the consume side, not an exploitable path from a well-behaved engine.
- Failure scenario: anything able to publish on the `TRUNKS` stream (a bugged/rolled-back engine, a
  mis-scoped NATS credential, an operator replaying a doctored message) can publish on
  `trunk.evt.v1.<orgA>.<trunkId>.status.changed` with `orgId: "<orgB>"` and have the row updated
  under tenant B's RLS scope, marking another tenant's trunk down.
- Fix: replace the hand-rolled parse with the library that already does all three checks:
  `safeValidateEvent(message.subject, JSON.parse(...))` — it validates the schema, the subject match
  AND `parsed.orgId !== envelope.orgId`. Failing that, one line:
  `if (message.subject.split(".")[3] !== envelope.orgId) { message.term(); return "terminated"; }`.
- Cross-area: none (uses `packages/events` as-is).

### [P1] The webhook dispatcher can exceed JetStream's default 30 s `ack_wait` (confidence: medium)

- Where: `apps/api/src/pbx/webhooks/webhook-dispatcher.service.ts:237-282`
- Code: `await manager.consumers.add(spec.stream, { durable_name: …, ack_policy: AckPolicy.Explicit, deliver_policy: DeliverPolicy.New, filter_subject: spec.filter, max_deliver: MAX_DELIVER });`
  and `const messages = await consumer.consume(); … await this.awaitSlot(); this.spawn(message, spec.family);`
- Problem: neither `ack_wait` nor `max_ack_pending` is set on any of the four durables (grep confirms
  the only occurrence of `ack_wait` in the repo is a spec, `packages/events/src/nats-integration.spec.ts:187`),
  so JetStream's 30 s default applies while `consumer.consume()` prefetches a large batch whose ack
  timers are all running. A message is already delivered when the loop parks in `awaitSlot`, so with
  `PBX_WEBHOOK_CONCURRENCY=8` and slow endpoints the ack clock burns entirely on queueing. A single
  fan-out is itself up to `MAX_ATTEMPTS × TIMEOUT_MS + backoff` ≈ 18 s at defaults and up to 5 minutes
  at the schema's allowed maxima (`PBX_WEBHOOK_TIMEOUT_MS` ≤ 30 000, `MAX_ATTEMPTS` ≤ 10).
- Failure scenario / cost: one slow tenant endpoint causes ack_wait expiry on queued messages →
  JetStream redelivers → **every subscription of every tenant on that message is POSTed again** (the
  header's own argument against NAKing applies verbatim to a redelivery), and after `MAX_DELIVER = 3`
  the event is silently dropped. Duplicate screen-pops plus lost notifications, from load alone.
- Fix: set `ack_wait` on the four durables to comfortably exceed the worst-case fan-out
  (`nanos(PBX_WEBHOOK_MAX_ATTEMPTS * PBX_WEBHOOK_TIMEOUT_MS + …)`, floor ~60 s) and set
  `max_ack_pending` to `PBX_WEBHOOK_CONCURRENCY` so the broker stops prefetching messages the loop
  cannot start. Add `ack()`-time telemetry if you want the margin observable.
- Cross-area: the same missing `ack_wait` applies to `TrunkStatusConsumer` (`max_deliver: 10`, so it
  degrades less) and to consumers outside this area — worth raising as a platform-wide convention.

### [P1] `SipCredentialsResponder.consume` is a `void`ed promise with no try/catch around the iterator (confidence: medium)

- Where: `apps/api/src/pbx/sip-credentials/sip-credentials.responder.ts:125,129,139-166`
- Code: `void this.consume(this.subscription); … for await (const message of subscription) { … }`
- Problem: the per-message body is wrapped in try/catch, but the `for await` over the NATS
  `Subscription` is not. A subscription-level error (permissions violation, a closed connection
  surfaced through the iterator) rejects the promise that `void` discards — an unhandled rejection,
  which under Node's default `--unhandled-rejections=throw` terminates the API process. Even if the
  process survives, nothing re-subscribes: `isReady` keeps reporting the stale subscription objects
  because they are only cleared on shutdown.
- Failure scenario: a NATS permissions change or a broker restart that errors the iterator takes the
  whole control plane down, or silently stops answering `rpc.sip.v1.credential` — after which **no
  phone on the platform can REGISTER** and the only symptom is 403s at the registrar.
- Fix: wrap the `for await` in try/catch (as `WebhookDispatcher.run` and `TrunkStatusConsumer.run`
  both already do), log, clear `this.subscription`/`this.trunkSubscription`, and re-subscribe with a
  bounded backoff rather than leaving the subject unserved.
- Cross-area: none.

### [P1] `selectorsMatch` re-parses (and re-regexes) every selector on every message (confidence: high)

- Where: `webhooks/webhook-dispatcher.service.ts:401-403` and `webhooks/webhook-selectors.ts:137-152`
- Code: `subscriptions.filter((s) => selectorsMatch(s.eventSelectors, parsed.family, type))` →
  `for (const selector of selectors) { const parsed = parseWebhookSelector(selector); … }`
- Problem: the dispatcher caches subscriptions as raw selector STRINGS, so each delivered event
  re-runs `parseWebhookSelector` — a map walk plus `EVENT_PATTERN.test` — for every selector of every
  cached subscription. The parse result is a pure function of a string that only changes when the row
  changes, i.e. at most once per `PBX_WEBHOOK_CACHE_TTL_MS`.
- Cost: DTO bounds are 200 subscriptions × 32 selectors = up to 6 400 regex executions **per platform
  event**, on the busiest subject family (`calls.evt.v1.>`). This is the dispatcher's whole hot path.
- Fix: parse once at cache-fill time — store `readonly parsed: readonly ParsedSelector[]` on
  `CachedSubscription` and give `webhook-selectors.ts` a `parsedSelectorsMatch(parsed, family, type)`
  overload. Keeps `selectorsMatch` for the DTO/test path.
- Cross-area: none.

### [P1] The dispatcher's per-tenant subscription cache is never evicted (confidence: medium)

- Where: `webhooks/webhook-dispatcher.service.ts:134,541-572`
- Code: `private readonly cache = new Map<string, CacheEntry>(); … this.cache.set(organizationId, { subscriptions, readAt: now });`
- Problem: entries are only ever added or overwritten. There is no TTL sweep, no LRU and no size
  bound; `invalidate()` is only called from `recordFailure`'s auto-disable path. Every organization
  whose events pass through the dispatcher is retained for the life of the process, holding up to 200
  rows each — **including each subscription's plaintext signing secret**.
- Cost: on a platform with tens of thousands of tenants this is unbounded resident memory that grows
  monotonically with tenant count, and a long-lived in-process store of every tenant's HMAC keys that
  survives their deletion.
- Fix: bound it — evict entries older than the TTL on each read (or a cheap periodic sweep) and cap
  the map size with LRU eviction, so a deleted or idle tenant's secrets leave the process.
- Cross-area: none.

### [P1] The whole audio library is readable and streamable by the narrowest self-service role (confidence: high)

- Where: `prompts/prompts.controller.ts:89-99,135-139`
- Code:
  ```ts
  @Get()  @RequirePermissions("settings.read")
  @Get(":id") @RequirePermissions("settings.read")
  @Post(":id/play-url") @RequirePermissions("settings.read")
  ```
- Problem: `settings.read` is in `SELF_SERVICE_PERMISSIONS` (`packages/auth/src/permissions.ts:1582-1593`)
  and therefore held by the `user` and `agent` roles. The controller header asserts the opposite
  ("the pair that does not accidentally hand a narrower role something broader", `:43-44`). Two
  consequences follow from `PROMPT_KINDS` including `"phrase"`
  (`packages/pbx-db/src/schema/media-schema.ts:41`) and `promptListQuerySchema.kind` accepting the
  full enum (`prompts.dto.ts:75-78`): `GET /api/v1/prompts?kind=phrase` returns phrase rows that
  `phrases.controller.ts:57` gates behind the manager-level `recordings.read`, and `?kind=moh` plus
  `POST /:id/play-url` reach MOH files — `mintPlaybackLink` (`prompts.service.ts:419-428`) checks only
  `prompt.id`, with no `kind` predicate.
- Failure scenario: any signed-in user of a tenant — the role meant to hold nothing but their own
  extension, voicemail and preferences — can enumerate every IVR prompt, greeting and hold-music file
  in the organization and mint a short-lived unauthenticated URL to stream each one. Horizontal
  privilege escalation within the tenant.
- Fix: raise the floor on the three routes to `recordings.read` (and the write routes to
  `recordings.configure` / `recordings.delete`), matching the sibling `phrases.controller.ts`. If
  `settings.read` must stay for a picker, at minimum drop `"phrase"` and `"moh"` from
  `promptListQuerySchema.kind` and add the same `kind` predicate to `mintPlaybackLink`.
- Cross-area: none for the surgical fix — `recordings.*` already exists at
  `packages/auth/src/permissions.ts:382-383`.

### [P1] `GET /api/v1/reseller/telephony-usage` is unbounded and counts members row-by-row (confidence: high)

- Where: `reseller-usage/reseller-telephony-usage.service.ts:55-73`
- Code: `const children = await listChildOrganizations(this.baseDb, organizationId); const childIds = children.map((c) => c.organizationId);`
- Problem: the only list endpoint in the area with no `listQuerySchema`, no `limit`, no `offset` —
  against `shared/pagination.ts`'s "never unbounded" rule that every other list honours.
  `listChildOrganizations` (`packages/db/src/platform-hierarchy.ts:73-88`) has no limit, and its
  member count (`:94-102`) selects one row per `member` across all children and tallies in JS instead
  of `count() … group by`.
- Cost: an unbounded response body, three `inArray` predicates of N uuids against the untenanted
  `adminDb`, and a `member` fetch proportional to the total membership of every child organization —
  on a route any `reseller.read` holder can call in a loop.
- Fix: accept `listQuerySchema` and page the children; replace the member fetch with
  `select({ organizationId, total: count() }).from(member).where(inArray(...)).groupBy(member.organizationId)`,
  which `countByOrganization` in the same file (`:102-106`) already does correctly.
- Cross-area: the paging parameter and the `count()` rewrite land in
  `packages/db/src/platform-hierarchy.ts`, shared with `apps/api/src/auth/reseller`.

### [P1] `did-index` and `sip-acl` reconcile do a KV `get` per key over the WHOLE platform per admin write (confidence: high)

- Where: `routing/did-index.publisher.ts:268`, `security/sip-acl.publisher.ts:286`
- Code: `for await (const key of await bucket.keys()) { const existing = await this.readEntry(bucket, key); … }`
- Problem: the headers call this "an O(n) scan over every DID on the platform per admin write", which
  understates it — it is n **sequential broker round trips**, not a scan. `sip-acl` pays it before
  every publish, on the path an operator uses to edit an allowlist during an attack.
- Cost: at 100k platform DIDs, one `PATCH /phone-numbers/:id` is ~100k sequential KV gets — minutes of
  wall clock in a fire-and-forget continuation holding a NATS connection. Contention starts around 10k.
- Fix: add the per-organization reverse key the headers themselves propose
  (`kvKeyFor.didIndexByOrg(orgId)` holding the key list) so deletion no longer needs the whole key
  space; short of that, take one `history`/`watch` snapshot instead of get-per-key.
- Cross-area: `packages/events/src/streams`, `scripts/rebuild-did-index.ts`, `scripts/rebuild-sip-acl.ts`.

### [P1] Every queue-roster sync reads the whole `extension` and `queue_agent` tables (confidence: high)

- Where: `queues/queue-membership.publisher.ts:328-336`
- Code: `transaction.select().from(queueAgent), transaction.select().from(queueTier), transaction.select().from(extension)`
- Problem: `readRosterRows` fetches every extension in the tenant only to build
  `extensionNumbersById` for the handful of agents that have an `extensionId`, and every `queue_agent`
  row whether or not it sits in a tier. It runs on every mutation to a queue-membership table,
  including agent logins that go through the repository.
- Cost: a 5 000-extension tenant transfers 5 000 rows per tier edit. Independent of the documented and
  accepted whole-org re-projection decision, which only needs the tier and queue rows.
- Fix: keep the whole-org projection; narrow the two supporting reads — select
  `extension.id, extension.number` restricted to the referenced ids (`inArray`), and only the
  `queue_agent` rows whose id appears in `queueTier`.
- Cross-area: none.

### [P1] `readOrganization` reads the tenant's roster entries one KV get at a time (confidence: high)

- Where: `queues/queue-membership.publisher.ts:302-308`
- Code: `for (const key of keys) { const entry = await readEntry(bucket, key); … }`
- Problem: sequential awaits over independent reads, on the same fire-and-forget path as above.
  (`trunk-directory.publisher.ts:284-296` has the identical shape but is bounded by the tenant's trunk
  count, so it is not called out separately.)
- Cost: a tenant with 200 queues pays 200 serial round trips per membership write — ~1 s of added
  latency per admin edit at 5 ms RTT before anything is published.
- Fix: `await Promise.all(keys.map((key) => readEntry(bucket, key)))`, then filter.
- Cross-area: none.

### [P1] `PATCH /queue-agents/:id` can clear the extension without restating `contactKind` (confidence: medium)

- Where: `queues/queues.dto.ts:110-118`
- Code: `if (patch.contactKind !== undefined) { assertReachable(patch, context); }`
- Problem: the guard only runs when the body restates `contactKind`, so
  `PATCH { "extensionId": null }` on an extension-backed agent passes. The comment ("A PATCH that
  touches neither leaves whatever the row already had") describes the case it handles, not the one it
  misses.
- Failure scenario: an admin clears the extension dropdown. The row saves, the agent disappears from
  every roster (`queue-membership.projection.ts` drops it as `no-extension` and logs), and the only
  symptom is a supervisor noticing one person stopped getting calls. The projection's header calls
  itself "the second line" and names this DTO as the first.
- Fix: also run `assertReachable` when the patch names `extensionId` or `contact`, treating an
  unstated `contactKind` as the row's current one.
- Cross-area: none.

---

# P2

### [P2] `uploadPromptFieldsDto.kind` is accepted, validated, then silently ignored (confidence: high)

- Where: `prompts/prompts.dto.ts:33`; `prompts/prompts.service.ts:204-206,229,245`
- Code: `kind: z.enum(PROMPT_KINDS).optional(),` — `upload()` reads only `fields.name`,
  `fields.mohClassId`, `fields.language`; the stored kind always comes from `options.kind`.
- Problem: exactly the bug `shared/dto.ts:18-19` warns about ("Silently dropping it is how 'I set
  recordEnabled and it did nothing' bugs are born"). A client uploading with `kind=greeting` gets a
  `prompt` row and no error. It is also a latent hazard: wiring `fields.kind` into the write later
  would let an uploader stamp `kind: "phrase"` with a non-null `object_key`, the pair
  `prompt_object_key_kind_check` exists to forbid.
- Fix: delete `kind` from `uploadPromptFieldsDto` — the URL is already the authority, as the header
  says for `mohClassId`.
- Cross-area: none.

### [P2] Webhook CRUD never invalidates the dispatcher's cache (confidence: high)

- Where: `webhooks/webhooks.service.ts:86-109` (no `invalidate` call anywhere) vs
  `webhook-dispatcher.service.ts:219-226` ("the seam a spec and a future CRUD hook both use")
- Problem: deleting a subscription, disabling it, changing its URL or rotating its secret has no
  effect on delivery for up to `PBX_WEBHOOK_CACHE_TTL_MS` (default 30 s, configurable to 600 s). A
  rotated secret means every delivery in the window is signed with the retired key, and a DELETED
  subscription keeps receiving a tenant's call metadata at a URL an administrator just removed.
- Fix: inject `WebhookDispatcher` into `WebhooksService` (or hook the module's existing `onMutation`
  seam on `webhook_subscription`) and call `invalidate(organizationId)` after create/update/remove.
  The seam already exists; only the call site is missing.
- Cross-area: `pbx.module.ts` if the `onMutation` route is preferred over direct injection.

### [P2] `sourceAddress` is carried through three layers of the credential path and never read (confidence: high)

- Where: `sip-credentials/sip-credentials.responder.ts:210`,
  `sip-credentials/sip-credentials.service.ts:78` (`sourceAddress?: string` in the request type)
- Problem: `sipd` sends the registering peer's address, the responder parses it and passes it on, and
  `resolve()` never touches it — it is not used for an ACL decision and does not even appear in the
  success-path log, only in the error branch. It is the one field that would let a credential lookup
  be correlated with a source, which is what an operator wants when a phone is failing to register or
  when credentials are being sprayed.
- Fix: either log it on the refusal paths (`found: false`, disabled line, ambiguous auth user) so the
  SIP auth-event trail has a source, or drop the parameter so the contract does not imply a check
  that is not made.
- Cross-area: none (the field already exists in `sipCredentialRequestSchema`).

### [P2] `answer()` returns a raw error message on the NATS reply (confidence: medium)

- Where: `sip-credentials/sip-credentials.responder.ts:222-224`
- Code: `return refuse(\`credential lookup failed: ${error instanceof Error ? error.message : String(error)}\`);`
- Problem: `answerTrunk` twelve lines above deliberately refuses to do this ("Carrier errors can
  contain response bodies. Do not log them or return them on NATS.") and returns a fixed string. The
  extension path returns whatever the database threw — connection strings, constraint text, driver
  detail — onto the backbone and into `sipd`'s logs. The two halves of one file disagree.
- Fix: log the error with detail as it already does, and return the same fixed `"credential lookup
failed"` string the trunk path uses.
- Cross-area: none.

### [P2] An unreadable queue-membership entry for a deleted queue leaks forever (confidence: medium)

- Where: `queues/queue-membership.publisher.ts:303-309`
- Code: `if (entry !== undefined && entry.orgId === organizationId) { found.set(key, entry); }`
- Problem: `readOrganization` treats an unparseable entry as absent, so it never enters `existing` and
  never reaches the delete loop at `:257`. If its queue has since been deleted, no future write will
  overwrite or remove it. The "treated as absent so the next write repairs it" comment only holds
  while the queue still exists. (`trunk-directory.publisher.ts:288-292` has the same shape.)
- Fix: collect unparseable keys separately and feed them into the delete loop — they are
  prefix-scoped to the org, so ownership is not in doubt.
- Cross-area: none.

### [P2] `sip_acl_entry.trunkId` accepts any UUID, including another tenant's trunk (confidence: medium)

- Where: `security/sip-acl.dto.ts` (`trunkId: z.uuid().nullish()`)
- Problem: the comment's reasoning is sound about the ACL ROW but not about the reference. The FK is
  enforced by Postgres at system level and does not respect RLS, so a `trunk_id` naming another
  tenant's trunk is accepted. Because the column is `on delete cascade`, tenant B deleting that trunk
  silently deletes tenant A's ACL entry — an access-control rule removed by an unrelated tenant's
  action. `projectSipAclEntry` also publishes the foreign `trunkId` to the edge as the attribution on
  a matched packet.
- Fix: validate the reference through the repository's existing scalar-reference guard (the same
  in-tenant existence check the destination trios get) rather than in the DTO.
- Cross-area: this is the area-wide "bare `z.uuid()` for scalar references" convention enforced (or
  not) in `shared/pbx.repository.ts`, which another agent owns.

### [P2] The translation-rule comment claims a DoS protection the length cap does not provide (confidence: medium)

- Where: `translations/translations.dto.ts:22,30`
- Code: `* … a string long enough to be a denial of service on the regex engine.` /
  `matchPattern: z.string().min(1).max(256),`
- Problem: 256 characters does not bound backtracking — `(a+)+$` is six. The only validation applied
  is that `new RegExp(source)` compiles (`packages/routing/src/translations.ts:92-104`), a syntax
  check, and the pattern is then executed per call on the dial path (`:124-140`, `resolve.ts`).
- Failure scenario: a `routes.write` holder (manager-level, not admin) saves a backtracking pattern;
  it compiles clean, and every outbound call matched by that ruleset burns CPU in the engine. The
  comment actively discourages the next reader from adding the real check.
- Fix: correct the comment to say the cap bounds SIZE only, and add a linear-time guard in
  `validateTranslationRule` — a nested-quantifier reject emitting a new `unsafe-pattern` issue beside
  the existing `invalid-regex`, or a match-step budget at compile time.
- Cross-area: the check belongs in `packages/routing/src/translations.ts`; only the comment is here.

### [P2] Child-collection DELETE guards disagree across sibling slices (confidence: medium)

- Where: `pin-sets/pin-sets.controller.ts:147` and `phrases/phrases.controller.ts:139`
  (`<parent>.delete`) vs `ring-groups/ring-groups.controller.ts:122`,
  `shared-lines/shared-lines.controller.ts:127`, `time-conditions/time-conditions.controller.ts:123`,
  `paging-groups/paging-groups.controller.ts:124` (`<parent>.write`)
- Problem: six structurally identical nested collections split two ways on whether removing a child
  needs the parent's `.delete` or `.write` grant, with no comment explaining the split — in an area
  otherwise scrupulous about recording such decisions. `translations` lands on a third variant.
- Cost: not a vulnerability today (the same roles hold both), but the permission surface is
  unpredictable and the next slice's author has a coin-flip precedent.
- Fix: standardise on `<parent>.write` for child removal (the child has no independent lifecycle),
  apply it to all six, and record the reasoning once beside the `PbxChildResourceService` header.
- Cross-area: none.

### [P2] Four consumer loops can overshoot `PBX_WEBHOOK_CONCURRENCY` (confidence: medium)

- Where: `webhooks/webhook-dispatcher.service.ts:294-308`
- Code: `releaseSlot()` resolves **every** parked waiter at once; each then re-checks
  `this.inFlight.size >= concurrency` before any of them has called `spawn`.
- Problem: when all four family loops are parked, freeing one slot wakes all four and all four pass
  the recheck, so up to `concurrency + 3` deliveries run. Harmless at the default of 8, but the bound
  is documented as exact ("the bound that stops a slow endpoint from stalling the consumer").
- Fix: resolve one waiter per released slot (shift from the queue) instead of draining the array.
- Cross-area: none.

---

# Voicemail slice

### [P1] The `.own` self-service voicemail path is enforced in the API but unreachable: no `voicemail.write.own` exists, so a self-service user can never mark a message read (confidence: high)

- Where: `voicemail-boxes/voicemail-messages.controller.ts:104-116`; registry
  `packages/auth/src/permissions.ts:129-135` and `:1582-1590`
- Code:
  ```ts
  @Patch(":id/messages/:messageId")
  @RequirePermissions("voicemail.write")   // no `.own` variant exists in PERMISSIONS
  ```
- Problem: `GET`, `DELETE` and `play-url` were lowered to `voicemail.read.own` / `.delete.own` /
  `.listen.own`, and `VoicemailMessagesService.assertMayReachBox`
  (`voicemail-messages.service.ts:392-406`) narrows the row. `PATCH …/messages/:messageId` — the only
  route that moves a message out of the `new` folder — was not, because there is no
  `voicemail.write.own` to lower it to. `SELF_SERVICE_PERMISSIONS` gives the `user` role no write of
  any kind, and `hasPermission` never lets a scoped grant satisfy an unscoped requirement
  (`permissions.spec.ts:579`).
- Failure scenario: a `user` opens the voicemail page (`apps/web/lib/page-permissions.ts:100` admits
  `voicemail.read.own`), lists their messages, and gets a 403 on every "mark as read". Because the MWI
  lamp is defined by the NEW count (`voicemail-messages.dto.ts:20-26`,
  `voicemail-mwi.publisher.ts:20-27`), their desk phone's lamp stays lit until they _delete_ the
  message — the only transition they are allowed. This is the class of bug
  `shared/self-ownership.ts:12-22` and `test/auth/permissionEnforcement.test.ts:110-131` claim was
  closed; the closure is one grant short.
- Fix: add `voicemail.write.own` to `PERMISSIONS` and `SELF_SERVICE_PERMISSIONS`, lower the `PATCH`
  floor to it, and add `await this.assertMayReachBox(session, organizationId, boxId, "voicemail.write")`
  at the top of `VoicemailMessagesService.move`. No repository change — `move` already runs inside
  `withTenantScope` and pairs message↔box.
- Cross-area: yes — `packages/auth/src/permissions.ts`. Separately `apps/web` gates the Play/Delete
  controls on the UNSCOPED grants (`voicemail-messages-dialog.tsx:89-91`, `voicemail-screen.tsx:57`),
  so even the three routes that WERE lowered are dead controls for a `user` — route to the web auditor.

### [P2] `VoicemailConsumer` scopes the write to the envelope's `orgId`, not the subject's (confidence: high)

- Where: `voicemail-boxes/voicemail-consumer.service.ts:262-283`
- Code:
  ```ts
  if (envelope.subject !== message.subject) {
  	/* "The tenancy cross-check validateEvent would have made" */
  }
  const mailboxId = message.subject.split(".")[4];
  const filed = await this.file(envelope.orgId, mailboxId, data);
  ```
- Problem: identical to the `TrunkStatusConsumer` P1 above, and the two should be fixed together. The
  check proves the envelope's self-declared subject equals the routed subject; it never compares
  `envelope.orgId` with segment `[3]`. The tenant used for `withTenantScope` is the only field in the
  path still taken from the body, while the mailbox id beside it comes from the trusted subject.
- Failure scenario: a skewed producer (or a forged publish) with `orgId = B` on subject
  `…v1.<A>.<box>…` scopes the write to B and looks up A's box id; RLS makes that a miss, so the
  message is `term()`ed — a permanent silent loss of a filed voicemail rather than a cross-tenant
  write. Ranked P2 rather than P1 because the failure is loss, not leakage.
- Fix: `const [, , , subjectOrgId, mailboxId] = message.subject.split(".")`, `term()` with a log when
  `subjectOrgId !== envelope.orgId`, and pass `subjectOrgId` to `file`. Better: use
  `safeValidateEvent`, which does all three checks (`packages/events/src/validate.ts:94-100`).
- Cross-area: none.

### [P2] Past the last page, a voicemail message list reports `total: 0` / `totalPages: 0` (confidence: high)

- Where: `voicemail-boxes/voicemail-messages.service.ts:152-153`
- Code: `const counts = await readMailboxCounts(…); const total = rows[0]?.total ?? 0;`
- Problem: `count(*) over ()` is a window on the RETURNED rows, so an offset past the last row returns
  no rows and the total collapses to 0; `paged()` then yields `totalPages: 0`.
- Failure scenario: a user on page 3 deletes enough messages to shrink the list to two pages; the next
  fetch returns `data: []`, `total: 0`, `totalPages: 0`, and the pager renders "no messages" for a
  mailbox holding 40 — with no page count to clamp back to. Same shape in `listForBroker` (`:361`),
  where `total` is additionally capped by `request.limit`.
- Fix: when `rows.length === 0 && pagination.offset > 0`, fall back to a `count(*)` over the same
  predicate, or derive the folder total from `readMailboxCounts`, which is already in hand.
- Cross-area: if `shared/pbx.repository.ts`'s generic list uses the same window, the fix belongs there
  too — that file is another agent's.

### [P2] Three helpers duplicated verbatim across the voicemail slice (confidence: high)

- Where: `voicemail-messages.service.ts:707-717` and `voicemail-transcription.service.ts:585-595`
  (`contentTypeFor`, byte-identical); `file-greeting.service.ts:270` and
  `file-greeting-rpc.controller.ts:120` (`refuse`, byte-identical); `voicemail-messages.service.ts:720-724`
  shadows the exported `downloadFileName` that `voicemail-greetings.service.ts:17` imports from
  `prompts.service.ts`.
- Problem: the audio-format map is the one that bites — adding a codec (the `.opus`/`.ogg` handling is
  already there speculatively) must be done in two files, and the transcription copy feeds the
  provider's `contentType` while the messages copy feeds the browser's.
- Fix: move `contentTypeFor` next to `resolveVoicemailObjectPath` in `voicemail-media-token.ts` and
  import it in both; export `refuse` from `file-greeting.service.ts` and import it in the controller.
- Cross-area: none.

### [P2] The permission table in `voicemail-messages.controller.ts` documents grants the decorators no longer use (confidence: high)

- Where: `voicemail-boxes/voicemail-messages.controller.ts:41-46`
- Problem: the table says `GET → voicemail.read`, `DELETE → voicemail.delete`,
  `play-url → voicemail.listen`; the decorators are the `.own` variants. This header is the artifact a
  reviewer checks the guards against, and it now describes the pre-`.own` design — which is why the
  `PATCH` gap above reads as intentional.
- Fix: restate the table with the `.own` floors and one line on the substitution rule.
- Cross-area: none.

---

## Verified and dropped (voicemail)

Media-token domain separation and verification order (`voicemail-media-token.ts`,
`openSignedMedia:250-311` — signature → expiry → tenant-scoped row → containment → stat, with forged
and cross-tenant answered identically); PIN handling (`secretColumns: ["pinHash"]`, scrypt +
`timingSafeEqual`); every query in the slice inside `withTenantScope` (the back-fill uses `adminDb`
but re-establishes the tenant before any audio is opened); both broker paths re-check `mailboxNumber`
against the row and answer rather than throw; `FileGreetingService.readRecording`'s `<orgId>/` prefix
check plus `probeAudio`; the transcription worker's serial drain, bounded retry/backoff, `queueLimit`
drop-to-`pending`, `unref`'d timers cleared on shutdown, and the `status = 'pending'` compare-and-set;
the sweeper's re-entrancy guard, `clearInterval` on shutdown and three stacked claim guards;
`email_sent_at` compare-and-set. No N+1 and no unbounded list endpoint in the slice.
