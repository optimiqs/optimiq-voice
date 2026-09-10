import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import {
	CATALOGUED_CATEGORIES,
	CATEGORY_PERMISSIONS,
	categoryPermissions,
	findSetting,
	COMPLIANCE_SETTINGS,
	COMPLIANCE_SETTINGS_CATEGORY,
	NOTIFICATION_SETTINGS,
	NOTIFICATION_SETTINGS_CATEGORY,
	RECORDING_RETENTION_SETTING,
	RECORDING_SETTINGS_CATEGORY,
	VOICEMAIL_RETENTION_SETTING,
	resolveCategory,
	resolveForUser,
	SETTING_CATALOG,
	settingsInCategory,
	toWireCatalog,
	USER_SCOPED_CATEGORIES,
	userScopedSettingsInCategory,
} from "../../src/pbx/org-settings/org-settings.catalog";
import {
	categoryPatchDto,
	createOrgSettingDto,
	parseCategoryPatch,
	updateOrgSettingDto,
} from "../../src/pbx/org-settings/org-settings.dto";
import { ORG_SETTING_RESOURCE } from "../../src/pbx/org-settings/org-settings.resource";
import {
	readRecordingSettings,
	readRoutingSettings,
	recordAutoPause,
	recordingConsentOverride,
	resolveSipRealm,
	ROUTING_SETTINGS_CATEGORY,
} from "../../src/pbx/routing/snapshot-loader";
import { parseDto } from "../../src/pbx/shared/dto";

/**
 * The settings cascade's write path.
 *
 * Every assertion here is about a pure function — the catalogue, the DTOs, the resolver — because
 * that is where the decisions are. The repository half is the same machinery the other eleven
 * resources use and is covered by `pbxResourceService.test.ts` and the live `verify:pbx` slice.
 */

