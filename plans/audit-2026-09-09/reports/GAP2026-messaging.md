# GAP2026 — messaging (two-way SMS/MMS, 10DLC, toll-free, compliance)

Rows closed: **1.1** (two-way SMS/MMS on business numbers), **1.2** (10DLC brand + campaign
registration, per-number assignment), **1.3** (toll-free verification with the Feb/Sept-2026 BRN and
policy-URL fields). All three were **MISSING** and are now built, tested at every layer, and proven
live against the local stack.

---

## 1. What the research changed about the design

Sources read (Sept 2026):

- Telnyx, _Receiving Webhooks for Messaging_ — Ed25519 over `${timestamp}|${rawBody}`, headers
  `telnyx-signature-ed25519` / `telnyx-timestamp`.
  https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
- Telnyx, _Messaging migration to SMS/MMS API v2_ — the v2 envelope, and that v1 delivers a
  different shape entirely. https://developers.telnyx.com/docs/development/migration/messaging-migration-guide
- Telnyx, _10DLC Quickstart / Brand Registration / Campaign Registration / Phone Number Assignment /
  Troubleshooting_ — `POST /v2/10dlc/brand`, `/campaignBuilder`, `/phoneNumberCampaign`; the
  diagnostic chain is `identityStatus` → `campaignStatus === ACTIVE` → number assigned.
  https://developers.telnyx.com/docs/messaging/10dlc/quickstart and .../phone-number-assignment
- Telnyx, _Toll-Free Verification with Business Registration Fields_ — `businessRegistrationNumber`,
  `businessRegistrationType`, `businessRegistrationCountry` **required for every new submission from
  17 Feb 2026**. https://developers.telnyx.com/docs/messaging/toll-free-verification
- CTIA, _Messaging Principles and Best Practices_ (last revised Oct 2025) — consent tiers, STOP/HELP
  obligations, sender identification, SHAFT.
  https://www.ctia.org/the-wireless-industry/industry-commitments/messaging-interoperability-sms-mms
- Holland & Knight, _Beyond TCPA Compliance_ (May 2026) — carriers now make CTIA compliance
  contractually mandatory for A2P. https://www.hklaw.com/en/insights/publications/2026/05/beyond-tcpa-compliance-why-ctia-messaging-principles
- Infobip, _2026 Guide to TCPA Compliance for SMS_ — the FCC's April-2025 order: opt-out by **any
  reasonable method**, honoured immediately for a text keyword and within ten business days for other
  channels; quiet hours 8am–9pm local. https://www.infobip.com/blog/tcpa-compliance-sms
- FRANSiS, _CTIA Messaging Guidelines_ (Aug 2026) — the "voluntary but contractually enforced"
  status, and that enforcement is filtering and suspension rather than litigation.
  https://www.fransis.ai/articles/ctia-messaging-guidelines-explained

Three findings shaped the code rather than just the docs:

1. **The FCC's "any reasonable method" is a trap for a keyword matcher.** Matching only `STOP`
   under-honours; matching free text ("please stop sending me these") would also silence "stop by the
   shop at 5", invisibly. `compliance/keywords.ts` therefore matches only a whole-message keyword
   after punctuation/case normalisation, and the **manual opt-out path** exists precisely to carry
   the sentence-shaped requests a human has to read — which is also the channel the ten-business-day
   window applies to.
2. **Carrier enforcement is contractual, so the block has to be ours.** A send from an unregistered
   10DLC number is filtered by the carriers with no useful error. The registration state is therefore
   a projection this platform stores and the send path reads in a millisecond, defensible when the
   carrier is unreachable — not a live lookup.
3. **The BRN fields are already mandatory.** They are `not null` in the schema and required in the
   DTO, because accepting a submission without them only moves the rejection a week later with no
   field named.

---

## 2. What was built

### Database — `packages/pbx-db/src/schema/messaging-schema.ts` (7 tables, all `pgTable.withRLS`)

