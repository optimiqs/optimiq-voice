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
import { createCallBlockRuleDto, updateCallBlockRuleDto } from "./call-block.dto";
import { CallBlockService } from "./call-block.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/call-block-rules`.
 *
 * Guarded by `call-block.*`, a resource of its own rather than a ride on `routes.*`.
 *
 * The ride was drafted first, on the reasonable grounds that a block rule IS a routing input —
 * `affectsRouting("call_block_rule")` is true and a write here recompiles the artifact. It was
 * dropped because the two grants answer to different people. `routes.write` is the dial plan: who
 * reaches which menu, which trunk carries which prefix, what the office does after six. A
 * screening list is the tenant's answer to harassment and robocalls, and the person who maintains
 * it is whoever answered the phone — a receptionist adding the number that called nine times this
 * morning, not the administrator who owns the outbound routing table. Riding it on `routes.write`
 * would mean the only way to let somebody block a number is to hand them the dial plan.
 *
 * It cuts the other way too, and that is the half that made the decision. `block` is the harmless
 * action; `allow` is the dangerous one, because an allow rule is what lifts a number OUT of a
 * broad prefix block. A grant that can write allow rules can quietly re-admit a caller the
 * organization decided to exclude, which is a power worth naming in an audit row of its own rather
 * than burying inside "edited routing".
 *
 * Three entries and not two: `delete` is split from `write` because disabling a rule and deleting
 * it are not the same act here. `enabled: false` leaves the row, its `hitCount` and its
 * `lastHitAt` in place — the evidence that this number was calling — and deleting it destroys
 * that. The same argument `security.delete` lost, decided the other way, because a security ACL
 * entry carries no history and a screening rule does.
 */
@Controller("api/v1/call-block-rules")
export class CallBlockController {
	constructor(@Inject(CallBlockService) private readonly rules: CallBlockService) {}

	@Get()
	@RequirePermissions("call-block.read")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.rules.list(session, parseDto(listQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("call-block.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.rules.get(session, id);
	}

	@Post()
	@RequirePermissions("call-block.write")
	async create(@Session() session: AppSession, @Body() body: unknown) {
		return await this.rules.create(session, parseDto(createCallBlockRuleDto, body));
	}

	@Patch(":id")
	@RequirePermissions("call-block.write")
	async update(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		return await this.rules.update(session, id, parseDto(updateCallBlockRuleDto, body));
	}

	@Delete(":id")
	@RequirePermissions("call-block.delete")
	async remove(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.rules.remove(session, id);
	}
}
