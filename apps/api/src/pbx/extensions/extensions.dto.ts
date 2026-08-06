import { z } from "zod/v4";
import { RECORD_POLICIES, TOLL_CLASSES } from "@optimiq-voice/pbx-db";
import { dialableString, displayName, internalNumber, patchOf } from "../shared/dto";

/**
 * The follow-me ladder, stored whole as JSON because it is small, ordered and read as a unit.
 */
const followMeTarget = z.strictObject({
	destination: dialableString,
	delaySeconds: z.int().min(0).max(300),
	timeoutSeconds: z.int().min(1).max(300),
	confirm: z.boolean().optional(),
});

export const createExtensionDto = z.strictObject({
	number: internalNumber,
	label: displayName,
	/** Handle into the secret manager. The SIP password itself never reaches this database. */
	sipSecretRef: z.string().min(1).max(256),
	sipPasswordHa1: z.string().min(1).max(128).nullish(),
	callerIdName: z.string().max(128).nullish(),
	callerIdNumber: z.string().max(32).nullish(),
	outboundCallerIdName: z.string().max(128).nullish(),
	outboundCallerIdNumber: z.string().max(32).nullish(),
	emergencyCallerIdName: z.string().max(128).nullish(),
	emergencyCallerIdNumber: z.string().max(32).nullish(),
	voicemailEnabled: z.boolean().optional(),
	doNotDisturb: z.boolean().optional(),
	forwardAllEnabled: z.boolean().optional(),
	forwardAllDestination: dialableString.nullish(),
	forwardBusyEnabled: z.boolean().optional(),
	forwardBusyDestination: dialableString.nullish(),
	forwardNoAnswerEnabled: z.boolean().optional(),
	forwardNoAnswerDestination: dialableString.nullish(),
	forwardUnregisteredEnabled: z.boolean().optional(),
	forwardUnregisteredDestination: dialableString.nullish(),
	followMe: z
		.strictObject({
			enabled: z.boolean(),
			ignoreBusy: z.boolean().optional(),
			targets: z.array(followMeTarget).max(10),
		})
		.nullish(),
	recordPolicy: z.enum(RECORD_POLICIES).optional(),
	mohClassId: z.uuid().nullish(),
	/**
	 * The anti-toll-fraud gate: an extension may only take an outbound route whose class its own
	 * class covers. `national` is the schema default and stays the default here — silently
	 * granting `international` to every new extension is how a compromised endpoint becomes an
	 * expensive weekend.
	 */
	tollClass: z.enum(TOLL_CLASSES).optional(),
	callTimeoutSeconds: z.int().min(5).max(300).optional(),
	maxRegistrations: z.int().min(1).max(20).optional(),
	codecOverride: z.string().max(128).nullish(),
	enabled: z.boolean().optional(),
});

export const updateExtensionDto = patchOf(createExtensionDto);

export type CreateExtensionDto = z.infer<typeof createExtensionDto>;
