import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import {
	CATALOGUED_CATEGORIES,
	CATEGORY_PERMISSIONS,
	categoryPermissions,
	findSetting,
	NOTIFICATION_SETTINGS,
	NOTIFICATION_SETTINGS_CATEGORY,
	RECORDING_RETENTION_SETTING,
	RECORDING_SETTINGS_CATEGORY,
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
import { ROUTING_SETTINGS_CATEGORY } from "../../src/pbx/routing/snapshot-loader";
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
		// no call will ever observe. The list is pinned to the eight the loader reads.
		expect(settingsInCategory(ROUTING_SETTINGS_CATEGORY).map((entry) => entry.name)).to.deep.equal([
			"defaultTimezone",
			"voicemailPrefix",
			"voicemailCheckPrefix",
			"outboundCallerIdNumber",
			"outboundCallerIdName",
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
			"notifications",
			"provision",
			"recordings",
			"routing",
		]);
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
