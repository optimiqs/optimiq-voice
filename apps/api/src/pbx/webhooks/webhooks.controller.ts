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
import { createWebhookDto, updateWebhookDto } from "./webhooks.dto";
import { WebhooksService } from "./webhooks.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/webhooks`.
 *
 * DELETE rides `webhooks.write` rather than a `webhooks.delete` that does not exist — see the
 * registry entry for the argument, which is the one `security.delete` lost: deleting a subscription
 * and disabling it stop the same deliveries and leave nothing behind.
 */
@Controller("api/v1/webhooks")
export class WebhooksController {
	constructor(@Inject(WebhooksService) private readonly webhooks: WebhooksService) {}

	@Get()
	@RequirePermissions("webhooks.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.webhooks.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("webhooks.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.webhooks.get(session, id);
	}

	@Post()
	@RequirePermissions("webhooks.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.webhooks.create(session, parseDto(createWebhookDto, body));
	}

	@Patch(":id")
	@RequirePermissions("webhooks.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.webhooks.update(session, id, parseDto(updateWebhookDto, body));
	}

	@Delete(":id")
	@RequirePermissions("webhooks.write")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.webhooks.remove(session, id);
	}
}
