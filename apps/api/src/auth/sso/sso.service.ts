import {
	ConflictException,
	Inject,
	Injectable,
	NotFoundException,
	UnprocessableEntityException,
} from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	createSsoProvider,
	deleteSsoProvider,
	listSsoProviders,
	readSsoProvider,
	type SsoProviderRow,
	updateSsoProvider,
} from "@optimiq-voice/db";
import { AUTH_PLATFORM } from "../auth.tokens";
import type { AuthPlatform } from "../auth.platform";
import type { CreateSsoProviderInput, UpdateSsoProviderInput } from "./sso.dto";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * A Postgres unique-constraint violation, whatever driver wrapped it.
 *
 * `23505` is the SQLSTATE; `pg` puts it on `code`, and drizzle rethrows with the driver error as
 * `cause`, so both are checked rather than assuming a shape.
 */
function isUniqueViolation(error: unknown): boolean {
	for (let current = error, depth = 0; current !== undefined && depth < 4; depth += 1) {
		if (typeof current === "object" && current !== null) {
			if ((current as { code?: unknown }).code === "23505") {
				return true;
			}
			current = (current as { cause?: unknown }).cause;
			continue;
		}
		return false;
	}
	return false;
}

/**
 * A provider as returned to a client: everything except the client secret, which never leaves the
 * process. `hasClientSecret` proves one is configured without disclosing it — the shape
 * `webhooks` uses for its signing key.
 */
export interface SsoProviderView {
	readonly id: string;
	readonly providerId: string;
	readonly protocol: "oidc";
	readonly issuer: string;
	readonly clientId: string;
	readonly hasClientSecret: boolean;
	readonly discoveryUrl: string | null;
	readonly scopes: string | null;
	readonly emailDomain: string | null;
	readonly enabled: boolean;
}

function toView(row: SsoProviderRow): SsoProviderView {
	return {
		id: row.id,
		providerId: row.providerId,
		protocol: row.protocol,
		issuer: row.issuer,
		clientId: row.clientId,
		// The projection no longer carries the secret at all — `packages/db` keeps it out of every
		// shape a request handler can hold. A stored row always has one, so its presence is the fact
		// this field reports.
		hasClientSecret: true,
		discoveryUrl: row.discoveryUrl,
		scopes: row.scopes,
		emailDomain: row.emailDomain,
		enabled: row.enabled,
	};
}

/**
 * Per-organization SSO (OIDC) identity-provider configuration.
 *
 * The storage, the guard (`sso.configure`) and the CRUD are here; the LIVE sign-in path is now
 * wired. `apps/api/src/auth/auth.platform.ts` reads the enabled rows through
 * `listEnabledSsoProviders` at boot and hands them to `createAuth`, which registers the in-tree
 * `better-auth/plugins/generic-oauth` plugin — so `/api/auth/sign-in/oauth2` starts a login against a
 * configured provider and `/api/auth/oauth2/callback/:providerId` completes it and issues a session
 * (the same catch-all and the same tenant-claim session hook as email/password). Two honest limits
 * remain, both `genericOAuth`'s and not this code's: the provider set is a boot-time snapshot (a row
 * added here takes effect on the next process start — better-auth's DB-backed dynamic `sso` plugin,
 * which would refresh live, is a separate package that is not installed), and SAML is not supported
 * (OIDC only, which is what the `protocol` column already constrains).
 *
 * ## `providerId` is a PLATFORM-wide namespace, and `emailDomain` restricts nothing
 *
 * Two limits that are the data model's rather than this file's, stated because a tenant reading the
 * per-organization CRUD would reasonably assume otherwise:
 *
 * - `organization_sso_provider.provider_id` carries a GLOBAL unique index, so the first tenant to
 *   register `okta` owns that slug for the whole deployment. `create` answers 409 for that below,
 *   rather than letting the unique violation surface as a 500, but it cannot make the namespace
 *   per-tenant — that is a schema change in `packages/db`.
 * - `/api/auth/sign-in/oauth2?providerId=…` is therefore not organization-scoped either: it names a
 *   provider, not a tenant.
 *
 * `emailDomain` is no longer documentation of intent. `packages/auth`'s `buildGenericOAuthConfig`
 * refuses to register a provider without one, and `auth-http.plugin.ts` asserts at the CALLBACK that
 * the session the provider issued landed in the organization that owns the provider —
 * `assertSsoProviderOrganization`. Which is why {@link SsoService.update} will not flip `enabled`
 * on for a row that has no domain: the row would be silently dropped at the next boot, and a
 * feature that appears on and is off is worse than a refused write.
 */
@Injectable()
export class SsoService {
	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {}

	private get adminDb() {
		return this.platform.database.adminDb;
	}

	async list(session: AppSession): Promise<readonly SsoProviderView[]> {
		const organizationId = requireActiveOrganizationId(session);
		const rows = await listSsoProviders(this.adminDb, organizationId);
		return rows.map(toView);
	}

	async get(session: AppSession, id: string): Promise<SsoProviderView> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await readSsoProvider(this.adminDb, organizationId, id);
		if (!row) {
			throw new NotFoundException("No such SSO provider.");
		}
		return toView(row);
	}

	async create(session: AppSession, input: CreateSsoProviderInput): Promise<SsoProviderView> {
		const organizationId = requireActiveOrganizationId(session);
		try {
			const row = await createSsoProvider(this.adminDb, { organizationId, ...input });
			return toView(row);
		} catch (error) {
			// The global unique index on `provider_id` — see the class header. Named rather than
			// rethrown, because "another organization on this deployment already registered that
			// identifier" is a thing the caller can act on and a 500 is not.
			if (isUniqueViolation(error)) {
				throw new ConflictException(
					`The identifier "${input.providerId}" is already registered on this deployment. ` +
						"Provider identifiers are unique platform-wide; choose another.",
				);
			}
			throw error;
		}
	}

	async update(
		session: AppSession,
		id: string,
		input: UpdateSsoProviderInput,
	): Promise<SsoProviderView> {
		const organizationId = requireActiveOrganizationId(session);
		const existing = await readSsoProvider(this.adminDb, organizationId, id);
		if (!existing) {
			throw new NotFoundException("No such SSO provider.");
		}
		// A row may not become enabled without an email domain — see the class header. The patch's own
		// domain counts, so setting both in one request is allowed; only the combination that would
		// leave an enabled row with a null column is refused.
		const domain = input.emailDomain ?? existing.emailDomain;
		if ((input.enabled ?? existing.enabled) && (domain === null || domain.trim().length === 0)) {
			throw new UnprocessableEntityException(
				"An SSO provider needs an email domain before it can be enabled; " +
					"a provider that may assert any address is a cross-tenant takeover.",
			);
		}
		const row = await updateSsoProvider(this.adminDb, organizationId, id, input);
		if (!row) {
			throw new NotFoundException("No such SSO provider.");
		}
		return toView(row);
	}

	async remove(session: AppSession, id: string): Promise<{ readonly id: string }> {
		const organizationId = requireActiveOrganizationId(session);
		const deleted = await deleteSsoProvider(this.adminDb, organizationId, id);
		if (!deleted) {
			throw new NotFoundException("No such SSO provider.");
		}
		return { id };
	}
}
