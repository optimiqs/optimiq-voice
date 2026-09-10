import { Inject, Injectable, Optional } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { CallControlClient } from "./call-control.client";
import {
	CallNotControllableException,
	CallRecordingNotPausableException,
	CallRecordingPauseUnsupportedException,
	CallRecordingUnavailableException,
} from "./call-recording.errors";
import { ControlledCalls } from "./controlled-calls";
import type { AppSession } from "@optimiq-voice/auth";
import type { CallControlResponse, CallControlVerb } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.calls");

/** What a pause or a resume tells the caller. */
export interface CallRecordingState {
	readonly callId: string;
	readonly legId: string;
	/** The state the recording is now in, and it is a FACT — the engine acknowledged the verb. */
	readonly paused: boolean;
	/** The engine that acted. Echoed for the caller's log, as every other control surface does. */
	readonly instanceId: string;
}

/**
 * `POST /api/v1/calls/:id/recording/{pause,resume}` — the PCI pause.
 *
 * ## Why it exists
 *
 * A card number read aloud must not reach the recording, and stopping and restarting the recorder
 * is not the same thing: it produces two objects, two rows and two timelines, and a retention
 * policy that has to reason about which half of a call it holds. `mediad`'s pause keeps ONE file,
 * writes silence for the gap, and files the intervals on `recording.finished` — so the artefact
 * says where the silence is and why. All of that has been true below the surface for a while and
 * was reachable only from the programmable-session socket, which is a surface no agent has.
 *
 * ## The transport is the session verb, not a new subject
 *
 * `pauseRecord` / `resumeRecord` are already in `SESSION_VERBS` and already implemented by the
 * engine's verb executor. This service sends exactly those, through the closure the session
 * registered in {@link ControlledCalls}. A second RPC for the same two commands would be a second
 * authorization model over one operation.
 *
 * ## …for a call an application is driving. For every other call it is `call-control`
 *
 * The engine authorises a session verb against the SESSION it minted, so that transport reaches
 * only a call an application took — see `ControlledCalls`. A call an agent dialled from the
 * softphone, a desk-phone call, a queue call: none has a session, and every one of them is the case
 * a PCI pause is actually pressed on. Those go through `rpc.engine.v1.call-control` instead, which
 * authorises on the operator's own organization plus the engine's ownership of the leg, and which
 * this service addresses by reading the call's owning instance out of the `channels` bucket.
 *
 * **The session path is tried FIRST**, and that order is the decision worth stating. A call under an
 * application's control has exactly one commander, and routing its pause around the session would
 * mean two paths acting on one recorder with no ordering between them — the race
 * `ApplicationSessions.run` refuses a second session to avoid. So the registry decides, and the
 * engine subject is the fallback for everything it does not hold.
 *
 * ## Two routes, one method
 *
 * The controller has `/pause` and `/resume` because a path verb has exactly one target — the
 * `conference-moderation.controller.ts` argument — and they share this method because the only
 * difference between them is which verb goes on the wire. A `PATCH … { paused }` would have been
 * the same operation with a body a client can half-fill and an audit line that reads as a diff.
 */
@Injectable()
export class CallRecordingService {
	constructor(
		@Inject(ControlledCalls) private readonly controlled: ControlledCalls,
		/**
		 * The engine subject. Optional so a spec about the session path needs no broker at all, which
		 * is the rule every optional dependency on this surface follows; the deployed module always
		 * provides it. Absent, a PBX call answers `CALL_NOT_CONTROLLABLE` exactly as it did before
		 * the subject existed.
		 */
		@Optional() @Inject(CallControlClient) private readonly engine?: CallControlClient,
	) {}

