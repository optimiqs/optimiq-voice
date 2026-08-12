import { describe, expect, it } from "bun:test";
import { queryKeys } from "../query-keys";
import {
	changedSettings,
	NOTIFICATIONS_CATEGORY,
	RECORDING_RETENTION_MAX_DAYS,
	RECORDINGS_CATEGORY,
	RETRYABLE_HANGUP_CAUSES,
	ROUTING_CATEGORY,
	toNotificationSettings,
	toOwnNotificationSettings,
	toRecordingSettings,
	toRoutingSettings,
	USER_SCOPED_CATEGORIES,
} from "./client";
import {
	EMPTY_ROUTING_FORM,
	formatDialStringList,
	fromRoutingFormValues,
	parseDialStringList,
	routingSettingsFormSchema,
	timezoneOptions,
	toRoutingFormValues,
} from "./routing-form";
import type { RoutingSettings } from "./client";

/**
 * The settings cascade as `apps/web` reads and writes it.
 *
 * Everything covered here is PURE — the narrowing of an untyped category payload, the projection
 * into and out of the form, and the diff that decides what a save sends. That is deliberate: the
 * one behaviour on this screen that can quietly break a tenant's phone system (writing an empty
 * `trunkContinueOnCauses`, see `changedSettings`) is a property of a function, not of a click.
 */

/** The eight names `readRoutingSettings` reads. A ninth here would be a setting nothing observes. */
const ROUTING_SETTING_NAMES = [
	"defaultTimezone",
	"voicemailPrefix",
	"voicemailCheckPrefix",
	"outboundCallerIdNumber",
	"outboundCallerIdName",
	"outboundEnabled",
	"trunkContinueOnCauses",
	"emergencyNumbers",
] as const;

const RESOLVED: Record<string, unknown> = {
	defaultTimezone: "America/New_York",
	voicemailPrefix: "*99",
	voicemailCheckPrefix: "*98",
	outboundCallerIdNumber: "+12125550100",
	outboundCallerIdName: "Acme Corp",
	outboundEnabled: true,
	trunkContinueOnCauses: ["GATEWAY_DOWN", "MEDIA_TIMEOUT"],
	emergencyNumbers: ["112", "999"],
};

describe("category constants", () => {
	/** These strings are the URL. A typo is a 404 the screen renders as an empty form. */
	it("names the three catalogued categories exactly as the API does", () => {
		expect(NOTIFICATIONS_CATEGORY).toBe("notifications");
		expect(ROUTING_CATEGORY).toBe("routing");
		expect(RECORDINGS_CATEGORY).toBe("recordings");
	});

	/**
	 * The categories `GET …/me` iterates, mirroring `USER_SCOPED_CATEGORIES`.
	 *
	 * `recordings` is deliberately NOT among them and must never join by accident: retention of
	 * recorded calls is a compliance posture, and no individual's preference may shorten or extend
	 * how long the organization keeps evidence. `routing` is out for a different reason — the
	 * compiler reads those names into ONE artifact per tenant, so a per-user override would be a
	 * value saved, shown, and observed by no call.
	 */
	it("exposes only the category that genuinely has a user level", () => {
		expect([...USER_SCOPED_CATEGORIES]).toEqual([NOTIFICATIONS_CATEGORY]);
		expect([...USER_SCOPED_CATEGORIES]).not.toContain(RECORDINGS_CATEGORY);
		expect([...USER_SCOPED_CATEGORIES]).not.toContain(ROUTING_CATEGORY);
	});
});

/**
 * The recording policy, whose whole surface is one integer and whose whole risk is what that
 * integer means.
 */
