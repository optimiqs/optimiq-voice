import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	type BrandingRow,
	readBranding,
	readBrandingByCustomDomain,
	readHierarchy,
	upsertBranding,
} from "@optimiq-voice/db";
import { AUTH_PLATFORM } from "../auth.tokens";
import { type EffectiveBranding, resolveEffectiveBranding } from "./branding.resolver";
import type { AuthPlatform } from "../auth.platform";
import type { UpdateBrandingInput } from "./branding.dto";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * White-label branding and the theme cascade.
 *
 * Branding lives entirely in the base (control-plane) database because it is resolved before
 * authentication — the web shell themes its login page by request host with no session — and
 * because the reseller-default level is another tenant's row, both of which the tenant RLS boundary
 * forbids. Writes run on the untenanted `adminDb`; the reseller default a child inherits is simply
 * the reseller org's own branding row, read through the hierarchy.
 */
@Injectable()
export class BrandingService {
	constructor(@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform) {}

	private get adminDb() {
		return this.platform.database.adminDb;
	}

	/** The reseller-default branding row for an org: its parent's, if it has one. */
	private async resellerDefaultFor(organizationId: string): Promise<BrandingRow | null> {
		const hierarchy = await readHierarchy(this.adminDb, organizationId);
		const parentId = hierarchy?.parentOrganizationId;
		return parentId ? await readBranding(this.adminDb, parentId) : null;
	}

	private async resolveFor(organizationId: string): Promise<EffectiveBranding> {
		const [org, resellerDefault] = await Promise.all([
			readBranding(this.adminDb, organizationId),
			this.resellerDefaultFor(organizationId),
		]);
		return resolveEffectiveBranding(org, resellerDefault);
	}

	/**
	 * Effective branding for an organization id — the sessionless entry the mail path resolves
	 * through so a composed email carries the tenant's product name, exactly as
	 * `org-settings.service.ts` exposes `readNotificationSettingsFor(organizationId)` for the same
	 * consumers.
	 */
	async resolveForOrganization(organizationId: string): Promise<EffectiveBranding> {
		return await this.resolveFor(organizationId);
	}

	/** Effective branding for the acting session's own organization. */
	async readEffective(session: AppSession): Promise<EffectiveBranding> {
		return await this.resolveFor(requireActiveOrganizationId(session));
	}

	/**
	 * Effective branding for a request host — the pre-auth theming read. Returns ONLY brand fields
	 * and never reveals which organization owns the host or any other tenant data. An unknown host
	 * resolves to the code default, so the login page always themes to something.
	 */
	async readByHost(host: string): Promise<EffectiveBranding> {
		const row = await readBrandingByCustomDomain(this.adminDb, host);
		if (!row) {
			return resolveEffectiveBranding(null, null);
		}
		return await this.resolveFor(row.organizationId);
	}

	/** Write the acting organization's branding override. */
	async update(session: AppSession, input: UpdateBrandingInput): Promise<EffectiveBranding> {
		const organizationId = requireActiveOrganizationId(session);
		await upsertBranding(this.adminDb, organizationId, input);
		return await this.resolveFor(organizationId);
	}
}
