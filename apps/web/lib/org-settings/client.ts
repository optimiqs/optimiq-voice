import { apiFetch } from "../api-client";

/**
 * The organization settings cascade — `/api/v1/org-settings`.
 *
 * ## Why this is not a `PBX_RESOURCES` descriptor
 *
 * The generic machinery in `lib/pbx/client.ts` is paged-list CRUD addressed by row id, and that is
 * the wrong shape for a settings SCREEN. A settings form does not know whether each of its fields
 * already has a row — the cascade's whole point is that an unset setting has no row at all — so
 * saving through `PATCH /path/:id` would mean a GET per field to find out, and a race with anyone
 * else saving the same form.
 *
 * The API answers that with a category facade: `GET …/categories/:category` returns every setting
 * in the category already resolved through `code default → org_setting`, and
 * `PATCH …/categories/:category` upserts a partial `{ name: value }` object as a unit. Two calls,
 * no ids, and hand-written like `lib/carrier/client.ts` for the same reason it is.
 *
 * The raw row CRUD still exists on the same prefix for operator tooling; nothing in `apps/web`
 * needs it yet, so nothing here mirrors it.
 */

/** Mirrors `SETTING_VALUE_TYPES` in `packages/pbx-db`. Restated, not imported — see `lib/pbx/contracts.ts`. */
export const SETTING_VALUE_TYPES = ["string", "number", "boolean", "json", "array"] as const;
export type SettingValueType = (typeof SETTING_VALUE_TYPES)[number];

/** One entry of `GET /org-settings/catalog` — what exists, what type it is, what the default is. */
export interface SettingDescriptor {
	readonly category: string;
	readonly name: string;
	readonly valueType: SettingValueType;
	readonly label: string;
	readonly description: string;
	readonly defaultValue: unknown;
}

export interface SettingCategoryEnvelope {
	readonly category: string;
	readonly data: Record<string, unknown>;
}

export interface SettingCategoryMutation extends SettingCategoryEnvelope {
	/** The names that actually reached a row, so a caller can say what it saved. */
	readonly written: readonly string[];
}

/**
 * The notification settings, typed.
 *
 * The names are the API catalogue's (`org-settings.catalog.ts`), and the shape is restated here
 * rather than derived, on the same terms as every other contract mirror in `lib/`: importing the
 * server's zod schemas would drag `zod/v4`, `@nestjs/common` and `@optimiq-voice/pbx-db` into the
 * browser bundle.
 */
export interface NotificationSettings {
	readonly voicemailToEmailEnabled: boolean;
	readonly voicemailToEmailIncludeLink: boolean;
	readonly voicemailToEmailIncludeTranscription: boolean;
	readonly fromName: string | null;
	readonly replyTo: string | null;
}

/**
 * The routing settings, typed.
 *
 * These are the eight names `readRoutingSettings` feeds the compiler — restated here on the same
 * terms as {@link NotificationSettings}, and for the same reason. The names are load-bearing: one
 * that the loader does not read is a setting a user can save and no call will ever observe.
 */
export interface RoutingSettings {
	readonly defaultTimezone: string;
	readonly voicemailPrefix: string | null;
	readonly voicemailCheckPrefix: string | null;
	readonly outboundCallerIdNumber: string | null;
	readonly outboundCallerIdName: string | null;
	readonly outboundEnabled: boolean;
	readonly trunkContinueOnCauses: readonly string[];
	readonly emergencyNumbers: readonly string[];
}

/**
 * The recording policy, typed.
 *
 * One setting, and `0` is not a missing value — it means KEEP INDEFINITELY, on exactly the terms
 * the platform's own `CDR_RECORDING_RETENTION_DAYS` environment variable uses. The two vocabularies
 * are identical on purpose: two spellings for one number is how a tenant sets "30" and gets a month
 * while an operator reads "30" and expects a fortnight. So this is a plain `number` rather than a
 * `number | null`, and the form's empty state has to be a real zero rather than a blank.
 */
export interface RecordingSettings {
	readonly retentionDays: number;
}

export const NOTIFICATIONS_CATEGORY = "notifications";
export const ROUTING_CATEGORY = "routing";
export const RECORDINGS_CATEGORY = "recordings";

/** The server's bound on `retentionDays`: ten years, and `0` for "for ever". */
export const RECORDING_RETENTION_MAX_DAYS = 3_650;

/**
 * The hangup causes the compiler will accept for `trunkContinueOnCauses`, offered as choices.
 *
 * Restated from `packages/telephony`'s `RETRYABLE_HANGUP_CAUSES` rather than imported, on the same
 * terms as every other contract mirror here — and offered as a CLOSED list because the compiler
 * silently drops a name it does not recognise (with a warning nobody reads) rather than refusing
 * the save. A free-text box for this field is a typo that turns off trunk failover.
 *
 * The rule behind the list is "the far end never made a decision about this call": transport,
 * congestion, gateway-health and timeout failures. `USER_BUSY`, `NO_ANSWER`, `CALL_REJECTED` and
 * `UNALLOCATED_NUMBER` are deliberately absent — retrying a decision on every trunk in the route
 * is how toll-fraud loops and duplicate-billing bugs start.
 */
