import { z } from "zod";
import * as Messages from "../messages";

enum EventsHookAllowedEvents {
  ALL = "all",
  CONVERSATION_STARTED = "conversation.started",
  CONVERSATION_ENDED = "conversation.ended"
}

const eventsHookSchema = z.object({
  url: z.string().url({ message: Messages.VALID_URL }),
  headers: z.record(z.string(), z.string()).optional(),
  events: z
    .array(z.nativeEnum(EventsHookAllowedEvents))
    .min(1)
    .default([EventsHookAllowedEvents.ALL])
});

export { eventsHookSchema, EventsHookAllowedEvents };
