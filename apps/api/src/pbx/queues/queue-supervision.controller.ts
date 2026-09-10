import { Body, Controller, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { QueueSupervisionService } from "./queue-supervision.service";
import { superviseCallDto } from "./queues.dto";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/queues/:queueId/live/:callId/supervise` — the wallboard's listen-in button.
 *
 * A separate controller from `QueuesController`, which is CRUD over rows: this route touches no
 * row, places a call, and is guarded by `queues.monitor` rather than by the read/write/manage-agents
 * trio. Mounting it beside the resource endpoints would have put a live-call action behind a class
 * whose header explains a permission split it does not belong to.
 *
 * `live` is in the path and is not a resource this API serves — there is no `GET
 * /queues/:id/live`. It is a namespace segment separating "things about the queue's configuration"
 * from "things about the calls on it right now", so that a future `…/live/:callId/hangup` does not
 * have to argue about whether a call id could collide with a tier id.
 *
 * See `queue-supervision.service.ts` for why this endpoint is defence in depth rather than the gate
 * (the engine's `*0` chain is), and why the requested mode is reached by DTMF rather than applied
 * here.
 */
@Controller("api/v1/queues")
export class QueueSupervisionController {
	constructor(
		@Inject(QueueSupervisionService) private readonly supervision: QueueSupervisionService,
	) {}

	@Post(":queueId/live/:callId/supervise")
	@RequirePermissions("queues.monitor")
	async supervise(
		@Session() session: AppSession,
		@Param("queueId", ParseUUIDPipe) queueId: string,
		@Param("callId", ParseUUIDPipe) callId: string,
		@Body() body: unknown,
	) {
		const { mode } = parseDto(superviseCallDto, body ?? {});
		return await this.supervision.supervise(session, queueId, callId, mode);
	}
}
