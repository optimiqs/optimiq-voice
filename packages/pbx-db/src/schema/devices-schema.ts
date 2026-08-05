import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidEntityId,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { extension } from "./extensions-schema";

/**
 * Devices and provisioning. FusionPBX's provisioning endpoint is unauthenticated and resolves a
 * device by MAC, user agent or source IP; ours resolves by a per-device bearer token carried in
 * the URL, so `provisioning_token` is unique across the whole database (a provisioning request
 * arrives with no organization context and must resolve the tenant from the token alone).
 */

/** v1 provisioning catalogue — roughly 80% of the installed base. */
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

export const SIP_TRANSPORTS = ["udp", "tcp", "tls"] as const;
export type SipTransport = (typeof SIP_TRANSPORTS)[number];

/** Physical grouping of a programmable key on the handset. */
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

/** Free-form vendor settings applied by the template renderer, lowest precedence first. */
export type ProvisioningSettings = Readonly<Record<string, string | number | boolean>>;

export const deviceProfile = pgTable.withRLS(
	"device_profile",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		description: text("description"),
		vendor: text("vendor").$type<DeviceVendor>().notNull().default("generic"),
		/** NULL means the profile applies to every model of `vendor`. */
		model: text("model"),
		settings: jsonb("settings").$type<ProvisioningSettings>(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("device_profile_organization_name_key").on(table.organizationId, table.name),
		index("device_profile_organization_vendor_idx").on(table.organizationId, table.vendor),
		tenantIsolationPolicy("device_profile"),
	],
);

export const deviceProfileKey = pgTable.withRLS(
	"device_profile_key",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		deviceProfileId: uuidEntityId("device_profile_id")
			.notNull()
			.references(() => deviceProfile.id, { onDelete: "cascade" }),
		category: text("category").$type<DeviceKeyCategory>().notNull().default("memory"),
		keyIndex: integer("key_index").notNull(),
		keyType: text("key_type").$type<DeviceKeyType>().notNull().default("none"),
		/** Dial string or monitored extension number, interpreted per `keyType`. */
		value: text("value"),
		label: text("label"),
		lineNumber: integer("line_number").notNull().default(1),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("device_profile_key_profile_category_index_key").on(
			table.organizationId,
			table.deviceProfileId,
			table.category,
			table.keyIndex,
		),
		tenantIsolationPolicy("device_profile_key"),
	],
);

export const device = pgTable.withRLS(
	"device",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		/** Lower-case, colon-free MAC. Unique per organization, not globally. */
		macAddress: text("mac_address").notNull(),
		vendor: text("vendor").$type<DeviceVendor>().notNull().default("generic"),
		model: text("model"),
		label: text("label"),
		deviceProfileId: uuidEntityId("device_profile_id").references(() => deviceProfile.id, {
			onDelete: "set null",
		}),
		/**
		 * Bearer token in the provisioning URL. Globally unique because the provisioning request
		 * has no tenant context; rotate it to revoke a stolen config URL.
		 */
		provisioningToken: text("provisioning_token").notNull(),
		provisioningTokenExpiresAt: utcTimestamp("provisioning_token_expires_at"),
		lastProvisionedAt: utcTimestamp("last_provisioned_at"),
		lastProvisionedIp: text("last_provisioned_ip"),
		settings: jsonb("settings").$type<ProvisioningSettings>(),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("device_organization_mac_address_key").on(table.organizationId, table.macAddress),
		uniqueIndex("device_provisioning_token_key").on(table.provisioningToken),
		index("device_organization_enabled_idx").on(table.organizationId, table.enabled),
		index("device_organization_profile_idx").on(table.organizationId, table.deviceProfileId),
		tenantIsolationPolicy("device"),
	],
);

export const deviceLine = pgTable.withRLS(
	"device_line",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		deviceId: uuidEntityId("device_id")
			.notNull()
			.references(() => device.id, { onDelete: "cascade" }),
		lineNumber: integer("line_number").notNull(),
		extensionId: uuidEntityId("extension_id").references(() => extension.id, {
			onDelete: "set null",
		}),
		/** Auth id rendered into the config; defaults to the extension number when NULL. */
		authUser: text("auth_user"),
		sipSecretRef: text("sip_secret_ref"),
		serverAddress: text("server_address"),
		serverPort: integer("server_port").notNull().default(5060),
		transport: text("transport").$type<SipTransport>().notNull().default("udp"),
		registerExpiresSeconds: integer("register_expires_seconds").notNull().default(120),
		sharedLine: boolean("shared_line").notNull().default(false),
		label: text("label"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("device_line_organization_device_line_key").on(
			table.organizationId,
			table.deviceId,
			table.lineNumber,
		),
		index("device_line_organization_extension_idx").on(table.organizationId, table.extensionId),
		tenantIsolationPolicy("device_line"),
	],
);

export const deviceKey = pgTable.withRLS(
	"device_key",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		deviceId: uuidEntityId("device_id")
			.notNull()
			.references(() => device.id, { onDelete: "cascade" }),
		category: text("category").$type<DeviceKeyCategory>().notNull().default("memory"),
		keyIndex: integer("key_index").notNull(),
		keyType: text("key_type").$type<DeviceKeyType>().notNull().default("none"),
		value: text("value"),
		label: text("label"),
		lineNumber: integer("line_number").notNull().default(1),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("device_key_organization_device_category_index_key").on(
			table.organizationId,
			table.deviceId,
			table.category,
			table.keyIndex,
		),
		tenantIsolationPolicy("device_key"),
	],
);
