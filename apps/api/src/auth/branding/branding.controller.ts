import { Body, Controller, Get, Header, Inject, Patch, Query } from "@nestjs/common";
import { z } from "zod/v4";
import { parseDto } from "../../pbx/shared/dto";
import { PublicRoute } from "../public-route.decorator";
import { RequirePermissions } from "../require-permissions.decorator";
import { Session } from "../session.decorator";
import { updateBrandingDto } from "./branding.dto";
import { BrandingService } from "./branding.service";
import type { EffectiveBranding } from "./branding.resolver";
import type { AppSession } from "@optimiq-voice/auth";

const byHostQuery = z.object({ host: z.string().trim().min(1).max(253) });

/**
 * White-label branding.
 *
 * The public host-keyed read is deliberately kept on this authenticated controller rather than in a
 * separate namespace: it is `@PublicRoute()` and its handler returns ONLY resolved brand fields for
 * one host, reaching no tenant data — the security control is that narrow return shape, stated here
 * at the call site as `public-route.decorator.ts` requires.
 */
@Controller("api/v1/branding")
export class BrandingController {
	constructor(@Inject(BrandingService) private readonly branding: BrandingService) {}

	@Get()
	@RequirePermissions("settings.read")
	async readEffective(@Session() session: AppSession): Promise<{ data: EffectiveBranding }> {
		return { data: await this.branding.readEffective(session) };
	}

	/**
	 * Pre-auth theming: the web shell calls this by request host before anyone signs in. No session,
	 * no permission — it returns brand fields for a single host and nothing else, and an unknown host
	 * yields the code default so the login page always themes.
	 */
	@Get("by-host")
	@PublicRoute()
	@Header("Cache-Control", "public, max-age=60")
	async readByHost(@Query() query: unknown): Promise<{ data: EffectiveBranding }> {
		const { host } = parseDto(byHostQuery, query ?? {});
		return { data: await this.branding.readByHost(host) };
	}

	@Patch()
	@RequirePermissions("branding.write")
	async update(
		@Session() session: AppSession,
		@Body() body: unknown,
	): Promise<{ data: EffectiveBranding }> {
		return { data: await this.branding.update(session, parseDto(updateBrandingDto, body)) };
	}
}