describe("org settings catalogue", () => {
	it("declares every setting exactly once", () => {
		const keys = SETTING_CATALOG.map((entry) => `${entry.category}.${entry.name}`);
		expect(new Set(keys).size).to.equal(keys.length);
	});

	it("gives every setting a default, so a tenant with no rows is fully configured", () => {
		for (const entry of SETTING_CATALOG) {
			expect(entry.schema.safeParse(entry.defaultValue).success, `${entry.name} default`).to.equal(
				true,
			);
		}
	});

	it("catalogues the notification settings the mailer reads", () => {
		expect(NOTIFICATION_SETTINGS.map((entry) => entry.name)).to.deep.equal([
			"voicemailToEmailEnabled",
			"voicemailToEmailIncludeLink",
			"voicemailToEmailIncludeTranscription",
			"fromName",
			"replyTo",
			"emergencyNotificationEmails",
		]);
	});

	it("catalogues the Kari's Law recipients as an empty-by-default address list", () => {
		const entry = findSetting(NOTIFICATION_SETTINGS_CATEGORY, "emergencyNotificationEmails");
		expect(entry?.valueType).to.equal("array");
		expect(entry?.defaultValue).to.deep.equal([]);
		expect(entry?.schema.safeParse(["ops@example.com", "desk@example.com"]).success).to.equal(true);
		// A non-address in the list would become a recipient nothing can deliver to.
		expect(entry?.schema.safeParse(["not-an-address"]).success).to.equal(false);
	});

	it("resolves the emergency recipients to the empty list when a tenant has no row", () => {
		const resolved = resolveCategory(NOTIFICATION_SETTINGS_CATEGORY, []);
		expect(resolved.emergencyNotificationEmails).to.deep.equal([]);
	});

	it("only catalogues routing names the compiler actually reads", () => {
		// A name here that `readRoutingSettings` does not project is a setting a user can save and
		// no call will ever observe. The list is pinned to the nine the loader reads.
		expect(settingsInCategory(ROUTING_SETTINGS_CATEGORY).map((entry) => entry.name)).to.deep.equal([
			"defaultTimezone",
			"voicemailPrefix",
			"voicemailCheckPrefix",
			"outboundCallerIdNumber",
			"outboundCallerIdName",
			"defaultCallingCode",
			"outboundEnabled",
			"trunkContinueOnCauses",
			"emergencyNumbers",
		]);
	});

	/**
	 * Four now: `provision` joined when the SIP transport preference landed, `recordings` when the
	 * retention window became a tenant's own setting.
	 *
	 * Worth noting why the `provision` category is only PARTIALLY catalogued, since the assertion
	 * below cannot see it. `provision.repository.ts` reads the whole category and hands it to a
	 * device template, so a vendor parameter this codebase has never heard of is a legitimate row
	 * and must keep working. Only the two keys the platform itself reads — `sipTransport` and
	 * `sipPort` — are declared, which is the rule `org-settings.catalog.ts` states for exactly this
	 * case.
	 */
	it("lists the catalogued categories", () => {
		expect([...CATALOGUED_CATEGORIES].sort()).to.deep.equal([
			"compliance",
			"notifications",
			"provision",
			"recordings",
			"routing",
			"sip",
		]);
	});

	/**
	 * The compliance category, which is the newest and the one with the sharpest failure mode.
	 *
	 * Both defaults are the permissive answer on purpose — turning either on for an existing
	 * deployment stops calls that work today — so the assertions below pin the defaults as hard as
	 * they pin the value domains. A default that drifted to `refuse` or to `true` would take a
	 * platform off the air on an upgrade, silently, with no migration to point at.
	 */
	it("catalogues the two compliance settings the attestation policy compiles", () => {
		expect(COMPLIANCE_SETTINGS.map((entry) => entry.name)).to.deep.equal([
			"unverifiedCallerIdPolicy",
			"requireKycForOutbound",
		]);
		expect(COMPLIANCE_SETTINGS_CATEGORY).to.equal("compliance");
	});

	it("defaults an unverified caller id to allow, and refuses a policy it has no meaning for", () => {
		const entry = findSetting(COMPLIANCE_SETTINGS_CATEGORY, "unverifiedCallerIdPolicy");
		expect(entry?.valueType).to.equal("string");
		expect(entry?.defaultValue).to.equal("allow");
		expect(entry?.scope).to.equal("organization");
		for (const good of ["allow", "replace", "refuse"]) {
			expect(entry?.schema.safeParse(good).success, good).to.equal(true);
		}
		expect(entry?.schema.safeParse("block").success).to.equal(false);
	});

	it("defaults the KYC gate to off, so an upgrade never blocks a working tenant", () => {
		const entry = findSetting(COMPLIANCE_SETTINGS_CATEGORY, "requireKycForOutbound");
		expect(entry?.valueType).to.equal("boolean");
		expect(entry?.defaultValue).to.equal(false);
		expect(entry?.schema.safeParse(true).success).to.equal(true);
		expect(entry?.schema.safeParse("yes").success).to.equal(false);
	});

	it("resolves both compliance settings for a tenant with no rows", () => {
		const resolved = resolveCategory(COMPLIANCE_SETTINGS_CATEGORY, []);
		expect(resolved.unverifiedCallerIdPolicy).to.equal("allow");
		expect(resolved.requireKycForOutbound).to.equal(false);
	});

	it("exposes a zod-free catalogue to clients", () => {
		const wire = toWireCatalog();
		expect(wire.length).to.equal(SETTING_CATALOG.length);
		const entry = wire.find((item) => item.name === "voicemailToEmailEnabled");
		expect(entry?.valueType).to.equal("boolean");
		expect(entry?.defaultValue).to.equal(true);
		expect(entry).to.not.have.property("schema");
	});

	it("finds a setting by its category and name, and nothing else", () => {
		expect(findSetting(NOTIFICATION_SETTINGS_CATEGORY, "fromName")).to.not.equal(undefined);
		// The same NAME in a category that does not declare it is not a match: the pair is the key.
		expect(findSetting(ROUTING_SETTINGS_CATEGORY, "fromName")).to.equal(undefined);
	});
});