| Table                              | Purpose                                                                                                                                                               |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messaging_brand`                  | TCR brand identity. `ein` is deliberately **outside** the repository's column set, so no list, detail or log line can leak it; one function reads it, only to submit. |
| `messaging_campaign`               | Use case, samples, opt-in/out/help keywords, HELP and STOP reply text, optional quiet-hours trio, throughput class.                                                   |
| `messaging_toll_free_verification` | The Feb-2026 BRN trio + both Sept-2026 policy URLs, all `not null`.                                                                                                   |
| `messaging_number`                 | The join between a `phone_number` and the A2P world: class, carrier profile, campaign, `registration_status` **and a stored `registration_reason`**.                  |
| `conversation`                     | One thread per (our number, their number), with denormalised last-message and unread columns so the inbox pages without scanning `message`.                           |
| `message`                          | One SMS/MMS either way. MMS parts as object-store keys, never carrier URLs (a carrier URL expires; a two-week-old attachment would be a broken link).                 |
| `messaging_opt_out`                | The suppression ledger, keyed by the **pair**.                                                                                                                        |

Migration `20260910052813_pbx_messaging` + hand-written `…052814_pbx_messaging_grants`, applied
under `MIGRATION-LOCK-pbx-db`. RLS preflight: **74 tables, 0 errors**.

Design decisions worth naming:

- **A START deletes the opt-out row rather than flagging it inactive.** An "inactive opt-out" is a
  row that a query with a forgotten `where active` turns back into permission to send. The consumer's
  own STOP and START stay in `message` as the evidence of both acts.
- **`conversation` is `on delete restrict` from `messaging_number`.** Disabling a messaging line must
  not let a tenant erase what was said to consumers; the service disables and keeps, and the response
  says which happened.
- **Two global partial indexes** (`message_send_queue_idx`, `message_retention_idx`) plus the
  carrier-id uniques are registered in `schema.spec.ts`'s deliberate-exception list with their
  reasoning, per that file's convention.

### Carrier client — `packages/telnyx` (new files, additive exports only)

`resources/messages.ts` (send + get + the `message.*` event map + `telnyxDeliveryStatus`, the one
place the carrier's eight per-recipient statuses become our four), `messaging-profiles.ts`,
`ten-dlc.ts`, `toll-free-verification.ts`, `asMessageWebhook` on the existing webhook parser, and a
substantially extended in-package **fake carrier** that enforces the two rules the feature exists to
anticipate: a number cannot be assigned to a non-`ACTIVE` campaign, and a US local number with no
active campaign cannot send. 136 package tests pass.

Doc disagreements found and followed: the brand OTP verify body field is `otpPin`, not `pin`; the
`message.*` webhook payload is the same shape as the message object (unlike fax, which renames `id`).

### Events — `packages/events` (additive family)

New `messaging` family: root `messaging.evt.v1.<orgId>.<conversationId>.<event>`,
`message.received` / `message.delivered`, `MESSAGING_STREAM` (30 days, `discard: new`), schemas,
subject builders, `parseSubject` branch, validation entry. `config/nats.conf` gained least-privilege
grants for the **api user only** — publish and subscribe on `messaging.evt.v1.>` plus the enumerated
`$JS.API.*.MESSAGING` set, validated with `nats-server -t` in a container.

`message.delivered` carries `failed` as well as `sent`/`delivered`: one delivery receipt with an
outcome, branched on in the payload, the same argument `number_order.complete` makes. The inbound
event caps the body and carries no media bytes — a webhook is a notification, and fanning a
consumer's full message to an arbitrary endpoint would route around `messaging.read`.

### API — `apps/api/src/messaging/**` (new area, 22 files)

Behind a **port** (`provider/messaging-provider.port.ts`) with two implementations:
`TelnyxMessagingProvider` and `FakeMessagingProvider`. The port carries only what a carrier must do —
send, authenticate a webhook, fetch media, attach a number to a profile. Opt-out, keyword
classification, quiet hours and the registration gate are all **above** the port, because each must
be answerable when the carrier is unreachable.

**The send gate**, in `MessagingService.send`, refuses in a fixed order chosen so the caller sees the
most actionable refusal: configured → enabled → **registered** (with the stored reason) → **opted
out** (checked _inside_ the send transaction, so a STOP landing between check and insert cannot be
raced past) → **quiet hours**. Each is a distinct `code` and a human sentence:

- `MESSAGING_NUMBER_NOT_REGISTERED` — the admin has work to do; quotes `registrationReason`.
- `MESSAGING_RECIPIENT_OPTED_OUT` — nobody has work to do; names the date.
- `MESSAGING_QUIET_HOURS` — the clock is wrong; quotes the window and the local time.

Also: inbound ingestion with redelivery dedupe, automatic STOP/HELP/START handling with **exactly
one** opt-out confirmation (a second STOP gets silence — CTIA allows one), a send worker
(`skip locked`, attempts incremented by the claim, permanent-vs-transient branch), a registration
poller that **fans a campaign suspension out to every number on it** so the gate closes instantly, a
retention sweeper (media before row, and it never touches the opt-out ledger — a "stop texting me"
has no expiry), signed expiring MMS links with a browser-safe content-type **allow-list** (SVG is
refused: it is an XML document that can carry script), and eight Prometheus counters — the useful one
being `api_messaging_sends_blocked_total{reason}`, since a blocked send never reaches the carrier and
is invisible in a success rate.

### Permissions — `packages/auth`

`messaging.read` / `messaging.send` / `messaging.manage`, catalogue entry, role assignment, and the
ceiling paragraph the spec's convention requires (model now 131, ceiling stays 135). **There is
deliberately no `messaging.delete`**: a conversation is the tenant's own evidence in a TCPA dispute,
so it is removed by a time-scoped retention policy, never by a button. `messaging.send` sits with the
manager rather than the agent only because `AGENT_PERMISSIONS` may hold nothing organization-wide —
the same ceiling that keeps `calls.originate` out.

### Web — `apps/web` (new `/messaging` + five settings pages)

Inbox (number selector with a registration badge, thread list with unread/preview/relative time,
thread view, composer with attachments) and settings for numbers, brand (incl. the sole-proprietor
OTP round trip), campaigns, toll-free and opt-outs. 68 bun tests. `errorReason` and
`registrationReason` render as **text, never as `title=`** — a tooltip is unreachable by touch and
keyboard, and those two sentences are the only explanation a filtered message ever gets.

---

## 3. Tests

| Layer                                 | Result                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api (mocha, fake provider)            | **50 passing** — keywords, quiet hours incl. DST/zones/midnight-wrap, media allow-list + token rotation, DTOs (BRN required, 2–5 samples, EIN-unless-sole-proprietor), the fake provider's signature contract, send worker retry/permanent/abandon/MMS-URL paths                                                                                                                                              |
| `packages/telnyx`                     | **136 pass, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/pbx-db`                     | **117 pass, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/events`                     | **437 pass, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/auth`                       | **243 pass, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                          |
| web (bun)                             | **68 pass, 0 fail**                                                                                                                                                                                                                                                                                                                                                                                           |
| **RLS integration (live PostgreSQL)** | **5 pass** — new `messaging-tenant-rls.integration.spec.ts`: cross-tenant read hidden even with a known id, `WITH CHECK` refuses a cross-tenant write, one tenant's STOP does not suppress another's number _and_ the other tenant can still record its own for the same consumer, and `messaging_number.e164` uniqueness holds across the RLS boundary (`23505` against a row the inserting role cannot see) |
| RLS preflight                         | 74 tables, 0 errors                                                                                                                                                                                                                                                                                                                                                                                           |

Typecheck clean: `pbx-db`, `auth`, `telnyx`, `events`, `apps/api` (messaging-scoped), `apps/web`.

---

## 4. Live proof — against the running local stack

`MESSAGING_DRIVER=fake` on the api. Scripts in `<scratchpad>/e2e/messaging/`
(`setup.mjs`, `proof.mjs`, `proof-ui.mjs`); screenshots in
`<scratchpad>/e2e/artifacts/messaging/`.

**Registration chain, through the real API and the real Telnyx client against the package's fake
server:** DID → messaging line (`unregistered`, with the reason) → brand (`self-declared`) → campaign
(`active`) → number assigned → line becomes **`registered`, reason cleared**.

**API proof — all eight steps passed:**

1. An **unsigned** webhook → `403 MESSAGING_SIGNATURE_INVALID`.
2. A signed inbound → filed into a thread, preview and unread count correct.
3. The **same carrier id delivered twice** → filed exactly once.
4. Send → `queued` → worker hands it to the carrier → `sent` → receipt → **`delivered`**.
5. `STOP` → suppression row (`source: keyword`, `keyword: STOP`) → the next send refused
   `422 MESSAGING_RECIPIENT_OPTED_OUT` with the dated sentence.
6. **Exactly one** opt-out confirmation in the thread.
7. `START` → suppression cleared → send accepted again.
8. A second, unregistered number → `422 MESSAGING_NUMBER_NOT_REGISTERED` quoting its stored reason.

**Browser proof (Playwright, the real web app):** signed in, `/messaging`, selected
`+1 (312) 555-7001` (badge: **Registered**) — inbox showed the inbound thread with its preview and
unread badge; opened the thread and read the inbound body; **composed and sent a reply from the UI**,
and the row reached the fake carrier (`status = sent`, `carrier_message_id = fake-msg-c4786ec6…`);
the STOP/START lifecycle is visible in the thread as bubbles with `Sent` badges; and attempting to
send in the STOPped thread renders **"This recipient has opted out"** plus the API's exact sentence.

No messaging-related broker authorization violations after the grants landed; zero
`failed to publish a messaging event` in the api log.

---

## 5. Two bugs the live proof found (both fixed)

1. **`thread-view.tsx` read `message.media`, the API returned `mediaKeys`** — a runtime TypeError on
   every thread open. Resolved toward the _web's_ shape, which is the better contract: the API now
   returns `media: [{ objectKey, part, contentType }]`, with the content type derived from the stored
   key rather than stat'ed (a thread is a list; a stat per attachment would be an object-store round
   trip per part on a read path). `sizeBytes` was dropped rather than faked.
2. **Registration was unreachable under the fake driver**, so the inbox could never be proven. Fixed
   by standing the carrier package's own fake server up under `MESSAGING_DRIVER=fake` and pointing a
   **real** `TelnyxClient` at it (dynamic import, only on that branch, so no other build loads the
   `/fake` subpath). A hand-written double would have agreed with whatever we sent.

Two smaller corrections made while proving:

- The campaign gate required a `verified` brand; TCR accepts campaigns from a `SELF_DECLARED` brand
  (that is the standard low-throughput path). Relaxed to match the registry, still refusing
  `pending` / `unverified` / `failed`.
- Enabling messaging now **lazily provisions the platform messaging profile** and attaches the DID by
  carrier ref _or_ E.164 — the latter is what a hosted or hand-configured number has, and refusing it
  would have limited the feature to numbers bought through this platform.

---

## 6. Files outside my lane, and one incident

**Edited outside `apps/api/src/messaging`, `packages/telnyx`, `packages/pbx-db` messaging, web
messaging:**

- `apps/api/src/main.ts` — one line: `MessagingModule` added to the `pbxAreaEnabled` module list.
- `packages/auth/src/permissions.ts` + `.spec.ts` — the three tokens, catalogue, role entry, ceiling
  paragraph (registry convention).
- `packages/pbx-db/src/schema/{tables,drizzle-kit,schema.spec}.ts` — registering the new schema and
  its deliberate global indexes.
- `config/nats.conf` — api-only messaging grants.
- `.scripts/local-stack/render-env.sh` — **six lines** in the `api.env` heredoc turning the fake
  driver on for the local stack. Kept minimal; flagged here as asked.
- `apps/web/lib/{routes,page-permissions,query-keys}.ts`, `nav-config.ts`, `settings-nav.tsx`,
  `icons.tsx` — nav/permission wiring for the new pages.

**Incident, owned:** my `bash .scripts/local-stack/down.sh api` calls took the **entire stack** down
twice — `down.sh` ignored its argument at the time. The coordinator has since patched `down.sh` and
restored the stack. Separately, while resetting a mis-applied migration I ran a `delete` on
`drizzle.__drizzle_migrations` with an over-broad `created_at` predicate and removed **seven other
packs' ledger rows**; I repaired it by recomputing each migration's hash _and name_ with the same
`readMigrationFiles` the migrator uses and re-filing them, then verified only my two migrations were
outstanding before applying. The ledger is correct (42 rows) and `db:migrate` is clean. No other
pack's DDL was re-run or lost.

**Not mine, observed:** the engine was crash-looping on
`$JS.API.STREAM.INFO.SECURITY` (another pack's stream, no grant) — reported, not touched.

---

## 7. Known gaps, deliberately left

- **No live-gateway fan-out.** An open thread does not update without a refresh. The platform events
  are published; a live fan-out should be a _consumer_ of them, not a third write path beside the
  JetStream publish.
- **Quiet hours are evaluated in the campaign's declared zone, not the recipient's.** The recipient's
  is the legally interesting one and this platform does not know it — deriving it from an area code
  has been unreliable since portability. `isWithinQuietHours` takes a `recipientTimeZone` argument for
  the day a verified one exists.
- **Throughput class is stored but not enforced.** `messaging_campaign.throughput_per_second` is
  projected from the carrier; the send worker does not yet rate-limit against it (it sends one at a
  time, so the ceiling is not currently reachable).
- **No MMS transcoding.** Parts are stored and forwarded as uploaded; a carrier that refuses an
  oversized part fails the message with the carrier's own sentence.
- **The fake registry is in-process**, so its brand/campaign ids do not survive an api restart. The
  setup script is re-runnable; production is unaffected.
