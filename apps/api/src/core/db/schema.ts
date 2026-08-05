import { defineRelations } from "drizzle-orm";
import {
	foreignKey,
	index,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	varchar,
} from "drizzle-orm/pg-core";

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
	(table) => [index("applications_access_key_id_idx").using("hash", table.accessKeyId)],
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
	],
);

const speechToTextServices = pgTable(
	"stt_services",
	{
		ref: text("ref").primaryKey(),
		config: jsonb("config").notNull(),
		credentials: text("credentials_hash"),
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
	],
);

const intelligenceServices = pgTable(
	"intelligence_services",
	{
		ref: text("ref").primaryKey(),
		config: jsonb("config").notNull(),
		credentials: text("credentials_hash"),
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
	],
);

const secrets = pgTable(
	"secrets",
	{
		ref: text("ref").primaryKey(),
		accessKeyId: text("access_key_id").notNull(),
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
