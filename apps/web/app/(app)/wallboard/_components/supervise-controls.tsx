"use client";

import { useMutation } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { toast } from "~/components/ui/toast";
import { ApiError } from "~/lib/api-client";
import {
	SUPERVISE_MODES,
	describeSupervision,
	superviseQueueCall,
	type SuperviseMode,
} from "~/lib/live/supervision";

/**
 * Listen in on one live queue call: monitor, whisper, barge.
 *
 * ## The button does not put you in the mode, and the toast says so
 *
 * `*0` connects the supervisor SILENT, always. Whisper and barge are reached by sending a DTMF digit
 * from their own handset once the call connects — the engine's escalation, which no control plane
 * can perform on somebody's behalf, and deliberately so: a supervisor who can drop out of a barge
 * with a keypress is the safe design. So pressing "Barge" places a MONITORING call and the
 * acknowledgement tells them which digit makes them audible.
 *
 * That is why the three buttons exist at all rather than one "Listen in": each is a different
 * INTENTION, each is audited as that intention, and each answers with the digit that gets there. A
 * single button would leave the supervisor to remember three digits, and a UI that claimed to have
 * applied the mode would leave a customer being discussed by somebody the agent cannot hear.
 *
 * ## Gated on `queues.monitor`, per control
 *
 * The wallboard is already behind that grant, and the buttons ask for it again rather than assuming:
 * the panel renders for anybody who reached the route, and this is the one thing on it that puts a
 * person inside somebody else's conversation.
 */
const MODE_LABELS: Readonly<Record<SuperviseMode, string>> = {
	monitor: "Monitor",
	whisper: "Whisper",
	barge: "Barge",
};

const MODE_TITLES: Readonly<Record<SuperviseMode, string>> = {
	monitor: "Join the call silently. Neither the agent nor the caller hears you.",
	whisper:
		"Join silently, then press the digit you are given to speak to the agent alone — the caller hears nothing of it.",
	barge:
		"Join silently, then press the digit you are given to speak on the call. Both the agent and the caller hear you.",
};

export function SuperviseControls({
	queueId,
	callId,
	agentName,
	canMonitor,
}: {
	queueId: string;
	/** The live call the agent is on, from their `agent-state` entry. */
	callId: string;
	agentName: string;
	canMonitor: boolean;
}) {
	const supervise = useMutation({
		mutationFn: async (mode: SuperviseMode) => await superviseQueueCall(queueId, callId, mode),
		onSuccess: (result) => {
			toast.success(describeSupervision(result));
		},
		onError: (error) => {
			toast.error(supervisionMessage(error));
		},
	});

	if (!canMonitor) {
		return null;
	}

	return (
		<div className="flex items-center gap-1">
			{SUPERVISE_MODES.map((mode) => (
				<Button
					key={mode}
					size="sm"
					variant="ghost"
					loading={supervise.isPending}
					onClick={() => supervise.mutate(mode)}
					title={MODE_TITLES[mode]}
					aria-label={`${MODE_LABELS[mode]} ${agentName}'s call`}
				>
					{MODE_LABELS[mode]}
				</Button>
			))}
		</div>
	);
}

/**
 * A refused supervision attempt, in words a supervisor can act on.
 *
 * The two the platform produces need different next steps — the call has already ended, or the agent
 * is not somebody this platform is in the audio path for — and both are more useful than "failed".
 * The engine can also refuse after this succeeded, and nothing here can say so: the honest limit of
 * this message is what the API decided.
 */
export function supervisionMessage(error: unknown): string {
	if (!(error instanceof ApiError)) {
		return "The call could not be joined. Check your connection and try again.";
	}
	const body = error.body as { code?: string; message?: string } | null;
	switch (body?.code) {
		case "QUEUE_SUPERVISION_NO_AGENT":
			return "That call is no longer live on this queue, so there is nothing to join.";
		case "QUEUE_SUPERVISION_NO_EXTENSION":
			return (
				body.message ??
				"The agent on this call is reached over a carrier rather than an extension, so the platform is not in the audio path."
			);
		default:
			return body?.message ?? `The call could not be joined (${String(error.status)}).`;
	}
}
