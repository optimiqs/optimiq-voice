import { and, callLegs, eq, isNotNull } from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logging";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.pbx");

/**
 * The reporting half of a wrap-up code: `call_legs.queue_disposition_code`.
 *
 * ## Why this is a port and not a direct write
 *
 * `PbxModule` and `CdrModule` are siblings composed conditionally in `main.ts` — a deployment with
 * a PBX database and no `CDR_DATABASE_URL` is a supported shape, and the queues area must keep
 * working in it. So the ledger update is injected, `@Optional()`, and its absence is a queue that
 * records dispositions in `queue_call_disposition` and reports on them from there. That is the same
 * posture `pbx-cdr-ports.module.ts` sets up in the other direction, one seam removed.
 *
 * ## Why it is best-effort even when the port IS present
 *
 * The agent picks a code seconds after the leg row was inserted, and the leg may still be in flight
 * through the CDR consumer. An UPDATE that matched nothing is therefore NORMAL, not an error — and
 * failing the agent's request over it would refuse a submission the durable store already accepted.
 * The `pbx-db` row is the write that must succeed; this is the copy that makes "every call that
 * closed as escalated and took over four minutes" one scan of one ledger.
 */
export const QUEUE_DISPOSITION_LEDGER = Symbol.for("QueueDispositionLedger");

export interface QueueDispositionLedger {
	/**
	 * Stamps the code onto every leg of the call that names this agent.
	 *
	 * Returns how many rows moved, so a caller can log the miss without treating it as a failure.
	 * Never throws: the implementation swallows and logs, because there is no caller that could do
	 * anything useful with the exception.
	 */
	recordDisposition(input: QueueDispositionLedgerWrite): Promise<number>;
}

export interface QueueDispositionLedgerWrite {
	readonly organizationId: string;
	readonly callId: string;
	/** The `queue_agent` row id, which is what `call_legs.queue_agent_ref` holds. */
	readonly queueAgentId: string;
	readonly code: string;
}

/**
 * The `cdr-db` implementation.
 *
 * A plain class rather than an `@Injectable()`, following the convention every other cross-area
 * port here follows: the module provides it through a factory, and a test constructs it with a
 * fake client instead of standing up a container.
 *
 * The predicate is `(call_id, queue_agent_ref)` and NOT the leg id, because the API does not have
 * one: the console submits a CALL and an agent, which is exactly the pair
 * `queue_call_disposition`'s unique index is on. `queue_agent_ref is not null` is redundant beside
 * the equality and is there for the planner — it is the partial index's own predicate, and without
 * it the index is not eligible.
 */
export class QueueDispositionLedgerService implements QueueDispositionLedger {
	constructor(private readonly database: CdrDatabaseClient) {}

	async recordDisposition(input: QueueDispositionLedgerWrite): Promise<number> {
		try {
			return await this.database.withTenantScope(input.organizationId, async (transaction) => {
				const updated = await transaction
					.update(callLegs)
					.set({ queueDispositionCode: input.code })
					.where(
						and(
							eq(callLegs.callId, input.callId),
							eq(callLegs.queueAgentRef, input.queueAgentId),
							isNotNull(callLegs.queueAgentRef),
						),
					)
					.returning({ id: callLegs.id });
				return updated.length;
			});
		} catch (error) {
			logger.warn(
				{
					organizationId: input.organizationId,
					callId: input.callId,
					queueAgentId: input.queueAgentId,
					err: error,
				},
				"the wrap-up code was recorded but could not be stamped onto the CDR leg; the agent " +
					"statistics breakdown will not count it",
			);
			return 0;
		}
	}
}
