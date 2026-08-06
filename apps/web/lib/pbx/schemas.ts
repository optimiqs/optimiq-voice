/**
 * Client schemas, mirroring the `*.dto.ts` files under `apps/api/src/pbx` — never importing them.
 *
 * The server's DTOs are built on `zod/v4` inside a Nest module that also pulls in Drizzle and a
 * Postgres driver; importing them would put the backend in the browser's dependency graph. So the
 * constraints are restated, and the trade is made explicit: **the server is the authority**. These
 * exist so the common mistakes (an empty name, a number with letters in it, a DID that is not
 * E.164) are caught before a round trip, not so the server can be trusted less. `schemas.spec.ts`
 * pins the shared primitives against the regexes `shared/dto.ts` uses.
 *
 * Only the fields the forms render are declared. That is the point of `PATCH` semantics — a form
 * sends what it edited and the API leaves everything else alone — so a schema that mirrored every
 * column would invite forms to send columns they never showed.
 */

import { z } from "zod";
import {
	FEATURE_CODE_ACTIONS,
	MOH_SOURCES,
	IVR_OPTION_MATCH_KINDS,
	QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES,
	QUEUE_STRATEGIES,
	RECORD_POLICIES,
	RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS,
	ROUTING_CONTEXTS,
	SIP_TRANSPORTS,
	TOLL_CLASSES,
	TRUNK_KINDS,
	VOICEMAIL_EMAIL_MODES,
	VOICEMAIL_GREETING_KINDS,
} from "./contracts";

// ---------------------------------------------------------------------------------------------
// Shared primitives, mirroring shared/dto.ts
// ---------------------------------------------------------------------------------------------

/** An internal number: digits only. The leading `*` space belongs to feature codes. */
export const internalNumber = z
	.string()
	.trim()
	.min(1, "Required")
	.max(16, "At most 16 digits")
	.regex(/^[0-9]+$/u, "Digits only");

/** E.164, `+` included — how every DID is stored. */
export const e164 = z
	.string()
	.trim()
	.min(2, "Required")
	.max(20, "At most 20 characters")
	.regex(/^\+[1-9]\d{1,18}$/u, "Must be E.164, e.g. +12125550100");

