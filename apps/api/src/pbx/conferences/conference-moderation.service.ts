import { Inject, Injectable } from "@nestjs/common";
import { hasPermission, requireActiveOrganizationId } from "@optimiq-voice/auth";
import { getLogger } from "@optimiq-voice/logging";
import { ConferenceControlClient } from "./conference-control.client";
import {
	ConferenceActionNotServableException,
	ConferenceControlUnavailableException,
	ConferenceMemberNotFoundException,
	ConferenceModerateForbiddenException,
	ConferenceNotRunningException,
} from "./conference-moderation.errors";
import type { AppSession } from "@optimiq-voice/auth";
import type {
	ConferenceControlAction,
	ConferenceControlRequest,
	ConferenceControlResponse,
} from "@optimiq-voice/events/schemas";

const logger = getLogger("api.pbx");

/**
 * In-conference moderation: mute, deafen, kick, re-level, lock.
 *
 * ## The authorization model, and why the guard is not the decision
 *
 * Every route on the controller declares `conferences.read` and nothing more, and the real check
 * happens here against `conferences.moderate`. That is the `queue-agent-session` precedent, applied
 * for a related but distinct reason.
 *
 * There, the rule was an OR over a ROW ("`queues.join`, or `queues.join.own` and this agent is
 * you") which a decorator cannot evaluate. Here the rule is simpler — one grant, no row — and the
 * split is about what a 403 TELLS the caller. `conferences.read` is a real floor: a plain `user`
 * holds neither grant and is refused by the guard before this class runs, having learned nothing
 * about the tenant's rooms. A `manager` who holds `read` and has had `moderate` withheld gets a
 * refusal that names the missing grant, which an administrator fixes in one click.
 *
 * The alternative — `@RequirePermissions("conferences.moderate")` on each route — would produce one
 * indistinguishable 403 for both, and the second caller would file a support ticket saying the
 * button is broken.
 *
 * ## `conferences.moderate` deliberately does NOT guard the CRUD
 *
 * `conferences.controller.ts` has said so in its header since it was written, and the argument is
 * worth restating on the surface that finally uses the grant: muting a participant for a minute and
 * re-pointing the room's recording policy forever are different powers. So are moderating a meeting
 * and setting the PIN that decides who may enter it.
 *
 * ## How a command reaches the right engine
 *
 * See `conference-control.client.ts`. In one sentence: the room's `conference-claims` value names
 * every engine instance with unexpired members in it, exactly one of those holds the member being
 * acted on, and this service asks them in order until one stops saying "not mine".
 *
 * ## What is NOT here: the participant list
 *
 * There is no `GET /conferences/:id/participants`, and its absence is a decision rather than an
 * omission. The claim knows how many people are in a room and not who they are, so answering it
 * would mean fanning a "list your members" request across every contributor on every poll of every
 * open console. The live `conferences` topic carries participants as they arrive and leave, which is
 * what a panel actually needs, and a REST snapshot would be a second answer to one question that
 * could disagree with it mid-meeting.
 */
@Injectable()
export class ConferenceModerationService {
	constructor(@Inject(ConferenceControlClient) private readonly control: ConferenceControlClient) {}

	/**
	 * One command on one live room.
	 *
	 * The order is: authorize, find the meeting, then ask the engines. Finding the meeting first is
	 * what turns a command on a room nobody has joined into an immediate 404 rather than a fan-out
	 * over instances that have never heard of it.
	 */
	async moderate(
		session: AppSession,
		conferenceId: string,
		action: ConferenceControlAction,
		options: {
			readonly memberRef?: string;
			readonly gainPercent?: number;
			readonly gainScope?: "talk" | "listen" | "both";
		} = {},
	): Promise<{ readonly data: ConferenceModerationView }> {
		const organizationId = requireActiveOrganizationId(session);
		this.assertMayModerate(session);

		const claim = await this.control.claim(organizationId, conferenceId);
		if (claim === undefined) {
			if (!this.control.isReady) {
				// Told apart from "nobody is in the room", because the two need opposite reactions: one
				// is a meeting that has not started and one is a platform that cannot answer.
				throw new ConferenceControlUnavailableException(
					"the control plane cannot reach the call engines; no moderation command was sent",
				);
			}
			throw new ConferenceNotRunningException(conferenceId);
		}

		const contributors = this.control.contributors(claim);
		if (contributors.length === 0) {
			// Every contribution has expired: the room's claim outlived the instances that held it,
			// which the next joiner will reap. There is nobody to ask.
			throw new ConferenceNotRunningException(conferenceId);
		}

		const request: ConferenceControlRequest = {
			orgId: organizationId,
			conferenceId,
			action,
			...(options.memberRef === undefined ? {} : { memberRef: options.memberRef }),
			...(options.gainPercent === undefined ? {} : { gainPercent: options.gainPercent }),
			...(options.gainScope === undefined ? {} : { gainScope: options.gainScope }),
			...(session.user?.id === undefined ? {} : { byUserId: session.user.id }),
		};

		const answer = await this.ask(contributors, request);
		return { data: this.view(conferenceId, answer) };
	}

