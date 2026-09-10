# FIX — Porting workflow (LNP) and CNAM

Both audit findings closed: `packages/telnyx` gained a porting-orders resource and a CNAM pair,
`apps/api` exposes five permission-gated routes, and `apps/web` has a "Port in & caller ID" tab.

## Files changed

### packages/telnyx

| File                                                           | Change                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/resources/porting-orders.ts`                              | **new** — the LNP resource                                                                                                                                                         |
| `src/resources/phone-numbers.ts`                               | `TelnyxCnamListing`, `UpdateCnamListingInput`, `assertCnamDetails`/`TelnyxCnamFormatError`, `getCnamListing`/`updateCnamListing`, plus `cnamListing` on `UpdateVoiceSettingsInput` |
| `src/client.ts`, `src/index.ts`                                | wired in and re-exported                                                                                                                                                           |
| `src/fake/state.ts`, `src/fake/server.ts`, `src/fake/index.ts` | `/porting_orders` routes, persisted CNAM on the voice PATCH                                                                                                                        |
| `src/client.spec.ts`                                           | 15 new specs                                                                                                                                                                       |

### apps/api

`src/pbx/carrier/carrier.dto.ts`, `carrier.service.ts`, `carrier.controller.ts`, `carrier.errors.ts`
(one branch), `test/pbx/carrierPorting.test.ts` (**new**, 19 tests).
**`pbx.module.ts` was NOT touched** — the routes hang off the already-registered `CarrierController`.

### apps/web

`lib/carrier/client.ts`, `lib/query-keys.ts` (+2 keys), `lib/routes.ts` (one array member),
`app/(app)/_hooks/use-carrier-queries.ts` (+4 hooks),
`app/(app)/numbers/_components/porting-panel.tsx` (**new**), `numbers-screen.tsx` (+1 tab).

## Client methods

```
portingOrders.create(input)                   POST   /porting_orders     retryable:false
portingOrders.list(query)                     GET    /porting_orders     data + meta
portingOrders.get(id)                         GET    /porting_orders/{id}
portingOrders.findByCustomerReference(ref)    GET    /porting_orders     the reconciliation read
phoneNumbers.getCnamListing(id)               GET    /phone_numbers/{id} + …/voice   (two reads)
phoneNumbers.updateCnamListing(id, input)     PATCH  …/voice, then re-read both
```

`create` answers with a **list**: Telnyx files one porting order per losing carrier, so a request
spanning two carriers returns two orders with two FOC dates. Modelling it as a single object would
silently drop the second, and the numbers in it would never port. The module returns an array and
the UI counts orders rather than numbers.

`getCnamListing` is two requests because Telnyx splits the answer: `caller_id_name_enabled` is
write-only on `PATCH …/voice` and readable only on the parent number, while `cnam_listing` lives on
the voice GET. `phone-numbers.ts` already documented that asymmetry; this respects it rather than
inventing a symmetric type that promises a round trip that does not exist. The fake server enforces
it — its voice GET deliberately omits `caller_id_name_enabled` — so a client that read the wrong
endpoint fails a test.

## API routes

| Route                                    | Permission      | Notes                                                  |
| ---------------------------------------- | --------------- | ------------------------------------------------------ |
| `POST /api/v1/carrier/porting-orders`    | `numbers.order` | a port-in is a recurring commitment                    |
| `GET /api/v1/carrier/porting-orders`     | `numbers.read`  | filtered to this org by the `customer_reference` token |
| `GET /api/v1/carrier/porting-orders/:id` | `numbers.read`  | another org's order is a **404**, not a 403            |
| `GET /api/v1/carrier/numbers/:id/cnam`   | `numbers.read`  | `:id` is the **local** row id                          |
| `PATCH /api/v1/carrier/numbers/:id/cnam` | `numbers.write` |                                                        |

No permission was added. Two design points worth review:

- **`createPortingOrder` writes no `phone_number` row.** A ported number belongs to the losing
  carrier for weeks; a row now would publish a DID to the routing compiler and the `did-index` whose
  calls still land elsewhere. The row is created the ordinary way once the port reports `ported`.
  This is the deliberate opposite of `orderNumber`'s carrier-first-then-DB, and the service and the
  UI both say so.
- **CNAM is addressed by the local phone-number id.** The lookup is organization-scoped, so another
  tenant's number 404s before a carrier request exists. Accepting a Telnyx id would have made the
  route a read-anyone's-CNAM oracle over a shared namespace.

Porting orders carry no organization at the carrier, so list/get scope on the
`optimiq-port-<orgId>-<uuid>` token this platform stamps. That is exactly as strong as the token,
which is why the token embeds the org id — noted here because it is the one place tenant isolation
is not enforced by a database scope.

## READ vs INFERRED

- **READ** from `reference/telnyx-api.md`: the whole CNAM surface — `cnam_listing{cnam_listing_enabled,
cnam_listing_details}` on `GET|PATCH …/voice`, and the `caller_id_name_enabled` write-only trap.
- **INFERRED** from the public Telnyx v2 API (the reference doc does not cover porting): every
  porting shape — `POST|GET /porting_orders`, `GET /porting_orders/{id}`, the list-shaped create
  response, the 8-value status enum, `support_key`, `activation_settings{foc_datetime_requested,
foc_datetime_actual, fast_port_eligible}`, `misc`, and the per-number `activation_status` enum.
  The module header says so in as many words. Every schema there is loose with only `id` and
  `status` required, so a wrong guess degrades a field rather than breaking a status read.
- The 15-character printable-ASCII CNAM ceiling is the NANP field width, not a Telnyx-documented
  limit — enforced client-side because Telnyx accepts a longer string and truncates it downstream.

## Verification

| Command                                                           | Result                                |
| ----------------------------------------------------------------- | ------------------------------------- |
| `pnpm --filter @optimiq-voice/telnyx run typecheck`               | pass                                  |
| `pnpm --filter @optimiq-voice/telnyx run test`                    | **95 pass / 0 fail** (was 80)         |
| `pnpm exec turbo run typecheck --filter=...@optimiq-voice/telnyx` | **15/15 successful**                  |
| `pnpm --filter @optimiq-voice/api run typecheck`                  | pass                                  |
| `pnpm --filter @optimiq-voice/api run test`                       | **1374 passing / 0 failing** (19 new) |
| `pnpm --filter @optimiq-voice/web run typecheck`                  | pass                                  |
| `pnpm --filter @optimiq-voice/web run test`                       | **847 pass / 0 fail**                 |
| `pnpm exec oxlint <dirs>`                                         | clean                                 |
| `pnpm exec oxfmt --check <dirs>`                                  | clean, 42 files                       |

No live carrier call anywhere. `TELNYX_API_KEY` was never set; every carrier request in both suites
goes to `startFakeTelnyxServer()` on loopback.

## Live evidence

See the "Agent log — AREA=porting-cnam" section of `STACK.md` for the full table. Summary: all three
porting routes answer **503 `CARRIER_NOT_CONFIGURED`** on the running stack, and a member session
lacking the grants gets four distinct **403**s naming `numbers.order`, `numbers.read` and
`numbers.write` respectively.

## One thing deliberately not done

The task listed a CNAM field on `apps/api/src/pbx/phone-numbers/phone-numbers.dto.ts`. **There is no
CNAM column in `packages/pbx-db`** (which is off-limits here), so a DTO field would be a write with
nowhere to land — `PhoneNumbersService.create/update` maps straight onto columns. CNAM is
carrier-held state with a single source of truth, and the service header says so. If a mirrored
column is wanted, it needs a `pbx-db` migration first; the route works without one.