/** A dialable string: digits plus the characters a PBX actually dials. */
export const dialableString = z
	.string()
	.trim()
	.min(1, "Required")
	.max(64, "At most 64 characters")
	.regex(/^[+*#0-9A-Za-z._-]+$/u, "Must be a dialable string");

export const displayName = z.string().trim().min(1, "Required").max(128, "At most 128 characters");

/**
 * A text control that may be left blank.
 *
 * Blank means "clear it", which on a `PATCH` is `null` — not `""`. Several of these columns are
 * `nullish` on the server and an empty string would be stored verbatim, so a caller-id name the
 * user cleared would come back as a zero-length name rather than as absent.
 */
function optionalText(max: number) {
	return z
		.string()
		.trim()
		.max(max, `At most ${max} characters`)
		.transform((value) => (value.length === 0 ? null : value));
}

/** An optional internal number: blank clears it, anything else must be digits. */
function optionalDigits(max: number) {
	return z
		.string()
		.trim()
		.refine((value) => value === "" || new RegExp(`^[0-9]{1,${max}}$`, "u").test(value), {
			message: "Digits only",
		})
		.transform((value) => (value.length === 0 ? null : value));
}

/** A numeric control bound to the server's range. Empty falls back to the API's own default. */
function optionalInt(min: number, max: number) {
	return z
		.string()
		.trim()
		.transform((value) => (value.length === 0 ? null : Number(value)))
		.refine((value) => value === null || Number.isInteger(value), "Whole numbers only")
		.refine(
			(value) => value === null || (value >= min && value <= max),
			`Must be between ${min} and ${max}`,
		);
}

/**
 * A numeric control the server has NO default for, so blank is not "use the default" — it is a
 * missing required column.
 *
 * `park_lot.slot_start` and `slot_end` are the only two of these: every other integer on a PBX row
 * is `notNull().default(n)` and therefore {@link optionalInt}. Treating them the same would send
 * `undefined` for a column the DTO requires and turn an empty input into a 400 with no field.
 */
function requiredInt(min: number, max: number) {
	return z
		.string()
		.trim()
		.min(1, "Required")
		.transform((value) => Number(value))
		.refine((value) => Number.isInteger(value), "Whole numbers only")
		.refine((value) => value >= min && value <= max, `Must be between ${min} and ${max}`);
}

/** A select over another resource's rows, where the server column is a required uuid. */
const requiredReference = z.string().trim().min(1, "Required");

/**
 * A select over another resource's rows, where the server column is `z.uuid().nullish()`.
 *
 * Blank means "clear it", and on a `PATCH` that is `null` rather than an absent key — the same
 * distinction {@link optionalText} makes, but with sharper consequences. An absent key leaves the
 * stored id alone, so a form that omitted an emptied selector would let an operator clear the hold
 * music, press Save, and hear the old class on the next call with nothing on screen disagreeing.
 * `""` is not an option either: the column is a uuid and Postgres answers an empty string with a
 * `22P02` the user cannot act on.
 *
 * The uuid check is here rather than left to the server because these values come from a select
 * whose options are ids: anything else in the control is a bug in this app, and a message on the
 * field names it better than a 400 does.
 */
function optionalReference() {
	return z
		.string()
		.trim()
		.refine((value) => value === "" || z.uuid().safeParse(value).success, {
			message: "Pick one from the list",
		})
		.transform((value) => (value.length === 0 ? null : value));
}

export const timezoneName = z
	.string()
	.trim()
	.min(1, "Required")
	.max(64, "At most 64 characters")
	.regex(/^[A-Za-z]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$|^UTC$/u, "Must be an IANA zone, e.g. UTC");

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

/**
 * The extension form, in the two shapes the SIP secret reference can take.
 *
 * ## Why there are two, and why they are built by a function
 *
 * The server stopped returning `sipSecretRef` — it is `secretColumns` on `EXTENSION_RESOURCE` —
 * so the edit dialog has nothing to pre-fill and the field opens blank on every edit. Under the
 * create rule that blank is a validation error, which would mean nobody could rename an extension
 * without first knowing and retyping its secret handle. So blank means "leave the stored reference
 * alone" when editing, and the dialog omits the key from the PATCH rather than sending `null`. The
 * cost is that the form can no longer CLEAR a reference — not a state an extension can usefully be
 * in, since `extension.sip_secret_ref` is `NOT NULL`.
 *
 * They come out of a factory, and the field is annotated `ZodType<string | null, string>`, so that
 * both constants have the SAME static type. A dialog picks one at render time and hands it to
 * TanStack Form's `validators.onSubmit`, which takes a schema and not a union of schemas — an
 * `.extend()` that narrowed one field would type-check here and fail at the call site.
 */
type SecretRefField = z.ZodType<string | null, string>;

const requiredSecretRef: SecretRefField = z
	.string()
	.trim()
	.min(1, "Required")
	.max(256, "At most 256 characters");

const optionalSecretRef: SecretRefField = optionalText(256);

function extensionSchema(sipSecretRef: SecretRefField) {
	return z.strictObject({
		number: internalNumber,
		label: displayName,
		sipSecretRef,
		callerIdName: optionalText(128),
		callerIdNumber: optionalText(32),
		outboundCallerIdNumber: optionalText(32),
		tollClass: z.enum(TOLL_CLASSES),
		recordPolicy: z.enum(RECORD_POLICIES),
		callTimeoutSeconds: optionalInt(5, 300),
		maxRegistrations: optionalInt(1, 20),
		mohClassId: optionalReference(),
		voicemailEnabled: z.boolean(),
		doNotDisturb: z.boolean(),
		enabled: z.boolean(),
	});
}

/** Creating: a reference is required, because `POST /api/v1/extensions` requires one. */
export const extensionFormSchema = extensionSchema(requiredSecretRef);
export type ExtensionFormValues = z.input<typeof extensionFormSchema>;

/** Editing: blank means "keep the stored reference", and the dialog drops the key. */
export const extensionEditFormSchema = extensionSchema(optionalSecretRef);

export const phoneNumberFormSchema = z.strictObject({
	e164,
	label: optionalText(128),
	callerIdNamePrefix: optionalText(32),
	recordEnabled: z.boolean(),
	/**
	 * The dispatchable location this DID reports when somebody dials 911 (RAY BAUM'S Act).
	 *
	 * Blank means "no location assigned", which is a real and common state — a DID that is never
	 * used for outbound calls needs none — so it clears to `null` rather than being required. The
	 * form warns when a voice-enabled number has none; it does not refuse to save one, because the
	 * alternative is an admin who cannot add a number until they have an address for it.
	 */
	emergencyAddressId: optionalText(64),
	voiceEnabled: z.boolean(),
	faxEnabled: z.boolean(),
	enabled: z.boolean(),
});
export type PhoneNumberFormValues = z.input<typeof phoneNumberFormSchema>;

export const trunkFormSchema = z.strictObject({
	name: displayName,
	kind: z.enum(TRUNK_KINDS),
	sipDomain: z.string().trim().min(1, "Required").max(255, "At most 255 characters"),
	sipProxy: z.string().trim().min(1, "Required").max(255, "At most 255 characters"),
	outboundProxy: optionalText(255),
	authUser: optionalText(128),
	sipSecretRef: optionalText(256),
	transport: z.enum(SIP_TRANSPORTS),
	registerExpiresSeconds: optionalInt(30, 86_400),
	maxChannels: optionalInt(1, 10_000),
	codecPrefs: optionalText(128),
	callerIdNumberOverride: optionalText(32),
	enabled: z.boolean(),
});
export type TrunkFormValues = z.input<typeof trunkFormSchema>;

export const inboundRouteFormSchema = z
	.strictObject({
		name: displayName,
		priority: optionalInt(0, 10_000),
		matchKind: z.enum(ROUTE_MATCH_KINDS),
		matchPattern: optionalText(256),
		phoneNumberId: z.string().trim(),
		callerIdPattern: optionalText(256),
		timeConditionId: z.string().trim(),
		recordEnabled: z.boolean(),
		enabled: z.boolean(),
	})
	/**
	 * A route must be reachable. `any` matches everything and needs no pattern, and a route
	 * narrowed to one DID is matched by that DID — but every other match kind is a pattern match,
	 * and an empty pattern silently makes the route unreachable rather than universal.
	 */
	.refine(
		(value) =>
			value.matchKind === "any" ||
			value.phoneNumberId.length > 0 ||
			(value.matchPattern ?? "").length > 0,
		{ path: ["matchPattern"], message: "Give a pattern, pick a number, or match any call." },
	);
export type InboundRouteFormValues = z.input<typeof inboundRouteFormSchema>;

export const outboundRouteFormSchema = z.strictObject({
	name: displayName,
	priority: optionalInt(0, 10_000),
	matchKind: z.enum(ROUTE_MATCH_KINDS),
	/** One per line in the form; split before it reaches the schema. */
	dialPatterns: z
		.array(z.string().trim().min(1).max(256))
		.min(1, "At least one dial pattern")
		.max(50, "At most 50 dial patterns"),
	stripDigits: optionalInt(0, 20),
	prependDigits: optionalText(20),
	/**
	 * Required, never defaulted — the anti-toll-fraud gate. An extension may only take a route
	 * whose class its own class covers, so a route that forgot to say what it costs must not
	 * silently become the cheapest thing in the table.
	 */
	tollClass: z.enum(TOLL_CLASSES),
	trunkIds: z.array(z.uuid()).max(20, "At most 20 trunks"),
	timeConditionId: z.string().trim(),
	callerIdNumberOverride: optionalText(32),
	recordEnabled: z.boolean(),
	enabled: z.boolean(),
});
export type OutboundRouteFormValues = z.input<typeof outboundRouteFormSchema>;

export const timeConditionFormSchema = z.strictObject({
	name: displayName,
	timezone: timezoneName,
	enabled: z.boolean(),
});
export type TimeConditionFormValues = z.input<typeof timeConditionFormSchema>;

const wallClock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Must be HH:MM, 24-hour");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "Must be YYYY-MM-DD");

export const timeRuleFormSchema = z
	.strictObject({
		label: optionalText(128),
		ordinal: optionalInt(0, 1000),
		/** ISO weekdays, 1 = Monday … 7 = Sunday. Empty means "any day". */
		weekdays: z.array(z.number().int().min(1).max(7)).max(7),
		fromTime: z.string().trim(),
		toTime: z.string().trim(),
		fromDate: z.string().trim(),
		toDate: z.string().trim(),
		enabled: z.boolean(),
	})
	.refine((value) => (value.fromTime === "") === (value.toTime === ""), {
		path: ["toTime"],
		message: "Give both ends of the time window, or neither.",
	})
	.refine((value) => (value.fromDate === "") === (value.toDate === ""), {
		path: ["toDate"],
		message: "Give both ends of the date range, or neither.",
	})
	.refine((value) => value.fromTime === "" || wallClock.safeParse(value.fromTime).success, {
		path: ["fromTime"],
		message: "Must be HH:MM, 24-hour",
	})
	.refine((value) => value.toTime === "" || wallClock.safeParse(value.toTime).success, {
		path: ["toTime"],
		message: "Must be HH:MM, 24-hour",
	})
	.refine((value) => value.fromDate === "" || isoDate.safeParse(value.fromDate).success, {
		path: ["fromDate"],
		message: "Must be YYYY-MM-DD",
	})
	.refine((value) => value.toDate === "" || isoDate.safeParse(value.toDate).success, {
		path: ["toDate"],
		message: "Must be YYYY-MM-DD",
	})
	/**
	 * A predicate with nothing in it matches always. That IS legitimate — it is the default branch
	 * — but as the only rule on a condition it makes the no-match destination unreachable, which
	 * is never what someone building "business hours" meant.
	 */
	.refine((value) => value.weekdays.length > 0 || value.fromTime !== "" || value.fromDate !== "", {
		path: ["weekdays"],
		message: "Choose at least one weekday, a time window, or a date range.",
	});
export type TimeRuleFormValues = z.input<typeof timeRuleFormSchema>;

export const ivrMenuFormSchema = z.strictObject({
	name: displayName,
	extensionNumber: optionalDigits(16),
	digitTimeoutMs: optionalInt(500, 60_000),
	interDigitTimeoutMs: optionalInt(200, 30_000),
	maxDigits: optionalInt(1, 10),
	maxFailures: optionalInt(1, 10),
	maxTimeouts: optionalInt(1, 10),
	/**
	 * The four things a caller hears from this menu, in the order a call meets them: the greeting on
	 * arrival, the shorter one on every re-prompt, and the two apologies for a wrong key and for
	 * silence. All four are optional and a menu with none of them answers mute, which is legal and
	 * occasionally deliberate — a menu reached only from another menu that has already spoken.
	 */
	greetingPromptId: optionalReference(),
	shortGreetingPromptId: optionalReference(),
	invalidPromptId: optionalReference(),
	timeoutPromptId: optionalReference(),
	directDialEnabled: z.boolean(),
	enabled: z.boolean(),
});
export type IvrMenuFormValues = z.input<typeof ivrMenuFormSchema>;

export const ivrOptionFormSchema = z
	.strictObject({
		ordinal: optionalInt(0, 1000),
		matchKind: z.enum(IVR_OPTION_MATCH_KINDS),
		matchValue: z.string().trim().min(1, "Required").max(64, "At most 64 characters"),
		label: optionalText(128),
		enabled: z.boolean(),
	})
	.refine((value) => value.matchKind !== "digit" || /^[0-9*#]$/u.test(value.matchValue), {
		path: ["matchValue"],
		message: "A digit option is one of 0-9, * or #.",
	});
export type IvrOptionFormValues = z.input<typeof ivrOptionFormSchema>;

export const ringGroupFormSchema = z.strictObject({
	name: displayName,
	extensionNumber: optionalDigits(16),
	strategy: z.enum(RING_GROUP_STRATEGIES),
	ringTimeoutSeconds: optionalInt(5, 600),
	callerIdNamePrefix: optionalText(32),
	ignoreBusy: z.boolean(),
	confirmEnabled: z.boolean(),
	/**
	 * `confirmPromptId` is only reached when `confirmEnabled` is on — it is what the answering member
	 * hears before they press a key — but it is NOT refused when the switch is off. Storing the
	 * prompt while confirmation is disabled is how someone sets a group up in two sittings, and
	 * clearing it on save would be a form deleting configuration nobody asked it to delete.
	 */
	confirmPromptId: optionalReference(),
	mohClassId: optionalReference(),
	ringbackPromptId: optionalReference(),
	enabled: z.boolean(),
});
export type RingGroupFormValues = z.input<typeof ringGroupFormSchema>;

export const ringGroupMemberFormSchema = z.strictObject({
	ordinal: optionalInt(0, 1000),
	delaySeconds: optionalInt(0, 300),
	timeoutSeconds: optionalInt(1, 600),
	confirmRequired: z.boolean(),
	enabled: z.boolean(),
});
export type RingGroupMemberFormValues = z.input<typeof ringGroupMemberFormSchema>;

/**
 * A queue's own settings — everything the DTO calls a knob, and nothing about who answers it.
 *
 * The three audio columns are here now that `/moh-classes` and `/prompts` exist to select from, and
 * they behave differently from every other optional field on this form: an emptied numeric knob
 * sends `null` meaning "put the server default back", while an emptied SELECTOR sends `null`
 * meaning "play nothing at all". Both are `null` on the wire and the difference is entirely in the
 * column — `announceFrequencySeconds` is `notNull().default(n)`, `announcePromptId` is nullable.
 */
export const queueFormSchema = z.strictObject({
	name: displayName,
	extensionNumber: optionalDigits(16),
	strategy: z.enum(QUEUE_STRATEGIES),
	mohClassId: optionalReference(),
	greetingPromptId: optionalReference(),
	announcePromptId: optionalReference(),
	/** 0 disables the cap and callers wait indefinitely. */
	maxWaitSeconds: optionalInt(0, 86_400),
	maxWaitNoAgentSeconds: optionalInt(0, 86_400),
	wrapUpSeconds: optionalInt(0, 3600),
	announcePositionEnabled: z.boolean(),
	announceFrequencySeconds: optionalInt(5, 3600),
	abandonedResumeAllowed: z.boolean(),
	discardAbandonedAfterSeconds: optionalInt(0, 86_400),
	tierRulesApply: z.boolean(),
	tierRuleWaitSeconds: optionalInt(0, 3600),
	tierRuleNoAgentNoWait: z.boolean(),
	recordEnabled: z.boolean(),
	enabled: z.boolean(),
});
export type QueueFormValues = z.input<typeof queueFormSchema>;

/**
 * One agent.
 *
 * The reachability pair is checked here as well as on the server, and deliberately with the server's
 * own wording: `contact_kind` decides which of two nullable columns is the live one, and an agent
 * the engine cannot dial is a seat that silently never rings. Catching it before the round trip puts
 * the message on the control the user was editing.
 *
 * `statusChangedAt` is not here because it is not writable — it is stamped when `status` moves, and
 * a form that could backdate it would make every wallboard's "on this call for 12 minutes" a number
 * the agent chose.
 */
export const queueAgentFormSchema = z
	.strictObject({
		name: displayName,
		contactKind: z.enum(QUEUE_AGENT_CONTACT_KINDS),
		extensionId: z.string().trim(),
		contact: z
			.string()
			.trim()
			.refine((value) => value === "" || dialableString.safeParse(value).success, {
				message: "Must be a dialable string",
			})
			.transform((value) => (value.length === 0 ? null : value)),
		status: z.enum(QUEUE_AGENT_STATUSES),
		wrapUpSeconds: optionalInt(0, 3600),
		maxNoAnswer: optionalInt(1, 100),
		noAnswerDelaySeconds: optionalInt(0, 3600),
		busyDelaySeconds: optionalInt(0, 3600),
		rejectDelaySeconds: optionalInt(0, 3600),
		enabled: z.boolean(),
	})
	.refine((value) => value.contactKind !== "extension" || value.extensionId.length > 0, {
		path: ["extensionId"],
		message: "An extension-backed agent needs the extension the call is offered to.",
	})
	.refine((value) => value.contactKind !== "external" || value.contact !== null, {
		path: ["contact"],
		message: "An external agent needs the number to dial.",
	});
export type QueueAgentFormValues = z.input<typeof queueAgentFormSchema>;

/**
 * A tier: which agent serves which queue, at which ring level and in what order within it.
 *
 * `queueId` is in the FORM but never in the body — the queue is the path segment. It is here because
 * the same dialog is opened from a queue's page (where the queue is fixed) and from the agents list
 * (where it is the thing being chosen), and the validator must be able to say "pick a queue" in the
 * second case.
 */
export const queueTierFormSchema = z.strictObject({
	queueId: requiredReference,
	queueAgentId: requiredReference,
	/** Lower levels are offered the call first; every agent at a level is tried before the next. */
	level: optionalInt(1, 100),
	/** Order within the level, which `top-down` and `round-robin` walk in. */
	position: optionalInt(1, 1000),
});
export type QueueTierFormValues = z.input<typeof queueTierFormSchema>;

/**
 * A conference room.
 *
 * No PIN fields: a PIN is set through an endpoint that hashes it, never by pasting a digest into a
 * JSON body, and that endpoint does not exist yet. The dialog says so rather than offering a control
 * that would silently store nothing.
 */
export const conferenceFormSchema = z.strictObject({
	name: displayName,
	roomNumber: internalNumber,
	maxMembers: optionalInt(2, 1000),
	mohClassId: optionalReference(),
	recordEnabled: z.boolean(),
	announceJoinLeave: z.boolean(),
	waitForModerator: z.boolean(),
	enabled: z.boolean(),
});
export type ConferenceFormValues = z.input<typeof conferenceFormSchema>;

/**
 * A park lot: an inclusive slot range and what happens to a call nobody picks back up.
 *
 * The range check mirrors the server's, which mirrors a check constraint. Without it the database
 * refuses the row with a `23514` that surfaces as a 503 — a failure the user cannot act on — so both
 * layers turn it into a message on `slotEnd`.
 */
export const parkLotFormSchema = z
	.strictObject({
		name: displayName,
		slotStart: requiredInt(1, 99_999),
		slotEnd: requiredInt(1, 99_999),
		timeoutSeconds: optionalInt(5, 86_400),
		mohClassId: optionalReference(),
		enabled: z.boolean(),
	})
	.refine((value) => value.slotEnd >= value.slotStart, {
		path: ["slotEnd"],
		message: "The last slot must not be lower than the first.",
	});
export type ParkLotFormValues = z.input<typeof parkLotFormSchema>;

export const featureCodeFormSchema = z.strictObject({
	code: z
		.string()
		.trim()
		.min(2, "Required")
		.max(16, "At most 16 characters")
		.regex(/^\*[0-9*#]+$/u, "Must start with * and contain only digits, * or #"),
	action: z.enum(FEATURE_CODE_ACTIONS),
	label: optionalText(128),
	enabled: z.boolean(),
});
export type FeatureCodeFormValues = z.input<typeof featureCodeFormSchema>;

export const voicemailBoxFormSchema = z
	.strictObject({
		mailboxNumber: internalNumber,
		label: optionalText(128),
		emailAddress: z
			.string()
			.trim()
			.refine((value) => value === "" || z.email().safeParse(value).success, {
				message: "Enter a valid email address",
			})
			.transform((value) => (value.length === 0 ? null : value)),
		emailMode: z.enum(VOICEMAIL_EMAIL_MODES),
		deleteAfterDelivery: z.boolean(),
		transcriptionEnabled: z.boolean(),
		mwiEnabled: z.boolean(),
		maxMessages: optionalInt(1, 10_000),
		maxMessageSeconds: optionalInt(10, 3600),
		enabled: z.boolean(),
	})
	/**
	 * "Email and delete" with nowhere to send it destroys every message the box receives. The
	 * server accepts the combination — it is only unsound in context — so the guard belongs here.
	 */
	.refine((value) => !value.deleteAfterDelivery || value.emailAddress !== null, {
		path: ["emailAddress"],
		message: "Delivering and deleting needs an email address, or messages are lost.",
	});
export type VoicemailBoxFormValues = z.input<typeof voicemailBoxFormSchema>;

export const simulateFormSchema = z.strictObject({
	routingContext: z.enum(ROUTING_CONTEXTS),
	destinationNumber: dialableString,
	callerNumber: z
		.string()
		.trim()
		.refine((value) => value === "" || dialableString.safeParse(value).success, {
			message: "Must be a dialable string",
		}),
	at: z.string().trim(),
});
export type SimulateFormValues = z.input<typeof simulateFormSchema>;

/** Splits a textarea of dial patterns into the array the API wants. */
export function parseDialPatterns(text: string): string[] {
	return text
		.split(/[\n,]/u)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

// ---------------------------------------------------------------------------------------------
// The media library
// ---------------------------------------------------------------------------------------------

/**
 * A music-on-hold class name.
 *
 * Stricter than `displayName` for a reason that is not cosmetic: the name is what the compiler
 * resolves every `mohClassId` to, and what the media server looks up as a section in
 * `musiconhold.conf`. A `]` or a newline in it is a configuration file that does not parse, so the
 * alphabet is the one every PBX has used for this since the beginning.
 */
export const mohClassName = z
	.string()
	.trim()
	.min(1, "Required")
	.max(64, "At most 64 characters")
	.regex(
		/^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
		"Letters, digits, dot, dash and underscore only — this becomes a class name in the media server",
	);

/**
 * A hold-music class.
 *
 * The refinement mirrors the server's: a `stream` class with no URI is a class that plays silence
 * to everyone on hold, and the media server has no way to report it. Refused on the field that is
 * missing, so the message lands on the control that produced it.
 */
export const mohClassFormSchema = z
	.strictObject({
		name: mohClassName,
		description: optionalText(512),
		source: z.enum(MOH_SOURCES),
		streamUri: optionalText(512),
		shuffle: z.boolean(),
		sampleRateHz: z.union([z.literal(8000), z.literal(16_000), z.literal(48_000)]),
		isDefault: z.boolean(),
		enabled: z.boolean(),
	})
	.refine((value) => value.source !== "stream" || value.streamUri !== null, {
		path: ["streamUri"],
		message: "A streaming class needs the URI the media server should pull",
	});
export type MohClassFormValues = z.input<typeof mohClassFormSchema>;

/**
 * A prompt's metadata.
 *
 * Only two fields, and that is the whole editable surface: `objectKey`, `contentType`, `sizeBytes`
 * and `checksum` are facts about the STORED OBJECT, written by the upload path from the bytes it
 * actually stored. The API refuses them in a `PATCH` body — accepting an object key from a client
 * would let an admin re-point a library entry at another tenant's file by editing a string.
 *
 * Replacing the audio is a new upload, not an edit: the object key is what a compiled artifact and
 * a live call may already be holding.
 */
export const promptFormSchema = z.strictObject({
	name: displayName,
	language: z
		.string()
		.trim()
		.min(1, "Required")
		.max(35, "At most 35 characters")
		.regex(/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u, "Must be a language tag, e.g. en-US"),
});
export type PromptFormValues = z.input<typeof promptFormSchema>;

/** The upload form: a file, plus the two things the server will otherwise infer from the file. */
export const promptUploadFormSchema = z.strictObject({
	name: optionalText(128),
	language: z
		.string()
		.trim()
		.max(35, "At most 35 characters")
		.regex(/^$|^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u, "Must be a language tag, e.g. en-US"),
});
export type PromptUploadFormValues = z.input<typeof promptUploadFormSchema>;

/** A voicemail greeting upload: which slot it fills, what to call it, whether to use it now. */
export const greetingUploadFormSchema = z.strictObject({
	kind: z.enum(VOICEMAIL_GREETING_KINDS),
	label: optionalText(128),
	active: z.boolean(),
});
export type GreetingUploadFormValues = z.input<typeof greetingUploadFormSchema>;

// ---------------------------------------------------------------------------------------------
// E911
// ---------------------------------------------------------------------------------------------

/**
 * A dispatchable location.
 *
 * Deliberately shallow, and this mirrors the server's reasoning rather than being lazy about it:
 * the address is going to be validated by a CARRIER'S E911 API against the authoritative database,
 * and a second, weaker validator here would refuse addresses that exist — for a building somebody
 * may one day dial 911 from. So the only rules are the ones that are wrong in every jurisdiction.
 *
 * `locationDetail` is optional and strongly recommended, and the form says which: a responder given
 * a twelve-floor office block and no floor number is the failure RAY BAUM'S was written about.
 *
 * `validated` is absent and always will be. It is a fact a provider asserted, not a value an admin
 * may set — accepting it here would let anyone with `numbers.emergency` mark an unverified address
 * as verified, which for a field whose entire purpose is regulatory assurance is not a validation
 * bug but a compliance one.
 */
export const emergencyAddressFormSchema = z.strictObject({
	label: displayName,
	streetLine1: z.string().trim().min(1, "Required").max(128, "At most 128 characters"),
	streetLine2: optionalText(128),
	locationDetail: optionalText(128),
	locality: z.string().trim().min(1, "Required").max(128, "At most 128 characters"),
	administrativeArea: z.string().trim().min(1, "Required").max(128, "At most 128 characters"),
	postalCode: z.string().trim().min(1, "Required").max(32, "At most 32 characters"),
	country: z
		.string()
		.trim()
		.length(2, "Two letters, e.g. US")
		.regex(/^[A-Za-z]{2}$/u, "Two letters, e.g. US")
		.transform((value) => value.toUpperCase()),
});
export type EmergencyAddressFormValues = z.input<typeof emergencyAddressFormSchema>;

// ---------------------------------------------------------------------------------------------
// PINs
// ---------------------------------------------------------------------------------------------

/**
 * A telephone-keypad PIN, mirroring `voicemailPinIssue` in `apps/api`.
 *
 * One schema for the mailbox PIN and both conference PINs, because the server uses one function for
 * all three: the keypad has ten keys, `#` terminates entry, and with three attempts per call a PIN
 * drawn from the handful an attacker tries first is materially weaker than one that is not.
 *
 * The blocklist stops at two shapes on purpose. A longer one — birthdays, `1122`, keypad patterns —
 * starts guessing at what a user meant and produces "rejected, and I do not know why", which is how
 * PINs end up written on the handset.
 */
export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 10;

export function keypadPinIssue(pin: string): string | undefined {
	if (!/^\d+$/u.test(pin)) {
		return "A PIN is digits only — it is entered on a telephone keypad.";
	}
	if (pin.length < MIN_PIN_LENGTH || pin.length > MAX_PIN_LENGTH) {
		return `A PIN is between ${MIN_PIN_LENGTH} and ${MAX_PIN_LENGTH} digits.`;
	}
	if ([...pin].every((digit) => digit === pin[0])) {
		return "A PIN of one repeated digit is among the first an attacker tries.";
	}
	if (isStraightRun(pin)) {
		return "A PIN that counts up or down is among the first an attacker tries.";
	}
	return undefined;
}

function isStraightRun(pin: string): boolean {
	let ascending = true;
	let descending = true;
	for (let index = 1; index < pin.length; index += 1) {
		const step = Number(pin[index]) - Number(pin[index - 1]);
		if (step !== 1) {
			ascending = false;
		}
		if (step !== -1) {
			descending = false;
		}
	}
	return ascending || descending;
}
