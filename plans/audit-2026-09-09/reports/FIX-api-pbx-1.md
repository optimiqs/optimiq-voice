# FIX — AREA `api-pbx-1`

## P0

1. **Reorder violates UNIQUE (parent, ordinal)** — FIXED. `shared/pbx.repository.ts`: two passes in the
   same transaction (park every row at `-(i+1)`, then land `0…n-1`). No ordinal column carries a
   `CHECK >= 0` (`grep check( packages/pbx-db/src/schema` → none), so negatives are safe.
   Test: new `test/pbx/pbxReorder.test.ts` — a fake transaction that enforces the unique index per
   statement, driven with a real swap and a full reversal. Verified it FAILS (`PbxConflictFailure`)
   against the old single-pass write.
2. **Conference fan-out stops on an unreachable engine** — FIXED. `conference-control.client.ts`
   exports `LOCALLY_SYNTHESISED_REFUSAL = "unreachable: "` and prefixes every refusal it synthesises;
   `conference-moderation.service.ts` continues past those and still stops at an engine-authored
   refusal. Used the `error`-prefix variant, not a new `reason`, because the reason set lives in
   `packages/events` (cross-area). Two tests added.
3. **`branding.logoObjectKey` → unauthenticated read of any object in the shared media store** —
   FIXED server-side. `branding-logo.controller.ts` refuses any key outside `branding/` with a 404
   before `store.head`. DTO change reported as cross-area.
4. **SVG logo served inline → stored XSS on the API origin** — FIXED. Logo route now sets
   `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; style-src
'unsafe-inline'; sandbox`, and serves `image/svg+xml` as `attachment`. Corrected the false safety
   note in `branding-image.ts`.
5. **`moh_class.streamUri` config injection → RCE** — FIXED. `moh-classes.dto.ts` gains `mohStreamUri`
   (allowlist regex, http/https only, no whitespace/quotes/`;`/`#`/backtick/control chars);
   `musiconhold-conf.ts` re-checks with `SAFE_STREAM_URI` and skips with a new
   `unsafe-stream-uri` reason for rows written before the constraint. Tests: 7 injection payloads at
   both layers.
6. **`maxStorageMb` enforced nowhere** — PARTIAL. `OrgLimitsService.assertMayStore` added and wired
   into `BrandingLogoUploadService` (before the object is stored). Prompt/greeting/voicemail upload
   paths are outside this area — reported below and named honestly in `org-limits.ts` rather than
   claimed. Also corrected `org-limits.ts`'s "same transaction as the insert" (it is read-then-create).
   Test added in `brandingLogo.test.ts`.
7. **Fax `client_state` non-UUID throws instead of falling back** — FIXED.
   `fax-inbound.service.ts` gains `correlationId()`: raw UUID, else base64-decoded UUID, else
   `undefined` → the carrier-fax-id fallback. Two tests (non-UUID and base64).
8. **Trunk re-provision rotates the live password with no compensation** — FIXED.
   `carrier.service.ts` retries the local write once and, failing that, logs at error with
   `connectionId`/`userName` and "rotated but not recorded — re-provision required", then rethrows.
9. **`retry_backoff_seconds` never applied** — FIXED (contained `claimed_at` variant, no migration).
   `releaseSend` now keeps the row `sending` and dates `claimed_at = retryAt - lease`, so the existing
   lease clause re-offers it exactly one backoff later; the worker reads `retryBackoffSeconds`
   alongside `retryAttempts`. Existing "releases the claim" test rewritten to the new contract.
10. **Call-flow presence publisher connects to the wrong broker** — FIXED. `connect({ servers: url,
...natsConnectionOptions(this.env, "api"), name: … })`; the `as never` cast is gone.
11. **Presence key written once against a 5-minute TTL bucket** — FIXED with a 60 s keep-alive over a
    `Map` of lit keys, cleared on shutdown. The bucket is shared with the engine, so raising `ttlMs`
    was not taken. Covers `TimeConditionOverrideService` too — it goes through the same publisher.

## P1

- **21+ serial round trips per delete** — FIXED. `destinations.ts` `findDestinationReferences` is now a
  single parenthesised `union all` over the sites (one round trip); the stale "fourteen" comment is
  gone with it (that P2 too).
