import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../shared/dto";
import { emptyAgentSessionDto, pauseAgentSessionDto } from "./queue-agent-session.dto";
import { QueueAgentSessionService } from "./queue-agent-session.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/queue-agents/:id/session` — agent availability.
 *
 * ## Why it is a sub-resource with four verbs, and not a PATCH on the agent
 *
 * `PATCH /queue-agents/:id { status }` already exists and is guarded by `queues.manage-agents`. It
 * writes the `queue_agent.status` COLUMN, which `packages/pbx-db` describes as "the persisted
 * last-known value so a wallboard can render before the KV watch warms up" — a cache. It does not
 * write the `agent-state` KV bucket, which is the only thing distribution reads, and it is not
 * guarded by the state machine. Extending it to do both would mean one endpoint that sometimes
 * edits a record and sometimes changes what happens to the next caller in a queue, guarded by one
 * permission, with a transition table that only applies to some of its values.
 *
 * So availability gets its own sub-resource, and the ACTION is in the path rather than a status in
 * a body. That is what makes the state machine enforceable: `pause` has one target, so there is no
 * request that can name a status the machine would have to be asked about after the fact, and no
 * way to reach `ringing` — the engine's — through a control-plane route at all.
 *
 * ## Permissions
 *
 * Every route declares `queues.read` and nothing more, and the real decision is made in the service
 * against the ROW. See `queue-agent-session.service.ts` for why: the rule is
 * "`queues.join` or `queues.manage-agents`, OR `queues.join.own` and this agent is linked to you",
 * which is an OR over a row and `@RequirePermissions` is an AND over a request.
 *
 * `queues.read` is a real floor rather than a formality — it is held by `agent`, `manager`, `admin`
 * and `owner` and by nobody else, so a plain `user` is refused by the guard before any of this
 * class runs.
 *
 * ## Route shapes
 *
 * `session/me` is two segments, so it cannot be captured by `QueueAgentsController`'s `@Get(":id")`
 * however the two controllers happen to be ordered in the module. That is deliberate: a `me` route
 * at the top level would depend on registration order for correctness, and `ParseUUIDPipe` would
 * turn a regression into a 400 rather than a test failure.
 */
@Controller("api/v1/queue-agents")
export class QueueAgentSessionController {
	constructor(
		@Inject(QueueAgentSessionService) private readonly sessions: QueueAgentSessionService,
	) {}

	/**
	 * The agent seat the caller occupies, or `{ data: null }`.
	 *
	 * `null` and not 404: most members of an organization are not agents, and an error would make
	 * the console's own absence look like a failure the user should report.
	 */
	@Get("session/me")
	@RequirePermissions("queues.read")
	async me(@Session() session: AppSession) {
		return await this.sessions.self(session);
	}

	@Get(":id/session")
	@RequirePermissions("queues.read")
	async get(@Session() session: AppSession, @Param("id", ParseUUIDPipe) id: string) {
		return await this.sessions.get(session, id);
	}

	@Post(":id/session/login")
	@RequirePermissions("queues.read")
	async login(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyAgentSessionDto, body ?? {});
		return await this.sessions.apply(session, id, "login");
	}

	@Post(":id/session/logout")
	@RequirePermissions("queues.read")
	async logout(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyAgentSessionDto, body ?? {});
		return await this.sessions.apply(session, id, "logout");
	}

	@Post(":id/session/pause")
	@RequirePermissions("queues.read")
	async pause(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		const { reason } = parseDto(pauseAgentSessionDto, body ?? {});
		return await this.sessions.apply(session, id, "pause", { reason });
	}

	@Post(":id/session/resume")
	@RequirePermissions("queues.read")
	async resume(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Body() body: unknown,
	) {
		parseDto(emptyAgentSessionDto, body ?? {});
		return await this.sessions.apply(session, id, "resume");
	}
}