	/**
	 * Pauses or resumes the recording on one live call.
	 *
	 * @throws the mapped refusal, a 404 when nothing holds the call, or a 503 when no engine answered
	 */
	async setPaused(
		session: AppSession,
		callId: string,
		paused: boolean,
	): Promise<CallRecordingState> {
		const organizationId = requireActiveOrganizationId(session);

		// The tenancy check IS this lookup: the registry is keyed by organization, so a call id from
		// another tenant finds nothing and is answered exactly as an id that never existed. No
		// controller on this surface accepts an organization from a caller, and none needs to.
		const verb: CallControlVerb = paused ? "pauseRecord" : "resumeRecord";
		const call = this.controlled.find(organizationId, callId);
		if (call === undefined) {
			return await this.setPausedOnEngine(organizationId, callId, paused, session);
		}

		const response = await call.sendVerb(verb);
		if (!response.ok) {
			const reason = response.reason ?? "internal";
			logger.info(
				{
					organizationId,
					callId,
					legId: call.legId,
					application: call.application,
					paused,
					reason,
					err: response.error,
				},
				"a recording pause was refused",
			);
			if (reason === "unsupported") {
				throw new CallRecordingPauseUnsupportedException(response.error);
			}
			if (reason === "internal" || reason === "shutting-down") {
				throw new CallRecordingUnavailableException(response.error ?? reason);
			}
			throw new CallRecordingNotPausableException(reason, response.error);
		}

		logger.info(
			{
				organizationId,
				callId,
				legId: call.legId,
				application: call.application,
				paused,
				instanceId: response.instanceId,
			},
			paused ? "paused a call recording" : "resumed a call recording",
		);
		return {
			callId,
			legId: call.legId,
			paused,
			instanceId: response.instanceId,
		};
	}

	/**
	 * The same act on a call nobody was handed, through `rpc.engine.v1.call-control`.
	 *
	 * The owners are walked in turn until one answers something other than `wrong_instance`, which is
	 * `ConferenceControlClient`'s fan-out and is bounded by the number of engines holding legs of ONE
	 * call — one, in every deployment that is not mid-scale-out. `wrong_instance` is the only reason
	 * worth continuing on: it means the bucket entry was stale, where every other refusal is a fact
	 * about the call that the next instance would repeat.
	 */
	private async setPausedOnEngine(
		organizationId: string,
		callId: string,
		paused: boolean,
		session: AppSession,
	): Promise<CallRecordingState> {
		const engine = this.engine;
		if (engine === undefined) {
			throw new CallNotControllableException(callId);
		}
		const owners = await engine.ownersOf(organizationId, callId);
		if (owners.length === 0) {
			// Nothing live with that id in this organization. Indistinguishable, deliberately, from a
			// call id that never existed — the tenancy check IS the lookup, exactly as it is above.
			throw new CallNotControllableException(callId);
		}

		const verb: CallControlVerb = paused ? "pauseRecord" : "resumeRecord";
		const userId = session.user.id;
		let last: CallControlResponse | undefined;
		for (const instanceId of owners) {
			last = await engine.send(instanceId, {
				orgId: organizationId,
				callId,
				verb,
				...(userId === undefined ? {} : { byUserId: userId }),
			});
			if (last.ok || last.reason !== "wrong_instance") {
				break;
			}
		}

		if (last === undefined || !last.ok) {
			const reason = last?.reason ?? "internal";
			logger.info(
				{ organizationId, callId, paused, reason, err: last?.error },
				"a recording pause was refused by the engine",
			);
			if (reason === "unsupported") {
				throw new CallRecordingPauseUnsupportedException(last?.error);
			}
			if (reason === "internal" || reason === "shutting-down") {
				throw new CallRecordingUnavailableException(last?.error ?? reason);
			}
			if (reason === "unknown-call" || reason === "wrong_instance") {
				// The call went away between the bucket read and the verb, or is mid-failover. Both are
				// "there is no recording control here right now", which is what a 404 says.
				throw new CallNotControllableException(callId);
			}
			// `not-recording`, `media-refused` and `bad_request` all mean the call is reachable and the
			// engine would not change it — a 409 carrying the reason, so a console can decide between
			// hiding the control and saying why it did nothing.
			throw new CallRecordingNotPausableException(reason, last?.error);
		}

		logger.info(
			{
				organizationId,
				callId,
				legId: last.legId,
				paused,
				instanceId: last.instanceId,
			},
			paused ? "paused a call recording" : "resumed a call recording",
		);
		return {
			callId,
			legId: last.legId ?? callId,
			// The ENGINE's answer, not the request. A resume that landed on an already-running
			// recorder must report what the recorder is doing, because that is what the button draws.
			paused: last.paused ?? paused,
			instanceId: last.instanceId,
		};
	}
}
