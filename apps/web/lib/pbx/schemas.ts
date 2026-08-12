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
import { networkIssue, normalizeNetwork } from "./cidr";
import {
	CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS,
	CALL_BLOCK_MATCH_KINDS,
	DIRECTORY_SEARCH_FIELDS,
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
	SIP_ACL_ACTIONS,
	SIP_ACL_SCOPES,
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
 * A star code or short code a phone can dial: `*281`, `*01`, `8001`.
 *
 * Mirrors `shortCode` in `apps/api/src/pbx/shared/dto.ts`, and it is deliberately NOT
 * {@link internalNumber}: a code MAY begin with `*` and an extension may not — that space belongs to
 * the feature codes, and a code that lives in it has to be screened against them, which the COMPILER
 * does. Nothing here checks for a collision, because a collision is a fact about the whole tenant
 * rather than about this row: the compiler's diagnostic is what says "`*281` already answers to
 * something", and it runs inside the write transaction.
 */
export const shortCode = z
	.string()
	.trim()
	.min(1, "Required")
	.max(10, "At most 10 characters")
	.regex(/^[*#]?[0-9*#]+$/u, "Digits, optionally led by * or #");

/** An optional short code: blank clears it, anything else must be a dialable code. */
const optionalShortCode = z
	.string()
	.trim()
	.refine((value) => value === "" || shortCode.safeParse(value).success, {
		message: "Digits, optionally led by * or #",
	})
	.transform((value) => (value.length === 0 ? null : value));

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
		/**
		 * The `*8` pickup group, bounded at 64 to match `pickupGroupName` in the server's DTO.
		 *
		 * {@link optionalText} and not a plain string: blank has to reach the server as `null`, and
		 * this is the one text column on an extension where that matters beyond tidiness. `""` in
		 * the column would be a group whose only member is an extension nobody meant to group, and
		 * `null` is the documented "no group, fall back to organization-wide pickup".
		 */
		pickupGroup: optionalText(64),
		/**
		 * Screen external callers before this extension is rung.
		 *
		 * A plain boolean with no conditional partner, unlike `confirmEnabled`/`confirmPromptId` on a
		 * ring group: the prompts a screen plays are deployment settings on the walker
		 * (`screeningRecordPrompt`, `screeningIntroPrompt`), not columns on the extension, so there is
		 * nothing on this form for the switch to gate.
		 */
		callScreening: z.boolean(),
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

/**
 * The follow-me ladder, mirroring `followMeTarget` in `apps/api/src/pbx/extensions/extensions.dto.ts`.
 *
 * It is NOT part of `extensionSchema`, and that is deliberate: `follow_me` is one JSON column
 * written as a whole object, so the dialog holds it beside the flat form rather than inside it —
 * the same separation the destination trio and the trunk chain already use. Keeping it out also
 * keeps `z.input<typeof extensionFormSchema>` a flat record of strings and booleans, which is what
 * TanStack Form's `defaultValues` wants.
 *
 * Both numbers are REQUIRED per target, because the server's `followMeTarget` is a `strictObject`
 * with neither key optional — a blank box is a 400, not "use the default". The editor pre-fills a
 * new row rather than leaving them empty, so the requirement is only ever met by someone who
 * cleared a box on purpose.
 *
 * The ceiling is the server's `.max(10)`. It is restated rather than left to the round trip because
 * an eleventh target is refused with a path (`followMe.targets`) that collapses to one message on
 * the whole section — which does not say which row to delete.
 */
export const MAX_FOLLOW_ME_TARGETS = 10;

export const followMeTargetFormSchema = z.strictObject({
	/** An extension number or an external number — the column is a dialable string, not a ref. */
	destination: dialableString,
	delaySeconds: requiredInt(0, 300),
	timeoutSeconds: requiredInt(1, 300),
	/**
	 * "Press 1 to accept." Optional on the wire and therefore defaulted to `false` here: a target
	 * that never carried the key must round-trip through this form unchanged.
	 */
	confirm: z.boolean(),
});
export type FollowMeTargetFormValues = z.input<typeof followMeTargetFormSchema>;

export const followMeFormSchema = z.strictObject({
	enabled: z.boolean(),
	ignoreBusy: z.boolean(),
	targets: z
		.array(followMeTargetFormSchema)
		.max(MAX_FOLLOW_ME_TARGETS, `At most ${MAX_FOLLOW_ME_TARGETS} targets`),
});
export type FollowMeFormValues = z.input<typeof followMeFormSchema>;
export type FollowMeParsedValues = z.output<typeof followMeFormSchema>;

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
 * A paging group, mirroring `apps/api/src/pbx/paging-groups/paging-groups.dto.ts`.
 *
 * Shorter than its ring-group sibling by exactly the thing that makes it a page rather than a call:
 * there is no destination trio and no strategy. A page has nowhere to continue to — the pager
 * speaks, the handsets auto-answer, and the announcement ends when the pager hangs up — so there is
 * no "when nobody answers" branch to configure, because a page does not wait for an answer.
 *
 * `timeoutSeconds` is therefore NOT a ring time. It is how long ONE member's auto-answered leg may
 * take to come up before it is given up on, which is why the server's ceiling is 300 rather than the
 * ring group's 600: 600 is how long a HUMAN is given to pick up, and nothing here is waiting for a
 * human.
 */
export const pagingGroupFormSchema = z.strictObject({
	name: displayName,
	/**
	 * Blank is legal and means "no number": a group reachable only through the `*81` feature code has
	 * none, and forcing one would make an operator invent digits that then collide with an extension.
	 * {@link optionalDigits} sends that blank as `null`, which the nullable column takes as "clear it".
	 */
	extensionNumber: optionalDigits(16),
	duplex: z.boolean(),
	timeoutSeconds: optionalInt(5, 300),
	enabled: z.boolean(),
});
export type PagingGroupFormValues = z.input<typeof pagingGroupFormSchema>;

/**
 * One handset in a group.
 *
 * `extensionId` is REQUIRED and is a plain reference rather than a destination, which is the whole
 * difference from a ring-group member: the engine originates an auto-answered leg to the member, and
 * only a registered endpoint can be told to pick up. An external number over a trunk cannot, so the
 * form offers extensions and nothing else.
 *
 * Not {@link optionalReference}: blank is not "clear it" here, it is a member that pages nobody.
 */
export const pagingGroupMemberFormSchema = z.strictObject({
	extensionId: z
		.string()
		.trim()
		.min(1, "Required")
		.refine((value) => z.uuid().safeParse(value).success, "Pick one from the list"),
	ordinal: optionalInt(0, 1000),
	enabled: z.boolean(),
});
export type PagingGroupMemberFormValues = z.input<typeof pagingGroupMemberFormSchema>;

/**
 * A caller-screening rule, mirroring `apps/api/src/pbx/call-block/call-block.dto.ts`.
 *
 * ## `pattern` is length-bounded and nothing else, deliberately
 *
 * The obvious schema — a discriminated union that validates the string against `matchKind` — was
 * the server's first draft too, and it was dropped there for a reason that applies twice as hard
 * here. `compilePattern` in `@optimiq-voice/routing` is the function whose opinion decides whether
 * a rule can be ENFORCED, and `compileCallBlock` runs it inside the write transaction: an
 * uncompilable pattern is a 422 addressed at `pattern` that rolls the insert back, and an
 * unanchored regex is a warning carried in the mutation envelope and rendered next to the field.
 *
 * A regex validator in the browser would be a THIRD opinion — after the compiler's and the DTO's —
 * and the three would disagree on the first interesting input, with this one being the copy that
 * refuses a rule the engine would happily enforce. So the bound is a LENGTH bound, matching the
 * DTO's `min(1).max(256)`, because a regex may legitimately contain almost anything.
 *
 * ## What is absent, and why a strict object is what keeps it absent
 *
 * `hitCount` and `lastHitAt` are enforcement counters. The server's `z.strictObject` answers a
 * client that sends one with a 400 naming the field rather than dropping it silently, so a form
 * that offered them would fail the whole save rather than ignore two controls. `z.strictObject`
 * here is what stops a copied block from adding them.
 */
export const callBlockRuleFormSchema = z.strictObject({
	pattern: z.string().trim().min(1, "Required").max(256, "At most 256 characters"),
	matchKind: z.enum(CALL_BLOCK_MATCH_KINDS),
	direction: z.enum(CALL_BLOCK_DIRECTIONS),
	action: z.enum(CALL_BLOCK_ACTIONS),
	/** Blank clears the note; the column is `nullish` on the server and `""` would be stored. */
	label: optionalText(128),
	enabled: z.boolean(),
});
export type CallBlockRuleFormValues = z.input<typeof callBlockRuleFormSchema>;

/**
 * A queue's own settings — everything the DTO calls a knob, and nothing about who answers it.
 *
 * The four audio columns are here now that `/moh-classes` and `/prompts` exist to select from, and
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
	/**
	 * Played to the ANSWERING AGENT alone, before the caller is bridged in.
	 *
	 * The same helper as the two above and the opposite side of the bridge: those two play to the
	 * caller, this one never does. Blank clears it, because the column is nullable — an agent with no
	 * whisper simply gets the call.
	 */
	agentWhisperPromptId: optionalReference(),
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
// The T2 admin block
// ---------------------------------------------------------------------------------------------

/**
 * A call flow — the day/night switch.
 *
 * `mode` is absent and its absence is the contract: `createCallFlowDto` and `updateCallFlowDto` both
 * omit it, because moving the switch is `POST /call-flows/:id/toggle` behind `call-flows.toggle`
 * rather than a field behind `call-flows.write`. `z.strictObject` here is what stops a copied block
 * from adding it — the server would answer a body carrying `mode` with a 400 naming the field.
 *
 * The two destination trios are not here either, for the reason every trio is held beside its form
 * rather than inside it: they are three columns each and the picker owns them. BOTH are required,
 * which is unusual — a flow with one position is not a switch — and the dialog passes
 * `{ required: true }` to `validateDestinationValue` for each.
 */
export const callFlowFormSchema = z.strictObject({
	name: displayName,
	/** Blank is legal: a flow reached only by its toggle code has no number of its own. */
	extensionNumber: optionalDigits(16),
	/**
	 * The star code that toggles the flow, and the key a BLF lamp is provisioned with.
	 *
	 * Upstream numbers these `*28` plus a per-flow suffix, and nothing here enforces that shape — the
	 * suffix is the tenant's. The check that matters is the compile-time screen against the
	 * feature-code catalogue, because two mechanisms answering the same digits is a collision with no
	 * runtime symptom beyond the wrong one winning.
	 */
	featureCode: optionalShortCode,
	enabled: z.boolean(),
});
export type CallFlowFormValues = z.input<typeof callFlowFormSchema>;

/**
 * A PIN set — the list, never a code.
 *
 * Nothing on this form reaches a secret, and there is no field that could: the codes live on the
 * entries and are set through an endpoint that hashes them. See {@link pinSchema}.
 */
export const pinSetFormSchema = z.strictObject({
	name: displayName,
	description: optionalText(512),
	/** What the caller hears when they are asked for a code, and when they get it wrong. */
	promptId: optionalReference(),
	failurePromptId: optionalReference(),
	/**
	 * Three is the universal telephone answer and the bound below it is the reason: a four-digit PIN
	 * behind unbounded retries is a keypad away from being brute forced during one long call.
	 */
	maxAttempts: optionalInt(1, 10),
	digitTimeoutMs: optionalInt(1000, 60_000),
	enabled: z.boolean(),
});
export type PinSetFormValues = z.input<typeof pinSetFormSchema>;

/**
 * One code's metadata — and deliberately not the code.
 *
 * `ordinal` is {@link requiredInt} rather than {@link optionalInt}, which is the second time that
 * helper has been needed and for a different reason from the first: `park_lot.slot_start` is
 * required because the column has no default, and this is required because the ordinal is the
 * IDENTITY a call detail record names ("code 3, the night desk"). A blank box is not "put it at the
 * end", it is a code whose CDR label the server would have to invent. The dialog pre-fills the next
 * free ordinal so the requirement is only ever met by somebody who cleared the box on purpose.
 */
export const pinSetEntryFormSchema = z.strictObject({
	label: optionalText(128),
	ordinal: requiredInt(0, 1000),
	enabled: z.boolean(),
});
export type PinSetEntryFormValues = z.input<typeof pinSetEntryFormSchema>;

/**
 * The digits themselves.
 *
 * Four at the bottom because that is the shortest anybody actually uses; sixteen at the top is the
 * server's. `keypadPinIssue` — the mailbox and conference rule — is deliberately NOT reused, and the
 * difference is the server's rather than a lapse: `setPinDto` checks the length and the alphabet and
 * nothing else, so importing the weak-PIN blocklist here would refuse a code the API would accept
 * and leave the user with a message no round trip could have produced. The dialog says "avoid a
 * repeated or counting code" as ADVICE beside the field instead, which is the honest shape for a
 * rule this app does not get to enforce.
 */
export const pinSchema = z
	.string()
	.trim()
	.min(4, "At least 4 digits")
	.max(16, "At most 16 digits")
	.regex(/^[0-9]+$/u, "Digits only — it is entered on a telephone keypad");

/** A ruleset: a name for a pipeline. Everything that does anything is in its rules. */
export const translationRulesetFormSchema = z.strictObject({
	name: displayName,
	description: optionalText(512),
	enabled: z.boolean(),
});
export type TranslationRulesetFormValues = z.input<typeof translationRulesetFormSchema>;

/**
 * One rewrite.
 *
 * ## Neither half is validated beyond its length, and that is the server's decision restated
 *
 * `validateTranslationRule` in `@optimiq-voice/routing` is the function whose opinion decides
 * whether a rule can be APPLIED — it compiles the regex, and it checks that the replacement can only
 * ever emit dialable output — and it runs inside the write transaction. A `new RegExp(...)` here
 * would be a second opinion that agrees today and disagrees the first time somebody writes a
 * lookbehind, and the replacement allow-list is a SECURITY boundary (a replacement that can emit `@`
 * is a rule that could put a second host into a request URI), which is not a check to duplicate in
 * the half of the system an attacker controls.
 *
 * `replacement` may be EMPTY — that is how a strip rule is written — so it is a plain bounded string
 * rather than {@link optionalText}, whose blank-means-null transform would send `null` for a column
 * the server declares `z.string().max(256)`.
 */
export const translationRuleFormSchema = z.strictObject({
	label: optionalText(128),
	matchPattern: z.string().trim().min(1, "Required").max(256, "At most 256 characters"),
	replacement: z.string().trim().max(256, "At most 256 characters"),
	ordinal: requiredInt(0, 1000),
	enabled: z.boolean(),
});
export type TranslationRuleFormValues = z.input<typeof translationRuleFormSchema>;

/** A named destination: a name, a note, and the trio the picker holds beside this. */
export const destinationAliasFormSchema = z.strictObject({
	name: displayName,
	description: optionalText(512),
	enabled: z.boolean(),
});
export type DestinationAliasFormValues = z.input<typeof destinationAliasFormSchema>;

/**
 * A remote audio source.
 *
 * The `http(s)` rule is the one check on this form that is a SECURITY check rather than formatting,
 * and it is why it is restated rather than left to the round trip: the set of things a tenant may
 * cause the media server to open is a decision about what the media server will READ, and
 * `file:///etc/passwd` is a URL. The server refuses it at the edge and the compiler refuses it again
 * from the snapshot; this is the third copy and the least authoritative, which is the correct order.
 */
export const audioStreamFormSchema = z.strictObject({
	name: displayName,
	description: optionalText(512),
	url: z
		.string()
		.trim()
		.min(1, "Required")
		.max(1024, "At most 1024 characters")
		.refine((value) => /^https?:\/\//iu.test(value), "Must be an http or https URL")
		.refine((value) => {
			try {
				void new URL(value);
				return true;
			} catch {
				return false;
			}
		}, "Must be a valid absolute URL"),
	answerFirst: z.boolean(),
	/** Zero means "until the caller hangs up", which is what an always-on radio feed wants. */
	maxSeconds: optionalInt(0, 86_400),
	enabled: z.boolean(),
});
export type AudioStreamFormValues = z.input<typeof audioStreamFormSchema>;

/**
 * A dial-by-name directory.
 *
 * There is no member list to edit: the entries are DERIVED from the organization's extensions at
 * compile time, keyed on the mailbox's recorded NAME greeting. That is why the form has a note
 * rather than a picker — an extension with no recorded name is skipped with a compile warning, and
 * the fix is on the mailbox rather than here.
 */
export const dialByNameDirectoryFormSchema = z.strictObject({
	name: displayName,
	extensionNumber: optionalDigits(16),
	searchField: z.enum(DIRECTORY_SEARCH_FIELDS),
	/**
	 * Two at the bottom because a two-letter surname exists; six at the top because past that the
	 * caller is spelling the whole name, which is the interaction a directory exists to avoid.
	 */
	minDigits: optionalInt(2, 6),
	greetingPromptId: optionalReference(),
	invalidPromptId: optionalReference(),
	maxFailures: optionalInt(1, 10),
	enabled: z.boolean(),
});
export type DialByNameDirectoryFormValues = z.input<typeof dialByNameDirectoryFormSchema>;

/**
 * An organization speed dial.
 *
 * `code` accepts both `*01` and `8001`, and neither shape is screened here: whether a code collides
 * with a feature code or with an internal number is a fact about the whole tenant, so the compiler
 * answers it inside the write transaction and the diagnostic rides out in the mutation envelope.
 */
export const speedDialFormSchema = z.strictObject({
	code: shortCode,
	label: displayName,
	enabled: z.boolean(),
});
export type SpeedDialFormValues = z.input<typeof speedDialFormSchema>;

/**
 * The organization's four quotas.
 *
 * The one form in this file where a blank box means something other than "put the default back".
 * Every column is nullable and `null` means NO CEILING — unlimited is the default and always has
 * been, because this table arrived after tenants existed — so {@link optionalInt}'s blank-to-null
 * transform is doing a different job here from the one it does on every other numeric field in this
 * module. Clearing a box removes the limit; it does not restore one.
 *
 * The upper bounds are the server's and are not policy: they are the largest values that are not
 * obviously a typo. A hundred thousand extensions is larger than any single tenant this platform
 * will hold, and a ceiling that high is indistinguishable from none.
 */
export const orgLimitsFormSchema = z.strictObject({
	maxExtensions: optionalInt(0, 100_000),
	maxTrunks: optionalInt(0, 10_000),
	maxConcurrentCalls: optionalInt(0, 100_000),
	maxStorageMb: optionalInt(0, 10_000_000),
});
export type OrgLimitsFormValues = z.input<typeof orgLimitsFormSchema>;

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

// ---------------------------------------------------------------------------------------------
// SIP security
// ---------------------------------------------------------------------------------------------

/**
 * One CIDR access rule.
 *
 * The network is checked with {@link networkIssue}, which is `sip-acl.dto.ts`'s pre-filter restated
 * — including the host-bits rule, which is the one that catches the mistake an administrator
 * actually makes. It is then NORMALISED, so a bare address and its `/32` are one row rather than
 * two that collide on the server's unique index only after PostgreSQL has widened them.
 *
 * `scope` has no default here even though the column defaults to `registration`, for the reason the
 * server's DTO gives: a caller who omitted the scope almost certainly did not mean "the one that
 * governs whether phones can register". The form therefore makes it an explicit choice.
 */
export const sipAclEntryFormSchema = z.strictObject({
	name: optionalText(128),
	network: z
		.string()
		.trim()
		.superRefine((value, context) => {
			const issue = networkIssue(value);
			if (issue !== undefined) {
				context.addIssue({ code: "custom", message: issue });
			}
		})
		.transform((value) => normalizeNetwork(value)),
	action: z.enum(SIP_ACL_ACTIONS),
	scope: z.enum(SIP_ACL_SCOPES),
	priority: optionalInt(0, 10_000),
	description: optionalText(512),
	enabled: z.boolean(),
});
export type SipAclEntryFormValues = z.input<typeof sipAclEntryFormSchema>;

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/**
 * A webhook subscription's scalar fields. The event selectors are not here — see below.
 *
 * ## `url` is checked for SHAPE only, and http is deliberately not refused
 *
 * The server's DTO checks the same two things this does: that it parses as an absolute http(s) URL,
 * and that it carries no embedded credentials. The `https`-ONLY rule lives one layer up, in
 * `WebhooksService`, because it depends on `PBX_WEBHOOK_ALLOW_INSECURE_URLS` — an environment
 * variable this bundle cannot read. Refusing http here would break the development deployments that
 * variable exists for; the deployments that enforce it answer with a 400 addressed at `url`, which
 * lands on this control through `pbxFieldErrors`. The form says so beside the field rather than
 * guessing.
 *
 * Nothing checks that the host resolves or that it is not a private address. The second is the
 * interesting omission and it is the server's reasoning: DNS is not stable between a write-time
 * check and the delivery, so the control that works belongs in the dispatcher — a fixed method, no
 * redirects, a short timeout — and it is implemented there rather than pretended at here.
 *
 * ## `secret` blank means two different things, and both are correct
 *
 * On CREATE, blank means "generate one" — the server mints 256 bits and returns it exactly once, in
 * the create response and nowhere else. On EDIT, blank means "leave the existing key alone": the
 * secret is never returned by a read, so the field cannot be pre-filled, and a form that sent an
 * empty string would rotate a working signature to nothing. The dialog omits the key entirely when
 * this is `null`, which is what `PATCH` semantics turn into "unchanged".
 *
 * ## `eventSelectors` is validated separately
 *
 * The control that produces it is four checkboxes and a textarea rather than one input, so its
 * message is attached by the dialog through `selectorListIssue` — the same division the destination
 * picker uses. Putting it in this schema would key the message to a field name no control has.
 */
export const webhookFormSchema = z.strictObject({
	description: optionalText(256),
	url: z
		.string()
		.trim()
		.min(1, "Required")
		.max(2048, "At most 2048 characters")
		.refine((value) => /^https?:\/\//iu.test(value), "Must be an http(s) URL")
		.refine((value) => {
			try {
				const parsed = new URL(value);
				return parsed.username === "" && parsed.password === "";
			} catch {
				return false;
			}
		}, "Must be a valid absolute URL, and must not carry a username or password"),
	secret: z
		.string()
		.trim()
		.refine(
			(value) => value.length === 0 || (value.length >= 16 && value.length <= 256),
			"A signing key is between 16 and 256 characters. Leave it blank to have one generated.",
		)
		.transform((value) => (value.length === 0 ? null : value)),
	enabled: z.boolean(),
});
export type WebhookFormValues = z.input<typeof webhookFormSchema>;