describe("toRecordingSettings", () => {
	/**
	 * `0` is "keep for ever", on exactly the terms `CDR_RECORDING_RETENTION_DAYS` uses. It is the
	 * catalogue's default, so it is also what a tenant that has never opened the screen resolves to
	 * — which means the fallback and the real value are indistinguishable here, and correctly so.
	 */
	it("reads zero as a real value rather than as an absence", () => {
		expect(toRecordingSettings({ retentionDays: 0 })).toEqual({ retentionDays: 0 });
		expect(toRecordingSettings({ retentionDays: 30 })).toEqual({ retentionDays: 30 });
	});

	/**
	 * Never invent a window. A guessed number is the worst possible outcome of a version skew: a
	 * screen claiming this organization purges after N days when nothing does, which somebody may
	 * report to an auditor.
	 */
	it("falls back to keep-for-ever rather than to a guessed window", () => {
		expect(toRecordingSettings({})).toEqual({ retentionDays: 0 });
		expect(toRecordingSettings({ retentionDays: "30" })).toEqual({ retentionDays: 0 });
		expect(toRecordingSettings({ retentionDays: -1 })).toEqual({ retentionDays: 0 });
		expect(toRecordingSettings({ retentionDays: 1.5 })).toEqual({ retentionDays: 0 });
	});

	it("holds the server's ten-year ceiling", () => {
		expect(RECORDING_RETENTION_MAX_DAYS).toBe(3_650);
		expect(toRecordingSettings({ retentionDays: 3_650 })).toEqual({ retentionDays: 3_650 });
		expect(toRecordingSettings({ retentionDays: 3_651 })).toEqual({ retentionDays: 0 });
	});
});

/**
 * The user level of the cascade.
 *
 * `GET …/me` answers with every user-scoped category grouped by name, already resolved through all
 * three levels — so what these assert is that the narrowing reads the right block, and that the
 * fallbacks repeat the catalogue's defaults rather than inventing an answer.
 */
describe("toOwnNotificationSettings", () => {
	it("reads the notifications block and defaults both switches on", () => {
		expect(toOwnNotificationSettings({})).toEqual({
			voicemailToEmailIncludeLink: true,
			voicemailToEmailIncludeTranscription: true,
		});
		expect(
			toOwnNotificationSettings({
				notifications: {
					voicemailToEmailIncludeLink: false,
					voicemailToEmailIncludeTranscription: true,
				},
			}),
		).toEqual({
			voicemailToEmailIncludeLink: false,
			voicemailToEmailIncludeTranscription: true,
		});
	});

	/**
	 * The organization's kill switch may legitimately be present in the resolved block, because the
	 * cascade resolves the WHOLE category. It must not leak into the shape this screen binds to:
	 * only the two the catalogue marks user-scoped are writable through `PATCH …/me`, and a form
	 * that sent a third would be refused with a 400 naming it.
	 */
	it("takes only the two user-scoped names, never the organization's own settings", () => {
		const narrowed = toOwnNotificationSettings({
			notifications: {
				voicemailToEmailEnabled: false,
				fromName: "Acme",
				voicemailToEmailIncludeLink: true,
				voicemailToEmailIncludeTranscription: false,
			},
		});

		expect(Object.keys(narrowed).sort()).toEqual([
			"voicemailToEmailIncludeLink",
			"voicemailToEmailIncludeTranscription",
		]);
		expect(narrowed.voicemailToEmailIncludeTranscription).toBe(false);
	});
});

describe("toRoutingSettings", () => {
	it("narrows a resolved category payload", () => {
		expect(toRoutingSettings(RESOLVED)).toEqual({
			defaultTimezone: "America/New_York",
			voicemailPrefix: "*99",
			voicemailCheckPrefix: "*98",
			outboundCallerIdNumber: "+12125550100",
			outboundCallerIdName: "Acme Corp",
			outboundEnabled: true,
			trunkContinueOnCauses: ["GATEWAY_DOWN", "MEDIA_TIMEOUT"],
			emergencyNumbers: ["112", "999"],
		});
	});

	/**
	 * The API always sends every catalogued name, so these fallbacks are version-skew insurance —
	 * and they must repeat the catalogue's defaults rather than invent new ones, or the form would
	 * show one thing and the compiler use another.
	 */
	it("falls back to the catalogue's own defaults for an absent name", () => {
		const settings = toRoutingSettings({});
		expect(settings).toEqual({
			defaultTimezone: "UTC",
			voicemailPrefix: null,
			voicemailCheckPrefix: null,
			outboundCallerIdNumber: null,
			outboundCallerIdName: null,
			outboundEnabled: true,
			trunkContinueOnCauses: [],
			emergencyNumbers: [],
		});
	});

	it("covers every name the routing compiler reads, and no others", () => {
		expect(Object.keys(toRoutingSettings({})).sort()).toEqual([...ROUTING_SETTING_NAMES].sort());
	});

	/** `null` on the wire is how the cascade says "unset"; it must never reach a controlled input. */
	it("treats a null as unset rather than as a value", () => {
		const settings = toRoutingSettings({ ...RESOLVED, outboundCallerIdName: null });
		expect(settings.outboundCallerIdName).toBeNull();
	});

	it("drops a non-string out of a list rather than rendering it", () => {
		const settings = toRoutingSettings({ ...RESOLVED, emergencyNumbers: ["112", 999, null] });
		expect(settings.emergencyNumbers).toEqual(["112"]);
	});

	/** `outboundEnabled` defaults to true, so only an explicit `false` turns outbound off. */
	it("only turns outbound off for an explicit false", () => {
		expect(toRoutingSettings({ outboundEnabled: false }).outboundEnabled).toBe(false);
		expect(toRoutingSettings({ outboundEnabled: undefined }).outboundEnabled).toBe(true);
	});
});

