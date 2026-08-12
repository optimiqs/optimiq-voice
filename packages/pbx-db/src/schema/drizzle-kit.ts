/**
 * Flat schema surface consumed by drizzle-kit. `drizzle.config.ts` points at this file only, so
 * every table, policy and role belonging to the telephony journal must be reachable from here.
 *
 * `pbxTenantRole` is re-exported because the kit manages roles for this database
 * (`entities.roles: true`) — the CREATE ROLE statement is generated, not hand-written. The GRANTs
 * it needs cannot be expressed in the schema and live in the hand-authored grants migration.
 */
export { pbxTenantRole } from "../tenant";
export * from "./aliases-schema";
export * from "./call-flows-schema";
export * from "./conferences-schema";
export * from "./devices-schema";
export * from "./directory-schema";
export * from "./emergency-schema";
export * from "./extensions-schema";
export * from "./fax-schema";
export * from "./features-schema";
export * from "./ivr-schema";
export * from "./limits-schema";
export * from "./media-schema";
export * from "./numbers-schema";
export * from "./outbox-schema";
export * from "./paging-schema";
export * from "./phrases-schema";
export * from "./pins-schema";
export * from "./queues-schema";
export * from "./ring-groups-schema";
export * from "./routing-schema";
export * from "./security-schema";
export * from "./settings-schema";
export * from "./speed-dials-schema";
export * from "./streams-schema";
export * from "./time-conditions-schema";
export * from "./translations-schema";
export * from "./trunks-schema";
export * from "./voicemail-schema";
export * from "./webhooks-schema";
