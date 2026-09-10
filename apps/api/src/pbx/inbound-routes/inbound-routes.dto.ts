import { z } from "zod/v4";
import { RECORDING_CONSENT_POLICIES, ROUTE_MATCH_KINDS } from "@optimiq-voice/pbx-db";
import {
	destinationShape,
	displayName,
	namedDestinationShape,
	patchOf,
	resettable,
} from "../shared/dto";

export const createInboundRouteDto = z.strictObject({
	name: displayName,
	/** Lowest first. The compiler sorts by `(priority asc, specificity desc, id asc)`. */
	priority: resettable(z.int().min(0).max(10_000)),
	matchKind: z.enum(ROUTE_MATCH_KINDS).optional(),
	matchPattern: z.string().max(256).nullish(),
	/** Narrows the route to one DID instead of a pattern. */
	phoneNumberId: z.uuid().nullish(),
	callerIdPattern: z.string().max(256).nullish(),
	...destinationShape(true),
	...namedDestinationShape("failover"),
	/** A gate: the route only applies while the condition's rules match. */
	timeConditionId: z.uuid().nullish(),
	recordEnabled: z.boolean().optional(),
	/**
	 * The same override {@link createPhoneNumberDto.shape.recordingConsentPolicy} carries, one level
	 * more specific: a route that matches a pattern rather than a single number, and that therefore
	 * beats the DID's answer for the calls it claims. `null` inherits — from the DID if the route
	 * names one, from the organization otherwise.
	 */
	recordingConsentPolicy: z.enum(RECORDING_CONSENT_POLICIES).nullish(),
	recordingConsentPromptId: z.uuid().nullish(),
	enabled: z.boolean().optional(),
});

export const updateInboundRouteDto = patchOf(createInboundRouteDto);
