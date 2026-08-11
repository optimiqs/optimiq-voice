import type {
	ParkHandoffRefusalReason,
	ParkHandoffRequest,
	ParkHandoffResponse,
} from "@optimiq-voice/events";

/**
 * The engine-to-engine seam for `rpc.engine.v1.park-handoff`.
 *
 * ## Why a port and not a NATS connection
 *
 * The same reason `MediadTransport` is a port: every branch of the cross-instance retrieval path —
 * the happy one, each refusal, the timeout — is then a fast unit spec with no broker, and the
 * gated integration suite is left to prove the wire. `CallControl` is the class this hangs off, and
 * `call-control.spec.ts` drives the whole of it in process.
 *
 * ## Why the OWNER's instance id is an argument rather than part of the payload
 *
 * Because it is not payload — it is ADDRESS. The subject is
 * `rpc.engine.v1.park-handoff.<instanceToken>` (see `subjectFor.engineParkHandoffRpc`), so the
 * instance this request is for decides where the bytes go, not what they say. Passing it in the
 * body as well would create two places that could disagree about who is being asked, and the
 * disagreement would surface as a call that never gets connected.
 */
export interface ParkHandoffClient {
	/**
	 * Asks `ownerInstanceId` to bridge the call it has parked to the channel in `request`.
	 *
	 * @throws when no reply could be read at all — the owner is gone, the broker dropped it, or the
	 * bytes were not JSON. A REFUSAL is not a throw: it arrives as `{ok: false, reason}`, because an
	 * instance that answers "I no longer have that call" and an instance that has died need
	 * different things said to the person holding the handset.
	 */
	handoff(ownerInstanceId: string, request: ParkHandoffRequest): Promise<ParkHandoffResponse>;
}

/** Thrown when a handoff reply cannot be read at all — a timeout, or bytes that are not JSON. */
export class ParkHandoffError extends Error {
	readonly ownerInstanceId: string;

	constructor(ownerInstanceId: string, message: string, options?: { cause?: unknown }) {
		super(`park handoff to ${ownerInstanceId}: ${message}`, options);
		this.name = "ParkHandoffError";
		this.ownerInstanceId = ownerInstanceId;
	}
}

/**
 * What the person who dialled the orbit is told when a handoff is refused.
 *
 * Written here, once, rather than at the call site, because these strings are the ENTIRE user
 * experience of a distributed failure: somebody dialled 401, and what comes back has to tell them
 * whether to try again, to stop looking, or to call the person who parked it. Two of them
 * deliberately say the same thing a same-instance retrieval says — a race lost to a colleague looks
 * identical whether the colleague was on this node or another, and it should.
 */
export function parkHandoffRefusal(
	slot: number,
	reason: ParkHandoffRefusalReason | undefined,
	error: string | undefined,
): string {
	const orbit = `orbit ${String(slot)}`;
	switch (reason) {
		case "not_parked":
		case "claim_superseded":
			return `nothing is parked on ${orbit}`;
		case "channel_gone":
			return `the call on ${orbit} has already gone`;
		case "unreachable_channel":
			return `the call on ${orbit} is parked on an engine that does not share this media server, so it cannot be retrieved from here`;
		case "media_failed":
			return `the parked call could not be connected: ${error ?? "the media server refused the bridge"}`;
		case "shutting_down":
			return `the engine holding ${orbit} is shutting down; the call will ring back to whoever parked it`;
		case "bad_request":
		case "internal":
		case undefined:
			return `the parked call could not be connected: ${error ?? "the owning engine refused the handoff"}`;
	}
}
