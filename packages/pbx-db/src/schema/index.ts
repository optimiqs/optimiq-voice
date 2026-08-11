/**
 * The telephony schema surface: tables, the const tuples their status columns are typed against,
 * the JSON shapes stored in `jsonb` columns, and the relational configuration.
 */
export * from "./carrier-schema";
export * from "./columns";
export * from "./conferences-schema";
export * from "./devices-schema";
export * from "./emergency-schema";
export * from "./extensions-schema";
export * from "./features-schema";
export * from "./ivr-schema";
export * from "./media-schema";
export * from "./numbers-schema";
export * from "./outbox-schema";
export * from "./queues-schema";
export * from "./relations";
export * from "./ring-groups-schema";
export * from "./routing-schema";
export * from "./security-schema";
export * from "./settings-schema";
export * from "./tables";
export * from "./time-conditions-schema";
export * from "./trunks-schema";
export * from "./voicemail-schema";
export * from "./webhooks-schema";