- **Unbounded child reads** — FIXED. `MAX_CHILDREN = 1000` on `listChildren` and both `reorderChildren`
  reads.
- **Outbox sweeper does not wait at shutdown** — FIXED. `inFlight` promise + async
  `onApplicationShutdown` awaiting it.
- **Stream MOH class decodes empty stdin** — FIXED. `--mono ${uri}` replaces `--mono -`, sequenced
  behind the URI validation. Test asserts the exact command line and that `--mono -` is gone.
- **`storageBytesFor` streams two whole tables into Node** — FIXED. `coalesce(sum(...), 0)` in SQL.
- **Fax media download unbounded in memory** — FIXED. `MAX_FAX_MEDIA_BYTES = 50 MiB`, checked on the
  declared `content-length` and enforced while streaming; the reader is cancelled on every exit path.
- **Fax list endpoints run a second `count(*)`** — FIXED. `count(*) over ()` on the same query, per
  `shared/pagination.ts`'s contract. `count` import dropped.
- **Emergency consumer's tenancy check does not check the tenant** — FIXED. The org token is read off
  the delivery subject (index 3) and compared to `envelope.orgId`. Two tests.

## P2

- **`PbxDatabaseFailure` leaks the raw Postgres message** — FIXED. Body is now
  `The telephony database refused "<op>".`; the detail is logged at error in `toPbxFailure`.
- **`resource_ref` bypasses `asUuid`** — FIXED.
- **Stale "until that endpoint exists" headers** — FIXED; they now point at `conference-pin.service.ts`.
- **`.own` resolution opens two transactions** — FIXED. One `withTenantScope` with an internal
  `extensionIdsIn` helper; signatures unchanged.
- **`assertNotReferenced` header undercounts** — FIXED (rewritten with the `union all`).
- **`patchOwnCategory` skips the category override** — FIXED.
- **`findMessageOrgById` does not constrain direction** — FIXED (`and direction = 'outbound'`).
- **Signed fax links cannot survive a rotation** — FIXED. `FAX_MEDIA_URL_SECRET_PREVIOUS` added and
  threaded, mirroring `PBX_VOICEMAIL_URL_SECRET_PREVIOUS`.
- **Repeated `?token=` yields a 500** — FIXED (`typeof token === "string" ? token : ""`).
- **Origination budget spent on a 503** — FIXED; the connection guard moved above `limiter.consume`.

Nothing skipped, nothing found WRONG.

## Cross-area needed

1. `apps/api/src/auth/branding/branding.dto.ts:26` — drop `logoObjectKey` from `updateBrandingDto`
   entirely, so the key can only be minted by `BrandingLogoUploadService`. The read-side prefix guard
   makes this defence-in-depth rather than the only defence.
2. `apps/api/src/media/media-response.ts` — the `nosniff` + CSP headers are per-route today. Every
   route through this file (prompts, greetings, recordings, voicemail) wants the same; a global header
   hook beats four per-route fixes.
3. `packages/events` `conferenceControlResponseSchema` — a distinct `unreachable` reason would be
   cleaner than the `error`-prefix marker, if the engine is expected to echo it.
4. `pbx/prompts`, `pbx/voicemail-*`, greeting upload — each needs
   `await this.limits.assertMayStore(session, bytes)` before storing, for `maxStorageMb` to be real.
5. `voicemail-boxes/voicemail-consumer.service.ts:245-260` (p–z) — the identical vacuous tenancy
   check; same one-line fix.
6. `packages/pbx-db` fax schema — the `next_attempt_at` column would be the clean spelling of the fax
   backoff; the contained `claimed_at` variant shipped instead and needs no migration.

## Verification

- `pnpm --filter @optimiq-voice/api run typecheck` — clean (both `tsconfig.json` and
  `tsconfig.strict.json`). Earlier `src/auth/auth.platform.ts` / `src/auth/sso/sso.service.ts` errors
  were another agent's in-flight work and are now gone.
- `pnpm --filter @optimiq-voice/api run test` — **1197 passing, 0 failing**.
- `pnpm exec oxlint apps/api/src/pbx apps/api/test/pbx` — 0 warnings, 0 errors.
- `pnpm exec oxfmt apps/api/src/pbx apps/api/test/pbx` — 280 files, clean.
