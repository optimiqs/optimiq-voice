# FIX — Ray Baum's per-device dispatchable location (AREA=raybaum)

The audit finding: address model and ELIN selection were real at DID and extension level, but
`devices-schema.ts` had no emergency column, so two desks on one extension shared one address and a
responder was sent to a building rather than to a desk.

Closed by giving every device — and, by borrowing its extension's handset, every softphone user — a
dispatchable location: an `emergency_address` reference plus a free-text desk detail that refines it.

## Files changed

### Schema and migration

- `packages/pbx-db/src/schema/devices-schema.ts` — `device.emergency_address_id`
  (`uuid`, nullable, `ON DELETE SET NULL` → `emergency_address`, mirroring `phone_number`'s
  precedent) and `device.emergency_location_detail` (`text`, nullable), plus
  `device_organization_emergency_address_idx`.
- `packages/pbx-db/drizzle/20260909202353_pbx_device_dispatchable_location/` — generated,
  **additive only**: two `ADD COLUMN` (both nullable), one `CREATE INDEX`, one `ADD CONSTRAINT` FK.
  No `_grants` pair: grants are table-level in this schema and precedent
  (`20260806051622_pbx_device_token_hash`) adds none for a new column.

### API — device surface

- `apps/api/src/provisioning/devices/devices.dto.ts` — `emergencyAddressId` (uuid) and
  `emergencyLocationDetail` (≤255) on `createDeviceDto`, so `patchOf` picks them up for PATCH.
- `apps/api/src/provisioning/devices/devices.service.ts` — new exported
  `assertMayWriteDispatchableLocation(session, values)`. Refuses with 403
  `EMERGENCY_LOCATION_FORBIDDEN` unless the caller holds `numbers.emergency`. **No new permission.**
  The check is conditional on field PRESENCE (an explicit `null` counts — clearing a location is
  setting one), which is why it lives in the service rather than on the decorator: a
  `devices.write`-only holder must still be able to rename a phone.
- `apps/api/src/provisioning/devices/devices.controller.ts` — wired into `POST` and `PATCH`.

### API — provisioning render and softphone

- `apps/api/src/provisioning/render/provision.repository.ts` — `RenderSnapshot.emergencyAddress`,
  read conditionally (a second query, not a left join: the column is NULL on most devices and this
  path runs on every config fetch a fleet makes).
- `apps/api/src/provisioning/catalog/render-context.ts` — new `DispatchableLocation`
  (`addressId` / `formatted` / `detail` / `validated`) and `RenderContext.dispatchableLocation`.
- `apps/api/src/provisioning/render/provision.service.ts` — `dispatchableLocationOf(snapshot)`,
  reusing the mail area's `formatDispatchableLocation` so the address a user reads in the softphone
  is character-for-character the one a responder is read off the notification.
- `apps/api/src/provisioning/catalog/templates/softphone.ts` — `dispatchableLocation` in the payload
  (`null` rather than an omitted key). No desk-phone `.cfg` consumes it — a vendor config has nowhere
  to put a street address — so this is the surface where the location becomes checkable by a human.
- `apps/api/src/provisioning/softphone/softphone.service.ts` — `GET /api/v1/me/softphone` gains
  `dispatchableLocation`, resolved from a located handset on the caller's own extension. It is
  explicitly not a claim about where the browser is; it is "the address your extension currently
  reports", which is the check §9.8 assumes somebody has made.

### API — Kari's Law notification

- `apps/api/src/mail/mail-templates.ts` — `formatDispatchableLocation(address, deviceDetail?)`: the
  device detail is inserted immediately AFTER the address's own `locationDetail` rather than
  replacing it or being appended after the country, so "Floor 7, Desk 12" reads as an address.
  `EmergencyDialedMailInput` gains `locationDevice` (renders a `Device:` row) and `locationValidated`
  (renders `(address not validated)`).
- `apps/api/src/pbx/emergency-addresses/emergency-notification.service.ts` — `readContext` now, after
  resolving the calling extension, walks `device_line → device` for that extension. A device with its
  own address WINS over the number's; a device with only a detail REFINES the number's address (the
  address row is kept, not just its formatted string, so the re-format puts the desk beside the
  floor). When several handsets each claim a location the notice names the one it used and says the
  others disagree, rather than presenting a coin flip as fact.

### Web

- `apps/web/lib/provisioning/contracts.ts` — the two fields on `DeviceRow`.
- `apps/web/lib/provisioning/schemas.ts` — the two fields on `deviceFormSchema` (surgical append).
- `apps/web/app/(app)/devices/_components/device-dialog.tsx` — a "Dispatchable location" section: a
  `ResourceSelect` over `PBX_RESOURCES.emergencyAddresses` and a detail `TextField`, with a notice
  explaining the two-desks case and that the write needs the emergency permission. The form is
  deliberately not the gate — a permission enforced only in a browser is enforced nowhere.

