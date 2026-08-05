/**
 * The better-auth 1.6.23 Drizzle schema.
 *
 * It lives in @optimiq-voice/db (not @optimiq-voice/auth) because the base database package
 * owns the single migration journal for this database; @optimiq-voice/auth re-exports these
 * tables so callers configuring `drizzleAdapter` never import a database package directly.
 *
 * The object keys below are better-auth model names and MUST NOT be renamed: the adapter
 * resolves tables as `schema[model]` and columns as `schema[model][field]`.
 */
export { account, session, user, verification } from "./identity-schema";
export { invitation, member, organization } from "./organization-schema";
export { apikey, jwks, twoFactor } from "./credential-schema";

import { apikey, jwks, twoFactor } from "./credential-schema";
import { account, session, user, verification } from "./identity-schema";
import { invitation, member, organization } from "./organization-schema";

/** Ready-made `drizzleAdapter({ schema })` argument covering every configured plugin. */
export const authSchema = {
	account,
	apikey,
	invitation,
	jwks,
	member,
	organization,
	session,
	twoFactor,
	user,
	verification,
} as const;

export type AuthSchema = typeof authSchema;
