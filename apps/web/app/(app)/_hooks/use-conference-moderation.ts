"use client";

import { useMutation } from "@tanstack/react-query";
import { toast } from "~/components/ui/toast";
import {
	moderateConferenceParticipant,
	setConferenceLocked,
	setConferenceParticipantVolume,
	type ConferenceGainScope,
	type ConferenceModerationView,
	type ConferenceParticipantAction,
} from "~/lib/pbx/client";
import { conferenceModerationMessage } from "~/lib/pbx/errors";

/**
 * Acting on a live meeting.
 *
 * ## Nothing is invalidated and nothing is patched
 *
 * The response carries the member's whole state, so setting it into a cache would be one render
 * faster. It would also be wrong twice over. There is no cached value to set — a running meeting is
 * not in the query cache at all, for the reason `use-live-queries.ts` opens with — and the engine
 * publishes `conference.participant.updated` for the same change, which is what the panel is already
 * rendering. Writing the answer in as well would make one mute arrive twice, and the two copies
 * would disagree the moment a second moderator acted between them.
 *
 * So the mutation acknowledges and the socket carries the truth. That is the trunk-status decision,
 * restated: when the event carries everything the surface renders, a refetch is a request that
 * returns what is already on screen.
 *
 * ## One mutation, and a key that says which control is busy
 *
 * A panel showing a room of twelve has twelve Mute buttons and a Lock. A single `isPending` would
 * spin all thirteen for one click, so the pressed control is identified by
 * {@link ConferenceModerationMutation.pendingKey} — the same string the caller builds for its
 * buttons — and nothing else moves.
 */

export interface ConferenceModerationInput {
	readonly conferenceId: string;
	/** Names the room this is about, for the toast. The id is not something to read back. */
	readonly roomLabel: string;
	readonly action: ConferenceParticipantAction | "lock" | "unlock" | "volume";
	/** The participant's leg id. Absent for `lock` / `unlock`, which address the room. */
	readonly memberRef?: string;
	/** `volume` only. Percent of unity. */
	readonly gainPercent?: number;
	readonly scope?: ConferenceGainScope;
}

export interface ConferenceModerationMutation {
	readonly run: (input: ConferenceModerationInput) => void;
	readonly isPending: boolean;
	/**
	 * `<conferenceId>:<memberRef ?? "room">` for the command in flight, or `null`.
	 *
	 * Keyed by the TARGET rather than by the action, so pressing Mute disables Deafen for the same
	 * participant too — two commands racing on one member are how a panel ends up disagreeing with
	 * the mixer.
	 */
	readonly pendingKey: string | null;
	readonly error: unknown;
}

/** The key a caller compares against {@link ConferenceModerationMutation.pendingKey}. */
export function conferenceTargetKey(conferenceId: string, memberRef?: string): string {
	return `${conferenceId}:${memberRef ?? "room"}`;
}

export function useConferenceModeration(): ConferenceModerationMutation {
	const mutation = useMutation({
		mutationFn: async (input: ConferenceModerationInput) => {
			if (input.action === "lock" || input.action === "unlock") {
				return await setConferenceLocked(input.conferenceId, input.action === "lock");
			}
			if (input.action === "volume") {
				return await setConferenceParticipantVolume(
					input.conferenceId,
					input.memberRef ?? "",
					input.gainPercent ?? 100,
					input.scope,
				);
			}
			return await moderateConferenceParticipant(
				input.conferenceId,
				input.memberRef ?? "",
				input.action,
			);
		},
		onSuccess: (result, input) => {
			toast.success(successMessage(input, result.data));
		},
		onError: (error) => {
			toast.error(conferenceModerationMessage(error));
		},
	});

	const inFlight = mutation.isPending ? mutation.variables : undefined;
	return {
		run: (input) => mutation.mutate(input),
		isPending: mutation.isPending,
		pendingKey:
			inFlight === undefined
				? null
				: conferenceTargetKey(inFlight.conferenceId, inFlight.memberRef),
		error: mutation.error,
	};
}

/**
 * What the toast says.
 *
 * The member COUNT comes from the response rather than from the panel's own state, because the
 * response is cluster-wide and the panel's participant list is whatever this tab has been told
 * about. On a kick that difference is the whole message — "removed; four people remain" is a fact,
 * and "removed; three rows left in my table" is a guess.
 */
function successMessage(input: ConferenceModerationInput, view: ConferenceModerationView): string {
	const remaining = `${String(view.memberCount)} ${view.memberCount === 1 ? "person" : "people"} in ${input.roomLabel}.`;
	switch (input.action) {
		case "mute": {
			return `Muted. ${remaining}`;
		}
		case "unmute": {
			return `Unmuted. ${remaining}`;
		}
		case "deaf": {
			return `They can no longer hear the room. ${remaining}`;
		}
		case "undeaf": {
			return `They can hear the room again. ${remaining}`;
		}
		case "kick": {
			return `Removed from the meeting. ${remaining}`;
		}
		case "lock": {
			return `${input.roomLabel} is locked — nobody new can join.`;
		}
		case "unlock": {
			return `${input.roomLabel} is open again.`;
		}
		default: {
			return `Level changed. ${remaining}`;
		}
	}
}