describe("the user-scoped catalogue", () => {
	/**
	 * The FIRST prerequisite `settings-schema.ts` named for `user_setting`'s return, pinned as an
	 * exact list: exactly the two notification presentation preferences, and nothing that is
	 * anyone's policy. Additions here should be as deliberate as permission grants — every name in
	 * this list is a name `PATCH /org-settings/me` will accept.
	 */
	it("marks exactly the two presentation preferences user-scoped", () => {
		const userScoped = SETTING_CATALOG.filter((entry) => entry.scope === "user").map(
			(entry) => `${entry.category}.${entry.name}`,
		);
		expect(userScoped.sort()).to.deep.equal([
			"notifications.voicemailToEmailIncludeLink",
			"notifications.voicemailToEmailIncludeTranscription",
		]);
		// Non-empty is the load-bearing half: `pbx-db`'s schema spec brought the table back on the
		// promise that the catalogue names a user-scoped set, and it cannot assert that itself.
		expect(userScoped.length).to.be.greaterThan(0);
	});

	it("keeps the org kill switch out of the user scope — the mailbox column is the user answer", () => {
		expect(findSetting(NOTIFICATION_SETTINGS_CATEGORY, "voicemailToEmailEnabled")?.scope).to.equal(
			"organization",
		);
	});

	it("keeps every routing, provisioning and recordings setting organization-scoped", () => {
		for (const entry of SETTING_CATALOG) {
			if (entry.category === NOTIFICATION_SETTINGS_CATEGORY) {
				continue;
			}
			expect(entry.scope, `${entry.category}.${entry.name}`).to.equal("organization");
		}
	});

	it("derives the user-scoped views from the same catalogue", () => {
		expect(USER_SCOPED_CATEGORIES).to.deep.equal([NOTIFICATION_SETTINGS_CATEGORY]);
		expect(
			userScopedSettingsInCategory(NOTIFICATION_SETTINGS_CATEGORY).map((entry) => entry.name),
		).to.deep.equal(["voicemailToEmailIncludeLink", "voicemailToEmailIncludeTranscription"]);
		expect(userScopedSettingsInCategory(ROUTING_SETTINGS_CATEGORY)).to.deep.equal([]);
	});

	it("puts the scope on the wire so a preferences screen can render from the catalogue", () => {
		const wire = toWireCatalog();
		expect(wire.find((entry) => entry.name === "voicemailToEmailIncludeLink")?.scope).to.equal(
			"user",
		);
		expect(wire.find((entry) => entry.name === "voicemailToEmailEnabled")?.scope).to.equal(
			"organization",
		);
	});
});

describe("resolveForUser", () => {
	const CATEGORY = NOTIFICATION_SETTINGS_CATEGORY;

	it("answers the code default when neither level has rows", () => {
		const resolved = resolveForUser(CATEGORY, [], []);
		expect(resolved.voicemailToEmailIncludeLink).to.equal(true);
		expect(resolved.voicemailToEmailEnabled).to.equal(true);
	});

	it("lets the user level override the organization's answer for a user-scoped setting", () => {
		const resolved = resolveForUser(
			CATEGORY,
			[{ name: "voicemailToEmailIncludeLink", value: true, enabled: true }],
			[{ name: "voicemailToEmailIncludeLink", value: false, enabled: true }],
		);
		expect(resolved.voicemailToEmailIncludeLink).to.equal(false);
	});

	it("IGNORES a user row for a setting the catalogue does not mark user-scoped", () => {
		// Not an error: a catalogue can tighten, and rows written under the old catalogue must
		// degrade to the organization's answer rather than break every read.
		const resolved = resolveForUser(
			CATEGORY,
			[{ name: "voicemailToEmailEnabled", value: true, enabled: true }],
			[{ name: "voicemailToEmailEnabled", value: false, enabled: true }],
		);
		expect(resolved.voicemailToEmailEnabled).to.equal(true);
	});

	it("treats a disabled user row as absent, exactly as resolveCategory does", () => {
		const resolved = resolveForUser(
			CATEGORY,
			[{ name: "voicemailToEmailIncludeLink", value: true, enabled: true }],
			[{ name: "voicemailToEmailIncludeLink", value: false, enabled: false }],
		);
		expect(resolved.voicemailToEmailIncludeLink).to.equal(true);
	});

	it("falls back to the ORG answer, not the code default, when a user value fails its schema", () => {
		const resolved = resolveForUser(
			CATEGORY,
			[{ name: "voicemailToEmailIncludeLink", value: false, enabled: true }],
			[{ name: "voicemailToEmailIncludeLink", value: "yes", enabled: true }],
		);
		expect(resolved.voicemailToEmailIncludeLink).to.equal(false);
	});

	it("still applies the org level's own rules underneath", () => {
		// A disabled ORG row is absent, so the user overlays the code default, not the org value.
		const resolved = resolveForUser(
			CATEGORY,
			[{ name: "voicemailToEmailIncludeTranscription", value: false, enabled: false }],
			[{ name: "voicemailToEmailIncludeTranscription", value: false, enabled: true }],
		);
		expect(resolved.voicemailToEmailIncludeTranscription).to.equal(false);
	});

	it("ignores a user row whose name is not catalogued at all", () => {
		const resolved = resolveForUser(CATEGORY, [], [{ name: "nope", value: 1, enabled: true }]);
		expect(resolved).to.not.have.property("nope");
	});
});

