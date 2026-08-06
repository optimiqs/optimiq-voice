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
import { createPhoneNumberDto, updatePhoneNumberDto } from "./phone-numbers.dto";
import { PhoneNumbersService } from "./phone-numbers.service";
import type { AppSession } from "@optimiq-voice/auth";

/** `/api/v1/phone-numbers` — DIDs and their default destination. */
@Controller("api/v1/phone-numbers")
export class PhoneNumbersController {
	constructor(@Inject(PhoneNumbersService) private readonly numbers: PhoneNumbersService) {}

	@Get()
	@RequirePermissions("numbers.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.numbers.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("numbers.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.numbers.get(session, id);
	}

	@Post()
	@RequirePermissions("numbers.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.numbers.create(session, parseDto(createPhoneNumberDto, body));
	}

	@Patch(":id")
	@RequirePermissions("numbers.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.numbers.update(session, id, parseDto(updatePhoneNumberDto, body));
	}

	@Delete(":id")
	@RequirePermissions("numbers.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.numbers.remove(session, id);
	}
}
