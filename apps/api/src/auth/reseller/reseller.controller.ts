import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { parseDto } from "../../pbx/shared/dto";
import { RequirePermissions } from "../require-permissions.decorator";
import { Session } from "../session.decorator";
import { createChildDto, suspendChildDto } from "./reseller.dto";
import {
	type ChildOrganizationView,
	ResellerService,
	type ResellerUsageView,
} from "./reseller.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * The reseller (parent-tenant) surface.
 *
 * Every route is gated twice: `@RequirePermissions("reseller.*")` here, and the service's
 * `is_reseller` capability check plus the per-row `assertChildOfReseller`. The parent is always the
 * acting session's own organization — no route accepts a parent id from the client.
 */
@Controller("api/v1/reseller")
export class ResellerController {
	constructor(@Inject(ResellerService) private readonly reseller: ResellerService) {}

	@Get("children")
	@RequirePermissions("reseller.read")
	async listChildren(
		@Session() session: AppSession,
	): Promise<{ data: readonly ChildOrganizationView[] }> {
		return { data: await this.reseller.listChildren(session) };
	}

	@Get("usage")
	@RequirePermissions("reseller.read")
	async usage(@Session() session: AppSession): Promise<{ data: ResellerUsageView }> {
		return { data: await this.reseller.usage(session) };
	}

	@Post("children")
	@RequirePermissions("reseller.write")
	async createChild(
		@Session() session: AppSession,
		@Body() body: unknown,
	): Promise<{ data: ChildOrganizationView }> {
		return { data: await this.reseller.createChild(session, parseDto(createChildDto, body)) };
	}

	@Post("children/:organizationId/suspension")
	@RequirePermissions("reseller.write")
	async setSuspension(
		@Session() session: AppSession,
		@Param("organizationId", ParseUUIDPipe) organizationId: string,
		@Body() body: unknown,
	): Promise<{ data: { readonly organizationId: string; readonly suspended: boolean } }> {
		const { suspended } = parseDto(suspendChildDto, body);
		return { data: await this.reseller.setSuspended(session, organizationId, suspended) };
	}
}