describe("the recordings category and the per-category permission map", () => {
	it("catalogues the retention window with the env variable's exact meaning and bounds", () => {
		const entry = findSetting(RECORDING_SETTINGS_CATEGORY, RECORDING_RETENTION_SETTING);
		expect(entry?.valueType).to.equal("number");
		// 0 = keep for ever, matching CDR_RECORDING_RETENTION_DAYS so the two cannot disagree.
		expect(entry?.defaultValue).to.equal(0);
		expect(entry?.schema.safeParse(0).success).to.equal(true);
		expect(entry?.schema.safeParse(3_650).success).to.equal(true);
		expect(entry?.schema.safeParse(3_651).success).to.equal(false);
		expect(entry?.schema.safeParse(-1).success).to.equal(false);
		expect(entry?.schema.safeParse(30.5).success).to.equal(false);
		expect(entry?.scope).to.equal("organization");
	});

	/**
	 * The voicemail window is deliberately the recording window's twin. Two retention settings on
	 * one screen in two vocabularies is how an administrator sets 30 meaning days and gets weeks.
	 */
	it("catalogues the voicemail window in the SAME vocabulary and bounds as the recording one", () => {
		const voicemail = findSetting(RECORDING_SETTINGS_CATEGORY, VOICEMAIL_RETENTION_SETTING);
		const recording = findSetting(RECORDING_SETTINGS_CATEGORY, RECORDING_RETENTION_SETTING);
		expect(voicemail?.valueType).to.equal(recording?.valueType);
		// 0 = keep indefinitely, exactly as beside it. A sweeper shipped by an upgrade must not
		// start destroying messages for a tenant that never opened the settings screen.
		expect(voicemail?.defaultValue).to.equal(0);
		expect(voicemail?.schema.safeParse(0).success).to.equal(true);
		expect(voicemail?.schema.safeParse(3_650).success).to.equal(true);
		expect(voicemail?.schema.safeParse(3_651).success).to.equal(false);
		expect(voicemail?.schema.safeParse(-1).success).to.equal(false);
		expect(voicemail?.schema.safeParse(30.5).success).to.equal(false);
		// Organization-scoped, never user-scoped: no individual's preference may shorten or extend
		// how long the organization keeps a mailbox.
		expect(voicemail?.scope).to.equal("organization");
	});

	/**
	 * This is what finally makes `recordings.configure` enforce something: the permission has been
	 * in the registry since it was declared and guarded nothing.
	 */
	it("demands recordings.configure to WRITE the recordings category, settings.read to read it", () => {
		expect(CATEGORY_PERMISSIONS[RECORDING_SETTINGS_CATEGORY]).to.deep.equal({
			read: "settings.read",
			write: "recordings.configure",
		});
		expect(categoryPermissions(RECORDING_SETTINGS_CATEGORY).write).to.equal("recordings.configure");
	});

	it("defaults every other category to the settings pair the decorator already floors on", () => {
		expect(categoryPermissions(NOTIFICATION_SETTINGS_CATEGORY)).to.deep.equal({
			read: "settings.read",
			write: "settings.write",
		});
		expect(categoryPermissions("anything-uncatalogued")).to.deep.equal({
			read: "settings.read",
			write: "settings.write",
		});
	});
});

