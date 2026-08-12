import { boolean, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { organization } from "../auth/organization-schema";
import { auditTimestampColumns, utcTimestamp, uuidEntityId, uuidV7PrimaryKey } from "../primitives";

/**
 * The platform (control-plane) metadata about an organization — the tables W14 owns.
 *
 * ## Why these are untenanted, and live beside the better-auth org graph
 *
 * Every OTHER tenant table in this platform carries row-level security keyed on a single active
 * `organization_id` (`packages/pbx-db`'s `tenantIsolationPolicy`). That is exactly the wrong tool
 * for these two, and the reason is structural, not convenience:
 *
 * 1. **The reseller relationship is inherently cross-tenant.** A reseller admin lists, suspends and
 *    aggregates usage across MANY child organizations, whose rows carry a different
 *    `organization_id` than the reseller's own session. A `FOR ALL` policy keyed on the active org
 *    can never return another tenant's row, so RLS cannot express "the orgs I am the parent of".
 * 2. **A child must not be able to edit its own parentage or lift its own suspension.** A tenant
 *    `FOR ALL` policy grants the row's own org UPDATE on it — precisely the write a suspended child
 *    must not have. So even a self-owned row is the wrong ownership model here.
 * 3. **Branding is resolved BEFORE authentication.** The web shell themes its login page by the
 *    request host, with no session and therefore no active-org setting for a policy to read.
 *
 * So both tables sit in the base database next to `organization` / `member` — the org graph
 * better-auth already keeps untenanted — and their enforcement is the API permission guard plus a
 * per-row `assertMayAct(parent == session org)` check in the reseller service, exactly the way the
 * whole membership graph is guarded in application code rather than by Postgres RLS.
 */

/**
 * A row per organization describing its place in the reseller hierarchy.
 *
 * `is_reseller` is the platform capability flag: an org may administer children only when this is
 * true AND the acting member holds `reseller.write`. Both are required — the permission alone is
 * inert on an ordinary tenant, which is what keeps `reseller.*` safe to grant to the `admin`
 * template. `parent_organization_id` is the reseller that administers THIS org; `suspended_at`
 * being set means the reseller has suspended this child.
 */
export const organizationHierarchy = pgTable(
	"organization_hierarchy",
	{
		id: uuidV7PrimaryKey(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		parentOrganizationId: uuidEntityId("parent_organization_id").references(() => organization.id, {
			onDelete: "set null",
		}),
		isReseller: boolean("is_reseller").notNull().default(false),
		suspendedAt: utcTimestamp("suspended_at"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("organization_hierarchy_organization_key").on(table.organizationId),
		index("organization_hierarchy_parent_idx").on(table.parentOrganizationId),
	],
);

/**
 * Per-organization white-label branding, and the custom host that resolves to it.
 *
 * Every column is nullable: an org with no row (or an unset field) inherits from its reseller
 * default and then from the code default, which is what makes this a cascade level rather than a
 * record. `custom_domain` carries a unique index because the pre-auth `GET /api/v1/branding` reads
 * it to answer "which org owns this host?" — the one lookup that is genuinely cross-tenant and the
 * reason branding cannot be an ordinary tenant setting row.
 */
export const organizationBranding = pgTable(
	"organization_branding",
	{
		id: uuidV7PrimaryKey(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		productName: text("product_name"),
		logoObjectKey: text("logo_object_key"),
		primaryColor: text("primary_color"),
		accentColor: text("accent_color"),
		supportEmail: text("support_email"),
		customDomain: text("custom_domain"),
		defaultLanguage: text("default_language"),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("organization_branding_organization_key").on(table.organizationId),
		uniqueIndex("organization_branding_custom_domain_key").on(table.customDomain),
	],
);

/**
 * Per-organization (and per-language) overrides of the fixed mail templates.
 *
 * The mail path composes from typed template functions in `apps/api/src/mail/mail-templates.ts`
 * (the code default). This table is the two levels above it in the same cascade branding uses:
 * an org override, and — because a child with no row inherits its reseller's — a reseller default.
 * A row overrides only the parts it sets: a null `subject` keeps the code subject, a null
 * `body_intro` keeps the code body. `template_key` is validated against a closed set in the app
 * (there is no row to render for a key nothing sends), which is why it is plain text here.
 *
 * It is untenanted for the same reason branding is: the reseller-default level is another tenant's
 * row, and the mail path resolves it server-side with no active-org setting for an RLS policy to
 * read.
 */
export const organizationMailTemplate = pgTable(
	"organization_mail_template",
	{
		id: uuidV7PrimaryKey(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		templateKey: text("template_key").notNull(),
		language: text("language").notNull().default("en"),
		subject: text("subject"),
		bodyIntro: text("body_intro"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("organization_mail_template_key").on(
			table.organizationId,
			table.templateKey,
			table.language,
		),
		index("organization_mail_template_org_idx").on(table.organizationId),
	],
);

/**
 * Per-organization SSO identity providers (OIDC today).
 *
 * An org admin configures their IdP here and their members sign in through it. The provider config
 * is control-plane data sitting beside the org graph, exactly where better-auth's own (uninstalled)
 * `sso` plugin would keep it. `provider_id` is globally unique because it is the slug a sign-in URL
 * carries; `email_domain` lets a login form route a user to their org's IdP by email domain.
 * `client_secret` is stored here and is stripped from every API read (a secret column).
 *
 * See the W14 report's SSO section for the live-wiring seam: the installed better-auth ships
 * `genericOAuth` (a static, boot-time provider list) but NOT the per-org DB-backed `sso` plugin,
 * and no SAML support at all.
 */
export const organizationSsoProvider = pgTable(
	"organization_sso_provider",
	{
		id: uuidV7PrimaryKey(),
		organizationId: uuidEntityId("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		providerId: text("provider_id").notNull(),
		protocol: text("protocol").$type<"oidc">().notNull().default("oidc"),
		issuer: text("issuer").notNull(),
		clientId: text("client_id").notNull(),
		clientSecret: text("client_secret").notNull(),
		discoveryUrl: text("discovery_url"),
		scopes: text("scopes"),
		emailDomain: text("email_domain"),
		enabled: boolean("enabled").notNull().default(true),
		...auditTimestampColumns(),
	},
	(table) => [
		uniqueIndex("organization_sso_provider_provider_key").on(table.providerId),
		index("organization_sso_provider_org_idx").on(table.organizationId),
		index("organization_sso_provider_email_domain_idx").on(table.emailDomain),
	],
);
