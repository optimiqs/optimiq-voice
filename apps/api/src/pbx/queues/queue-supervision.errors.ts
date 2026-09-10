import { ConflictException, HttpStatus, NotFoundException } from "@nestjs/common";

/**
 * The supervision surface's HTTP errors.
 *
 * Nest exceptions rather than Effect failures, for the reason `queue-agent-session.errors.ts`
 * records: this service's stores are a KV bucket and two tenant-scoped reads, none of which is
 * below the repository seam. The body contract is the same `{ statusCode, code, message, … }`
 * `apps/web` switches on.
 *
 * ```jsonc
 * // 404 — no such queue in this organization
 * { "statusCode": 404, "code": "PBX_NOT_FOUND", "kind": "queue", "id": "…" }
 * // 409 — the call is not live on this queue (ended, never existed, or belongs to another queue)
 * { "statusCode": 409, "code": "QUEUE_SUPERVISION_NO_AGENT", "callId": "…" }
 * // 409 — one of the two ends has no extension to ring
 * { "statusCode": 409, "code": "QUEUE_SUPERVISION_NO_EXTENSION", "message": "…" }
 * ```
 */

/** No such queue in the acting organization. Mirrors `PbxEntityNotFoundFailure`'s body. */
export class QueueSupervisionQueueNotFoundException extends NotFoundException {
	constructor(id: string) {
		super({
			statusCode: HttpStatus.NOT_FOUND,
			code: "PBX_NOT_FOUND",
			message: `No queue with id ${id} in this organization.`,
			kind: "queue",
			id,
		});
	}
}

/**
 * Nobody is on that call, on this queue, right now.
 *
 * ONE exception for three causes — the call ended, the id was never real, and the call belongs to
 * another queue — and that is deliberate. Separating them would answer "does call X exist?" for a
 * caller who may monitor a different queue, which is the enumeration this endpoint's `queueId` path
 * segment exists to prevent. The one honest message covers all three.
 *
 * 409 and not 404: a live call is not a resource this API serves, and the request was well-formed.
 * What refuses it is the current state of the floor, which is what a console should re-read.
 */
export class QueueSupervisionNoAgentException extends ConflictException {
	constructor(callId: string) {
		super({
			statusCode: HttpStatus.CONFLICT,
			code: "QUEUE_SUPERVISION_NO_AGENT",
			message:
				"No agent on this queue is on that call any more. Refresh the wallboard and try the " +
				"call that is live now.",
			callId,
		});
	}
}

/**
 * One end of the supervision has no extension to ring.
 *
 * Either the agent is external — dialled through a carrier, with the platform not in the media path
 * — or the acting user is not linked to an extension. Both are configuration a person can fix, and
 * both are 409 rather than 403: the caller holds `queues.monitor` and is not being refused
 * permission, they are being told there is no phone.
 */
export class QueueSupervisionNoExtensionException extends ConflictException {
	constructor(detail: string) {
		super({
			statusCode: HttpStatus.CONFLICT,
			code: "QUEUE_SUPERVISION_NO_EXTENSION",
			message: detail,
		});
	}
}
