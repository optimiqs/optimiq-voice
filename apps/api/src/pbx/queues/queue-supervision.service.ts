import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { eq, extension, extensionUser, queue, queueAgent } from "@optimiq-voice/pbx-db";
import { CallsService } from "../calls/calls.service";
import { asUuid, actorFromSession, insertAuditLog } from "../shared/audit-log";
import { PBX_DATABASE } from "../shared/pbx.tokens";
import { AgentStatePublisher } from "./agent-state.publisher";
import {
	QueueSupervisionNoAgentException,
	QueueSupervisionNoExtensionException,
	QueueSupervisionQueueNotFoundException,
} from "./queue-supervision.errors";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/** How the supervisor wants to be on the call. */
export type SuperviseMode = "monitor" | "whisper" | "barge";

/**
 * The DTMF digit that escalates `*0` into each mode, once the supervisor is connected.
 *
 * Documented at `apps/engine/src/routing/plan-walker.ts` (~line 2027) and pinned here because this
 * endpoint's whole contract is telling the caller which one to send. `monitor` is `4` rather than
 * "nothing" on purpose: `*0` already starts silent, so 4 is the digit that RETURNS to monitoring
 * after a whisper, and a console that offers all three modes needs a digit for each of them.
 */
const ESCALATION_DIGITS: Readonly<Record<SuperviseMode, string>> = {
	monitor: "4",
	whisper: "5",
	barge: "6",
};

export interface SupervisionResult {
	readonly ok: true;
	/** Send this DTMF digit once the call connects to reach the requested mode. See below. */
	readonly escalationDigit: string;
	readonly mode: SuperviseMode;
	/** The seat being supervised, for the console's own display. */
	readonly agentId: string;
	readonly agentExtension: string;
	readonly supervisorExtension: string;
	readonly callId: string;
}

/**
 * `POST /queues/:queueId/live/:callId/supervise` — a supervisor joins a live queue call.
 *
 * ## This endpoint is defence in depth, not the gate
 *
 * The actual authorization happens in the engine. `*0<extension>` runs the full authorize → tap
 * chain there and is gated on `calls.supervise`, which is checked against the ORIGINATING
 * extension's owner at dial time — so a supervisor who lost the grant between opening the wallboard
 * and pressing the button is refused by the engine whatever this service decided. `queues.monitor`
 * here is the second lock: it stops the wallboard from being a way to enumerate which agent is on
 * which call, and it keeps the audit row attributable to a session rather than to a handset.
 *
 * ## The mode is NOT applied server-side, and saying so is the contract
 *
 * `*0` always starts SILENT. Whisper and barge are reached by the supervisor sending DTMF 4/5/6
 * once connected — the engine's escalation, and this process cannot change it (nor should it; a
 * supervisor who can drop out of a barge with a keypress is the safe design). So the response
 * carries the digit for the requested mode and nothing else happens: a `mode: "barge"` request
 * places a MONITORING call and tells the caller how to become audible. Pretending otherwise would
 * be an API that reports a state the platform is not in, and the person on the other end of it is a
 * customer who cannot hear the supervisor who thinks they joined.
 *
 * ## Every attempt is audited, allowed or refused
 *
 * A supervision attempt is exactly what a change ledger exists for: it is one person listening to
 * another person's conversation, and "who tried" is as much of the record as "who succeeded". The
 * row is written before the originate is attempted and again with the outcome, so a refusal
 * downstream — no extension, no agent, the engine saying no — still leaves a trace.
 */
@Injectable()
export class QueueSupervisionService {
	constructor(
		@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient,
		@Inject(AgentStatePublisher) private readonly agentState: AgentStatePublisher,
		@Inject(CallsService) private readonly calls: CallsService,
	) {}

