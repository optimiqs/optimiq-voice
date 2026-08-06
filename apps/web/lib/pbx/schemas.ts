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
	IVR_OPTION_MATCH_KINDS,
	RECORD_POLICIES,
	RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS,
	ROUTING_CONTEXTS,
	SIP_TRANSPORTS,
	TOLL_CLASSES,
	TRUNK_KINDS,
	VOICEMAIL_EMAIL_MODES,
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

export const timezoneName = z
	.string()
	.trim()
	.min(1, "Required")
	.max(64, "At most 64 characters")
	.regex(/^[A-Za-z]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$|^UTC$/u, "Must be an IANA zone, e.g. UTC");

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

export const extensionFormSchema = z.strictObject({
	number: internalNumber,
	label: displayName,
	sipSecretRef: z.string().trim().min(1, "Required").max(256, "At most 256 characters"),
	callerIdName: optionalText(128),
	callerIdNumber: optionalText(32),
	outboundCallerIdNumber: optionalText(32),
	tollClass: z.enum(TOLL_CLASSES),
	recordPolicy: z.enum(RECORD_POLICIES),
	callTimeoutSeconds: optionalInt(5, 300),
	maxRegistrations: optionalInt(1, 20),
	voicemailEnabled: z.boolean(),
	doNotDisturb: z.boolean(),
	enabled: z.boolean(),
});
export type ExtensionFormValues = z.input<typeof extensionFormSchema>;

export const phoneNumberFormSchema = z.strictObject({
	e164,
	label: optionalText(128),
	callerIdNamePrefix: optionalText(32),
	recordEnabled: z.boolean(),
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
