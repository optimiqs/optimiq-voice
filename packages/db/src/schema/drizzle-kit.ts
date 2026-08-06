/**
 * Flat schema surface consumed by drizzle-kit. `drizzle.config.ts` points at this file only,
 * so every table that belongs to this database's single journal must be re-exported here.
 *
 * Phase 0 owns the better-auth tables. The PBX bounded contexts (pbx-db, cdr-db) get their
 * own packages and journals in Phase 1 and must NOT be added here.
 */
export * from "./auth/identity-schema";
export * from "./auth/organization-schema";
export * from "./auth/credential-schema";
