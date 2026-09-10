import { z } from "zod/v4";
import { RECORDING_CONSENT_POLICIES } from "@optimiq-voice/pbx-db";
import { destinationShape, e164, patchOf } from "../shared/dto";

export const createPhoneNumberDto = z.strictObject({
	e164,
	label: z.string().max(128).nullish(),
	...destinationShape(true),
	/** Prefixed onto the inbound caller-id name, e.g. `[Support] `. */
	callerIdNamePrefix: z.string().max(32).nullish(),
	recordEnabled: z.boolean().optional(),
	/**
	 * What this DID asks of a call it records, overriding the organization's own consent policy.
	 *
	 * Nullable and NOT `resettable`, because `null` is a real answer with a meaning of its own:
	 * "inherit the org", which is where every DID starts and where an admin clearing the field puts
	 * it back. The three-member enum has no "unset" arm — `none` means the tenant decided this DID
	 * announces nothing, which is a different instruction from declining to decide.
	 */
	recordingConsentPolicy: z.enum(RECORDING_CONSENT_POLICIES).nullish(),
	/** The prompt played when this DID announces. `null` falls back to the seeded system stem. */
	recordingConsentPromptId: z.uuid().nullish(),
	emergencyAddressId: z.uuid().nullish(),
	voiceEnabled: z.boolean().optional(),
	faxEnabled: z.boolean().optional(),
	enabled: z.boolean().optional(),
});

export const updatePhoneNumberDto = patchOf(createPhoneNumberDto);