describe("resolveCategory", () => {
	it("returns every catalogued name even when the tenant has no rows", () => {
		const resolved = resolveCategory(NOTIFICATION_SETTINGS_CATEGORY, []);
		expect(Object.keys(resolved).sort()).to.deep.equal(
			NOTIFICATION_SETTINGS.map((entry) => entry.name).sort(),
		);
		expect(resolved.voicemailToEmailEnabled).to.equal(true);
		expect(resolved.fromName).to.equal(null);
	});

	it("overlays a stored row on the code default", () => {
		const resolved = resolveCategory(NOTIFICATION_SETTINGS_CATEGORY, [
			{ name: "voicemailToEmailEnabled", value: false, enabled: true },
			{ name: "fromName", value: "Acme Support", enabled: true },
		]);
		expect(resolved.voicemailToEmailEnabled).to.equal(false);
		expect(resolved.fromName).to.equal("Acme Support");
	});

	it("treats a disabled row as absent, exactly as the routing loader does", () => {
		const resolved = resolveCategory(NOTIFICATION_SETTINGS_CATEGORY, [
			{ name: "voicemailToEmailEnabled", value: false, enabled: false },
		]);
		expect(resolved.voicemailToEmailEnabled).to.equal(true);
	});

	it("falls back to the default when a stored value no longer fits its schema", () => {
		// The catalogue can tighten; a row written before it did must not propagate a value the
		// reader cannot use.
		const resolved = resolveCategory(NOTIFICATION_SETTINGS_CATEGORY, [
			{ name: "voicemailToEmailEnabled", value: "yes", enabled: true },
		]);
		expect(resolved.voicemailToEmailEnabled).to.equal(true);
	});

	it("ignores a row whose name is not catalogued", () => {
		const resolved = resolveCategory(NOTIFICATION_SETTINGS_CATEGORY, [
			{ name: "somethingNobodyReads", value: 1, enabled: true },
		]);
		expect(resolved).to.not.have.property("somethingNobodyReads");
	});
});

describe("parseCategoryPatch", () => {
	it("accepts a partial patch of catalogued names", () => {
		const result = parseCategoryPatch(NOTIFICATION_SETTINGS_CATEGORY, {
			voicemailToEmailEnabled: false,
			fromName: "Acme Support",
		});
		expect(result.outcome).to.equal("valid");
		if (result.outcome !== "valid") return;
		expect([...result.values.entries()]).to.deep.equal([
			["voicemailToEmailEnabled", false],
			["fromName", "Acme Support"],
		]);
	});

	it("refuses an unrecognised name in a catalogued category", () => {
		const result = parseCategoryPatch(NOTIFICATION_SETTINGS_CATEGORY, { voicemailToEmail: true });
		expect(result.outcome).to.equal("invalid");
		if (result.outcome !== "invalid") return;
		expect(result.issues[0]?.field).to.equal("voicemailToEmail");
		expect(result.issues[0]?.code).to.equal("unrecognized_keys");
	});

	it("refuses a wrong-typed value rather than storing a row nothing can read", () => {
		const result = parseCategoryPatch(NOTIFICATION_SETTINGS_CATEGORY, {
			voicemailToEmailEnabled: "true",
		});
		expect(result.outcome).to.equal("invalid");
	});

	it("returns every issue, so a form can mark every bad field in one pass", () => {
		const result = parseCategoryPatch(NOTIFICATION_SETTINGS_CATEGORY, {
			voicemailToEmailEnabled: "true",
			replyTo: "not-an-address",
			nope: 1,
		});
		expect(result.outcome).to.equal("invalid");
		if (result.outcome !== "invalid") return;
		expect(result.issues.map((issue) => issue.field)).to.have.members([
			"voicemailToEmailEnabled",
			"replyTo",
			"nope",
		]);
	});

	it("accepts null for a clearable setting", () => {
		const result = parseCategoryPatch(NOTIFICATION_SETTINGS_CATEGORY, { fromName: null });
		expect(result.outcome).to.equal("valid");
	});

	it("validates the routing category against the same catalogue", () => {
		expect(
			parseCategoryPatch(ROUTING_SETTINGS_CATEGORY, { outboundCallerIdNumber: "12125550100" })
				.outcome,
		).to.equal("invalid");
		expect(
			parseCategoryPatch(ROUTING_SETTINGS_CATEGORY, { outboundCallerIdNumber: "+12125550100" })
				.outcome,
		).to.equal("valid");
	});

	it("accepts a user-scoped setting under the user scope gate", () => {
		const result = parseCategoryPatch(
			NOTIFICATION_SETTINGS_CATEGORY,
			{ voicemailToEmailIncludeLink: false },
			{ scope: "user" },
		);
		expect(result.outcome).to.equal("valid");
	});

	it("refuses an organization-scoped setting under the user scope gate, NAMING the setting", () => {
		// The refusal is the contract: a silently-written user row for an org-scoped name would be
		// configuration the resolver ignores forever while the form shows it saved.
		const result = parseCategoryPatch(
			NOTIFICATION_SETTINGS_CATEGORY,
			{ voicemailToEmailEnabled: false, voicemailToEmailIncludeLink: false },
			{ scope: "user" },
		);
		expect(result.outcome).to.equal("invalid");
		if (result.outcome !== "invalid") return;
		expect(result.issues).to.have.length(1);
		expect(result.issues[0]?.field).to.equal("voicemailToEmailEnabled");
		expect(result.issues[0]?.code).to.equal("not_user_scoped");
		expect(result.issues[0]?.message).to.contain("voicemailToEmailEnabled");
	});

	it("leaves the org surface unchanged when no scope gate is passed", () => {
		expect(
			parseCategoryPatch(NOTIFICATION_SETTINGS_CATEGORY, { voicemailToEmailEnabled: false })
				.outcome,
		).to.equal("valid");
	});
});