	async supervise(
		session: AppSession,
		queueId: string,
		callId: string,
		mode: SuperviseMode,
	): Promise<SupervisionResult> {
		const organizationId = requireActiveOrganizationId(session);

		// The queue is read first, and it is the tenancy check rather than a nicety: an id from
		// another tenant or one that never existed must be a 404 BEFORE the KV bucket is scanned,
		// which is the same ordering `GET /queues/:id/callbacks` uses.
		await this.requireQueue(organizationId, queueId);

		const live = await this.agentState.findByCall(organizationId, callId);
		if (live === undefined) {
			await this.audit(session, organizationId, queueId, callId, mode, "no-agent");
			throw new QueueSupervisionNoAgentException(callId);
		}
		// The entry names the queue that distributed the call. Checking it here is what stops the
		// path parameter from being decorative: a supervisor holding `queues.monitor` on one queue
		// would otherwise reach every live call in the tenant by guessing a call id.
		if (live.queueId !== queueId) {
			await this.audit(session, organizationId, queueId, callId, mode, "wrong-queue");
			throw new QueueSupervisionNoAgentException(callId);
		}

		const agentExtension = await this.agentExtensionNumber(organizationId, live.agentId);
		if (agentExtension === undefined) {
			await this.audit(session, organizationId, queueId, callId, mode, "agent-has-no-extension");
			throw new QueueSupervisionNoExtensionException(
				"The agent on this call is not reached through an extension, so there is nothing to " +
					"monitor. External agents are dialled through a carrier and the platform is not in " +
					"the path.",
			);
		}

		const supervisorExtension = await this.supervisorExtensionNumber(
			organizationId,
			session.user.id,
		);
		if (supervisorExtension === undefined) {
			await this.audit(session, organizationId, queueId, callId, mode, "no-supervisor-extension");
			throw new QueueSupervisionNoExtensionException(
				"Your account is not linked to an extension, so there is no phone to ring. An " +
					"administrator can link one on the extension's users tab.",
			);
		}

		// The feature code, not a bespoke command: `*0<extension>` is the ONE path that runs the
		// engine's authorize → tap chain, and a second way in would be a second place the rules could
		// be wrong. `calls.service.ts` is injected read-only for exactly this reason — nothing here
		// edits it, and the origination is the ordinary click-to-call the engine already serves.
		const placed = await this.calls.originate(session, {
			from: supervisorExtension,
			to: `*0${agentExtension}`,
		});

		await this.audit(session, organizationId, queueId, callId, mode, "placed", {
			agentId: live.agentId,
			agentExtension,
			supervisorExtension,
			originatedCallId: placed.callId,
		});

		logger.info(
			{
				organizationId,
				queueId,
				callId,
				mode,
				agentId: live.agentId,
				supervisor: session.user.id,
				originatedCallId: placed.callId,
			},
			"a supervision call was placed",
		);

		return {
			ok: true,
			escalationDigit: ESCALATION_DIGITS[mode],
			mode,
			agentId: live.agentId,
			agentExtension,
			supervisorExtension,
			callId,
		};
	}

	private async requireQueue(organizationId: string, queueId: string): Promise<void> {
		const found = await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ id: queue.id })
				.from(queue)
				.where(eq(queue.id, queueId))
				.limit(1);
			return rows.length > 0;
		});
		if (!found) {
			throw new QueueSupervisionQueueNotFoundException(queueId);
		}
	}

	/** The agent's extension NUMBER, or undefined when the seat is external or unlinked. */
	private async agentExtensionNumber(
		organizationId: string,
		agentId: string,
	): Promise<string | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ number: extension.number })
				.from(queueAgent)
				.innerJoin(extension, eq(extension.id, queueAgent.extensionId))
				.where(eq(queueAgent.id, agentId))
				.limit(1);
			return rows[0]?.number;
		});
	}

	/**
	 * The extension the acting user owns, through `extension_user`.
	 *
	 * The same link `shared/self-ownership.ts` resolves for the `.own` scopes, joined to the number
	 * rather than to the id because what is needed here is something to dial FROM. `limit(1)` and
	 * not a choice: a user with two extensions gets the first by row order, which is arbitrary and
	 * is the honest thing to do — the alternative is a `from` parameter, and a supervision request
	 * that could name any extension as its origin would let a caller place a monitoring call from
	 * somebody else's desk.
	 */
	private async supervisorExtensionNumber(
		organizationId: string,
		userId: string,
	): Promise<string | undefined> {
		return await this.database.withTenantScope(organizationId, async (transaction) => {
			const rows = await transaction
				.select({ number: extension.number })
				.from(extensionUser)
				.innerJoin(extension, eq(extension.id, extensionUser.extensionId))
				.where(eq(extensionUser.userId, userId))
				.limit(1);
			return rows[0]?.number;
		});
	}

	/**
	 * One ledger row per attempt.
	 *
	 * Over `insertAuditLog` rather than `AuditLogService.recordMutation`, for the reason
	 * `recording-purge-audit.service.ts` gives: `recordMutation` diffs a before/after pair on a
	 * `PbxResource`, and nothing is being mutated here — a supervision attempt is an EVENT, and
	 * inventing a resource declaration for it would put a lie in the type system. `before` carries
	 * what was attempted and `after` stays null, which is the shape this ledger already uses for a
	 * thing that happened rather than a row that changed.
	 *
	 * Its own `withTenantScope` and its own failure handling: this runs on refusal paths that are
	 * about to throw, and an audit insert that failed must not replace the real error with its own.
	 */
	private async audit(
		session: AppSession,
		organizationId: string,
		queueId: string,
		callId: string,
		mode: SuperviseMode,
		outcome: string,
		detail: Record<string, unknown> = {},
	): Promise<void> {
		try {
			await this.database.withTenantScope(organizationId, async (transaction) => {
				await insertAuditLog(transaction, {
					organizationId,
					actor: actorFromSession(session),
					action: "queue.supervise",
					resourceType: "queue",
					resourceRef: asUuid(queueId),
					before: { callId, mode, outcome, ...detail },
					after: null,
				});
			});
		} catch (error) {
			logger.error(
				{ organizationId, queueId, callId, mode, outcome, err: error },
				"a supervision attempt could not be written to the audit ledger",
			);
		}
	}
}
