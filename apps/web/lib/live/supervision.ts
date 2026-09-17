import { apiFetch } from "../api-client";

/**
 * `POST /queues/:queueId/live/:callId/supervise` — the wallboard's listen-in button.
 *
 * Its own module rather than a verb on `agent-session.ts`, for the reason the API split the two
 * controllers: that surface is an agent moving themselves around a state machine, and this is a
 * supervisor placing a CALL. It touches no row, it is guarded by `queues.monitor` alone, and the
 * thing it returns is an instruction rather than a resource.
 *
 * ## The mode is NOT applied, and a console that implied otherwise would be lying
 *
 * `*0` always connects the supervisor SILENT. Whisper and barge are reached by the supervisor
 * sending a DTMF digit from their own phone once connected — the engine's escalation, which no
 * control plane can perform on their behalf (nor should it; a supervisor who can drop out of a barge
 * with a keypress is the safe design). So a `mode: "barge"` request places a MONITORING call and the
 * response says which digit makes it audible. Every screen using this has to say the same, because
 * the person on the other end of the mistake is a customer who cannot hear the supervisor who
 * thinks they joined.
 */
export const SUPERVISE_MODES = ["monitor", "whisper", "barge"] as const;
export type SuperviseMode = (typeof SUPERVISE_MODES)[number];

/** Mirrors `SupervisionResult` in `apps/api`. */
export interface SupervisionResult {
	readonly ok: true;
	/** Send this DTMF digit once the call connects to reach the requested mode. */
	readonly escalationDigit: string;
	readonly mode: SuperviseMode;
	readonly agentId: string;
	readonly agentExtension: string;
	readonly supervisorExtension: string;
	readonly callId: string;
}

export async function superviseQueueCall(
	queueId: string,
	callId: string,
	mode: SuperviseMode,
): Promise<SupervisionResult> {
	return await apiFetch<SupervisionResult>(
		`/queues/${encodeURIComponent(queueId)}/live/${encodeURIComponent(callId)}/supervise`,
		{ method: "POST", body: JSON.stringify({ mode }) },
	);
}

/**
 * What the supervisor's phone will do, said in the order it happens.
 *
 * One sentence and not three, because the honest version has three clauses and dropping any of them
 * produces a different promise: the platform rings YOU, you arrive silent, and the digit is how you
 * become audible. `monitor` still names its digit — `4` is what RETURNS to silence after a whisper,
 * so a supervisor who has escalated once needs it.
 */
export function describeSupervision(result: SupervisionResult): string {
	const arrival = `Your extension ${result.supervisorExtension} is being called, and you will join extension ${result.agentExtension}'s call silently — the caller and the agent hear nothing.`;
	if (result.mode === "monitor") {
		return `${arrival} Press ${result.escalationDigit} to return to silent monitoring after a whisper or a barge.`;
	}
	const audible =
		result.mode === "whisper"
			? `press ${result.escalationDigit} to whisper to the agent alone`
			: `press ${result.escalationDigit} to join the call so both sides hear you`;
	return `${arrival} Once connected, ${audible}.`;
}