describe("org setting DTOs", () => {
	it("accepts a raw row for an uncatalogued category", () => {
		// The cascade is genuinely open-ended: `provision` rows are read by device templates, and
		// refusing them would turn a general-purpose table into a closed enum.
		const parsed = parseDto(createOrgSettingDto, {
			category: "provision",
			name: "ntpServer",
			value: "pool.ntp.org",
			valueType: "string",
		});
		expect(parsed.category).to.equal("provision");
	});

	it("refuses an unknown key on a raw write", () => {
		expect(() =>
			parseDto(createOrgSettingDto, {
				category: "provision",
				name: "x",
				value: 1,
				organizationId: "00000000-0000-0000-0000-000000000000",
			}),
		).to.throw(BadRequestException);
	});

	it("does not let a PATCH rename a row", () => {
		// `(organization_id, category, name)` is the row's identity; renaming in place would move a
		// value from a name something reads to a name nothing does.
		expect(() => parseDto(updateOrgSettingDto, { name: "other" })).to.throw(BadRequestException);
		expect(() => parseDto(updateOrgSettingDto, { category: "other" })).to.throw(
			BadRequestException,
		);
	});

	it("accepts a null value, which is a legitimate stored setting", () => {
		expect(parseDto(updateOrgSettingDto, { value: null }).value).to.equal(null);
	});

	it("accepts a category patch as a flat name/value object", () => {
		expect(parseDto(categoryPatchDto, { fromName: "Acme" })).to.deep.equal({ fromName: "Acme" });
	});
});

describe("the org-setting resource declaration", () => {
	it("is the org_setting table, searchable by category and name", () => {
		expect(ORG_SETTING_RESOURCE.kind).to.equal("org-setting");
		expect(ORG_SETTING_RESOURCE.tableName).to.equal("org_setting");
		expect(ORG_SETTING_RESOURCE.searchColumns.length).to.equal(2);
	});

	it("is not a dispatchable location and points at nothing", () => {
		expect(ORG_SETTING_RESOURCE.destinations).to.deep.equal([]);
		expect(ORG_SETTING_RESOURCE.destinationType).to.equal(null);
	});

	it("declares no secret columns, because a setting has none", () => {
		expect(ORG_SETTING_RESOURCE.secretColumns).to.equal(undefined);
	});
});

/**
 * The SIP realm projection into the compiled snapshot.
 *
 * The realm lives under `category='sip'`, `name='realm'` — not the `routing` category the other
 * settings read — and it is fetched on its own statement so a `sip` row and a `routing` row cannot
 * collide in one map. It rides `settings` so the engine can dial `sip:{number}@{realm}` off the
 * artifact without a database handle it does not have.
 */
/**
 * The `sip`/`realm` setting — a PER-TENANT unique claim, unlike every other setting in the cascade.
 *
 * Two organizations claiming one domain is not a cosmetic collision: `resolveOrganizationForRealm`
 * refuses a realm more than one tenant claims, so BOTH tenants' phones stop registering. The claim
 * is therefore enforced in three places and each is tested where it lives:
 *   - the SHAPE, here — a lowercase hostname with no scheme, port or trailing dot;
 *   - the UNIQUENESS, by `org_setting_sip_realm_global_key` in `packages/pbx-db`, a partial unique
 *     index over `lower(btrim(value #>> '{}'))` where `category='sip' AND name='realm' AND enabled`,
 *     so the write-time answer is a real 409 rather than a check with a race under it;
 *   - the 409's FIELD, by `pbxErrors.test.ts` — the index is on an expression, so the field is
 *     stated rather than derived.
 */
