import {
	AllowedHttpMethod,
	EventsHookAllowedEvents,
	eventsHookSchema,
	sendHttpRequest,
} from "@optimiq-voice/common";
import { getLogger } from "@optimiq-voice/logger";

const logger = getLogger({ service: "autopilot", filePath: __filename });

export type EventsHook = {
	url: string;
	events: EventsHookAllowedEvents[];
	headers?: Record<string, string>;
};

export async function sendConversationEndedEvent(
	eventsHook: EventsHook,
	data: {
		appRef: string;
		callRef: string;
		phone: string;
		chatHistory: Record<string, string>[];
		recordingUrl: string;
	},
) {
	const { chatHistory, phone, appRef, callRef, recordingUrl } = data;

	if (
		!eventsHook?.events.includes(EventsHookAllowedEvents.CONVERSATION_ENDED) &&
		!eventsHook?.events.includes(EventsHookAllowedEvents.ALL)
	) {
		return;
	}

	const parsedEventsHook = eventsHookSchema.parse(eventsHook);
	const params = {
		eventType: EventsHookAllowedEvents.CONVERSATION_ENDED,
		appRef,
		callRef,
		phone,
		chatHistory,
		...(recordingUrl && { recordingUrl }),
	};

	logger.verbose("dispatching conversation.ended webhook", {
		url: parsedEventsHook.url,
		eventType: params.eventType,
		appRef,
		callRef,
	});

	try {
		await sendHttpRequest({
			url: parsedEventsHook.url!,
			method: AllowedHttpMethod.POST,
			headers: parsedEventsHook.headers,
			waitForResponse: false,
			params,
		});
	} catch (e) {
		logger.error("failed to send conversation.ended webhook", {
			url: parsedEventsHook.url,
			method: AllowedHttpMethod.POST,
			waitForResponse: false,
			appRef,
			callRef,
			error: e instanceof Error ? e.message : e,
		});
	}
}
