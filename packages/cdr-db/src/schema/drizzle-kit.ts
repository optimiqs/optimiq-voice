/**
 * Flat schema surface consumed by drizzle-kit. `drizzle.config.ts` points at this file only,
 * so every table that belongs to the CDR journal must be re-exported here.
 *
 * The CDR context owns its own database and its own journal; nothing from @optimiq-voice/db's
 * auth journal or from pbx-db may be re-exported here. Cross-context references are by id only.
 */
export * from "./call-leg-schema";
export * from "./call-event-schema";
export * from "./recording-schema";
export * from "./quarantine-schema";

import { cdrTenantContext } from "../cdr-context";

/** The `cdr_tenant_tls` role, exported as a drizzle entity so the kit can resolve the policies. */
export const cdrTenantRole = cdrTenantContext.role;
