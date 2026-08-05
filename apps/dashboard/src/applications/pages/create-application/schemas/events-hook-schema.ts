import { z } from "zod";
import { VALID_URL } from "./messages";

export enum EventsHookAllowedEvents {
	ALL = "all",
	CONVERSATION_STARTED = "conversation.started",
	CONVERSATION_ENDED = "conversation.ended",
}

export const EVENTS = [
	{
		value: EventsHookAllowedEvents.ALL,
		label: "All",
	},
	{
		value: EventsHookAllowedEvents.CONVERSATION_STARTED,
		label: "Conversation Started",
	},
	{
		value: EventsHookAllowedEvents.CONVERSATION_ENDED,
		label: "Conversation Ended",
	},
];

export const eventsHookSchema = z
	.object({
		url: z
			.string()
			.optional()
			.refine(
				(val) => {
					// Allow empty string, undefined, or valid URL
					if (!val || val.trim() === "") return true;
					try {
						new URL(val);
						return true;
					} catch {
						return false;
					}
				},
				{ message: VALID_URL },
			),
		headers: z.record(z.string(), z.string()).optional(),
		events: z.array(z.nativeEnum(EventsHookAllowedEvents)).optional(),
	})
	.superRefine((data, ctx) => {
		// Only validate if URL is actually provided (not empty or undefined)
		if (data.url && data.url.trim() !== "" && (!data.events || data.events.length === 0)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "Events are required when URL is provided",
				path: ["events"],
			});
		}
	});
