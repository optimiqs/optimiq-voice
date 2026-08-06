import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import {
	CATALOGUED_CATEGORIES,
	findSetting,
	NOTIFICATION_SETTINGS,
	NOTIFICATION_SETTINGS_CATEGORY,
	resolveCategory,
	SETTING_CATALOG,
	settingsInCategory,
	toWireCatalog,
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
		]);
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

	it("lists both catalogued categories", () => {
		expect([...CATALOGUED_CATEGORIES].sort()).to.deep.equal(["notifications", "routing"]);
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
