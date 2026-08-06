import { Inject, Injectable } from "@nestjs/common";
import { hasPermission, requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	ABSENT_AGENT_STATUS,
	planAgentSessionAction,
	type AgentSessionAction,
	type AgentStateEntry,
	type AgentStatus,
} from "@optimiq-voice/events/schemas";
import { getLogger } from "@optimiq-voice/logger";
import { eq, queueAgent, queueTier } from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { AgentStatePublisher, AgentStateUnavailableError } from "./agent-state.publisher";
import {
	AgentStateStoreUnavailableException,
	AgentTransitionRefusedException,
	QueueAgentNotFoundException,
	QueueAgentSessionForbiddenException,
} from "./queue-agent-session.errors";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * Agent availability: the shift half of the ACD state machine, which the engine refuses to write.
 *
 * ## The authorization model, and the user ↔ agent link
 *
 * Three permissions already existed in the registry for this and none of them were wired to
 * anything, which is why this wave adds no permission:
 *
 * | Permission             | Means                                                   |
 * | ---------------------- | ------------------------------------------------------- |
 * | `queues.join`          | Log ANY agent in or out. A supervisor's floor control.  |
 * | `queues.manage-agents` | Staff the tiers, and (per its own label) force state.   |
 * | `queues.join.own`      | Set OWN availability. What the `agent` role is given.   |
 *
 * The route's guard requires only `queues.read`, which every role that can reach this surface
 * holds, and the real decision is made here. That is deliberate rather than lax:
 * `@RequirePermissions` is an AND of its arguments and this rule is an OR whose right-hand side
 * depends on the ROW ("…or `queues.join.own` and this agent is you"), which no decorator on a
 * handler can evaluate before the row is read. Splitting the endpoint in two — one for self, one
 * for others — would move the same decision into the client, where a mis-chosen URL becomes a 403
 * the user cannot act on.
 *
 * `queue_agent.user_id` is what makes the self case answerable, and it already exists: a plain UUID
 * column with no cross-database foreign key (the `user` row lives in the auth database), already
 * exposed on the agent DTO. An agent with a NULL `user_id` is a seat nobody has claimed — it can be
 * driven by a supervisor and by nobody else, and the 403's message says so, because "your account
 * is not linked to this agent" is a thing an admin can fix in ten seconds and "forbidden" is not.
 *
 * ## What is written, in what order
 *
 * `agent-state` KV first (the only store distribution reads — see `agent-state.publisher.ts`), then
 * `queue_agent.status` / `status_changed_at`, which `packages/pbx-db` documents as "the persisted
 * last-known value so a wallboard can render before the KV watch warms up". The column is
 * best-effort: it is a cache of the bucket, and failing a login because a cache write failed would
 * be refusing the operation for the sake of the thing that exists to make it look faster.
 */
