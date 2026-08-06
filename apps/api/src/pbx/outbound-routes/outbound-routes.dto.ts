import { z } from "zod/v4";
import { ROUTE_MATCH_KINDS, TOLL_CLASSES } from "@optimiq-voice/pbx-db";
import { displayName, namedDestinationShape, patchOf, resettable } from "../shared/dto";

/** One trunk in the ordered failover chain. `weight` shares load between equal `order`s. */
const trunkPriorityEntry = z.strictObject({
	trunkId: z.uuid(),
	order: z.int().min(0).max(100),
	weight: z.int().min(1).max(1000).optional(),
});

export const createOutboundRouteDto = z.strictObject({
	name: displayName,
	priority: resettable(z.int().min(0).max(10_000)),
	matchKind: z.enum(ROUTE_MATCH_KINDS).optional(),
	/** Ordered alternatives; the first that matches wins. */
	dialPatterns: z.array(z.string().min(1).max(256)).min(1).max(50),
	stripDigits: resettable(z.int().min(0).max(20)),
	prependDigits: z.string().max(20).nullish(),
	/**
	 * Required, never defaulted. An extension may only take this route when its own `tollClass`
	 * covers this one — the anti-toll-fraud gate — so a route that forgot to say what it costs
	 * must not silently become the cheapest thing in the table.
	 */
	tollClass: z.enum(TOLL_CLASSES),
	trunkPriority: z.array(trunkPriorityEntry).max(20),
	timeConditionId: z.uuid().nullish(),
	...namedDestinationShape("failover"),
	callerIdNumberOverride: z.string().max(32).nullish(),
	recordEnabled: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const updateOutboundRouteDto = patchOf(createOutboundRouteDto);
