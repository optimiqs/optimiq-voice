import { defineRelations, sql } from "drizzle-orm";
import {
	foreignKey,
	index,
	jsonb,
	pgEnum,
	pgPolicy,
	pgRole,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	varchar,
} from "drizzle-orm/pg-core";
import { API_TENANT_ROLE_NAME, API_TENANT_SCOPE_SQL } from "./tenant";

/**
 * Identity-removal **Step 5 item 2** — the tenant role and the per-table isolation policies for
 * this database, mirroring what `packages/pbx-db` already does for `optimiq_pbx`.
 *
 * The role is NOINHERIT, so `set local role api_tenant_tls` drops every privilege the connecting
 * principal holds; the grants migration is therefore the complete list of what a tenant
 * transaction can reach, and these policies narrow each grant to one organization.
 *
 * The policy NAME is load-bearing: `createPostgresTenantRlsIntrospector` in `@optimiq-voice/db`
 * asserts `<table>_tenant_isolation` exists as a PERMISSIVE `FOR ALL` policy granted to the role
 * whose USING and WITH CHECK both mention the setting. `db:preflight:tenant-rls` and the boot
 * preflight both fail if any of that drifts.
 */
const apiTenantRole = pgRole(API_TENANT_ROLE_NAME, {
	createDb: false,
	createRole: false,
	inherit: false,
});

const apiTenantScope = sql.raw(API_TENANT_SCOPE_SQL);

function tenantIsolationPolicy(tableName: string) {
	return pgPolicy(`${tableName}_tenant_isolation`, {
		as: "permissive",
		for: "all",
		to: apiTenantRole,
		using: apiTenantScope,
		withCheck: apiTenantScope,
	});
}

const applicationType = pgEnum("application_types", ["EXTERNAL", "AUTOPILOT"]);
const productType = pgEnum("product_types", ["TTS", "STT", "LLM"]);
const productVendor = pgEnum("product_vendors", [
	"GOOGLE",
	"MICROSOFT",
	"AMAZON",
	"DEEPGRAM",
	"IBM",
	"RASA",
	"OPENAI",
	"GROQ",
	"ANTHROPIC",
	"ELEVEN_LABS",
	"GENERIC",
]);

const applications = pgTable(
	"applications",
	{
		ref: text("ref").primaryKey(),
		accessKeyId: text("access_key_id").notNull(),
		organizationId: uuid("organization_id").notNull(),
		name: varchar("name", { length: 255 }).notNull(),
		type: applicationType("type").notNull(),
		endpoint: varchar("endpoint", { length: 255 }).notNull(),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: false })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: false })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("applications_access_key_id_idx").using("hash", table.accessKeyId),
		index("applications_organization_id_idx").on(table.organizationId),
		tenantIsolationPolicy("applications"),
	],
);

const products = pgTable("products", {
	ref: text("ref").primaryKey(),
	name: text("name").notNull(),
	vendor: productVendor("vendor").notNull(),
	type: productType("type").notNull(),
});

