import { relations } from "drizzle-orm";
import {
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar
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
  "GENERIC"
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
      .notNull()
  },
  (table) => [
    index("applications_access_key_id_idx").using("hash", table.accessKeyId)
  ]
);

const products = pgTable("products", {
  ref: text("ref").primaryKey(),
  name: text("name").notNull(),
  vendor: productVendor("vendor").notNull(),
  type: productType("type").notNull()
});

const textToSpeechServices = pgTable(
  "tts_services",
  {
    ref: text("ref").primaryKey(),
    config: jsonb("config").notNull(),
    credentials: text("credentials_hash"),
    applicationRef: text("application_ref").notNull(),
    productRef: text("product_ref").notNull()
  },
  (table) => [
    foreignKey({
      name: "tts_services_application_ref_fkey",
      columns: [table.applicationRef],
      foreignColumns: [applications.ref]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      name: "tts_services_product_ref_fkey",
      columns: [table.productRef],
      foreignColumns: [products.ref]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    uniqueIndex("tts_services_application_ref_key").on(table.applicationRef),
    index("tts_services_application_ref_idx").using(
      "hash",
      table.applicationRef
    ),
    index("tts_services_product_ref_idx").using("hash", table.productRef)
  ]
);

const speechToTextServices = pgTable(
  "stt_services",
  {
    ref: text("ref").primaryKey(),
    config: jsonb("config").notNull(),
    credentials: text("credentials_hash"),
    applicationRef: text("application_ref").notNull(),
    productRef: text("product_ref").notNull()
  },
  (table) => [
    foreignKey({
      name: "stt_services_application_ref_fkey",
      columns: [table.applicationRef],
      foreignColumns: [applications.ref]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      name: "stt_services_product_ref_fkey",
      columns: [table.productRef],
      foreignColumns: [products.ref]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    uniqueIndex("stt_services_application_ref_key").on(table.applicationRef),
    index("stt_services_application_ref_idx").using(
      "hash",
      table.applicationRef
    ),
    index("stt_services_product_ref_idx").using("hash", table.productRef)
  ]
);

const intelligenceServices = pgTable(
  "intelligence_services",
  {
    ref: text("ref").primaryKey(),
    config: jsonb("config").notNull(),
    credentials: text("credentials_hash"),
    applicationRef: text("application_ref").notNull(),
    productRef: text("product_ref").notNull()
  },
  (table) => [
    foreignKey({
      name: "intelligence_services_application_ref_fkey",
      columns: [table.applicationRef],
      foreignColumns: [applications.ref]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    foreignKey({
      name: "intelligence_services_product_ref_fkey",
      columns: [table.productRef],
      foreignColumns: [products.ref]
    })
      .onDelete("cascade")
      .onUpdate("cascade"),
    uniqueIndex("intelligence_services_application_ref_key").on(
      table.applicationRef
    ),
    index("intelligence_services_application_ref_idx").using(
      "hash",
      table.applicationRef
    ),
    index("intelligence_services_product_ref_idx").using(
      "hash",
      table.productRef
    )
  ]
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
      .notNull()
  },
  (table) => [
    index("secrets_access_key_id_idx").using("hash", table.accessKeyId),
    index("secrets_name_idx").using("hash", table.name)
  ]
);

const applicationsRelations = relations(applications, ({ one }) => ({
  textToSpeech: one(textToSpeechServices),
  speechToText: one(speechToTextServices),
  intelligence: one(intelligenceServices)
}));

const textToSpeechServicesRelations = relations(
  textToSpeechServices,
  ({ one }) => ({
    application: one(applications, {
      fields: [textToSpeechServices.applicationRef],
      references: [applications.ref]
    }),
    product: one(products, {
      fields: [textToSpeechServices.productRef],
      references: [products.ref]
    })
  })
);

const speechToTextServicesRelations = relations(
  speechToTextServices,
  ({ one }) => ({
    application: one(applications, {
      fields: [speechToTextServices.applicationRef],
      references: [applications.ref]
    }),
    product: one(products, {
      fields: [speechToTextServices.productRef],
      references: [products.ref]
    })
  })
);

const intelligenceServicesRelations = relations(
  intelligenceServices,
  ({ one }) => ({
    application: one(applications, {
      fields: [intelligenceServices.applicationRef],
      references: [applications.ref]
    }),
    product: one(products, {
      fields: [intelligenceServices.productRef],
      references: [products.ref]
    })
  })
);

const productsRelations = relations(products, ({ many }) => ({
  textToSpeech: many(textToSpeechServices),
  speechToText: many(speechToTextServices),
  intelligence: many(intelligenceServices)
}));

export {
  applicationType,
  applications,
  applicationsRelations,
  intelligenceServices,
  intelligenceServicesRelations,
  products,
  productsRelations,
  productType,
  productVendor,
  secrets,
  speechToTextServices,
  speechToTextServicesRelations,
  textToSpeechServices,
  textToSpeechServicesRelations
};
