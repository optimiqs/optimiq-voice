import { apiFetch } from "~/lib/api-client";

/**
 * The two calls behind the recording control.
 *
 * Kept out of `recording.ts` so that module stays pure and testable without a fetch. Two paths
 * rather than one with a body, because that is what the API serves — see the controller's header
 * for why a mid-call action is a path verb.
 */

export interface CallRecordingStateView {
	readonly callId: string;
	readonly legId: string;
	readonly paused: boolean;
	readonly instanceId: string;
}

/** Pauses or resumes the recording on one live call. Rejects with `ApiError` on a refusal. */
export async function setCallRecordingPaused(
	callId: string,
	paused: boolean,
): Promise<CallRecordingStateView> {
	const { data } = await apiFetch<{ readonly data: CallRecordingStateView }>(
		`/calls/${encodeURIComponent(callId)}/recording/${paused ? "pause" : "resume"}`,
		{ method: "POST" },
	);
	return data;
}
