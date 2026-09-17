# FIX report — AREA api-pbx-2 (`apps/api/src/pbx`, p–z)

## P0

**ACL: one tenant's allow row denied every other tenant — FIXED**
`security/acl-conf.ts`. `renderSection` now computes `allowlistIsSafe = hasAllow && organizations.size <= 1`.
The leading `deny = 0.0.0.0/0` (and `::/0`) is emitted only for a single-tenant scope; with rules from more
than one organization the section degrades to blocklist rendering (allow rows survive as exceptions under
Asterisk's last-match-wins, nothing unmentioned is denied) and a hard warning names the count and points at
`apps/sipd`. The multi-org deny warning now fires on `hasDeny` rather than `mode === "blocklist"`, so the
allow case is no longer unwarned. File header and the blocklist comment corrected to match.
Test: `test/pbx/sipAclConf.test.ts` — "withholds the implicit deny once a second tenant has rules in the
scope" pins both the one-tenant allowlist and the two-tenant degradation.
Not built: per-tenant named ACLs. The file header's argument stands — a named ACL per tenant needs an
endpoint per tenant, which nothing generates on the Asterisk plane. See "Cross-area".

**Projection outbox discharged on total KV failure — FIXED**
`trunks/trunk-directory.publisher.ts`, `queues/queue-membership.publisher.ts`,
`routing/did-index.publisher.ts`, `security/sip-acl.publisher.ts`: each `*SyncResult` gains
`readonly failed: number`, incremented on every `bucket.put`/`bucket.delete` that threw. Deliberately NOT
incremented for key-derivation failures (an un-keyable e164/network/id is permanent — counting it would make
the sweeper republish forever). `pbx.module.ts` discharge guards are now
`!result.skipped && result.failed === 0 [&& result.conflicts.length === 0]` for all four, mirroring
`RoutingCachePublisher`. Test: `trunkDirectoryProjection.test.ts` — "reports a failed write, so the outbox
obligation is not discharged".

## P1

- **`TrunkStatusConsumer` scoped the write to the payload's `orgId` — FIXED.**
  `trunks/trunk-status-consumer.service.ts` destructures `[, , , subjectOrgId, trunkId]` from the routed
  subject, terms on `subjectOrgId !== envelope.orgId`, and passes `subjectOrgId` to `write`. Test added.
- **Webhook dispatcher `ack_wait` / `max_ack_pending` — FIXED.** All four durables now set
  `ack_wait: ackWaitNanos()` (`max(60s, 2 × (MAX_ATTEMPTS × TIMEOUT_MS + MAX_ATTEMPTS × MAX_BACKOFF_MS))`)
  and `max_ack_pending: PBX_WEBHOOK_CONCURRENCY`, so the broker stops prefetching messages the loop cannot
  start and the ack clock covers the queue as well as the POST.
- **`SipCredentialsResponder.consume` unguarded iterator — FIXED.** Replaced the two `void this.consume(...)`
  calls with `void this.serve(kind)`: subscribe → consume inside try/catch → clear the handle (so `isReady`
  stops lying) → re-subscribe with 1s→30s bounded backoff, stopping on shutdown. Added an `unref`'d `delay`.
- **Selector re-parsing on the hot path — FIXED.** `webhook-selectors.ts` gains `parseWebhookSelectors` and
  `parsedSelectorsMatch`; `selectorsMatch` is now their composition (DTO/test path unchanged).
  `CachedSubscription.eventSelectors: string[]` became `selectors: readonly ParsedSelector[]`, parsed once at
  cache-fill. Test asserts the two paths agree.
- **Unbounded subscription cache — FIXED.** `CACHE_MAX_ORGANIZATIONS = 1000`, LRU by Map insertion order
  (a hit deletes+re-sets), stale entries deleted on read, oldest evicted after each fill — so an idle or
  deleted tenant's plaintext signing secrets leave the process.
- **Audio library readable by self-service roles — FIXED.** `prompts/prompts.controller.ts`:
  `GET`/`GET :id`/`POST :id/play-url` → `recordings.read`; `POST`/`PATCH` → `recordings.configure`;
  `DELETE` → `recordings.delete`, matching the sibling `phrases.controller.ts`. Header table rewritten.
- **`/reseller/telephony-usage` unbounded — PARTIALLY FIXED.** The route now accepts `listQuerySchema` and
  pages `children` (`page`/`limit`/`totalPages` added to the view); `childCount` and `totals` stay over the
  whole child set, and `sumOf` now sums the grouped count maps instead of the page. The SQL-level `limit` on
  `listChildOrganizations` is cross-area.
  The audit's second half is **WRONG**: `packages/db/src/platform-hierarchy.ts:93-102` already does
  `select({ organizationId, memberCount: count() }) … groupBy(member.organizationId)`. There is no
  row-per-member fetch to replace.
- **`did-index` / `sip-acl` get-per-key — FIXED (mitigated).** Both reconciles now collect the key space
  first and read values in parallel batches of `READ_CONCURRENCY = 64` instead of one sequential round trip
  per key. The per-organization reverse key that removes the walk entirely is cross-area.
- **Queue roster read the whole `extension` and `queue_agent` tables — FIXED.** `readRosterRows` reads
  `queue` + `queue_tier` in parallel, then `queue_agent` restricted to `inArray(queueAgent.id, tierAgentIds)`,
  then `select({id, number})` from `extension` restricted to the referenced ids. Whole-org re-projection
  unchanged.
- **`readOrganization` serial KV gets — FIXED.** `Promise.all` over the keys in both
  `queue-membership.publisher.ts` and `trunk-directory.publisher.ts`.
- **`PATCH /queue-agents/:id` could clear the extension — FIXED.** `queues/queues.dto.ts`: when `contactKind`
  is unstated, a patch that sets `extensionId: null` with no `contact` (or `contact: null` with no
  `extensionId`) is now rejected with the field named. Test added.
- **`voicemail.write.own` — FIXED (the registry half landed from another area mid-run).** The decorator on
  `PATCH …/messages/:messageId` is now `voicemail.write.own`, and
  `VoicemailMessagesService.update` calls `assertMayReachBox(session, orgId, boxId, "voicemail.write")`
  before moving the message (placed in `update`, not `move`, because `remove` already asserts with
  `voicemail.delete`). This also cleared the `permissionEnforcement.test.ts` failure the other agent's
  registry addition had produced.

## P2

FIXED: `uploadPromptFieldsDto.kind` deleted (the route is the authority, and wiring it through would let an
uploader stamp `kind: "phrase"` on a row with an `object_key`) · webhook CRUD now calls
`dispatcher.invalidate(orgId)` after create/update/remove (`@Optional()` injection so specs still construct
the service) · `sourceAddress` logged on all four `SipCredentialsService.resolve` refusal paths ·
`answer()` returns the fixed `"credential lookup failed"` instead of the raw error message, matching
`answerTrunk` · unparseable KV entries are now carried into `existing` in both `queue-membership` and
`trunk-directory` so the delete loop can reclaim a key whose queue/trunk is gone (test added) · translations
DoS comment corrected (the cap bounds size only) with the real check named and located · four consumer loops
could overshoot concurrency — `releaseSlot` now shifts one waiter · voicemail: `contentTypeFor` moved to
`voicemail-media-token.ts` as `voicemailContentTypeFor` and imported by both services, `refuse` exported from
`file-greeting.service.ts` as `refuseFileGreeting` and the controller's copy deleted,
`downloadFileName` renamed `voicemailDownloadFileName` to stop shadowing the prompts export ·
voicemail message `total` now comes from `readMailboxCounts` in both `list` and `listForBroker` (the
`count(*) over ()` window collapsed to 0 past the last page, and was capped by `request.limit` for the
broker); the two dead window columns removed · voicemail controller permission table restated with the
`.own` floors and the substitution rule.

SKIPPED:

- **Child-collection DELETE guard split.** The audit's fix lowers `pin-sets` and `phrases` from
  `<parent>.delete` to `<parent>.write`. That is a permission _loosening_ with no bug behind it (the audit
  says so), and `recordings.delete` / `pinsets.delete` exist deliberately. Standardising the other direction
  would be the six-file change the brief warns off. Left for a human decision.
- **`sip_acl_entry.trunkId` cross-tenant reference.** The fix belongs in the repository's scalar-reference
  guard — `shared/pbx.repository.ts`, another agent's file. Reported below.

## Additional fixes noticed while in the files

- `VoicemailConsumer` had the same payload-`orgId` hole as `TrunkStatusConsumer` (audit ranked it P2);
  fixed identically — subject-derived `subjectOrgId`, term on disagreement, `file(subjectOrgId, …)`.
- `SipCredentialsResponder.onApplicationShutdown` now sets `stopped` before draining, so the new
  re-subscribe loop cannot resurrect a subscription during shutdown.

## Cross-area needed

1. `packages/routing/src/translations.ts` — add an `unsafe-pattern` issue to `validateTranslationRule`
   (nested-quantifier reject or a match-step budget). The DTO comment now points at it; nothing guards it.
2. `shared/pbx.repository.ts` — route `sip_acl_entry.trunkId` (and every bare `z.uuid()` scalar reference)
   through the in-tenant existence check. Today tenant B deleting a trunk cascades away tenant A's ACL row.
3. `packages/db/src/platform-hierarchy.ts` — `listChildOrganizations` needs `limit`/`offset` so the paging
   added above reaches SQL. (Its member count is already `count() … groupBy`.)
4. `packages/events/src/streams` + `scripts/rebuild-did-index.ts` / `rebuild-sip-acl.ts` — the
   per-organization reverse key (`kvKeyFor.didIndexByOrg`) that removes the whole-key-space walk. Batching
   is a mitigation, not the fix.
5. `apps/asterisk` / `scripts/generate-sip-acl.ts` — per-tenant registration admission is now explicitly
   `apps/sipd`'s job; the generator may want to exit non-zero on the new multi-tenant-allowlist warning.
6. `apps/web` — the prompts pages are gated on `settings.read`/`settings.write` and now need
   `recordings.read`/`recordings.configure`/`recordings.delete`. Also
   `voicemail-messages-dialog.tsx:89-91` / `voicemail-screen.tsx:57` gate on the UNSCOPED voicemail grants,
   so the `.own` routes remain dead controls for a `user`.
7. Platform convention: no consumer in the repo sets `ack_wait`. Worth a shared default.

## Verification

- `pnpm --filter @optimiq-voice/api run typecheck` — **clean** (both `tsconfig.json` and
  `tsconfig.strict.json`). One earlier failure in `test/pbx/conferenceModeration.test.ts` was another agent's
  in-flight edit and cleared on the re-run, per the brief.
- `pnpm --filter @optimiq-voice/api run test` — **1195 passing, 0 failing**, exit 0.
  (First run: 1190 passing / 1 failing, the `voicemail.write.own` unenforced-permission assertion, closed by
  lowering the PATCH decorator.)
- `pnpm exec oxlint <owned dirs>` — **clean**. Remaining repo hits (`moh-classes`, `media`) are outside the
  area.
- `pnpm exec oxfmt <owned dirs> apps/api/test/pbx` — **clean**. `--check` reports 5 files, all outside the
  area (`branding-logo`, `call-flows`, `org-limits`, `shared`, `emergencyNotification`).
