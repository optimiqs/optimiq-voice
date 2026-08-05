/**
 * Identity-removal migration artifacts. See `./legacy-identity-schema.ts` — these tables are
 * transitional and are dropped with `fnidentity` in identity-removal Step 9.
 */
export { legacyUserAccount, legacyWorkspaceOrganization } from "./legacy-identity-schema";
