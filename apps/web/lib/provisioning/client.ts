/**
 * The provisioning REST surface.
 *
 * Devices, profiles and their child collections reuse `PbxResourceDescriptor` and the generic
 * `listPbx` / `createPbx` / … helpers, because on the wire they ARE PBX resources: the API serves
 * them from the same declarative repository with the same envelopes, the same paging and the same
 * failure taxonomy. Declaring a second client for them would be a second copy of the same four
 * fetches, and the copy is where the `?limit` cap or the `PATCH` semantics get forgotten.
 *
 * What is NOT generic — the catalogue, the token rotation and the softphone payload — is written
 * out below, because each returns a shape the CRUD envelope has no room for.
 */

import { apiFetch } from "../api-client";
import { formatMacAddress } from "./contracts";
import type { PbxChildDescriptor, PbxResourceDescriptor } from "../pbx/client";
import type { ItemEnvelope } from "../pbx/contracts";
import type {
	DeviceKeyRow,
	DeviceLineRow,
	DeviceProfileKeyRow,
	DeviceProfileRow,
	DeviceRow,
	ProvisionedDeviceEnvelope,
	ProvisioningCatalog,
} from "./contracts";

export const PROVISIONING_RESOURCES = {
	/**
	 * `affectsRouting: false` on all of these, and it is not an oversight.
	 *
	 * `ROUTING_TABLE_TO_ENTITY` in `@optimiq-voice/routing` is the authority on what changes a
	 * compiled artifact, and it lists none of the device tables. Routing decides where a call GOES;
	 * a device is how an extension reaches a handset. Marking them `true` would evict the compile
	 * view on the tables administrators touch most often, for a change that cannot affect it.
	 */
	devices: {
		key: "devices",
		affectsRouting: false,
		path: "/devices",
		label: "device",
		labelPlural: "Devices",
		permissions: { read: "devices.read", write: "devices.write", delete: "devices.delete" },
		displayName: (row: DeviceRow) =>
			row.label
				? `${row.label} · ${formatMacAddress(row.macAddress)}`
				: formatMacAddress(row.macAddress),
	} satisfies PbxResourceDescriptor<DeviceRow>,

	deviceProfiles: {
		key: "device-profiles",
		affectsRouting: false,
		path: "/device-profiles",
		label: "device profile",
		labelPlural: "Device profiles",
		/**
		 * The same `devices.*` grants, deliberately.
		 *
		 * Editing a profile edits the configuration of every device that uses it — a strictly WIDER
		 * change than editing one device — so a weaker permission would be an escalation, and a
		 * separate one would have to be held by every role that holds `devices.write` anyway. The
		 * registry is at its stated ceiling and this earned no entry.
		 */
		permissions: { read: "devices.read", write: "devices.write", delete: "devices.delete" },
		displayName: (row: DeviceProfileRow) => row.name,
	} satisfies PbxResourceDescriptor<DeviceProfileRow>,
} as const;

export const PROVISIONING_CHILDREN = {
	deviceLines: {
		key: "lines",
		segment: "lines",
		label: "line",
		parentPath: "/devices",
		displayName: (row: DeviceLineRow) => row.label ?? `Line ${row.lineNumber}`,
		affectsRouting: false,
	} satisfies PbxChildDescriptor<DeviceLineRow>,

	deviceKeys: {
		key: "keys",
		segment: "keys",
		label: "key",
		parentPath: "/devices",
		displayName: (row: DeviceKeyRow) => row.label ?? `Key ${row.keyIndex}`,
		affectsRouting: false,
	} satisfies PbxChildDescriptor<DeviceKeyRow>,

	profileKeys: {
		key: "keys",
		segment: "keys",
		label: "key",
		parentPath: "/device-profiles",
		displayName: (row: DeviceProfileKeyRow) => row.label ?? `Key ${row.keyIndex}`,
		affectsRouting: false,
	} satisfies PbxChildDescriptor<DeviceProfileKeyRow>,
} as const;

/**
 * Which vendors this deployment can provision, and whether it can provision anything at all.
 *
 * Fetched rather than mirrored — see `contracts.ts`. Cached hard: it changes only when the API's
 * environment does, which is a deployment, not a user action.
 */
export async function fetchProvisioningCatalog(): Promise<ProvisioningCatalog> {
	const { data } = await apiFetch<ItemEnvelope<ProvisioningCatalog>>("/provisioning/catalog");
	return data;
}

/**
 * Creates a device and returns the provisioning token, once.
 *
 * A dedicated function rather than `createPbx(PROVISIONING_RESOURCES.devices, …)` because the
 * response carries a third top-level key the generic `MutationEnvelope` does not have — and the
 * value of that key is a credential the caller MUST notice, which a widened generic type would
 * quietly make optional everywhere.
 */
export async function createDevice(
	values: Record<string, unknown>,
): Promise<ProvisionedDeviceEnvelope> {
	return await apiFetch<ProvisionedDeviceEnvelope>("/devices", {
		method: "POST",
		body: JSON.stringify(values),
	});
}

/** Rotates a device's provisioning token. The previous URL stops working immediately. */
export async function regenerateProvisioningToken(
	deviceId: string,
	body: { readonly expiresInDays?: number } = {},
): Promise<ProvisionedDeviceEnvelope> {
	return await apiFetch<ProvisionedDeviceEnvelope>(`/devices/${deviceId}/provisioning-token`, {
		method: "POST",
		body: JSON.stringify(body),
	});
}
