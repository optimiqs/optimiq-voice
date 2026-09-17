import { z } from "zod/v4";

/**
 * The per-org OIDC provider write bodies. `clientSecret` is accepted on write and never returned on
 * read. `providerId` is the immutable slug a sign-in URL carries, so it is set once at create and
 * not editable.
 */

const providerId = z
	.string()
	.trim()
	.min(2)
	.max(60)
	.regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u, "expected a lower-kebab slug");

const emailDomain = z
	.string()
	.trim()
	.toLowerCase()
	.max(253)
	.regex(
		/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/u,
		"expected a domain",
	);

export const createSsoProviderDto = z.strictObject({
	providerId,
	issuer: z.url().max(512),
	clientId: z.string().trim().min(1).max(256),
	clientSecret: z.string().trim().min(1).max(512),
	discoveryUrl: z.url().max(512).nullable().optional(),
	scopes: z.string().trim().max(512).nullable().optional(),
	// Required on create, and not nullable: `packages/auth` refuses to register a provider without
	// one, because a provider that may assert any address is a cross-tenant takeover. Accepting the
	// row here and failing at the next boot would take the whole auth slice's SSO feed with it.
	emailDomain,
	enabled: z.boolean().optional(),
});
export type CreateSsoProviderInput = z.output<typeof createSsoProviderDto>;

export const updateSsoProviderDto = z.strictObject({
	issuer: z.url().max(512).optional(),
	clientId: z.string().trim().min(1).max(256).optional(),
	clientSecret: z.string().trim().min(1).max(512).optional(),
	discoveryUrl: z.url().max(512).nullable().optional(),
	scopes: z.string().trim().max(512).nullable().optional(),
	// Optional to omit, but never settable to null — see `createSsoProviderDto`.
	emailDomain: emailDomain.optional(),
	enabled: z.boolean().optional(),
});
export type UpdateSsoProviderInput = z.output<typeof updateSsoProviderDto>;
