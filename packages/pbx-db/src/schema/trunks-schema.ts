import { boolean, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import {
	auditTimestampColumns,
	tenantOrganizationIdColumn,
	utcTimestamp,
	uuidV7PrimaryKey,
} from "@optimiq-voice/db";
import { tenantIsolationPolicy } from "../tenant";
import { carrierCheck, carrierColumns } from "./carrier-schema";
import type { SipTransport } from "./devices-schema";

/**
 * Carrier trunks (FusionPBX "gateways"). Two authentication shapes cover every carrier we care
 * about: `register` (we send REGISTER with a digest credential) and `ip-auth` (the carrier
 * authenticates our source IP and we only need the proxy address).
 *
 * The `status*` columns are the persisted view of the SIP-edge OPTIONS pinger. They are written
 * by the engine, are eventually consistent by design, and are NOT the live truth — live trunk
 * state lives in NATS KV. They exist so the admin UI can render a trunk list without a KV fan-out
 * and so an alerting job has something to diff.
 */

export const TRUNK_KINDS = ["register", "ip-auth"] as const;
export type TrunkKind = (typeof TRUNK_KINDS)[number];

export const TRUNK_STATUSES = ["unknown", "up", "down", "degraded", "disabled"] as const;
export type TrunkStatus = (typeof TRUNK_STATUSES)[number];

export const trunk = pgTable.withRLS(
	"trunk",
	{
		id: uuidV7PrimaryKey(),
		organizationId: tenantOrganizationIdColumn(),
		name: text("name").notNull(),
		kind: text("kind").$type<TrunkKind>().notNull().default("register"),
		/** SIP domain sent in From/To; usually the carrier's realm. */
		sipDomain: text("sip_domain").notNull(),
		/** Where INVITEs go. */
		sipProxy: text("sip_proxy").notNull(),
		/** Optional pre-loaded route, used when the carrier fronts the proxy with an SBC. */
		outboundProxy: text("outbound_proxy"),
		authUser: text("auth_user"),
		/** Handle into the secret manager; the password never lands in this database. */
		sipSecretRef: text("sip_secret_ref"),
		registerExpiresSeconds: integer("register_expires_seconds").notNull().default(300),
		transport: text("transport").$type<SipTransport>().notNull().default("udp"),
		/** Comma-separated preference list, e.g. `PCMU,PCMA,OPUS`. */
		codecPrefs: text("codec_prefs"),
		/** Concurrency cap enforced by the engine before it offers a call to this trunk. */
		maxChannels: integer("max_channels"),
		callerIdNumberOverride: text("caller_id_number_override"),
		status: text("status").$type<TrunkStatus>().notNull().default("unknown"),
		statusChangedAt: utcTimestamp("status_changed_at"),
		statusReason: text("status_reason"),
		statusLatencyMs: integer("status_latency_ms"),
		enabled: boolean("enabled").notNull().default(true),
		/**
		 * Set when the platform provisioned this trunk at a managed carrier. `carrier_ref` is the
		 * connection's id over there — the handle the delete path needs to tear it down, and the one
		 * a re-provision uses to update rather than create a second connection.
		 */
		...carrierColumns(),
		/**
		 * The carrier-side outbound voice profile bound to this connection. Separate from
		 * `carrier_ref` because it is a distinct resource with its own lifecycle: profiles carry the
		 * spend limits and destination allow-lists, and several connections may share one, so
		 * deleting a connection must not assume it may delete the profile too.
		 */
		carrierProfileRef: text("carrier_profile_ref"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("trunk_organization_name_key").on(table.organizationId, table.name),
		index("trunk_organization_enabled_idx").on(table.organizationId, table.enabled),
		index("trunk_organization_status_idx").on(table.organizationId, table.status),
		index("trunk_organization_carrier_idx").on(
			table.organizationId,
			table.carrierProvider,
			table.carrierRef,
		),
		carrierCheck("trunk"),
		tenantIsolationPolicy("trunk"),
	],
);
