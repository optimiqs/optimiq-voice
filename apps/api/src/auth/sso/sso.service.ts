import { Inject, Injectable, NotFoundException } from "@nestjs/common";
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
		hasClientSecret: row.clientSecret.length > 0,
		discoveryUrl: row.discoveryUrl,
		scopes: row.scopes,
		emailDomain: row.emailDomain,
		enabled: row.enabled,
	};
}

/**
 * Per-organization SSO (OIDC) identity-provider configuration.
 *
 * The storage, the guard (`sso.configure`) and the CRUD are complete here. Turning a stored
 * provider into a live sign-in path is the documented seam: the installed better-auth ships
 * `genericOAuth` (a boot-time static provider list) but not the per-org DB-backed `sso` plugin, and
 * no SAML. `listEnabledSsoProviders` exists as the boot-time feed a `genericOAuth` wiring would read.
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
		const row = await createSsoProvider(this.adminDb, { organizationId, ...input });
		return toView(row);
	}

	async update(
		session: AppSession,
		id: string,
		input: UpdateSsoProviderInput,
	): Promise<SsoProviderView> {
		const organizationId = requireActiveOrganizationId(session);
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
