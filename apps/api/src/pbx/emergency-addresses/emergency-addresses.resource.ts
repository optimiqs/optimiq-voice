import { emergencyAddress } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../shared/pbx-resource";

/**
 * Dispatchable locations — the E911 half of Kari's Law and RAY BAUM'S Act.
 *
 * ## What the two rules actually require, in the order they bite
 *
 * **Kari's Law** (47 CFR §9.16): a multi-line telephone system must let a user dial `911` with no
 * prefix, and must send a NOTIFICATION to a central location on the premises when somebody does.
 * Neither half is data — the first is a routing rule and the second is an event — so neither lives
 * in this table. See the follow-up note at the end of this comment.
 *
 * **RAY BAUM'S Act** (§9.8): the call must convey a **dispatchable location** — a street address
 * PLUS the detail that tells a responder which door to come through. That is what this table is,
 * and `location_detail` ("Floor 3, Room 314") is the column that makes it a dispatchable location
 * rather than an address.
 *
 * ## `validated` is a gate, and the CRUD layer is not what enforces it
 *
 * `emergency-schema.ts` states the rule: *"a number may only be used for emergency origination
 * once its address has been validated by the upstream provider, so `validated` is a hard gate the
 * CRUD layer must check before allowing an emergency caller id."*
 *
 * The gate is real now, and it is enforced in one place rather than on this descriptor. Address
 * validation is a call to a carrier's E911 provisioning API — `packages/telnyx`'s `e911Addresses`
 * resource wraps Telnyx's, and `emergency-addresses.service.ts` is the only code allowed to write
 * `validated` and its three companions, from the carrier's answer and nothing else. A `validated`
 * flag this API set for itself would still be a lie with a compliance label on it, so the DTOs keep
 * refusing to accept one from a request body.
 *
 * The refusal itself is `EmergencyAddressNotValidatedException`, raised by
 * `EmergencyAddressesService.assertAssignable` — which every write that attaches an address to
 * something that can originate 911 calls first (`phone_number.emergency_address_id`,
 * `device.emergency_address_id`). It is a method on the service rather than a rule on this
 * descriptor because the seams that need it are in other slices, and a second copy of "what
 * validated means" is how the two drift apart.
 *
 * ## No destination trio, and one scalar reference
 *
 * An address is not a place a call goes. What points at it is `phone_number.emergency_address_id`,
 * which is `on delete set null` — so without the reference below, deleting an address would
 * silently strip the dispatchable location from every DID that used it, which is the single worst
 * silent change this table can undergo. Refused instead, naming the numbers.
 *
 * ## What this does NOT do, recorded rather than implied
 *
 * `emergency_address` is **not** in `ROUTING_TABLE_TO_ENTITY`, so a write here does not recompile
 * the tenant and the address does not appear in the routing artifact at all. That is correct today
 * because nothing in `packages/routing` reads it — the compiler's only emergency-aware field is
 * `ExtensionInput.emergencyCallerIdNumber`, which it copies to the extension index and never acts
 * on. Assigning an address to a number DOES recompile (`phone_number` is a routing table) and
 * produces an identical `snapshotHash`, because the loader does not project the column.
 *
 * Full E911 call handling needs three things this slice cannot provide: an emergency route that
 * bypasses the outbound kill-switch and the toll-class gate, an ELIN or location reference on the
 * outbound rule, and the Kari's Law notification event. All three are `packages/routing` and
 * `apps/engine` work; see the mission report.
 */
export const EMERGENCY_ADDRESS_RESOURCE: PbxResource = {
	kind: "emergency-address",
	tableName: "emergency_address",
	table: emergencyAddress,
	searchColumns: [
		emergencyAddress.label,
		emergencyAddress.streetLine1,
		emergencyAddress.locality,
		emergencyAddress.postalCode,
	],
	orderBy: [emergencyAddress.label, emergencyAddress.id],
	// No `enabled` column: an address is validated or it is not, and "disabled" would be a third
	// state with no meaning to a dispatcher.
	destinations: [],
	destinationType: null,
	scalarReferences: [
		{
			table: "phone_number",
			kind: "phone-number",
			column: "emergency_address_id",
			nameColumn: "e164",
		},
	],
};