@Injectable()
export class QueueAgentSessionService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(AgentStatePublisher) private readonly agentState: AgentStatePublisher,
	) {}

	/**
	 * The agent the acting user IS, if any, plus their live state.
	 *
	 * Returns `null` rather than 404 when there is no link: "you are not an agent" is a normal
	 * answer for most of an organization's members, and an error would make the console's own
	 * absence look like a failure.
	 */
	async self(session: AppSession): Promise<{ readonly data: AgentSessionView | null }> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select()
				.from(queueAgent)
				.where(eq(queueAgent.userId, session.user.id))
				.limit(1);
			return rows[0];
		});
		if (row === undefined) {
			return { data: null };
		}
		return { data: await this.viewOf(organizationId, row, session) };
	}

	/** One agent's live state. `queues.read` is enough — reading is not acting. */
	async get(session: AppSession, agentId: string): Promise<{ readonly data: AgentSessionView }> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.requireAgent(organizationId, agentId);
		return { data: await this.viewOf(organizationId, row, session) };
	}

	/**
	 * Applies one session action.
	 *
	 * Guard-then-execute, in this order and no other: the row is read (which is also the tenancy
	 * check, because RLS scopes the read), then the caller is authorized against it, then the
	 * CURRENT status is read from the bucket, then the machine decides, and only then is anything
	 * written. Every earlier step can refuse, and none of them has written anything when it does.
	 */
	async apply(
		session: AppSession,
		agentId: string,
		action: AgentSessionAction,
		options: { readonly reason?: string | undefined } = {},
	): Promise<{ readonly data: AgentSessionView; readonly changed: boolean }> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.requireAgent(organizationId, agentId);
		this.assertMayAct(session, row);

		const current = await this.agentState.read(organizationId, agentId);
		const from = statusOf(current, row.status);
		const plan = planAgentSessionAction(action, from);

		if (plan.outcome === "refused") {
			throw new AgentTransitionRefusedException(action, plan.error);
		}
		if (plan.outcome === "no-op") {
			// The button was pressed twice, or two tabs are open, or a request was retried. Answering
			// with the state that is already true is idempotent AND keeps the transition log free of
			// edges that did not happen — a wallboard reading `agent.state` as a log would otherwise
			// render a self-transition as an agent flapping.
			return {
				data: await this.viewOf(organizationId, row, session, current),
				changed: false,
			};
		}

		const queueIds = await this.queueIdsFor(organizationId, agentId);
		let entry: AgentStateEntry;
		try {
			entry = await this.agentState.write({
				organizationId,
				agentId,
				status: plan.to,
				previousStatus: from,
				reason: action === "pause" ? options.reason : undefined,
				queueIds,
				at: new Date(),
			});
		} catch (error) {
			if (AgentStateUnavailableError.is(error)) {
				throw new AgentStateStoreUnavailableException();
			}
			throw error;
		}

		await this.rememberStatus(organizationId, agentId, plan.to, entry.since);

		logger.info("agent session action applied", {
			organizationId,
			agentId,
			action,
			from,
			to: plan.to,
			actor: session.user.id,
			self: row.userId === session.user.id,
		});

		return {
			data: await this.viewOf(organizationId, row, session, entry),
			changed: true,
		};
	}

	private async requireAgent(organizationId: string, agentId: string): Promise<QueueAgentRow> {
		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select()
				.from(queueAgent)
				.where(eq(queueAgent.id, agentId))
				.limit(1);
			return rows[0];
		});
		if (row === undefined) {
			throw new QueueAgentNotFoundException(agentId);
		}
		return row;
	}

	/**
	 * The OR the decorator cannot express.
	 *
	 * `hasPermission` treats an unscoped grant as covering its scopes, so an owner holding
	 * `queues.join` satisfies the self case too and never reaches the link check.
	 */
	private assertMayAct(session: AppSession, row: QueueAgentRow): void {
		const granted = session.permissions ?? [];
		if (hasPermission(granted, "queues.join") || hasPermission(granted, "queues.manage-agents")) {
			return;
		}
		if (!hasPermission(granted, "queues.join.own")) {
			throw new QueueAgentSessionForbiddenException(
				"Changing an agent's availability needs queues.join or queues.manage-agents, or " +
					"queues.join.own for your own agent seat.",
			);
		}
		if (row.userId === null) {
			throw new QueueAgentSessionForbiddenException(
				`The agent "${row.name}" is not linked to any user account, so nobody can set their ` +
					"own availability on it. An administrator can link it on the agent's settings.",
			);
		}
		if (row.userId !== session.user.id) {
			throw new QueueAgentSessionForbiddenException(
				`You may only change your own availability. "${row.name}" is somebody else's seat.`,
			);
		}
	}

	/** The queues this agent serves, for the `agent.state` payload's `queueIds`. */
	private async queueIdsFor(organizationId: string, agentId: string): Promise<readonly string[]> {
		const rows = await this.database.withTenantScope(organizationId, async (transaction) =>
			transaction
				.select({ queueId: queueTier.queueId })
				.from(queueTier)
				.where(eq(queueTier.queueAgentId, agentId)),
		);
		return rows.map((row) => row.queueId);
	}

	/**
	 * Mirrors the new status onto the row.
	 *
	 * Swallows its own failure, deliberately: this column is a cache of the KV bucket for readers
	 * that have not warmed a watch yet, and the bucket has already been written by the time this
	 * runs. Failing the request here would refuse an operation that already took effect.
	 */
	private async rememberStatus(
		organizationId: string,
		agentId: string,
		status: AgentStatus,
		since: string,
	): Promise<void> {
		try {
			await this.database.withTenantScope(organizationId, async (transaction) => {
				await transaction
					.update(queueAgent)
					.set({ status: toStoredStatus(status), statusChangedAt: new Date(since) })
					.where(eq(queueAgent.id, agentId));
			});
		} catch (error) {
			logger.warn(
				"the agent's live state was updated but the persisted last-known status was not; a " +
					"wallboard will show the old value until its KV watch warms up",
				{ organizationId, agentId, status, error },
			);
		}
	}

	private async viewOf(
		organizationId: string,
		row: QueueAgentRow,
		session: AppSession,
		entry?: AgentStateEntry | undefined,
	): Promise<AgentSessionView> {
		const live = entry ?? (await this.agentState.read(organizationId, row.id));
		const granted = session.permissions ?? [];
		const managesOthers =
			hasPermission(granted, "queues.join") || hasPermission(granted, "queues.manage-agents");
		return {
			agentId: row.id,
			name: row.name,
			userId: row.userId,
			enabled: row.enabled,
			/**
			 * The bucket's answer wins over the column's, always. The column is written after the
			 * bucket and by this process only — the engine moves an agent to `ringing` without
			 * touching Postgres at all — so a disagreement means the column is behind, never ahead.
			 */
			status: statusOf(live, row.status),
			since: live?.since ?? row.statusChangedAt?.toISOString() ?? null,
			reason: live?.reason ?? null,
			availableAt: live?.availableAt ?? null,
			/** Which process last wrote it. `null` when only the column has ever been written. */
			source: live?.source ?? null,
			/** Whether the bucket has an entry at all, so a UI can say "live" rather than "last known". */
			live: live !== undefined,
			self: row.userId !== null && row.userId === session.user.id,
			/** What the caller may do, so a console renders the buttons it will not be refused for. */
			canManage: managesOthers,
			canManageSelf: managesOthers || hasPermission(granted, "queues.join.own"),
		};
	}
}

