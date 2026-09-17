import { Injectable } from "@nestjs/common";
import type { SessionVerbName, SessionVerbResponse } from "@optimiq-voice/events/schemas";

/** One live call a session holds, and the closure that commands it. */
export interface ControlledCall {
	readonly organizationId: string;
	readonly callId: string;
	readonly legId: string;
	/** The application that took the call. Named in a refusal so an operator knows who to ask. */
	readonly application: string;
	/**
	 * Sends one verb to the engine holding this leg.
	 *
	 * A CLOSURE rather than an instance id, and that is the whole reason this registry can live in
	 * `PbxModule` at all: `SessionHub` is in `SessionModule`, which already imports this module, so a
	 * provider here that reached back for the hub would close the import cycle. What it needs is not
	 * the hub, it is the ability to command one leg — which the registrant already has.
	 */
	readonly sendVerb: (
		verb: SessionVerbName,
		args?: Record<string, unknown>,
	) => Promise<SessionVerbResponse>;
}

/**
 * Which live calls are under a programmable session's control, on THIS replica.
 *
 * ## Why a control route needs it
 *
 * `rpc.engine.v1.session-verb` is the only surface the engine exposes for a mid-call verb, and it
 * authorises on the session id it minted — `application-sessions.ts` refuses `unknown-leg` for a
 * request that names a leg no session holds. So an HTTP route that wants to send `pauseRecord` has
 * to find the session first; there is no address for a leg without one.
 *
 * ## Replica-local, deliberately
 *
 * The session id is a capability held by ONE socket on ONE process, so a directory of them is
 * meaningless off that process. A control-plane replica that does not hold the socket answers "this
 * call is not under control" — which is honest, and is why the refusal names the fact rather than
 * pretending the call does not exist. A shared directory would be a way to address another
 * replica's capability, which is precisely what the session id exists to prevent.
 */
@Injectable()
export class ControlledCalls {
	/** Keyed by `<organizationId>/<callId>`. One entry per session held on this replica. */
	private readonly byCall = new Map<string, ControlledCall>();

	get size(): number {
		return this.byCall.size;
	}

	/**
	 * Records a call as controllable, and returns the release.
	 *
	 * The release is returned rather than requiring a matching `forget`, so a session that ends on
	 * any of its several paths — the leg destroyed, the socket closed, the sweep reaping it — cannot
	 * leave an entry behind. The same contract `SessionHub.watchCall` holds to.
	 */
	register(call: ControlledCall): () => void {
		const key = keyFor(call.organizationId, call.callId);
		this.byCall.set(key, call);
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			// Compared before deleting: a second session on the same call id would otherwise have its
			// entry removed by the first one's teardown.
			if (this.byCall.get(key) === call) {
				this.byCall.delete(key);
			}
		};
	}

	/** The session holding this call, or `undefined` when nothing on this replica does. */
	find(organizationId: string, callId: string): ControlledCall | undefined {
		return this.byCall.get(keyFor(organizationId, callId));
	}
}

function keyFor(organizationId: string, callId: string): string {
	return `${organizationId}/${callId}`;
}
