import {
	ConflictException,
	ForbiddenException,
	HttpStatus,
	NotFoundException,
	ServiceUnavailableException,
} from "@nestjs/common";
import type {
	AgentSessionAction,
	InvalidAgentTransitionError,
} from "@optimiq-voice/events/schemas";

/**
 * The agent-session surface's HTTP errors.
 *
 * Nest exceptions rather than `Schema.TaggedErrorClass` failures, for the reason
 * `carrier.errors.ts` records: the PBX failures exist to cross the Effect seam, and this service is
 * not below it — its stores are a KV bucket and one tenant-scoped read, neither of which is a
 * repository. The body contract is identical (`{ statusCode, code, message, … }`), because
 * `apps/web` switches on `code` and must not care which layer produced the failure.
 *
 * ```jsonc
 * // 404 — no such agent in this organization (or RLS hid it, which is the same thing)
 * { "statusCode": 404, "code": "PBX_NOT_FOUND", "kind": "queue-agent", "id": "…" }
 * // 403 — authenticated, holds queues.read, but may not act on THIS agent
 * { "statusCode": 403, "code": "QUEUE_AGENT_SESSION_FORBIDDEN", "message": "…" }
 * // 409 — the state machine refuses the move
 * { "statusCode": 409, "code": "AGENT_TRANSITION_REFUSED", "from": "on-call", "to": "on-break",
 *   "reason": "not-adjacent", "action": "pause" }
 * // 503 — no broker, so the change would not affect distribution and was not made
 * { "statusCode": 503, "code": "AGENT_STATE_UNAVAILABLE", "message": "…" }
 * ```
 */

/** No such agent in the acting organization. Mirrors `PbxEntityNotFoundFailure`'s body exactly. */
export class QueueAgentNotFoundException extends NotFoundException {
	constructor(id: string) {
		super({
			statusCode: HttpStatus.NOT_FOUND,
			code: "PBX_NOT_FOUND",
			message: `No queue-agent with id ${id} in this organization.`,
			kind: "queue-agent",
			id,
		});
	}
}

/**
 * The caller may read queues but may not move THIS agent's session.
 *
 * 403 and not 404, even though hiding the agent's existence is the usual instinct: the caller
 * already holds `queues.read` (the route's floor) and can therefore list this agent by name a
 * second later. Pretending it does not exist would be a lie the next request contradicts, and it
 * would send an agent whose account is simply not linked to their seat looking for a missing row.
 * The message names the actual fix.
 */
export class QueueAgentSessionForbiddenException extends ForbiddenException {
	constructor(detail: string) {
		super({
			statusCode: HttpStatus.FORBIDDEN,
			code: "QUEUE_AGENT_SESSION_FORBIDDEN",
			message: detail,
		});
	}
}

/**
 * The state machine refuses the move.
 *
 * 409 rather than 422: the request is well-formed and would have been valid a moment ago — what
 * refuses it is the CURRENT state of the resource, which is what 409 is for. A UI that got a 422
 * would look for a bad field; the right response is to re-read the agent's state and re-render.
 */
export class AgentTransitionRefusedException extends ConflictException {
	constructor(action: AgentSessionAction, error: InvalidAgentTransitionError) {
		super({
			statusCode: HttpStatus.CONFLICT,
			code: "AGENT_TRANSITION_REFUSED",
			message: error.message,
			action,
			from: error.from,
			to: error.to,
			reason: error.reason,
		});
	}
}

/**
 * There is no broker, so nothing was recorded.
 *
 * 503 rather than a silent success. This is the one write in the PBX area whose failure the caller
 * has to hear about: distribution reads the KV bucket and nothing else, so a login that "worked"
 * without reaching it leaves an agent sitting by a phone that will never ring, and the only person
 * who can notice is the one who pressed the button.
 */
export class AgentStateStoreUnavailableException extends ServiceUnavailableException {
	constructor() {
		super({
			statusCode: HttpStatus.SERVICE_UNAVAILABLE,
			code: "AGENT_STATE_UNAVAILABLE",
			message:
				"Availability could not be changed: the live agent-state store is unreachable, so this " +
				"would not affect how calls are distributed. Nothing was recorded.",
		});
	}
}
