import { z } from "zod/v4";
import { destinationShape, e164, patchOf } from "../shared/dto";

export const createPhoneNumberDto = z.strictObject({
	e164,
	label: z.string().max(128).nullish(),
	...destinationShape(true),
	/** Prefixed onto the inbound caller-id name, e.g. `[Support] `. */
	callerIdNamePrefix: z.string().max(32).nullish(),
	recordEnabled: z.boolean().optional(),
	emergencyAddressId: z.uuid().nullish(),
	voiceEnabled: z.boolean().optional(),
	faxEnabled: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const updatePhoneNumberDto = patchOf(createPhoneNumberDto);
