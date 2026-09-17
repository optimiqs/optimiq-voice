import {
	Body,
	Controller,
	Delete,
	Get,
	Inject,
	Param,
	ParseUUIDPipe,
	Patch,
	Post,
} from "@nestjs/common";
import { parseDto } from "../../pbx/shared/dto";
import { RequirePermissions } from "../require-permissions.decorator";
import { Session } from "../session.decorator";
import { createSsoProviderDto, updateSsoProviderDto } from "./sso.dto";
import { SsoService, type SsoProviderView } from "./sso.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * Per-organization SSO identity providers. All routes are gated by `sso.configure` — configuring an
 * organization's authentication is a credential-class power, not ordinary settings.
 */
@Controller("api/v1/sso/providers")
export class SsoController {
	constructor(@Inject(SsoService) private readonly sso: SsoService) {}

	@Get()
	@RequirePermissions("sso.configure")
	async list(@Session() session: AppSession): Promise<{ data: readonly SsoProviderView[] }> {
		return { data: await this.sso.list(session) };
	}

	@Get(":id")
	@RequirePermissions("sso.configure")
	async get(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
	): Promise<{ data: SsoProviderView }> {
		return { data: await this.sso.get(session, id) };
	}

	@Post()
	@RequirePermissions("sso.configure")
	async create(
		@Session() session: AppSession,
		@Body() body: unknown,
	): Promise<{ data: SsoProviderView }> {
		return { data: await this.sso.create(session, parseDto(createSsoProviderDto, body)) };
	}

	@Patch(":id")
	@RequirePermissions("sso.configure")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	): Promise<{ data: SsoProviderView }> {
		return { data: await this.sso.update(session, id, parseDto(updateSsoProviderDto, body)) };
	}

	@Delete(":id")
	@RequirePermissions("sso.configure")
	async remove(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
	): Promise<{ data: { readonly id: string } }> {
		return { data: await this.sso.remove(session, id) };
	}
}
