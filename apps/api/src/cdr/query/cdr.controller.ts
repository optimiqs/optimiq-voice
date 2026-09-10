import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from "@nestjs/common";
import { RequirePermissions } from "../../auth/require-permissions.decorator";
import { Session } from "../../auth/session.decorator";
import { parseDto } from "../../pbx/shared/dto";
import {
	agentStatsQuerySchema,
	callVolumeQuerySchema,
	cdrCallQuerySchema,
	cdrLegQuerySchema,
	cdrListQuerySchema,
	queueStatsQuerySchema,
} from "./cdr.dto";
import { CdrService } from "./cdr.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `/api/v1/cdr` — the call-history read surface.
 *
 * ## Why the floor is `cdr.read.own` and not `cdr.read`
 *
 * `@RequirePermissions` is an AND, so naming both would refuse everybody: the manager bundle holds
 * `cdr.read` and the self-service bundle holds `cdr.read.own`, and nobody holds the pair. The floor
 * is therefore the SCOPED grant, which an unscoped `cdr.read` holder satisfies anyway by the
 * substitution rule (`hasPermission`), and `CdrService` decides the REACH — the `.own` pattern
 * `pbx/shared/self-ownership.ts` set for extensions, devices and voicemail boxes.
 *
 * What "own" means over a ledger with no user ids is the whole of `cdr-self-scope.ts`: the acting
 * user's extensions, resolved by the PBX area through the `CDR_SELF_PARTIES` port, matched against
 * `from_number`/`to_number` and against `destination_ref` for the legs the switch dialled to them.
 * `queue-stats` keeps its own gate — it names no call and returns no row a person appears in.
 *
 * ## Why there is no POST, PATCH or DELETE
 *
 * `call_legs` is an append-only ledger — the tenant role holds SELECT and INSERT and has no UPDATE
 * or DELETE privilege at all. There is no write here to expose, and the only process that adds rows
 * is the durable writer.
 */
@Controller("api/v1/cdr")
export class CdrController {
	constructor(@Inject(CdrService) private readonly cdr: CdrService) {}

	@Get()
	@RequirePermissions("cdr.read.own")
	async list(@Session() session: AppSession, @Query() query: unknown) {
		return await this.cdr.list(session, parseDto(cdrListQuerySchema, query ?? {}));
	}

	/**
	 * Every leg of one call, before the `:id` route.
	 *
	 * Order matters: Nest matches routes in declaration order, and `calls` would otherwise be
	 * swallowed by `:id` — which, with `ParseUUIDPipe` on it, would turn this into a 400 rather
	 * than a 404 and make the mistake look like a client error.
	 */
	/**
	 * Queue service level over a window — the wallboard's numbers and the SLA widgets'.
	 *
	 * `queues.monitor` and not `cdr.read`, and the choice is worth arguing. What this returns is
	 * COUNTS and AVERAGES per queue: no caller number, no called number, no leg, nothing that names
	 * a call. `queues.monitor` is registered as "Watch live queue and agent state on the wallboard",
	 * and a wallboard whose live tiles worked while its service-level tile said 403 would be a
	 * wallboard with a hole in it — the two halves are one surface. Gating it on `cdr.read` instead
	 * would hand a supervisor's SLA widget the right to read every call the tenant ever made, which
	 * is a much larger grant for a much smaller need.
	 *
	 * Note where that lands for the `agent` role: agents hold `queues.monitor`, so an agent console
	 * may show the queue's service level. That is the intended shape — an agent seeing how their own
	 * queue is doing is the point of a wallboard — and it is strictly less than the `queues.read`
	 * they already hold, which returns the queue's whole configuration.
	 *
	 * Declared BEFORE `@Get(":id")`: `queue-stats` is one segment and would otherwise be captured by
	 * the id route and rejected by `ParseUUIDPipe`. The same ordering rule the agent-session
	 * controller documents.
	 */
	@Get("queue-stats")
	@RequirePermissions("queues.monitor")
	async queueStats(@Session() session: AppSession, @Query() query: unknown) {
		return await this.cdr.queueStats(session, parseDto(queueStatsQuerySchema, query ?? {}));
	}

	/**
	 * Per-agent handling over a window — who took the calls, for how long, and what happened between.
	 *
	 * `queues.monitor`, the same gate as `queue-stats` and for the same argument: what comes back is
	 * counts and averages keyed on a `queue_agent` row id — no caller number, no called number, no
	 * leg, nothing that names a call — and this is the other half of the wallboard's question. Gating
	 * it on `cdr.read` would hand an agent-performance table the right to read every conversation the
	 * tenant ever had, which is a far larger grant for a smaller need.
	 *
	 * Note what that means for the `agent` role, which HOLDS `queues.monitor`: an agent may see their
	 * colleagues' handling numbers. That is the same reach the wallboard already gives them over the
	 * queue's service level, and it is deliberate — a floor where everyone can see the same board is
	 * the shape a contact centre runs on. A deployment that disagrees removes `queues.monitor` from
	 * the agent bundle, which takes the wallboard with it, and that is the honest trade.
	 *
	 * Declared BEFORE `@Get(":id")` for the reason `queue-stats` is: `ParseUUIDPipe` would turn the
	 * mis-match into a 400 that looks like a client error.
	 */
	@Get("agent-stats")
	@RequirePermissions("queues.monitor")
	async agentStats(@Session() session: AppSession, @Query() query: unknown) {
		return await this.cdr.agentStats(session, parseDto(agentStatsQuerySchema, query ?? {}));
	}

	/**
	 * Call volume over time, bucketed by hour or day.
	 *
	 * `cdr.read` — the UNSCOPED grant, and the only endpoint on this controller whose floor is not
	 * `cdr.read.own`. That is not an oversight and it is not an escalation: a bucketed count is a
	 * property of the ORGANIZATION's traffic, and the `.own` narrowing that makes the listing safe
	 * would silently turn "we took 400 calls this week" into one person's slice wearing the same
	 * label. There is no honest scoped version of this number, so the endpoint asks for the grant
	 * that means "you may see the tenant's call history" and returns nothing more specific than a
	 * count.
	 *
	 * Declared before `@Get(":id")`, same rule.
	 */
	@Get("call-volume")
	@RequirePermissions("cdr.read")
	async callVolume(@Session() session: AppSession, @Query() query: unknown) {
		return await this.cdr.callVolume(session, parseDto(callVolumeQuerySchema, query ?? {}));
	}

	@Get("calls/:callId")
	@RequirePermissions("cdr.read.own")
	async getCall(
		@Session() session: AppSession,
		@Param("callId", ParseUUIDPipe) callId: string,
		@Query() query: unknown,
	) {
		return await this.cdr.getCall(session, callId, parseDto(cdrCallQuerySchema, query ?? {}));
	}

	@Get(":id")
	@RequirePermissions("cdr.read.own")
	async get(
		@Session() session: AppSession,
		@Param("id", ParseUUIDPipe) id: string,
		@Query() query: unknown,
	) {
		return await this.cdr.get(session, id, parseDto(cdrLegQuerySchema, query ?? {}));
	}
}
