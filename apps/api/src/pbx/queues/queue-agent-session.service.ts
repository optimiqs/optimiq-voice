import { Inject, Injectable, Optional } from "@nestjs/common";
import { hasPermission, requireActiveOrganizationId } from "@optimiq-voice/auth";
import {
	ABSENT_AGENT_STATUS,
	isEngineBenched,
	planAgentSessionAction,
	type AgentSessionAction,
	type AgentStateEntry,
	type AgentStatus,
} from "@optimiq-voice/events/schemas";
import { getLogger } from "@optimiq-voice/logging";
import {
	and,
	eq,
	queueAgent,
	queueCallDisposition,
	queueDispositionCode,
	QUEUE_DISPOSITION_UNSET,
	QUEUE_SURVEY_MAX_ANSWER,
	QUEUE_SURVEY_MIN_ANSWER,
	queueSurveyQuestion,
	queueSurveyResponse,
	queueTier,
	inArray,
} from "@optimiq-voice/pbx-db";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { AgentStatePublisher, AgentStateUnavailableError } from "./agent-state.publisher";
import {
	AgentStateStoreUnavailableException,
	AgentTransitionRefusedException,
	QueueAgentNotFoundException,
	QueueAgentSessionForbiddenException,
	QueueDispositionCodeUnknownException,
	QueueDispositionNoLiveCallException,
} from "./queue-agent-session.errors";
import { QUEUE_DISPOSITION_LEDGER } from "./queue-disposition-cdr.port";
import type { QueueDispositionLedger } from "./queue-disposition-cdr.port";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

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
		@Optional()
		@Inject(QUEUE_DISPOSITION_LEDGER)
		private readonly ledger?: QueueDispositionLedger,
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

		logger.info(
			{
				organizationId,
				agentId,
				action,
				from,
				to: plan.to,
				actor: session.user.id,
				self: row.userId === session.user.id,
			},
			"agent session action applied",
		);

		return {
			data: await this.viewOf(organizationId, row, session, entry),
			changed: true,
		};
	}

	/**
	 * Records the wrap-up code an agent picked for the call they are finishing.
	 *
	 * ## Why it is on this service and not its own
	 *
	 * Because it is guarded by the same sentence: `queues.join` or `queues.manage-agents` for
	 * anybody's seat, `queues.join.own` for your own. {@link assertMayAct} IS that sentence, and a
	 * second copy of an OR-over-a-row is how the two spellings eventually disagree about which one
	 * an unlinked seat falls under. The route's floor stays `queues.read`, for the reason the class
	 * header gives.
	 *
	 * ## The queue comes from the live entry, not from the caller
	 *
	 * The `agent-state` entry names the queue that distributed the call (`queueId`) and the call
	 * still owed a code (`dispositionCallId`). Both are read here rather than accepted, because a
	 * body that could name a queue would let an agent file a code from one queue's vocabulary
	 * against another queue's call — and every report groups by exactly that pair. An agent with no
	 * live entry, or one whose entry names no queue, is a 409: the wrap-up they are trying to close
	 * out is over or never happened, and there is nothing to attribute the code to.
	 *
	 * `callId` IS taken from the body and then checked against the entry. Restating it is what makes
	 * a late submission for the PREVIOUS call refusable instead of silently landing on the current
	 * one — the console reads it off the same entry, so a mismatch means the agent has moved on.
	 *
	 * ## Three writes, in this order, and only the first may fail the request
	 *
	 * 1. `queue_call_disposition`, upserted on `(call, agent)`. This is the durable record and the
	 *    only one whose failure the caller hears about. A correction inside the wrap-up window
	 *    overwrites rather than appends, which is what the unique index is for: an agent who picked
	 *    the wrong code and fixed it has chosen once.
	 * 2. The `agent-state` entry, so the console can read back what it just sent without waiting for
	 *    anything. The status is untouched — the engine owns it.
	 * 3. The CDR leg, best-effort and possibly absent entirely. See `queue-disposition-cdr.port.ts`.
	 */
	async submitDisposition(
		session: AppSession,
		agentId: string,
		input: { readonly callId: string; readonly code: string },
	): Promise<{ readonly data: QueueDispositionView }> {
		const organizationId = requireActiveOrganizationId(session);
		const row = await this.requireAgent(organizationId, agentId);
		this.assertMayAct(session, row);

		const live = await this.agentState.read(organizationId, agentId);
		const queueId = live?.queueId;
		if (live === undefined || queueId === undefined) {
			throw new QueueDispositionNoLiveCallException(input.callId);
		}
		// The entry may legitimately name no call at all — an agent whose wrap-up ended between the
		// console rendering the form and the submit — so an absent `dispositionCallId` is the same
		// refusal as a mismatched one rather than a pass.
		if (live.dispositionCallId !== input.callId) {
			throw new QueueDispositionNoLiveCallException(input.callId);
		}

		const recorded = await this.recordDisposition({
			organizationId,
			queueId,
			queueAgentId: agentId,
			callId: input.callId,
			code: input.code,
			auto: false,
		});

		try {
			await this.agentState.writeDisposition({
				organizationId,
				agentId,
				callId: input.callId,
				code: recorded.code,
			});
		} catch (error) {
			// The choice is already durable. Refusing the request now would tell the agent their code
			// was not recorded when it was, and they would pick it again on a call that has moved on.
			logger.warn(
				{ organizationId, agentId, callId: input.callId, error },
				"a wrap-up code was recorded but could not be written to the live agent-state entry; " +
					"the console will show it after its next read",
			);
		}

		await this.stampLedger(organizationId, agentId, input.callId, recorded.code);

		logger.info(
			{
				organizationId,
				agentId,
				queueId,
				callId: input.callId,
				code: recorded.code,
				actor: session.user.id,
				self: row.userId === session.user.id,
			},
			"a queue call disposition was recorded",
		);
		return { data: { ...recorded, queueId, agentId, callId: input.callId } };
	}

	/**
	 * The ENGINE's auto-wrap report: the deadline passed with nobody choosing.
	 *
	 * No session, and no {@link assertMayAct}: the caller is the distributor, reached over the
	 * broker, and the fact it is reporting is one only it can know. What replaces the permission
	 * check is the shape of what it may say — {@link QUEUE_DISPOSITION_UNSET} and nothing else. An
	 * engine that could name a real code here would be a second, unauthenticated way to write an
	 * agent's answer, and the whole point of `unset` is that it is the ABSENCE of one.
	 *
	 * Idempotent by the same unique index the agent's path uses, and deliberately LOSES to it: a
	 * report that arrives after the agent chose must not overwrite their choice with `unset`, which
	 * is why this upsert is conditional on the existing row being auto. The engine retrying a report
	 * it already delivered writes the same row twice, which is the same row.
	 *
	 * The KV entry is NOT stamped: `agentStateEntrySchema.dispositionCode` documents that `unset` is
	 * never written there, and a console showing "unset" as if it were a choice would be reporting
	 * the system's giving up as the agent's answer.
	 */
	async recordAutoDisposition(input: {
		readonly organizationId: string;
		readonly queueId: string;
		readonly agentId: string;
		readonly callId: string;
	}): Promise<{ readonly recorded: boolean }> {
		const written = await this.database.withTenantScope(
			input.organizationId,
			async (transaction) => {
				const result = await transaction
					.insert(queueCallDisposition)
					.values({
						organizationId: input.organizationId,
						queueId: input.queueId,
						queueAgentId: input.agentId,
						callId: input.callId,
						codeId: null,
						code: QUEUE_DISPOSITION_UNSET,
						auto: true,
					})
					.onConflictDoNothing()
					.returning({ id: queueCallDisposition.id });
				return result.length > 0;
			},
		);
		await this.stampLedger(
			input.organizationId,
			input.agentId,
			input.callId,
			QUEUE_DISPOSITION_UNSET,
		);
		logger.info(
			{ ...input, recorded: written },
			written
				? "the wrap-up deadline recorded an unset disposition"
				: "an auto-wrap report arrived for a call the agent had already dispositioned",
		);
		return { recorded: written };
	}

	/**
	 * Files what one caller pressed in the post-call survey.
	 *
	 * ## One row per answer, and the unique index is the whole idempotence story
	 *
	 * `queue_survey_response` is unique on `(organization_id, call_id, question_id)`, and this writes
	 * `onConflictDoNothing` against it. So a report the engine delivered twice — a timeout on the
	 * first attempt that in fact arrived, a restart mid-detach — counts a caller's rating once. Doing
	 * it the other way (an upsert that overwrote) would be the same thing for a replay and wrong for
	 * everything else: there is no second opinion to record, because the caller pressed once.
	 *
	 * `recorded` is therefore the number of rows this call actually inserted, and a report that
	 * writes fewer rows than it carried is a replay rather than an error. The engine logs the
	 * difference and does not retry.
	 *
	 * ## An answer for a question this queue does not have is REFUSED, not stored
	 *
	 * The questions are read first, inside the same transaction as the write, and every `questionId`
	 * is checked against that queue's own set. A caller cannot press a digit for a question they were
	 * never asked, so such a report is one of two bugs — a stale membership artifact naming a deleted
	 * question, or a report addressed to the wrong queue — and storing it would put a rating against
	 * a question nobody can interpret in the only table the scores are read from. The same goes for a
	 * digit outside 1-5, which `queue_survey_response`'s own check constraint would reject as a
	 * database error rather than as an answer. Both come back in `reason`, where the engine's log
	 * puts them in front of somebody.
	 *
	 * The refusal is per ANSWER and not per report: two good answers and one impossible one write
	 * two rows and say so, for the reason `runQueueSurvey` returns the answers it has when it stops
	 * early — a partial survey is more data than none.
	 */
	async recordSurveyAnswers(input: {
		readonly organizationId: string;
		readonly queueId: string;
		readonly agentId: string;
		readonly callId: string;
		readonly answers: readonly { readonly questionId: string; readonly answer: number }[];
	}): Promise<{ readonly recorded: number; readonly reason?: string }> {
		const answeredAt = new Date();
		const result = await this.database.withTenantScope(
			input.organizationId,
			async (transaction) => {
				const questionIds = [...new Set(input.answers.map((answer) => answer.questionId))];
				const known = new Set(
					(
						await transaction
							.select({ id: queueSurveyQuestion.id })
							.from(queueSurveyQuestion)
							.where(
								and(
									eq(queueSurveyQuestion.queueId, input.queueId),
									inArray(queueSurveyQuestion.id, questionIds),
								),
							)
					).map((row) => row.id),
				);

				const refusals: string[] = [];
				const values = input.answers.filter((answer) => {
					if (!known.has(answer.questionId)) {
						refusals.push(`${answer.questionId}: not a question of this queue`);
						return false;
					}
					if (
						!Number.isInteger(answer.answer) ||
						answer.answer < QUEUE_SURVEY_MIN_ANSWER ||
						answer.answer > QUEUE_SURVEY_MAX_ANSWER
					) {
						refusals.push(`${answer.questionId}: answer ${String(answer.answer)} is out of range`);
						return false;
					}
					return true;
				});

				if (values.length === 0) {
					return { recorded: 0, refusals };
				}
				const written = await transaction
					.insert(queueSurveyResponse)
					.values(
						values.map((answer) => ({
							organizationId: input.organizationId,
							queueId: input.queueId,
							questionId: answer.questionId,
							callId: input.callId,
							queueAgentId: input.agentId,
							answer: answer.answer,
							answeredAt,
						})),
					)
					.onConflictDoNothing()
					.returning({ id: queueSurveyResponse.id });
				return { recorded: written.length, refusals };
			},
		);

		const reason =
			result.refusals.length > 0 ? result.refusals.join("; ").slice(0, 256) : undefined;
		logger.info(
			{
				organizationId: input.organizationId,
				queueId: input.queueId,
				agentId: input.agentId,
				callId: input.callId,
				sent: input.answers.length,
				recorded: result.recorded,
				...(reason === undefined ? {} : { reason }),
			},
			reason === undefined
				? "recorded a post-call survey"
				: "a post-call survey report carried answers this queue could not accept",
		);
		return { recorded: result.recorded, ...(reason === undefined ? {} : { reason }) };
	}

	/**
	 * Resolves the code against the queue's ENABLED vocabulary and upserts the row.
	 *
	 * The lookup and the write share one transaction, so a code retired between the two cannot
	 * produce a row naming a code the queue no longer offers. `codeId` is stored beside the
	 * denormalised `code` because they answer different questions once somebody deletes a retired
	 * code: the id goes to NULL and the text is what the history is for.
	 */
	private async recordDisposition(input: {
		readonly organizationId: string;
		readonly queueId: string;
		readonly queueAgentId: string;
		readonly callId: string;
		readonly code: string;
		readonly auto: boolean;
	}): Promise<{ readonly code: string; readonly codeId: string | null; readonly auto: boolean }> {
		return await this.database.withTenantScope(input.organizationId, async (transaction) => {
			const rows = await transaction
				.select({ id: queueDispositionCode.id })
				.from(queueDispositionCode)
				.where(
					and(
						eq(queueDispositionCode.queueId, input.queueId),
						eq(queueDispositionCode.code, input.code),
						eq(queueDispositionCode.enabled, true),
					),
				)
				.limit(1);
			const codeId = rows[0]?.id;
			if (codeId === undefined) {
				throw new QueueDispositionCodeUnknownException(input.code, input.queueId);
			}
			await transaction
				.insert(queueCallDisposition)
				.values({
					organizationId: input.organizationId,
					queueId: input.queueId,
					queueAgentId: input.queueAgentId,
					callId: input.callId,
					codeId,
					code: input.code,
					auto: input.auto,
				})
				.onConflictDoUpdate({
					target: [
						queueCallDisposition.organizationId,
						queueCallDisposition.callId,
						queueCallDisposition.queueAgentId,
					],
					set: { codeId, code: input.code, auto: input.auto, updatedAt: new Date() },
				});
			return { code: input.code, codeId, auto: input.auto };
		});
	}

	/** The reporting copy. Absent port, absent CDR database and a leg still in flight all no-op. */
	private async stampLedger(
		organizationId: string,
		queueAgentId: string,
		callId: string,
		code: string,
	): Promise<void> {
		if (this.ledger === undefined) {
			return;
		}
		const stamped = await this.ledger.recordDisposition({
			organizationId,
			callId,
			queueAgentId,
			code,
		});
		if (stamped === 0) {
			logger.debug(
				{ organizationId, queueAgentId, callId, code },
				"no CDR leg carried the wrap-up code yet; the ledger copy will be missing for this call",
			);
		}
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
				{ organizationId, agentId, status, error },
				"the agent's live state was updated but the persisted last-known status was not; a " +
					"wallboard will show the old value until its KV watch warms up",
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
		const self = row.userId !== null && row.userId === session.user.id;
		/**
		 * The call and disposition fields are the same live state the `agent-state` socket topic
		 * carries, and that topic is gated on `queues.monitor`. Repeating them here for a caller who
		 * only holds `queues.read` would hand out over HTTP what the socket refuses — so they are
		 * carried for a supervisor, or for the agent asking about their own seat.
		 */
		const seesLiveCall = self || hasPermission(granted, "queues.monitor");
		const call = seesLiveCall ? live : undefined;
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
			/**
			 * The free-text reason narrowed to the two the DISTRIBUTOR writes, so a supervisor can
			 * tell a phone nobody is answering from a person who typed "back at 3". Null for every
			 * human-set reason, which is still carried whole on `reason`.
			 */
			unavailableReason: live !== undefined && isEngineBenched(live) ? (live.reason ?? null) : null,
			/** Which process last wrote it. `null` when only the column has ever been written. */
			source: live?.source ?? null,
			/**
			 * The call fields the live socket already carries, repeated here so the wallboard's
			 * supervise button and the console's wrap-up panel work on a cold or unpermitted socket.
			 * All four are `null` off a call: the bucket omits them rather than writing a null.
			 */
			callId: call?.callId ?? null,
			/** The queue that distributed {@link callId}; a supervise request needs both. */
			queueId: call?.queueId ?? null,
			dispositionCallId: call?.dispositionCallId ?? null,
			dispositionCode: call?.dispositionCode ?? null,
			dispositionRequired: call?.dispositionRequired ?? false,
			/** Whether the bucket has an entry at all, so a UI can say "live" rather than "last known". */
			live: live !== undefined,
			self,
			/** What the caller may do, so a console renders the buttons it will not be refused for. */
			canManage: managesOthers,
			canManageSelf: managesOthers || hasPermission(granted, "queues.join.own"),
		};
	}
}

/** What the disposition endpoint answers with. Mirrored in `apps/web`'s `lib/pbx/contracts.ts`. */
export interface QueueDispositionView {
	readonly queueId: string;
	readonly agentId: string;
	readonly callId: string;
	readonly code: string;
	/** The `queue_disposition_code` row, or `null` when the deadline chose. */
	readonly codeId: string | null;
	/** False when a person picked it. See `packages/pbx-db`'s `queue_call_disposition.auto`. */
	readonly auto: boolean;
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
	/** `reason`, but only when the distributor benched the agent. See `ENGINE_UNAVAILABLE_REASONS`. */
	readonly unavailableReason: string | null;
	readonly availableAt: string | null;
	readonly source: "engine" | "api" | null;
	readonly callId: string | null;
	readonly queueId: string | null;
	readonly dispositionCallId: string | null;
	readonly dispositionCode: string | null;
	readonly dispositionRequired: boolean;
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