describe("the SIP realm setting's shape", () => {
	const realm = findSetting("sip", "realm");

	it("is catalogued, so a wrong-typed value is a 400 and not an unreadable row", () => {
		expect(realm?.valueType).to.equal("string");
		expect(realm?.defaultValue).to.equal(null);
		expect(realm?.scope).to.equal("organization");
	});

	/**
	 * Lower-casing on the way IN is what makes the uniqueness case-insensitive END TO END: the index
	 * lowercases too, and `sip-credentials.service.ts` lowercases the realm a REGISTER names. Three
	 * agreeing normalisations, so `ACME.EXAMPLE` and `acme.example` are one claim everywhere.
	 */
	it("normalises to lowercase and trims, so two casings are one claim", () => {
		const parsed = parseCategoryPatch("sip", { realm: "  ACME.Example.COM  " });
		expect(parsed.outcome).to.equal("valid");
		expect(parsed.outcome === "valid" && parsed.values.get("realm")).to.equal("acme.example.com");
		expect(realm?.schema.parse("  ACME.Example.COM  ")).to.equal("acme.example.com");
	});

	it("refuses a scheme, a port, a trailing dot, spaces and an over-long name", () => {
		for (const bad of [
			"sip://acme.example",
			"https://acme.example",
			"acme.example:5060",
			"acme.example.",
			".acme.example",
			"acme example",
			"acme..example",
			"-acme.example",
			"",
			`${"a".repeat(64)}.example`,
			"a".repeat(254),
		]) {
			expect(realm?.schema.safeParse(bad).success, `should refuse ${JSON.stringify(bad)}`).to.equal(
				false,
			);
		}
	});

	it("accepts an ordinary hostname and a single label, and null to clear the claim", () => {
		for (const good of ["acme.example.com", "pbx.acme-corp.example", "localhost", "a1.b2.c3"]) {
			expect(realm?.schema.safeParse(good).success, `should accept ${good}`).to.equal(true);
		}
		expect(realm?.schema.safeParse(null).success).to.equal(true);
	});

	it("reports a bad domain against the realm field, so the settings form can blame the input", () => {
		const parsed = parseCategoryPatch("sip", { realm: "not a domain!!" });
		expect(parsed.outcome).to.equal("invalid");
		expect(parsed.outcome === "invalid" && parsed.issues[0]?.field).to.equal("realm");
	});
});

describe("the SIP realm in the routing snapshot", () => {
	it("resolves the first enabled non-blank realm row", () => {
		expect(resolveSipRealm([{ value: "pbx.acme.example", enabled: true }])).to.equal(
			"pbx.acme.example",
		);
	});

	it("trims the realm, since it becomes the host half of a dial URI", () => {
		expect(resolveSipRealm([{ value: "  pbx.acme.example  ", enabled: true }])).to.equal(
			"pbx.acme.example",
		);
	});

	it("treats a disabled, blank, or non-string row as absent", () => {
		expect(resolveSipRealm([{ value: "pbx.acme.example", enabled: false }])).to.equal(undefined);
		expect(resolveSipRealm([{ value: "   ", enabled: true }])).to.equal(undefined);
		expect(resolveSipRealm([{ value: 42, enabled: true }])).to.equal(undefined);
		expect(resolveSipRealm([])).to.equal(undefined);
	});

	it("projects a resolved realm onto RoutingSettingsInput, and omits the key when absent", () => {
		expect(readRoutingSettings([], undefined, "pbx.acme.example").realm).to.equal(
			"pbx.acme.example",
		);
		expect(Object.hasOwn(readRoutingSettings([], undefined, undefined), "realm")).to.equal(false);
	});
});

/**
 * The recording-consent settings on their way into the routing snapshot.
 *
 * The property every case here defends is the same one `maxConcurrentCalls` and `realm` rely on and
 * that the first test states outright: a tenant who has configured nothing must produce the same
 * snapshot object it produced before this code existed. `canonicalizeSnapshot` hashes what is
 * present, so an emitted default would move every organization's `snapshotHash` and recompile the
 * whole estate into artifacts identical to the ones already cached.
 */
