import { z } from "zod/v4";
import { CALLER_ID_PRESENTATIONS, RECORD_POLICIES, TOLL_CLASSES } from "@optimiq-voice/pbx-db";
import {
	callerIdNumber,
	dialableString,
	displayName,
	internalNumber,
	patchOf,
	resettable,
} from "../shared/dto";

/**
 * The follow-me ladder, stored whole as JSON because it is small, ordered and read as a unit.
 */
const followMeTarget = z.strictObject({
	destination: dialableString,
	delaySeconds: z.int().min(0).max(300),
	timeoutSeconds: z.int().min(1).max(300),
	confirm: z.boolean().optional(),
});

/**
 * A pickup group name: the set `*8` may answer within.
 *
 * Free text, because a group is a name an administrator gives a set of desks and has no properties
 * of its own — see the column's note in `pbx-db`. What it is NOT is free-form: this is the one
 * text field on an extension where blank and absent mean different things to the engine, so the
 * value is normalised here rather than left to the compiler.
 *
 * - **Trimmed**, so `"sales "` and `"sales"` are the same group. Matching is exact and
 *   case-SENSITIVE downstream (`Sales` and `sales` are two groups, because an administrator who
 *   typed both meant two things), which makes a stray space a silent one-member group.
 * - **Blank becomes `null`**, and whitespace-only is blank. `null` is "no group", which the
 *   compiler renders as an ABSENT `pickupGroup` and the engine reads as org-wide pickup. `""` in
 *   the column would be a third spelling of the same thing that only the compiler's own trimming
 *   saved us from; this stops it reaching the database at all.
 * - **Bounded at 64**, the same bound the other short labels in this area carry. A group name is
 *   typed on a form and compared verbatim in the artifact; nothing legitimate is longer.
 *
 * `.nullish()` last, so a PATCH can clear the group with an explicit `null` while an absent key
 * still means "leave it alone".
 */
const pickupGroupName = z
	.string()
	.trim()
	.max(64)
	.transform((value) => (value.length === 0 ? null : value))
	.nullish();

export const createExtensionDto = z.strictObject({
	number: internalNumber,
	label: displayName,
	/** Handle into the secret manager. The SIP password itself never reaches this database. */
	sipSecretRef: z.string().min(1).max(256),
	sipPasswordHa1: z.string().min(1).max(128).nullish(),
	callerIdName: z.string().max(128).nullish(),
	callerIdNumber,
	outboundCallerIdName: z.string().max(128).nullish(),
	outboundCallerIdNumber: callerIdNumber,
	/**
	 * Whether that number is shown to the far end — CLIR.
	 *
	 * `allowed` is the column default and stays the default here: an extension nobody has configured
	 * presents its number, which is what every extension did before this field existed. `restricted`
	 * is a standing withhold; a caller lifts it for one call with `*82`, or takes it for one call
	 * with `*67`. The number itself is unaffected — it still travels in `P-Asserted-Identity` for the
	 * carrier, and the emergency path ignores the setting outright.
	 */
	outboundCallerIdPresentation: z.enum(CALLER_ID_PRESENTATIONS).optional(),
	emergencyCallerIdName: z.string().max(128).nullish(),
	emergencyCallerIdNumber: callerIdNumber,
	voicemailEnabled: z.boolean().optional(),
	/**
	 * Screen external callers: record a name, play it to the extension, 1 accepts / 2 rejects.
	 * The column compiles into the artifact today; the walk's runtime ships behind a default-off
	 * setting (`callScreeningEnabled` in the engine), and a follow-me ladder outranks screening —
	 * both stated on the form so the toggle never promises behaviour the walk does not deliver.
	 */
	callScreening: z.boolean().optional(),
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
	/**
	 * Whether a recording on this extension pauses itself while the party types digits — the PCI
	 * knob, so a card number spoken into a keypad never reaches the object store.
	 *
	 * A plain optional boolean and not `nullish`, unlike the consent overrides on a DID: the column
	 * is `not null default false` and there is no third state to inherit. An extension that has not
	 * been thought about does not auto-pause, which is the behaviour every extension had before this
	 * existed.
	 */
	recordAutoPauseOnDtmf: z.boolean().optional(),
	mohClassId: z.uuid().nullish(),
	/**
	 * The anti-toll-fraud gate: an extension may only take an outbound route whose class its own
	 * class covers. `national` is the schema default and stays the default here — silently
	 * granting `international` to every new extension is how a compromised endpoint becomes an
	 * expensive weekend.
	 */
	tollClass: z.enum(TOLL_CLASSES).optional(),
	/** Which `*8` pickup group this extension belongs to. Blank/absent means none — see above. */
	pickupGroup: pickupGroupName,
	/**
	 * The PIN set whose codes may claim this extension on a shared handset — the hot-desk gate.
	 *
	 * `null` (the default) is not "no PIN needed", it is "this extension cannot be hot-desked". The
	 * column fails closed for the reason `devices-schema.ts` gives: an ungated `*31` would let
	 * anybody in the building take anybody's calls by knowing an extension number printed on a phone.
	 */
	hotDeskPinSetId: z.uuid().nullish(),
	callTimeoutSeconds: resettable(z.int().min(5).max(300)),
	maxRegistrations: resettable(z.int().min(1).max(20)),
	codecOverride: z.string().max(128).nullish(),
	enabled: z.boolean().optional(),
});

export const updateExtensionDto = patchOf(createExtensionDto);

export type CreateExtensionDto = z.infer<typeof createExtensionDto>;