	// -------------------------------------------------------------------------------------------

	/**
	 * Asks each contributor in turn, and stops at the first one that did something.
	 *
	 * `unknown-conference` and `unknown-member` mean "not mine, try the next"; every other refusal is
	 * an ANSWER and stops the walk. That distinction is the whole protocol: a `media-refused` from
	 * the instance that actually holds the member must not send the command to a neighbour that would
	 * cheerfully say "not mine" and turn a real failure into a 404.
	 *
	 * The LAST refusal is what is thrown, not the first, because the interesting instance is the one
	 * that got furthest.
	 */
	private async ask(
		contributors: readonly string[],
		request: ConferenceControlRequest,
	): Promise<ConferenceControlResponse> {
		let last: ConferenceControlResponse | undefined;
		for (const instanceId of contributors) {
			const answer = await this.control.send(instanceId, request);
			if (answer.ok) {
				return answer;
			}
			last = answer;
			if (answer.reason === "unknown-conference" || answer.reason === "unknown-member") {
				continue;
			}
			// A real refusal from the instance that owns the member. Stop.
			break;
		}
		throw this.refusalFor(request, last);
	}

	private refusalFor(
		request: ConferenceControlRequest,
		answer: ConferenceControlResponse | undefined,
	): Error {
		if (answer === undefined) {
			return new ConferenceControlUnavailableException(
				"no engine instance answered; no moderation command was applied",
			);
		}
		logger.warn(
			{
				conferenceId: request.conferenceId,
				action: request.action,
				memberRef: request.memberRef,
				instanceId: answer.instanceId,
				reason: answer.reason,
			},
			"a conference moderation command was refused",
		);
		switch (answer.reason) {
			case "unknown-conference": {
				return new ConferenceNotRunningException(request.conferenceId);
			}
			case "unknown-member": {
				return new ConferenceMemberNotFoundException(request.memberRef ?? "");
			}
			case "not-servable": {
				return new ConferenceActionNotServableException(
					request.action,
					answer.error ?? "no media plane on this platform can serve that action",
				);
			}
			case "bad-request": {
				// The engine validated something this service should have. It is a 503 rather than a 400
				// on purpose: the caller cannot fix it, and dressing an internal disagreement as their
				// mistake would send them looking at their own request.
				return new ConferenceControlUnavailableException(
					answer.error ?? "the call engine refused a command this control plane built",
				);
			}
			default: {
				return new ConferenceControlUnavailableException(
					answer.error ?? "the call engine could not apply the command",
				);
			}
		}
	}

	/**
	 * The one grant this whole surface turns on.
	 *
	 * `hasPermission` and not a set lookup, for the rule it carries and this surface depends on: an
	 * unscoped grant covers its scopes and a scoped one never satisfies an unscoped requirement. There
	 * is no `conferences.moderate.own` and there should not be — "the meetings you started" is not a
	 * fact this platform records — so the check is exact.
	 */
	private assertMayModerate(session: AppSession): void {
		if (!hasPermission(session.permissions ?? [], "conferences.moderate")) {
			throw new ConferenceModerateForbiddenException(
				"Moderating a live conference needs the conferences.moderate permission.",
			);
		}
	}

	/**
	 * The wire view of what happened.
	 *
	 * It carries the member's WHOLE state rather than an acknowledgement, for the reason the
	 * `conference.participant.updated` event does: a panel that applied a delta to a row drawn from a
	 * frame it missed would show a mute button that disagrees with the mixer.
	 *
	 * `instanceId` is deliberately NOT on it. It is the engine's internal address, it is meaningless
	 * to a browser, and putting it in a response body would make it something a client could start
	 * sending back.
	 */
	private view(conferenceId: string, answer: ConferenceControlResponse): ConferenceModerationView {
		return {
			conferenceId,
			action: answer.action,
			memberCount: answer.memberCount,
			...(answer.locked === undefined ? {} : { locked: answer.locked }),
			...(answer.memberRef === undefined ? {} : { memberRef: answer.memberRef }),
			...(answer.muted === undefined ? {} : { muted: answer.muted }),
			...(answer.deafened === undefined ? {} : { deafened: answer.deafened }),
			...(answer.moderator === undefined ? {} : { moderator: answer.moderator }),
			...(answer.talkGainPercent === undefined ? {} : { talkGainPercent: answer.talkGainPercent }),
			...(answer.listenGainPercent === undefined
				? {}
				: { listenGainPercent: answer.listenGainPercent }),
		};
	}
}

/** What a moderation command answers with. See {@link ConferenceModerationService.view}. */
export interface ConferenceModerationView {
	readonly conferenceId: string;
	readonly action: ConferenceControlAction;
	/** People in the room, cluster-wide, after the command. */
	readonly memberCount: number;
	readonly locked?: boolean;
	readonly memberRef?: string;
	readonly muted?: boolean;
	readonly deafened?: boolean;
	readonly moderator?: boolean;
	readonly talkGainPercent?: number;
	readonly listenGainPercent?: number;
}
