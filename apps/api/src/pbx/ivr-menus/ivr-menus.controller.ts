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
	Put,
	Query,
} from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto, reorderDto } from "../shared/dto";
import { listQuerySchema } from "../shared/pagination";
import {
	createIvrMenuDto,
	createIvrMenuOptionDto,
	updateIvrMenuDto,
	updateIvrMenuOptionDto,
} from "./ivr-menus.dto";
import { IvrMenuOptionsService, IvrMenusService } from "./ivr-menus.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/ivr-menus` and its nested `/options`. */
@Controller("api/v1/ivr-menus")
export class IvrMenusController {
	constructor(
		@Inject(IvrMenusService) private readonly menus: IvrMenusService,
		@Inject(IvrMenuOptionsService) private readonly options: IvrMenuOptionsService,
	) {}

	@Get()
	@RequirePermissions("ivr.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.menus.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("ivr.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.menus.get(session, id);
	}

	@Post()
	@RequirePermissions("ivr.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.menus.create(session, parseDto(createIvrMenuDto, body));
	}

	@Patch(":id")
	@RequirePermissions("ivr.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.menus.update(session, id, parseDto(updateIvrMenuDto, body));
	}

	@Delete(":id")
	@RequirePermissions("ivr.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.menus.remove(session, id);
	}

	// --- options -------------------------------------------------------------------------------

	@Get(":id/options")
	@RequirePermissions("ivr.read")
	async listOptions(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.options.list(session, id);
	}

	@Post(":id/options")
	@RequirePermissions("ivr.write")
	async createOption(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.options.create(session, id, parseDto(createIvrMenuOptionDto, body));
	}

	/**
	 * Replaces the options' order in one transaction.
	 *
	 * Declared before `:id/options/:optionId` so `reorder` is read as the literal it is rather than
	 * as an option id — Nest matches routes in declaration order.
	 */
	@Put(":id/options/reorder")
	@RequirePermissions("ivr.write")
	async reorderOptions(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.options.reorder(session, id, parseDto(reorderDto, body).ids);
	}

	@Patch(":id/options/:optionId")
	@RequirePermissions("ivr.write")
	async updateOption(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("optionId", ParseUUIDPipe) optionId: string,
		@Body() body: unknown,
	) {
		return await this.options.update(session, id, optionId, parseDto(updateIvrMenuOptionDto, body));
	}

	@Delete(":id/options/:optionId")
	@RequirePermissions("ivr.write")
	async removeOption(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Param("optionId", ParseUUIDPipe) optionId: string,
	) {
		return await this.options.remove(session, id, optionId);
	}
}