describe("the recording-consent settings in the routing snapshot", () => {
	const enabled = (name: string, value: unknown) => ({ name, value, enabled: true });

	it("reads them from their own category, not the routing one", () => {
		expect(RECORDING_SETTINGS_CATEGORY).to.equal("recordings");
		expect(RECORDING_SETTINGS_CATEGORY).to.not.equal(ROUTING_SETTINGS_CATEGORY);
	});

	it("emits nothing at all for a tenant with no recordings rows", () => {
		expect(readRecordingSettings([])).to.deep.equal({});
		// The snapshot such a tenant produces is byte-identical to the one it produced before this
		// projection existed, which is what makes shipping it a no-op rather than a mass recompile.
		expect(JSON.stringify({ ...readRoutingSettings([]), ...readRecordingSettings([]) })).to.equal(
			JSON.stringify(readRoutingSettings([])),
		);
	});

	it("round-trips every one of the six settings", () => {
		expect(
			readRecordingSettings([
				enabled("consentPolicy", "announce-and-require-keypress"),
				enabled("consentPromptId", "0195c0f0-1c2f-7000-8000-00000000a010"),
				enabled("consentAcceptDigit", "3"),
				enabled("consentDeclineDigit", "4"),
				enabled("allPartyRegions", ["US-CA", "EU"]),
				enabled("autoPauseOnDtmf", true),
			]),
		).to.deep.equal({
			recordingConsentPolicy: "announce-and-require-keypress",
			recordingConsentPromptId: "0195c0f0-1c2f-7000-8000-00000000a010",
			recordingConsentAcceptDigit: "3",
			recordingConsentDeclineDigit: "4",
			recordingAllPartyRegions: ["US-CA", "EU"],
			recordingAutoPauseOnDtmf: true,
		});
	});

	it("treats a disabled row as absent, the way the whole settings cascade does", () => {
		expect(
			readRecordingSettings([
				{ name: "consentPolicy", value: "announce", enabled: false },
				{ name: "autoPauseOnDtmf", value: true, enabled: false },
			]),
		).to.deep.equal({});
	});

	it("ignores a policy string it does not recognise rather than compiling it", () => {
		expect(readRecordingSettings([enabled("consentPolicy", "announce-in-latin")])).to.deep.equal(
			{},
		);
		expect(readRecordingSettings([enabled("consentPolicy", 7)])).to.deep.equal({});
	});

	it("keeps a cleared prompt id as an explicit null, and a missing one as no key", () => {
		expect(readRecordingSettings([enabled("consentPromptId", null)])).to.deep.equal({
			recordingConsentPromptId: null,
		});
		expect(Object.hasOwn(readRecordingSettings([]), "recordingConsentPromptId")).to.equal(false);
	});

	it("keeps an empty region list, because switching the net off is not the same as never setting it", () => {
		expect(readRecordingSettings([enabled("allPartyRegions", [])])).to.deep.equal({
			recordingAllPartyRegions: [],
		});
		expect(readRecordingSettings([enabled("allPartyRegions", ["US-CA", 7, null])])).to.deep.equal({
			recordingAllPartyRegions: ["US-CA"],
		});
	});

	it("carries a DID's and a route's override, and inherits by omitting the key", () => {
		expect(
			recordingConsentOverride({
				recordingConsentPolicy: "announce",
				recordingConsentPromptId: "0195c0f0-1c2f-7000-8000-00000000a011",
			}),
		).to.deep.equal({
			recordingConsentPolicy: "announce",
			recordingConsentPromptId: "0195c0f0-1c2f-7000-8000-00000000a011",
		});
		expect(
			recordingConsentOverride({
				recordingConsentPolicy: null,
				recordingConsentPromptId: null,
			}),
		).to.deep.equal({});
		expect(
			recordingConsentOverride({
				recordingConsentPolicy: "announce-in-latin",
				recordingConsentPromptId: null,
			}),
		).to.deep.equal({});
	});

	it("emits the auto-pause flag only when it is on", () => {
		expect(recordAutoPause(true)).to.deep.equal({ recordAutoPauseOnDtmf: true });
		// `false` is what every extension and every queue row on the platform already holds, so
		// emitting it would move each of their hashes for no change in the compiled artifact.
		expect(recordAutoPause(false)).to.deep.equal({});
	});
});
