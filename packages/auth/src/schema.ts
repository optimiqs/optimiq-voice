/**
 * The better-auth Drizzle schema.
 *
 * The tables physically live in @optimiq-voice/db/schema/auth so the base database package owns
 * this database's single migration journal (Phase 1 adds the PBX tables to the same journal).
 * They are re-exported here so an application configures `drizzleAdapter({ schema: authSchema })`
 * from the auth package alone and never reaches into a database package's internals.
 */
export {
	account,
	apikey,
	authSchema,
	type AuthSchema,
	invitation,
	jwks,
	member,
	organization,
	session,
	twoFactor,
	user,
	verification,
} from "@optimiq-voice/db/schema/auth";
