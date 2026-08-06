/**
 * The provisioning contract, mirrored — never imported.
 *
 * Same rule and same reason as `lib/pbx/contracts.ts`: `apps/api/src/provisioning/**` is a Nest
 * application, and importing its DTOs would drag `zod/v4`, `@nestjs/common` and
 * `@optimiq-voice/pbx-db` — and therefore Drizzle and a Postgres driver — into the browser bundle.
 *
 * The one thing that is NOT mirrored is the vendor catalogue. It is fetched from
 * `GET /api/v1/provisioning/catalog` because it describes the DEPLOYMENT rather than the schema: a
 * hard-coded list would offer a vendor picker whose entries the API might have no template for, and
 * it could not tell an administrator which environment variable an operator still has to set.
 */

import type { EntityRow, SipTransport } from "../pbx/contracts";

/** The v1 catalogue. Mirrored because the FORM needs it before the catalogue request resolves. */
export const DEVICE_VENDORS = [
	"yealink",
	"poly",
	"grandstream",
	"fanvil",
	"snom",
	"softphone",
	"generic",
] as const;

export type DeviceVendor = (typeof DEVICE_VENDORS)[number];

export const DEVICE_KEY_CATEGORIES = [
	"line",
	"memory",
	"expansion",
	"soft",
	"programmable",
] as const;

export type DeviceKeyCategory = (typeof DEVICE_KEY_CATEGORIES)[number];

export const DEVICE_KEY_TYPES = [
	"none",
	"line",
	"blf",
	"speed-dial",
	"park",
	"intercom",
	"dtmf",
	"transfer",
	"url",
] as const;

export type DeviceKeyType = (typeof DEVICE_KEY_TYPES)[number];

/** Free-form vendor settings. Scalars only — a nested value has no meaning in a `key = value` file. */
export type ProvisioningSettings = Readonly<Record<string, string | number | boolean>>;

export interface DeviceRow extends EntityRow {
	/** Twelve lower-case hex characters. Format it with `formatMacAddress` before showing it. */
	readonly macAddress: string;
	readonly vendor: DeviceVendor;
	readonly model: string | null;
	readonly label: string | null;
	readonly deviceProfileId: string | null;
	/**
	 * The NON-SECRET half of the provisioning token.
	 *
	 * Present in every read, and deliberately useless on its own: the secret half is stored only as
	 * a SHA-256 and exists in plaintext for exactly one response — the create or the rotate that
	 * minted it. A UI that showed this as "the provisioning URL" would be showing a URL that 404s.
	 */
	readonly provisioningToken: string;
	readonly provisioningTokenExpiresAt: string | null;
	readonly lastProvisionedAt: string | null;
	readonly lastProvisionedIp: string | null;
	readonly settings: ProvisioningSettings | null;
	readonly enabled: boolean;
}

export interface DeviceProfileRow extends EntityRow {
	readonly name: string;
	readonly description: string | null;
	readonly vendor: DeviceVendor;
	readonly model: string | null;
	readonly settings: ProvisioningSettings | null;
	readonly enabled: boolean;
}

export interface DeviceLineRow extends EntityRow {
	readonly deviceId: string;
	readonly lineNumber: number;
	readonly extensionId: string | null;
	readonly authUser: string | null;
	readonly sipSecretRef: string | null;
	readonly serverAddress: string | null;
	readonly serverPort: number;
	readonly transport: SipTransport;
	readonly registerExpiresSeconds: number;
	readonly sharedLine: boolean;
	readonly label: string | null;
	readonly enabled: boolean;
}

export interface DeviceKeyRow extends EntityRow {
	readonly deviceId: string;
	readonly category: DeviceKeyCategory;
	readonly keyIndex: number;
	readonly keyType: DeviceKeyType;
	readonly value: string | null;
	readonly label: string | null;
	readonly lineNumber: number;
}

export interface DeviceProfileKeyRow extends EntityRow {
	readonly deviceProfileId: string;
	readonly category: DeviceKeyCategory;
	readonly keyIndex: number;
	readonly keyType: DeviceKeyType;
	readonly value: string | null;
	readonly label: string | null;
	readonly lineNumber: number;
}

/**
 * What a create or a rotate returns, once.
 *
 * `token` is the complete `<reference>.<secret>` string and exists nowhere else — not in the
 * database, not in a later read, not in a log. The UI shows it under a "shown once" banner and the
 * only recovery from losing it is another rotation.
 */
export interface ProvisioningTokenResult {
	readonly token: string;
	readonly configUrl: string | null;
	readonly expiresAt: string | null;
}

export interface ProvisionedDeviceEnvelope {
	readonly data: DeviceRow;
	readonly warnings: readonly unknown[];
	readonly provisioning: ProvisioningTokenResult;
}

export interface CatalogVendorEntry {
	readonly vendor: DeviceVendor;
	readonly templateId: string;
	readonly name: string;
	readonly models: readonly string[];
	readonly contentType: string;
	readonly sources: readonly string[];
	/** What has NOT been validated. Rendered beside the vendor picker rather than buried. */
	readonly caveats: readonly string[];
	readonly provisionable: boolean;
}

export interface ProvisioningCatalog {
	readonly vendors: readonly CatalogVendorEntry[];
	readonly configured: boolean;
	readonly missing: readonly string[];
	readonly baseUrl: string | null;
	readonly sipServer: string | null;
	readonly sipPort: number;
	readonly sipTransport: string;
	readonly rateLimitPerMinute: number;
	readonly requireIpAllowlist: boolean;
}

// ---------------------------------------------------------------------------------------------
// MAC display
// ---------------------------------------------------------------------------------------------

/**
 * `001565abcdef` -> `00:15:65:AB:CD:EF`.
 *
 * The server stores one spelling so its uniqueness index is over ADDRESSES rather than over
 * spellings; this is the one a human reads off the sticker on the bottom of a phone. The pair is
 * deliberate — formatting at the edge means the key stays a key and the display stays a preference.
 */
export function formatMacAddress(normalized: string): string {
	if (!/^[0-9a-f]{12}$/u.test(normalized)) {
		return normalized;
	}
	return (normalized.match(/.{2}/gu) ?? []).join(":").toUpperCase();
}

/** Mirrors the server's normalization so the form can show the stored value while it is typed. */
export function normalizeMacAddress(value: string): string | undefined {
	const stripped = value.replace(/[\s:.–—-]/gu, "").toLowerCase();
	return /^[0-9a-f]{12}$/u.test(stripped) ? stripped : undefined;
}

/** How a vendor's name reads in a picker. */
export const VENDOR_LABELS: Readonly<Record<DeviceVendor, string>> = {
	yealink: "Yealink",
	poly: "Poly / Polycom",
	grandstream: "Grandstream",
	fanvil: "Fanvil",
	snom: "Snom",
	softphone: "Softphone",
	generic: "Other / not listed",
};

export const KEY_TYPE_LABELS: Readonly<Record<DeviceKeyType, string>> = {
	none: "Nothing",
	line: "Line",
	blf: "Busy lamp field",
	"speed-dial": "Speed dial",
	park: "Call park",
	intercom: "Intercom",
	dtmf: "Send digits",
	transfer: "Transfer",
	url: "Open a URL",
};

export const KEY_CATEGORY_LABELS: Readonly<Record<DeviceKeyCategory, string>> = {
	line: "Line key",
	memory: "Memory key",
	expansion: "Expansion module",
	soft: "Soft key",
	programmable: "Programmable key",
};