### Tests

- `apps/api/test/provisioning/dispatchableLocation.test.ts` (new, 11 cases) — the render/softphone
  seam (located handset, detail-only, unlocated, detail ordering, payload `null`) and the five
  permission-gate cases.
- `apps/api/test/pbx/emergencyNotification.test.ts` (+4 cases, 22 total) — device location overrides
  the number's, a bare detail refines it, the multi-handset ambiguity is admitted, an unvalidated
  address is labelled. The fake transaction gained `innerJoin`/`orderBy` terminals.
- `apps/api/test/provisioning/provisioningCatalog.test.ts` — `dispatchableLocation: undefined` in the
  context fixture.
- `apps/web/lib/provisioning/provisioning.spec.ts` (+1 case) — the fields clear to `null`, and a
  typed detail is trimmed and kept.

## Verification

| Command                                             | Result                                                                                                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @optimiq-voice/pbx-db run typecheck` | clean                                                                                                                                                           |
| `pnpm --filter @optimiq-voice/pbx-db run test`      | **108 pass, 14 skip, 0 fail**                                                                                                                                   |
| `pnpm --filter @optimiq-voice/api run typecheck`    | clean (both projects)                                                                                                                                           |
| `pnpm --filter @optimiq-voice/api run test`         | **1374 passing, 0 failing**                                                                                                                                     |
| `pnpm --filter @optimiq-voice/web run test`         | **831 pass, 0 fail**                                                                                                                                            |
| `pnpm --filter @optimiq-voice/web run typecheck`    | one error, **not mine**: `app/(app)/reports/page.tsx(1,31)` cannot find `./_components/reports-screen` — another agent's in-progress screen. Clean on my files. |
| `pnpm exec oxlint <my dirs>`                        | clean                                                                                                                                                           |
| `pnpm exec oxfmt --check <my dirs>`                 | all 65 files correctly formatted                                                                                                                                |

## Live evidence

Migration applied to the running `optimiq_pbx` (127.0.0.1:5533):

```
 column_name               | data_type | is_nullable
 emergency_address_id      | uuid      | YES
 emergency_location_detail | text      | YES
```

api restarted once (killed by pid, then `.scripts/local-stack/up.sh api`); `/api/auth/ok` → 200. A
short node client (same cookie-jar/Origin shape as `smoke-call.mjs`) signed up, created an
organization, and round-tripped the field through the real API — full transcript in
`raybaum-live.log`:

```
organization 01a087e0-0e5e-710d-ba30-54587db6b784
emergency address 01a087e0-0e70-716e-a5cb-eaf9f382dc9b validated = false
POST  /devices     -> emergencyAddressId=01a087e0-…dc9b  emergencyLocationDetail="Desk 12, by the window"
GET   /devices/:id -> emergencyAddressId=01a087e0-…dc9b  emergencyLocationDetail="Desk 12, by the window"
PATCH /devices/:id -> "Desk 40, by the door"
PATCH clear        -> {"a":null,"d":null}
PATCH 300-char detail -> 400 PBX_INVALID_BODY "emergencyLocationDetail: Too big: expected string to have <=255 characters"
PASS
```

`STACK.md` carries an "Agent log — AREA=raybaum" section recording the migration and the restart.

## Cross-area needed

1. **The engine's event carries no device identifier.** `call.emergency.dialed` names a leg, an ELIN
   and an `emergencyAddressId`, but nothing that says which registration answered. The notification
   therefore resolves the handset by inference: `callerNumber → extension → device_line → device`.
   That is correct for the common case and honest about the case it cannot resolve (it names the
   ambiguity in the message when several handsets on the extension each claim a location), but the
   real fix is a `deviceId` — or the registration contact — on the event payload, which lives in
   `apps/engine` / `packages/events` and is off-limits here.
2. **`emergency_address.validated` is still not a write gate anywhere.** `phone_number` does not
   check it today either, so I did not add a device-only gate that would be inconsistent with the
   existing surface. Instead the flag is carried honestly: the softphone payload exposes
   `validated`, and the Kari's Law mail renders `(address not validated)`. Making `validated` a hard
   precondition for both `phone_number.emergency_address_id` and `device.emergency_address_id` is a
   one-place change in the emergency-address CRUD layer and should be a follow-up.
3. **Path note.** The task named `apps/api/src/pbx/devices/**` and `apps/web/lib/pbx/schemas.ts`.
   The device surface actually lives at `apps/api/src/provisioning/devices/**` and the device form
   schema at `apps/web/lib/provisioning/schemas.ts`; those are what I edited. I also added the two
   fields to `apps/web/lib/provisioning/contracts.ts` (`DeviceRow`), which the form cannot compile
   without.