describe("toNotificationSettings", () => {
	/** The reference screen's narrowing, pinned alongside routing's so the two cannot drift. */
	it("falls back to the catalogue's defaults", () => {
		expect(toNotificationSettings({})).toEqual({
			voicemailToEmailEnabled: true,
			voicemailToEmailIncludeLink: true,
			voicemailToEmailIncludeTranscription: true,
			fromName: null,
			replyTo: null,
		});
	});
});

describe("changedSettings", () => {
	/**
	 * The reason this screen diffs at all.
	 *
	 * `readRoutingSettings` omits `trunkContinueOnCauses` when no row exists and the compiler reads
	 * that omission as "use the platform's built-in retryable set". A row holding `[]` means "retry
	 * nothing". The category read resolves both to `[]`, so a save-everything form would write the
	 * second while the user believed they had the first — silently disabling trunk failover.
	 */
	it("sends nothing when nothing was touched", () => {
		const loaded = toRoutingSettings(RESOLVED);
		const next = fromRoutingFormValues(toRoutingFormValues(loaded));
		expect(changedSettings(loaded, next)).toEqual({});
	});

	it("does not write an empty trunkContinueOnCauses for an untouched form", () => {
		const loaded = toRoutingSettings({});
		const next = fromRoutingFormValues(toRoutingFormValues(loaded));
		expect(changedSettings(loaded, next)).toEqual({});
		expect(Object.keys(changedSettings(loaded, next))).not.toContain("trunkContinueOnCauses");
	});

	it("sends only the names that differ", () => {
		const loaded = toRoutingSettings(RESOLVED);
		const next: RoutingSettings = { ...loaded, outboundEnabled: false };
		expect(changedSettings(loaded, next)).toEqual({ outboundEnabled: false });
	});

	it("compares arrays element-wise and in order", () => {
		const loaded = toRoutingSettings(RESOLVED);
		expect(changedSettings(loaded, { ...loaded, emergencyNumbers: ["112", "999"] })).toEqual({});
		expect(changedSettings(loaded, { ...loaded, emergencyNumbers: ["999", "112"] })).toEqual({
			emergencyNumbers: ["999", "112"],
		});
		expect(changedSettings(loaded, { ...loaded, emergencyNumbers: [] })).toEqual({
			emergencyNumbers: [],
		});
	});

	/** Clearing a text setting is a real edit, and `null` is the only thing that expresses it. */
	it("sends null when a value is cleared", () => {
		const loaded = toRoutingSettings(RESOLVED);
		expect(changedSettings(loaded, { ...loaded, outboundCallerIdNumber: null })).toEqual({
			outboundCallerIdNumber: null,
		});
	});
});

