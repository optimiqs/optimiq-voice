import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	listMailTemplates,
	type MailTemplateRow,
	readHierarchy,
	readMailTemplate,
	upsertMailTemplate,
} from "@optimiq-voice/db";
import { AUTH_PLATFORM } from "../auth.tokens";
import { BrandingService } from "../branding/branding.service";
import type { MailTemplateOverride } from "../../mail/mail-template-resolution";
import type { AuthPlatform } from "../auth.platform";
import type { UpsertMailTemplateInput } from "./mail-template.dto";
import type { AppSession } from "@optimiq-voice/auth";

export interface MailTemplateView {
	readonly id: string;
	readonly templateKey: string;
	readonly language: string;
	readonly subject: string | null;
	readonly bodyIntro: string | null;
	readonly enabled: boolean;
}

/**
 * What a composer needs to brand and re-word one email: the product name to feed the code
 * template as its `appName`, and the resolved subject/intro override to apply afterwards.
 */
export interface MailComposition {
	readonly productName: string;
	readonly override: MailTemplateOverride | null;
}

function toView(row: MailTemplateRow): MailTemplateView {
	return {
		id: row.id,
		templateKey: row.templateKey,
		language: row.language,
		subject: row.subject,
		bodyIntro: row.bodyIntro,
		enabled: row.enabled,
	};
}

/**
 * The mail-template cascade: `code default → reseller default → org override`, plus the branding
 * product name.
 *
 * The management half (list/upsert) is guarded by `settings.*` on the controller — a template
 * override is presentation configuration, not a credential — and the resolution half
 * ({@link resolveComposition}) is the sessionless entry a mail consumer calls when composing.
 *
 * ## The consumer wiring
 *
 * The voicemail-to-email consumer (`voicemail-email.service.ts`) is wired: it resolves
 * `{ productName, override }` here, feeds `productName` as the code template's `appName`, and runs
 * the result through `applyMailOverride` before `sendRendered`. That is the reference for the
 * remaining three — the auth delivery (`auth-email.delivery.ts`, whose senders lack an active-org id
 * at verification time) and the fax/emergency-notification consumers — which still pass
 * `DEFAULT_MAIL_APP_NAME`. Each follows the voicemail pattern once it threads an organization id and
 * a template key to this service; the mechanism, its storage and its management surface are complete.
 */
@Injectable()
export class MailTemplateService {
	constructor(
		@Inject(AUTH_PLATFORM) private readonly platform: AuthPlatform,
		@Inject(BrandingService) private readonly branding: BrandingService,
	) {}

	private get adminDb() {
		return this.platform.database.adminDb;
	}

	async list(session: AppSession): Promise<readonly MailTemplateView[]> {
		const organizationId = requireActiveOrganizationId(session);
		const rows = await listMailTemplates(this.adminDb, organizationId);
		return rows.map(toView);
	}

	async upsert(session: AppSession, input: UpsertMailTemplateInput): Promise<MailTemplateView> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await upsertMailTemplate(this.adminDb, { organizationId, ...input });
		return toView(row);
	}

	/**
	 * Resolve the composition for an organization, template and language. Reads the org's override
	 * first, then its reseller's (the default a child inherits), and pairs it with the effective
	 * branding product name. Returns a code-default composition when nothing is overridden.
	 */
	async resolveComposition(
		organizationId: string,
		templateKey: string,
		language: string,
	): Promise<MailComposition> {
		const [branding, override] = await Promise.all([
			this.branding.resolveForOrganization(organizationId),
			this.resolveOverride(organizationId, templateKey, language),
		]);
		return { productName: branding.productName, override };
	}

	private async resolveOverride(
		organizationId: string,
		templateKey: string,
		language: string,
	): Promise<MailTemplateOverride | null> {
		const own = await readMailTemplate(this.adminDb, organizationId, templateKey, language);
		if (own) {
			return { subject: own.subject, bodyIntro: own.bodyIntro };
		}
		const hierarchy = await readHierarchy(this.adminDb, organizationId);
		const parentId = hierarchy?.parentOrganizationId;
		if (!parentId) {
			return null;
		}
		const inherited = await readMailTemplate(this.adminDb, parentId, templateKey, language);
		return inherited ? { subject: inherited.subject, bodyIntro: inherited.bodyIntro } : null;
	}
}
