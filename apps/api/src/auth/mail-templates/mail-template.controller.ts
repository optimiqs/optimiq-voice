import { Body, Controller, Get, Inject, Post } from "@nestjs/common";
import { parseDto } from "../../pbx/shared/dto";
import { RequirePermissions } from "../require-permissions.decorator";
import { Session } from "../session.decorator";
import { upsertMailTemplateDto } from "./mail-template.dto";
import { MailTemplateService, type MailTemplateView } from "./mail-template.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Managing per-organization mail-template overrides.
 *
 * Rides `settings.read` / `settings.write` rather than a new grant: an overridden subject line is
 * ordinary presentation configuration (unlike SSO or branding's custom domain), so it belongs with
 * the settings the same roles already manage. A reseller's own overrides are the default its
 * children inherit — the same cascade branding uses.
 */
@Controller("api/v1/mail-templates")
export class MailTemplateController {
	constructor(@Inject(MailTemplateService) private readonly templates: MailTemplateService) {}

	@Get()
	@RequirePermissions("settings.read")
	async list(@Session() session: AppSession): Promise<{ data: readonly MailTemplateView[] }> {
		return { data: await this.templates.list(session) };
	}

	@Post()
	@RequirePermissions("settings.write")
	async upsert(
		@Session() session: AppSession,
		@Body() body: unknown,
	): Promise<{ data: MailTemplateView }> {
		return { data: await this.templates.upsert(session, parseDto(upsertMailTemplateDto, body)) };
	}
}