describe("routing form projection", () => {
	it("round-trips a fully populated category", () => {
		const loaded = toRoutingSettings(RESOLVED);
		expect(fromRoutingFormValues(toRoutingFormValues(loaded))).toEqual(loaded);
	});

	it("shows an unset setting as an empty control", () => {
		const values = toRoutingFormValues(toRoutingSettings({}));
		expect(values).toEqual(EMPTY_ROUTING_FORM);
	});

	/**
	 * The cascade stores "unset" as `null`, never as `""`. An empty string is a VALUE — an outbound
	 * caller-id name of "" is a display name presented on a live call.
	 */
	it("writes an emptied control back as null rather than as an empty string", () => {
		const next = fromRoutingFormValues({
			...EMPTY_ROUTING_FORM,
			outboundCallerIdName: "   ",
			voicemailPrefix: "",
		});
		expect(next.outboundCallerIdName).toBeNull();
		expect(next.voicemailPrefix).toBeNull();
	});

	it("trims a value on the way out", () => {
		const next = fromRoutingFormValues({ ...EMPTY_ROUTING_FORM, voicemailPrefix: "  *99  " });
		expect(next.voicemailPrefix).toBe("*99");
	});

	/** Sorted and de-duplicated so a reordered set is not reported as an unsaved change. */
	it("normalises the cause set", () => {
		const next = fromRoutingFormValues({
			...EMPTY_ROUTING_FORM,
			trunkContinueOnCauses: ["MEDIA_TIMEOUT", "GATEWAY_DOWN", "MEDIA_TIMEOUT"],
		});
		expect(next.trunkContinueOnCauses).toEqual(["GATEWAY_DOWN", "MEDIA_TIMEOUT"]);
	});
});

describe("parseDialStringList", () => {
	/** Both separators, because both are how a person pastes a list of numbers. */
	it("splits on commas and on newlines", () => {
		expect(parseDialStringList("112, 999")).toEqual(["112", "999"]);
		expect(parseDialStringList("112\n999")).toEqual(["112", "999"]);
		expect(parseDialStringList("112,\n 999 ,")).toEqual(["112", "999"]);
	});

	it("is empty for an empty box", () => {
		expect(parseDialStringList("")).toEqual([]);
		expect(parseDialStringList("  \n , ")).toEqual([]);
	});

	it("collapses duplicates, because the compiler treats the list as a set", () => {
		expect(parseDialStringList("112, 112")).toEqual(["112"]);
	});

	it("round-trips through formatDialStringList", () => {
		expect(parseDialStringList(formatDialStringList(["112", "999"]))).toEqual(["112", "999"]);
		expect(formatDialStringList([])).toBe("");
	});
});

describe("routingSettingsFormSchema", () => {
	const valid = { ...EMPTY_ROUTING_FORM, defaultTimezone: "America/New_York" };

	it("accepts the empty form", () => {
		expect(routingSettingsFormSchema.safeParse(EMPTY_ROUTING_FORM).success).toBe(true);
	});

	/** An unknown zone does not fail the save, it fails the COMPILE — on some unrelated route. */
	it("wants an IANA zone and refuses an empty one", () => {
		expect(routingSettingsFormSchema.safeParse({ ...valid, defaultTimezone: "EST" }).success).toBe(
			false,
		);
		expect(routingSettingsFormSchema.safeParse({ ...valid, defaultTimezone: "" }).success).toBe(
			false,
		);
	});

	it("validates a caller ID number only when one is given", () => {
		expect(
			routingSettingsFormSchema.safeParse({ ...valid, outboundCallerIdNumber: "" }).success,
		).toBe(true);
		expect(
			routingSettingsFormSchema.safeParse({ ...valid, outboundCallerIdNumber: "+12125550100" })
				.success,
		).toBe(true);
		expect(
			routingSettingsFormSchema.safeParse({ ...valid, outboundCallerIdNumber: "2125550100" })
				.success,
		).toBe(false);
	});

	it("bounds both list settings the way the catalogue does", () => {
		const many = Array.from({ length: 33 }, (_, index) => `${index}`).join(",");
		expect(routingSettingsFormSchema.safeParse({ ...valid, emergencyNumbers: many }).success).toBe(
			false,
		);
		expect(
			routingSettingsFormSchema.safeParse({ ...valid, emergencyNumbers: "1".repeat(17) }).success,
		).toBe(false);
		expect(
			routingSettingsFormSchema.safeParse({ ...valid, emergencyNumbers: "112, 999" }).success,
		).toBe(true);
	});

	it("bounds a prefix at the catalogue's 16 characters", () => {
		expect(
			routingSettingsFormSchema.safeParse({ ...valid, voicemailPrefix: "*".repeat(17) }).success,
		).toBe(false);
	});
});