export const RETRYABLE_HANGUP_CAUSES: readonly string[] = [
	"NO_ROUTE_TRANSIT_NET",
	"NO_ROUTE_DESTINATION",
	"CHANNEL_UNACCEPTABLE",
	"DESTINATION_OUT_OF_ORDER",
	"NORMAL_CIRCUIT_CONGESTION",
	"NETWORK_OUT_OF_ORDER",
	"NORMAL_TEMPORARY_FAILURE",
	"SWITCH_CONGESTION",
	"REQUESTED_CHAN_UNAVAIL",
	"SERVICE_UNAVAILABLE",
	"RECOVERY_ON_TIMER_EXPIRE",
	"PROTOCOL_ERROR",
	"INTERWORKING",
	"NO_USER_RESPONSE",
	"MEDIA_TIMEOUT",
	"PROGRESS_TIMEOUT",
	"INVALID_GATEWAY",
	"GATEWAY_DOWN",
	"SRTP_READ_ERROR",
];

export async function fetchSettingCatalog(): Promise<readonly SettingDescriptor[]> {
	const { data } = await apiFetch<{ data: readonly SettingDescriptor[] }>("/org-settings/catalog");
	return data;
}

export async function fetchSettingCategory(category: string): Promise<SettingCategoryEnvelope> {
	return await apiFetch<SettingCategoryEnvelope>(
		`/org-settings/categories/${encodeURIComponent(category)}`,
	);
}

