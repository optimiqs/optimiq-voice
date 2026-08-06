import { z } from "zod/v4";
import { ROUTING_CONTEXTS } from "@optimiq-voice/routing";
import { dialableString } from "../shared/dto";

/**
 * "What happens if someone calls this number?"
 *
 * `at` is explicit because time conditions are first-class routing predicates: a simulation
 * without a clock can only answer "what happens right now", which is the one question an admin
 * configuring out-of-hours behaviour cannot use.
 */
export const simulateRoutingDto = z.strictObject({
	routingContext: z.enum(ROUTING_CONTEXTS),
	destinationNumber: dialableString,
	callerNumber: dialableString.optional(),
	callerName: z.string().max(128).optional(),
	at: z.iso.datetime().optional(),
});

export type SimulateRoutingDto = z.infer<typeof simulateRoutingDto>;