describe("RETRYABLE_HANGUP_CAUSES", () => {
	/**
	 * The compiler DROPS a cause it does not recognise and still publishes, so the offered list is
	 * the only thing standing between a typo and trunk failover quietly not happening.
	 */
	it("offers the transport and gateway failures", () => {
		expect(RETRYABLE_HANGUP_CAUSES).toContain("GATEWAY_DOWN");
		expect(RETRYABLE_HANGUP_CAUSES).toContain("NORMAL_TEMPORARY_FAILURE");
		expect(RETRYABLE_HANGUP_CAUSES).toContain("MEDIA_TIMEOUT");
	});

	/**
	 * Never a cause that IS the far end's decision. Retrying a rejection on every trunk in a route
	 * is how toll-fraud loops and duplicate-billing bugs start.
	 */
	it("never offers a cause that is a decision about the call", () => {
		for (const cause of ["USER_BUSY", "NO_ANSWER", "CALL_REJECTED", "UNALLOCATED_NUMBER"]) {
			expect(RETRYABLE_HANGUP_CAUSES).not.toContain(cause);
		}
	});

	it("has no duplicates", () => {
		expect(new Set(RETRYABLE_HANGUP_CAUSES).size).toBe(RETRYABLE_HANGUP_CAUSES.length);
	});
});

describe("timezoneOptions", () => {
	it("always offers UTC, sorted, without duplicates", () => {
		const zones = timezoneOptions("UTC");
		expect(zones).toContain("UTC");
		expect(new Set(zones).size).toBe(zones.length);
		expect([...zones].sort()).toEqual([...zones]);
	});

	/**
	 * A select whose value is not among its options renders as the FIRST option — so a stored zone
	 * this runtime's ICU build does not know would be shown, and then saved, as something else.
	 */
	it("includes a stored zone the runtime does not know", () => {
		expect(timezoneOptions("Mars/Olympus_Mons")).toContain("Mars/Olympus_Mons");
	});
});

describe("query keys", () => {
	/** Two categories, two cache entries: a notifications save must not evict the routing read. */
	it("gives each settings category its own entry under the organization", () => {
		const notifications = queryKeys.orgSettingsCategory("org-1", NOTIFICATIONS_CATEGORY);
		const routing = queryKeys.orgSettingsCategory("org-1", ROUTING_CATEGORY);
		expect(routing).toEqual(["organizations", "org-1", "pbx", "org-settings", "routing"]);
		expect(notifications).not.toEqual(routing);
	});

	/** Filed under `pbx`, so an org switch and the coarse PBX sweeps both reach it. */
	it("sits under the organization's pbx subtree", () => {
		const key = queryKeys.orgSettingsCategory("org-1", ROUTING_CATEGORY);
		expect(key.slice(0, 3)).toEqual(["organizations", "org-1", "pbx"]);
		expect(queryKeys.routingCompile("org-1").slice(0, 3)).toEqual([
			"organizations",
			"org-1",
			"pbx",
		]);
	});

	/** Not organization-scoped: the catalogue describes the deployment's code, not the tenant. */
	it("keeps the catalogue out of the organization scope", () => {
		expect(queryKeys.orgSettingsCatalog()).toEqual(["pbx", "org-settings-catalog"]);
	});

	/**
	 * The user level gets its own key, outside `org-settings`.
	 *
	 * Two properties, and both are what stops a settings save from touching it: it does not sit
	 * under the `org-settings` prefix any category invalidation reaches, and it carries no category
	 * segment because `GET …/me` answers with every user-scoped category at once. It DOES sit under
	 * the organization, so an org switch takes it — a cached copy of the previous tenant's
	 * preferences is the one eviction here that genuinely matters.
	 */
	it("files the caller's own preferences outside the org-settings prefix but inside the org", () => {
		const own = queryKeys.ownSettings("org-1");

		expect(own).toEqual(["organizations", "org-1", "pbx", "user-settings", "me"]);
		expect(own.slice(0, 2)).toEqual(["organizations", "org-1"]);
		expect(own).not.toContain("org-settings");
		for (const category of [NOTIFICATIONS_CATEGORY, ROUTING_CATEGORY, RECORDINGS_CATEGORY]) {
			expect(own).not.toEqual(queryKeys.orgSettingsCategory("org-1", category));
		}
	});

	/** The recordings category is a third entry, not a share of the notifications one. */
	it("gives the recordings category a cache entry of its own", () => {
		expect(queryKeys.orgSettingsCategory("org-1", RECORDINGS_CATEGORY)).toEqual([
			"organizations",
			"org-1",
			"pbx",
			"org-settings",
			"recordings",
		]);
	});
});
