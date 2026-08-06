import {
	device,
	deviceKey,
	deviceLine,
	deviceProfile,
	deviceProfileKey,
} from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../../pbx/shared/pbx-resource";

/**
 * The device inventory, declared.
 *
 * These reuse `PbxResource` and the PBX area's one repository on purpose. A device, its lines and
 * its keys are structurally identical CRUD over the same database with the same tenant wrapper, the
 * same paging and the same conflict mapping — the exact shape `pbx-resource.ts` exists to state
 * once. Writing a second repository here would be forty lines of Drizzle whose only distinguishing
 * feature is that a fix to the paging window would have to be applied twice.
 *
 * ## Why none of them is a routing input
 *
 * `ROUTING_TABLE_TO_ENTITY` in `@optimiq-voice/routing` is the authority on what evicts a tenant's
 * compiled artifact, and it does not list `device`, `device_line`, `device_key`, `device_profile`
 * or `device_profile_key`. That is correct and worth stating: routing decides where a call GOES,
 * and a device is how an extension reaches a handset. Re-pointing line 2 of a desk phone changes
 * which physical box rings for an extension the dial plan already resolves to; it does not change
 * the dial plan. Making a key-layout edit republish the routing artifact would evict a cache for a
 * change that cannot affect it, on the tables administrators touch most often.
 *
 * ## Why nothing points at a device as a destination
 *
 * `destinationType: null` on all five. A call is never routed "to a device" — it is routed to an
 * extension, and the registrar decides which of that extension's devices are ringing right now.
 * Making a device a destination would let an administrator pin a call to a handset that is
 * unplugged, which is the failure mode extensions exist to prevent.
 */

export const DEVICE_RESOURCE: PbxResource = {
	kind: "device",
	tableName: "device",
	table: device,
	/**
	 * The MAC is searchable and is stored normalized, so a search for `00:15:65` would find nothing
	 * while `001565` finds the OUI. The controller normalizes a search term that looks like a MAC
	 * fragment before it reaches here, because the alternative is an `ilike` over a `replace()`
	 * expression, which no index can serve.
	 */
	searchColumns: [device.macAddress, device.label, device.model],
	orderBy: [device.macAddress, device.id],
	enabledColumn: device.enabled,
	destinations: [],
	destinationType: null,
};

export const DEVICE_LINE_RESOURCE: PbxChildResource = {
	kind: "device-line",
	tableName: "device_line",
	table: deviceLine,
	parentColumn: deviceLine.deviceId,
	parentKind: "device",
	parentTable: device,
	searchColumns: [deviceLine.label],
	/**
	 * Ordered by line number, which is the order the keys appear on the handset. There is no
	 * `ordinalColumn` and therefore no `PUT …/reorder`: a line's position is `lineNumber`, which the
	 * caller sets explicitly because it corresponds to a physical key on a physical phone. A drag
	 * handle that moved line 2 above line 1 would be a lie about hardware.
	 */
	orderBy: [deviceLine.lineNumber, deviceLine.id],
	enabledColumn: deviceLine.enabled,
	destinations: [],
	destinationType: null,
};

export const DEVICE_KEY_RESOURCE: PbxChildResource = {
	kind: "device-key",
	tableName: "device_key",
	table: deviceKey,
	parentColumn: deviceKey.deviceId,
	parentKind: "device",
	parentTable: device,
	searchColumns: [deviceKey.label, deviceKey.value],
	/**
	 * `(category, keyIndex)` is the unique key and is also the physical layout: memory key 3 is a
	 * specific button. Same reasoning as lines — no reorder endpoint, because the order belongs to
	 * the hardware and the caller states it.
	 */
	orderBy: [deviceKey.category, deviceKey.keyIndex, deviceKey.id],
	destinations: [],
	destinationType: null,
};

export const DEVICE_PROFILE_RESOURCE: PbxResource = {
	kind: "device-profile",
	tableName: "device_profile",
	table: deviceProfile,
	searchColumns: [deviceProfile.name, deviceProfile.description, deviceProfile.model],
	orderBy: [deviceProfile.name, deviceProfile.id],
	enabledColumn: deviceProfile.enabled,
	destinations: [],
	destinationType: null,
	/**
	 * A profile a device still points at may not be deleted.
	 *
	 * `device.device_profile_id` is `ON DELETE SET NULL`, so the database would happily accept the
	 * delete and quietly strip the profile from every phone that used it — the next resync would
	 * hand those handsets a configuration without the settings their administrator thought they had,
	 * and nothing would report it. Refusing with a 409 that names the devices makes the consequence
	 * visible while the person still has the context to act on it.
	 *
	 * The profile's keys are not listed: they are `ON DELETE CASCADE` children and are supposed to
	 * die with it.
	 */
	scalarReferences: [
		{ kind: "device", table: "device", column: "device_profile_id", nameColumn: "label" },
	],
};

export const DEVICE_PROFILE_KEY_RESOURCE: PbxChildResource = {
	kind: "device-profile-key",
	tableName: "device_profile_key",
	table: deviceProfileKey,
	parentColumn: deviceProfileKey.deviceProfileId,
	parentKind: "device-profile",
	parentTable: deviceProfile,
	searchColumns: [deviceProfileKey.label, deviceProfileKey.value],
	orderBy: [deviceProfileKey.category, deviceProfileKey.keyIndex, deviceProfileKey.id],
	destinations: [],
	destinationType: null,
};