const textToSpeechServices = pgTable(
	"tts_services",
	{
		ref: text("ref").primaryKey(),
		config: jsonb("config").notNull(),
		credentials: text("credentials_hash"),
		organizationId: uuid("organization_id").notNull(),
		applicationRef: text("application_ref").notNull(),
		productRef: text("product_ref").notNull(),
	},
	(table) => [
		foreignKey({
			name: "tts_services_application_ref_fkey",
			columns: [table.applicationRef],
			foreignColumns: [applications.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "tts_services_product_ref_fkey",
			columns: [table.productRef],
			foreignColumns: [products.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		uniqueIndex("tts_services_application_ref_key").on(table.applicationRef),
		index("tts_services_application_ref_idx").using("hash", table.applicationRef),
		index("tts_services_product_ref_idx").using("hash", table.productRef),
		index("tts_services_organization_id_idx").on(table.organizationId),
		tenantIsolationPolicy("tts_services"),
	],
);

const speechToTextServices = pgTable(
	"stt_services",
	{
		ref: text("ref").primaryKey(),
		config: jsonb("config").notNull(),
		credentials: text("credentials_hash"),
		organizationId: uuid("organization_id").notNull(),
		applicationRef: text("application_ref").notNull(),
		productRef: text("product_ref").notNull(),
	},
	(table) => [
		foreignKey({
			name: "stt_services_application_ref_fkey",
			columns: [table.applicationRef],
			foreignColumns: [applications.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "stt_services_product_ref_fkey",
			columns: [table.productRef],
			foreignColumns: [products.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		uniqueIndex("stt_services_application_ref_key").on(table.applicationRef),
		index("stt_services_application_ref_idx").using("hash", table.applicationRef),
		index("stt_services_product_ref_idx").using("hash", table.productRef),
		index("stt_services_organization_id_idx").on(table.organizationId),
		tenantIsolationPolicy("stt_services"),
	],
);

const intelligenceServices = pgTable(
	"intelligence_services",
	{
		ref: text("ref").primaryKey(),
		config: jsonb("config").notNull(),
		credentials: text("credentials_hash"),
		organizationId: uuid("organization_id").notNull(),
		applicationRef: text("application_ref").notNull(),
		productRef: text("product_ref").notNull(),
	},
	(table) => [
		foreignKey({
			name: "intelligence_services_application_ref_fkey",
			columns: [table.applicationRef],
			foreignColumns: [applications.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "intelligence_services_product_ref_fkey",
			columns: [table.productRef],
			foreignColumns: [products.ref],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		uniqueIndex("intelligence_services_application_ref_key").on(table.applicationRef),
		index("intelligence_services_application_ref_idx").using("hash", table.applicationRef),
		index("intelligence_services_product_ref_idx").using("hash", table.productRef),
		index("intelligence_services_organization_id_idx").on(table.organizationId),
		tenantIsolationPolicy("intelligence_services"),
	],
);

const secrets = pgTable(
	"secrets",
	{
		ref: text("ref").primaryKey(),
		accessKeyId: text("access_key_id").notNull(),
		organizationId: uuid("organization_id").notNull(),
		name: text("name").notNull(),
		secret: text("secret_hash").notNull(),
		createdAt: timestamp("created_at", { precision: 3, withTimezone: false })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: false })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		index("secrets_access_key_id_idx").using("hash", table.accessKeyId),
		index("secrets_name_idx").using("hash", table.name),
		index("secrets_organization_id_idx").on(table.organizationId),
		tenantIsolationPolicy("secrets"),
	],
);

const tables = {
	applications,
	intelligenceServices,
	products,
	secrets,
	speechToTextServices,
	textToSpeechServices,
};

/**
 * drizzle 1.0 replaced the per-table `relations(table, ({ one, many }) => …)` helpers with a
 * single `defineRelations(schema, (r) => …)` graph, and `drizzle()` now takes that graph as
 * `relations` rather than the table map as `schema`. Both sides of every edge are declared here
 * (drizzle 1.0 no longer infers the inverse from a foreign key), which is why the one-to-one
 * service relations now spell out `from`/`to` in both directions.
 */
const relations = defineRelations(tables, (r) => ({
	applications: {
		textToSpeech: r.one.textToSpeechServices({
			from: r.applications.ref,
			to: r.textToSpeechServices.applicationRef,
		}),
		speechToText: r.one.speechToTextServices({
			from: r.applications.ref,
			to: r.speechToTextServices.applicationRef,
		}),
		intelligence: r.one.intelligenceServices({
			from: r.applications.ref,
			to: r.intelligenceServices.applicationRef,
		}),
	},
	textToSpeechServices: {
		application: r.one.applications({
			from: r.textToSpeechServices.applicationRef,
			to: r.applications.ref,
		}),
		product: r.one.products({
			from: r.textToSpeechServices.productRef,
			to: r.products.ref,
		}),
	},
	speechToTextServices: {
		application: r.one.applications({
			from: r.speechToTextServices.applicationRef,
			to: r.applications.ref,
		}),
		product: r.one.products({
			from: r.speechToTextServices.productRef,
			to: r.products.ref,
		}),
	},
	intelligenceServices: {
		application: r.one.applications({
			from: r.intelligenceServices.applicationRef,
			to: r.applications.ref,
		}),
		product: r.one.products({
			from: r.intelligenceServices.productRef,
			to: r.products.ref,
		}),
	},
	products: {
		textToSpeech: r.many.textToSpeechServices(),
		speechToText: r.many.speechToTextServices(),
		intelligence: r.many.intelligenceServices(),
	},
}));

export {
	API_TENANT_ROLE_NAME,
	API_TENANT_SCOPE_SQL,
	apiTenantRole,
	applicationType,
	applications,
	intelligenceServices,
	products,
	productType,
	productVendor,
	relations,
	secrets,
	speechToTextServices,
	tables,
	textToSpeechServices,
};
