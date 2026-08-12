import { z } from "zod/v4";
import { CALL_FLOW_MODES, TIME_CONDITION_OVERRIDES } from "@optimiq-voice/pbx-db";
import {
	destinationShape,
	displayName,
	internalNumber,
	namedDestinationShape,
	patchOf,
	shortCode,
} from "../shared/dto";

/**
 * A call flow.
 *
 * `mode` is absent from both write DTOs on purpose — see `call-flows.resource.ts`. It moves through
 * the toggle endpoint, which is a different grant and which also writes the presence entry a
 * busy-lamp key renders; a PATCH that set the column would change the routing and leave every lamp
 * in the building showing the old position.
 */
const callFlowShape = {
	name: displayName,
	/** Nullable for the reason a ring group's is: a flow reached only by its code has no number. */
	extensionNumber: internalNumber.nullish(),
	/**
	 * The star code that toggles the flow, and the key a BLF lamp is provisioned with.
	 *
	 * Upstream numbers these `*28` plus a per-flow suffix. Nothing here enforces that shape: the
	 * suffix is the tenant's, and the check that matters is the compile-time screen against the
	 * feature-code catalogue — two mechanisms answering the same digits is the failure this feature
	 * can have, and it is not one a regex at the edge can see.
	 */
	featureCode: shortCode.nullish(),
	/** Where calls go in day mode. */
	...destinationShape(true),
	/** Where calls go in night mode. Required — a switch with one position is not a switch. */
	...namedDestinationShape("night"),
	enabled: z.boolean().optional(),
};

export const createCallFlowDto = z.strictObject(callFlowShape);

export const updateCallFlowDto = patchOf(z.strictObject(callFlowShape));

/**
 * The toggle body.
 *
 * `mode` is optional and its absence means "the other one". A caller that knows what it wants sends
 * it — which is what makes the endpoint idempotent for a UI that has just rendered the current
 * state — and a handset-shaped caller that only knows "flip it" omits it. Refusing the second form
 * would make the button on a wallboard read the row first purely to say what it already said.
 */
export const toggleCallFlowDto = z.strictObject({
	mode: z.enum(CALL_FLOW_MODES).optional(),
});

/**
 * The time-condition override body.
 *
 * `override` is optional and absent means "advance one step around the cycle" —
 * `auto -> forced-match -> forced-no-match -> auto` — which is what a handset pressing the code
 * does. A ring rather than a toggle because there are three states, and it always returns to
 * obeying the clock, which is the state a tenant should reach by pressing the key enough times
 * rather than by finding the admin screen.
 */
export const overrideTimeConditionDto = z.strictObject({
	override: z.enum(TIME_CONDITION_OVERRIDES).optional(),
});
