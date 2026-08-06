import { z } from "zod/v4";

/**
 * The agent-session request bodies.
 *
 * Three of the four actions take nothing at all. `pause` takes a reason, and it is optional: a
 * console that forced one would get "brb" typed into it forever, and a supervisor reading a
 * wallboard learns nothing from a mandatory field nobody fills honestly. When it IS given it is
 * stored on the `agent-state` entry and rides out on the `agent.state` event, so it appears on the
 * wallboard next to the agent — which is the only reason to collect it.
 *
 * `strictObject` for the same reason every other DTO here uses it: a typo'd key is a value the
 * caller believes they sent and the server silently dropped.
 */

/** Bounded by `agentStateEntrySchema.reason`, which the KV value enforces on the way in. */
export const pauseAgentSessionDto = z.strictObject({
	reason: z.string().trim().min(1).max(128).optional(),
});

/**
 * Login, logout and resume take an empty body.
 *
 * Declared rather than skipped so `POST … {"status":"available"}` is a 400 rather than a request
 * that looks like it set something. The action is in the PATH, and it is the only thing that
 * decides the target status — a body that could name one would be a second, unguarded way to write
 * the machine.
 */
export const emptyAgentSessionDto = z.strictObject({});