export async function patchSettingCategory(
	category: string,
	patch: Readonly<Record<string, unknown>>,
): Promise<SettingCategoryMutation> {
	return await apiFetch<SettingCategoryMutation>(
		`/org-settings/categories/${encodeURIComponent(category)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

/**
 * Narrows the category's untyped answer to {@link NotificationSettings}.
 *
 * Every catalogued name is always present in the response — the API guarantees it, because a key
 * missing from a settings payload is indistinguishable from one whose value is `undefined`, and a
 * form binding to the second renders an uncontrolled input. The fallbacks here are therefore
 * belt-and-braces against a version skew, not an expected path, and they repeat the API's own
 * defaults rather than inventing new ones.
 */
export function toNotificationSettings(data: Record<string, unknown>): NotificationSettings {
	return {
		voicemailToEmailEnabled: data.voicemailToEmailEnabled !== false,
		voicemailToEmailIncludeLink: data.voicemailToEmailIncludeLink !== false,
		voicemailToEmailIncludeTranscription: data.voicemailToEmailIncludeTranscription !== false,
		fromName: typeof data.fromName === "string" ? data.fromName : null,
		replyTo: typeof data.replyTo === "string" ? data.replyTo : null,
	};
}

function stringList(value: unknown): readonly string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Narrows the category's untyped answer to {@link RoutingSettings}, on the same terms as
 * {@link toNotificationSettings}: the API always sends every catalogued name, so the fallbacks
 * repeat the catalogue's own defaults rather than inventing new ones.
 */
export function toRoutingSettings(data: Record<string, unknown>): RoutingSettings {
	return {
		defaultTimezone: typeof data.defaultTimezone === "string" ? data.defaultTimezone : "UTC",
		voicemailPrefix: typeof data.voicemailPrefix === "string" ? data.voicemailPrefix : null,
		voicemailCheckPrefix:
			typeof data.voicemailCheckPrefix === "string" ? data.voicemailCheckPrefix : null,
		outboundCallerIdNumber:
			typeof data.outboundCallerIdNumber === "string" ? data.outboundCallerIdNumber : null,
		outboundCallerIdName:
			typeof data.outboundCallerIdName === "string" ? data.outboundCallerIdName : null,
		outboundEnabled: data.outboundEnabled !== false,
		trunkContinueOnCauses: stringList(data.trunkContinueOnCauses),
		emergencyNumbers: stringList(data.emergencyNumbers),
	};
}

/**
 * Narrows the category's untyped answer to {@link RecordingSettings}.
 *
 * The fallback is `0` — the catalogue's own default, which means keep for ever — rather than a
 * guessed window. Inventing a number here would be the worst possible failure of a version skew:
 * a screen claiming this organization purges recordings after N days when nothing does.
 *
 * A negative or fractional value falls back too, because the column takes an integer between 0 and
 * 3,650 and a stored value outside that is a row the server itself would resolve to the default.
 */
export function toRecordingSettings(data: Record<string, unknown>): RecordingSettings {
	const value = data.retentionDays;
	return {
		retentionDays:
			typeof value === "number" &&
			Number.isInteger(value) &&
			value >= 0 &&
			value <= RECORDING_RETENTION_MAX_DAYS
				? value
				: 0,
	};
}

// ---------------------------------------------------------------------------------------------
// The user level of the cascade — `GET /org-settings/me`
// ---------------------------------------------------------------------------------------------

/**
 * The categories that have at least one user-scoped setting, mirroring `USER_SCOPED_CATEGORIES`.
 *
 * One today, and the list is stated rather than derived from the response so the screen can render
 * a section it knows how to word even before the request resolves — and, more usefully, so a
 * category the server starts exposing that this build has no copy for is a visible omission rather
 * than an untitled block of raw JSON.
 */
export const USER_SCOPED_CATEGORIES: readonly string[] = [NOTIFICATIONS_CATEGORY];

/**
 * The settings one person may override for themselves, in the `notifications` category.
 *
 * Deliberately a strict subset of {@link NotificationSettings}, and which fields are absent is the
 * whole design. `voicemailToEmailEnabled` is the organization's kill switch and is NOT here: the
 * per-person answer to "do I want voicemail email at all?" already lives on
 * `voicemail_box.email_mode`, and a `user_setting` row for the same question would be a second
 * source of truth that disagreed with the mailbox the first time somebody changed one. `fromName`
 * and `replyTo` are not here because they are what the ORGANIZATION appears to be.
 *
 * What is left is exactly the two presentation preferences: whether MY notification carries a
 * playback link and whether it carries the transcript. Neither narrows or widens anybody else's
 * mail, and neither has a compliance dimension — the org decides whether audio may leave at all.
 *
 * A name the catalogue does not mark user-scoped is refused by the server with a 400 NAMING the
 * setting rather than being written into a row the resolver would ignore for ever, so this mirror
 * being wrong is a visible failure rather than a silent one.
 */
export interface OwnNotificationSettings {
	readonly voicemailToEmailIncludeLink: boolean;
	readonly voicemailToEmailIncludeTranscription: boolean;
}

/** `GET /org-settings/me` — every user-scoped setting, grouped by category and fully resolved. */
export interface OwnSettingsEnvelope {
	readonly data: Readonly<Record<string, Record<string, unknown>>>;
}

export async function fetchOwnSettings(): Promise<OwnSettingsEnvelope> {
	return await apiFetch<OwnSettingsEnvelope>("/org-settings/me");
}

export async function patchOwnCategory(
	category: string,
	patch: Readonly<Record<string, unknown>>,
): Promise<SettingCategoryMutation> {
	return await apiFetch<SettingCategoryMutation>(
		`/org-settings/me/categories/${encodeURIComponent(category)}`,
		{ method: "PATCH", body: JSON.stringify(patch) },
	);
}

/**
 * Narrows the `notifications` block of `GET …/me` to {@link OwnNotificationSettings}.
 *
 * The values are RESOLVED through all three levels — code default, then the organization's row,
 * then this person's — so a `true` here may be the organization's answer rather than one this user
 * chose. That is the correct thing to bind a switch to: the control shows what is in force for
 * them, and touching it writes the override that makes it theirs.
 *
 * The fallbacks repeat the catalogue's own defaults rather than inventing new ones, on the same
 * terms as {@link toNotificationSettings}: the API always sends every user-scoped name, so they are
 * belt-and-braces against a version skew rather than an expected path.
 */
export function toOwnNotificationSettings(
	data: Readonly<Record<string, Record<string, unknown>>>,
): OwnNotificationSettings {
	const category = data[NOTIFICATIONS_CATEGORY] ?? {};
	return {
		voicemailToEmailIncludeLink: category.voicemailToEmailIncludeLink !== false,
		voicemailToEmailIncludeTranscription: category.voicemailToEmailIncludeTranscription !== false,
	};
}

/** Value equality for a settings payload: scalars by identity, arrays element-wise and in order. */
function sameSettingValue(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((entry, index) => entry === b[index])
		);
	}
	return a === b;
}

/**
 * The subset of `next` that actually differs from what was loaded — the body of the PATCH.
 *
 * ## Why this screen diffs and the notifications screen does not
 *
 * `PATCH …/categories/:category` is a partial upsert, so sending every key is harmless when a
 * key's stored absence and its stored default mean the same thing. In the `routing` category one
 * of them does NOT: `readRoutingSettings` omits `trunkContinueOnCauses` entirely when no row
 * exists, and the compiler reads that omission as "use the platform's built-in retryable set". A
 * row holding `[]` is a different instruction — "retry nothing, stop at the first trunk" — and the
 * category read resolves both to `[]`, so the two are indistinguishable on screen.
 *
 * A save-everything form would therefore write `trunkContinueOnCauses: []` the first time anybody
 * pressed Save on this page and silently disable trunk failover for the whole organization, with
 * nothing on screen changing. Sending only what the user touched is what keeps an untouched
 * setting untouched.
 */
export function changedSettings<T extends object>(loaded: T, next: T): Record<string, unknown> {
	const before = loaded as Readonly<Record<string, unknown>>;
	const patch: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(next)) {
		if (!sameSettingValue(before[name], value)) {
			patch[name] = value;
		}
	}
	return patch;
}