/** What a session endpoint answers with. Mirrored in `apps/web`'s `lib/pbx/contracts.ts`. */
export interface AgentSessionView {
	readonly agentId: string;
	readonly name: string;
	readonly userId: string | null;
	readonly enabled: boolean;
	readonly status: AgentStatus;
	readonly since: string | null;
	readonly reason: string | null;
	readonly availableAt: string | null;
	readonly source: "engine" | "api" | null;
	readonly live: boolean;
	readonly self: boolean;
	readonly canManage: boolean;
	readonly canManageSelf: boolean;
}

interface QueueAgentRow {
	readonly id: string;
	readonly name: string;
	readonly userId: string | null;
	readonly status: string;
	readonly statusChangedAt: Date | null;
	readonly enabled: boolean;
}

/**
 * The status to plan against.
 *
 * The bucket first, the column as a fallback, and `logged-out` when neither has anything — which is
 * `ABSENT_AGENT_STATUS`, and is the safe end of the machine: an unseen agent that read as
 * `available` would make an empty bucket look like a fully staffed queue.
 *
 * The column can hold a value the machine does not have (`pbx-db`'s `QUEUE_AGENT_STATUSES` has no
 * `ringing`, because a persisted "ringing" is meaningless after a restart), so it is narrowed
 * rather than trusted.
 */
function statusOf(entry: AgentStateEntry | undefined, stored: string): AgentStatus {
	if (entry !== undefined) {
		return entry.status;
	}
	return isAgentStatus(stored) ? stored : ABSENT_AGENT_STATUS;
}

const AGENT_STATUS_SET: ReadonlySet<string> = new Set<string>([
	"logged-out",
	"available",
	"ringing",
	"on-call",
	"wrap-up",
	"on-break",
	"unavailable",
]);

function isAgentStatus(value: string): value is AgentStatus {
	return AGENT_STATUS_SET.has(value);
}

/**
 * The column's vocabulary is `pbx-db`'s, which lacks `ringing`.
 *
 * Only the API's four targets are ever written through here and none of them is `ringing`, so this
 * is a total function in practice — it exists so that adding a fifth action cannot silently write a
 * value the column's own type rejects.
 */
function toStoredStatus(
	status: AgentStatus,
): "logged-out" | "available" | "on-break" | "on-call" | "wrap-up" | "unavailable" {
	return status === "ringing" ? "on-call" : status;
}
