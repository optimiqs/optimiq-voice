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
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import {
	createCallFlowDto,
	overrideTimeConditionDto,
	toggleCallFlowDto,
	updateCallFlowDto,
} from "./call-flows.dto";
import { CallFlowsService, TimeConditionOverrideService } from "./call-flows.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/call-flows`, plus the time-condition override that shares its toggle grant. */
@Controller("api/v1/call-flows")
export class CallFlowsController {
	constructor(
		@Inject(CallFlowsService) private readonly flows: CallFlowsService,
		@Inject(TimeConditionOverrideService)
		private readonly overrides: TimeConditionOverrideService,
	) {}

	@Get()
	@RequirePermissions("call-flows.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.flows.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("call-flows.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.flows.get(session, id);
	}

	@Post()
	@RequirePermissions("call-flows.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.flows.create(session, parseDto(createCallFlowDto, body));
	}

	@Patch(":id")
	@RequirePermissions("call-flows.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.flows.update(session, id, parseDto(updateCallFlowDto, body));
	}

	@Delete(":id")
	@RequirePermissions("call-flows.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.flows.remove(session, id);
	}

	/**
	 * Moves the switch.
	 *
	 * `POST` rather than `PATCH`, and a route of its own rather than a field, because it is a
	 * different GRANT: `call-flows.toggle` is what a receptionist holds and `call-flows.write` is
	 * what re-points the branches. A field on the PATCH would put the daily action behind the
	 * administrator's permission and would skip the busy-lamp write that tells every phone in the
	 * building the switch moved.
	 */
	@Post(":id/toggle")
	@RequirePermissions("call-flows.toggle")
	async toggle(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.flows.toggle(session, id, parseDto(toggleCallFlowDto, body ?? {}).mode);
	}

	/**
	 * Overrules a time condition's clock.
	 *
	 * Under `/call-flows` rather than under `/time-conditions`, which is the routing decision this
	 * controller is most likely to be argued with about. The reason is the grant: it is guarded by
	 * `call-flows.toggle`, because forcing a condition open and flipping a flow to night are one act
	 * on two tables, and a path under `/time-conditions` guarded by a `call-flows` permission would
	 * be a surprise every reader has to resolve. Editing the condition's RULES stays where it belongs,
	 * on `PATCH /time-conditions/:id` behind `time-conditions.write`.
	 */
	@Post("time-conditions/:id/override")
	@RequirePermissions("call-flows.toggle")
	async override(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.overrides.setOverride(
			session,
			id,
			parseDto(overrideTimeConditionDto, body ?? {}).override,
		);
	}
}
