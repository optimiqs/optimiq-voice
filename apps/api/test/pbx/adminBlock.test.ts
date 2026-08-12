import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import { PERMISSIONS, SYSTEM_ROLE_TEMPLATES } from "@optimiq-voice/auth";
import { getTableName } from "@optimiq-voice/pbx-db";
import {
	affectsRouting,
	ROUTING_TABLE_TO_ENTITY,
	SNAPSHOT_COLLECTIONS,
} from "@optimiq-voice/routing";
import {
	createCallFlowDto,
	overrideTimeConditionDto,
	toggleCallFlowDto,
	updateCallFlowDto,
} from "../../src/pbx/call-flows/call-flows.dto";
import { CALL_FLOW_RESOURCE } from "../../src/pbx/call-flows/call-flows.resource";
import {
	createAudioStreamDto,
	createSpeedDialDto,
	updateAudioStreamDto,
} from "../../src/pbx/dial-plan/dial-plan.dto";
import {
	AUDIO_STREAM_RESOURCE,
	DESTINATION_ALIAS_RESOURCE,
	DIAL_BY_NAME_DIRECTORY_RESOURCE,
	SPEED_DIAL_RESOURCE,
} from "../../src/pbx/dial-plan/dial-plan.resource";
import { assertWithinLimit, usageEntry } from "../../src/pbx/org-limits/org-limits";
import { writeOrgLimitsDto } from "../../src/pbx/org-limits/org-limits.dto";
import { createPinSetEntryDto, setPinDto } from "../../src/pbx/pin-sets/pin-sets.dto";
import { PIN_SET_ENTRY_RESOURCE, PIN_SET_RESOURCE } from "../../src/pbx/pin-sets/pin-sets.resource";
import { parseDto } from "../../src/pbx/shared/dto";
import { createTranslationRuleDto } from "../../src/pbx/translations/translations.dto";
import { TRANSLATION_RULESET_RESOURCE } from "../../src/pbx/translations/translations.resource";
import type { Permission } from "@optimiq-voice/auth";

/**
 * The T2 admin block's CRUD half.
 *
 * What is asserted here is the seam between the three layers this wave touches, not the behaviour of
 * any one of them: that every new table is wired into compile-on-write (so a save reaches the
 * engine), that the two secret-shaped columns never leave the process, that the delete guards name
 * the right referring tables, and that the DTOs refuse exactly the shapes the database or the
 * compiler would otherwise refuse later and less helpfully. The routing behaviour is
 * `packages/routing`'s `admin-block.spec.ts` and is not re-tested through a second layer.
 */

const ROUTING_INPUTS = [
	CALL_FLOW_RESOURCE,
	PIN_SET_RESOURCE,
	PIN_SET_ENTRY_RESOURCE,
	TRANSLATION_RULESET_RESOURCE,
	DESTINATION_ALIAS_RESOURCE,
	AUDIO_STREAM_RESOURCE,
	DIAL_BY_NAME_DIRECTORY_RESOURCE,
	SPEED_DIAL_RESOURCE,
];

describe("T2 admin block resources", () => {
	it("names the table each descriptor actually points at", () => {
		for (const resource of ROUTING_INPUTS) {
			expect(getTableName(resource.table as never), resource.kind).to.equal(resource.tableName);
		}
	});

	/**
	 * The property that makes the CRUD worth having.
	 *
	 * Every one of these tables is in `ROUTING_TABLE_TO_ENTITY`, so `requiresRecompile` is true and a
	 * write recompiles the tenant's artifact inside the write transaction. If any of these ever went
	 * false, saving a call flow would appear to work and change nothing on the wire.
	 */
	it("is a routing input, so a save recompiles the artifact", () => {
		for (const resource of ROUTING_INPUTS) {
			expect(affectsRouting(resource.tableName), resource.tableName).to.equal(true);
			const collection = ROUTING_TABLE_TO_ENTITY[resource.tableName];
			expect(collection, resource.tableName).to.be.a("string");
			expect(SNAPSHOT_COLLECTIONS).to.include(collection as never);
		}
	});

	it("orders every list by a column set that ends in the unique id", () => {
		for (const resource of ROUTING_INPUTS) {
			const last = resource.orderBy.at(-1) as { name?: string } | undefined;
			expect(last?.name, resource.kind).to.equal("id");
		}
	});

	/**
	 * A call flow is the only resource in this area with two REQUIRED trios, and the night one is the
	 * unusual half: every other secondary trio is a branch a tenant may leave unset. A switch with
	 * one position is not a switch.
	 */
	it("requires both of a call flow's destinations", () => {
		expect(CALL_FLOW_RESOURCE.destinations).to.deep.equal([
			{ prefix: "", required: true },
			{ prefix: "night", required: true },
		]);
	});

	/**
	 * A stream's fallback is required for a reason no other trio shares: remote-URL playback depends
	 * on the media driver, so a stream with nowhere to go is a call dropped in silence rather than a
	 * call released with a cause.
	 */
	it("requires an audio stream's fallback", () => {
		expect(AUDIO_STREAM_RESOURCE.destinations).to.deep.equal([
			{ prefix: "fallback", required: true },
		]);
	});

	/** Upstream's bridge was a raw dial string. Ours is a trio, and this is the read of that. */
	it("makes an alias a destination and a speed dial not one", () => {
		expect(DESTINATION_ALIAS_RESOURCE.destinationType).to.equal("alias");
		expect(SPEED_DIAL_RESOURCE.destinationType).to.equal(null);
		expect(SPEED_DIAL_RESOURCE.destinations).to.deep.equal([{ prefix: "", required: true }]);
	});

	/**
	 * A digest is not information an admin screen can use, and it is offline-crackable by anyone who
	 * obtains it. The write DTO excludes the column; this is the read half of the same sentence.
	 */
	it("never returns a PIN digest", () => {
		expect(PIN_SET_ENTRY_RESOURCE.secretColumns).to.deep.equal(["pinHash"]);
	});

	/**
	 * Neither a PIN set nor a ruleset is a destination, so the generic reverse scan cannot see the
	 * foreign keys that name one. Without these, deleting a set would silently ungate every route it
	 * was protecting — a change that appears to succeed and quietly removes a control.
	 */
	it("declares the scalar references the generic destination scan cannot see", () => {
		expect(
			PIN_SET_RESOURCE.scalarReferences?.map((site) => `${site.table}.${site.column}`),
		).to.deep.equal(["outbound_route.pin_set_id"]);
		expect(
			TRANSLATION_RULESET_RESOURCE.scalarReferences?.map((site) => `${site.table}.${site.column}`),
		).to.deep.equal([
			"outbound_route.translation_ruleset_id",
			"trunk.inbound_translation_ruleset_id",
		]);
	});
});

describe("call flow DTO", () => {
	const valid = {
		name: "Front desk",
		featureCode: "*281",
		destinationType: "extension",
		destinationRef: "0195c0f0-1c2f-7000-8000-0000000000a1",
		nightDestinationType: "hangup",
	};

	it("accepts a flow with both destinations", () => {
		expect(parseDto(createCallFlowDto, valid).name).to.equal("Front desk");
	});

	/**
	 * `mode` moves through the toggle endpoint, which is a DIFFERENT GRANT and which also writes the
	 * busy lamp. A field here would put the receptionist's daily action behind the administrator's
	 * permission and would leave every phone in the building showing the old position.
	 */
	it("refuses the mode, which belongs to the toggle endpoint", () => {
		expect(() => parseDto(createCallFlowDto, { ...valid, mode: "night" })).to.throw(
			BadRequestException,
		);
		expect(() => parseDto(updateCallFlowDto, { mode: "night" })).to.throw(BadRequestException);
	});

	it("refuses a toggle code that is not dialable", () => {
		expect(() => parseDto(createCallFlowDto, { ...valid, featureCode: "night mode" })).to.throw(
			BadRequestException,
		);
	});

	/** Absent means "the other one", which is what a wallboard button and a handset both want. */
	it("lets a toggle omit the mode", () => {
		expect(parseDto(toggleCallFlowDto, {}).mode).to.equal(undefined);
		expect(parseDto(toggleCallFlowDto, { mode: "night" }).mode).to.equal("night");
	});

	/** Absent means "one step around the ring", which is what pressing the code does. */
	it("lets an override omit the target state", () => {
		expect(parseDto(overrideTimeConditionDto, {}).override).to.equal(undefined);
		expect(parseDto(overrideTimeConditionDto, { override: "forced-match" }).override).to.equal(
			"forced-match",
		);
		expect(() => parseDto(overrideTimeConditionDto, { override: "maybe" })).to.throw(
			BadRequestException,
		);
	});
});

describe("PIN set DTO", () => {
	/** The whole of the feature's security posture, at the edge. */
	it("refuses a code anywhere in the entry body", () => {
		for (const body of [
			{ ordinal: 1, pin: "1234" },
			{ ordinal: 1, pinHash: "x" },
			{ ordinal: 1, pinNumber: "1234" },
		]) {
			expect(() => parseDto(createPinSetEntryDto, body), JSON.stringify(body)).to.throw(
				BadRequestException,
			);
		}
	});

	it("takes the code only through the endpoint that hashes it, and only as digits", () => {
		expect(parseDto(setPinDto, { pin: "482913" }).pin).to.equal("482913");
		for (const pin of ["12", "abcd", "12 34", ""]) {
			expect(() => parseDto(setPinDto, { pin }), pin).to.throw(BadRequestException);
		}
	});
});

describe("audio stream DTO", () => {
	const valid = {
		name: "Shop radio",
		url: "https://media.example.com/radio.mp3",
		fallbackDestinationType: "hangup",
	};

	it("accepts an http(s) source", () => {
		expect(parseDto(createAudioStreamDto, valid).url).to.equal(valid.url);
	});

	/**
	 * The set of things a tenant may cause the media server to OPEN is a security decision, not a
	 * formatting one — `file:///etc/passwd` is a perfectly well-formed URL. Checked here so a person
	 * gets a 400 naming the field, and re-checked by the compiler because the snapshot is data
	 * rather than a database.
	 */
	it("refuses a scheme the media server must never be asked to open", () => {
		for (const url of [
			"file:///etc/passwd",
			"ftp://example.com/a.mp3",
			"media.example.com/a.mp3",
		]) {
			expect(() => parseDto(createAudioStreamDto, { ...valid, url }), url).to.throw(
				BadRequestException,
			);
		}
	});

	it("lets a patch clear the timeout back to the server default", () => {
		expect(parseDto(updateAudioStreamDto, { maxSeconds: null }).maxSeconds).to.equal(null);
	});
});

describe("speed dial DTO", () => {
	it("accepts both a star code and bare digits", () => {
		for (const code of ["*01", "8001", "#5"]) {
			expect(
				parseDto(createSpeedDialDto, {
					code,
					label: "Head office",
					destinationType: "hangup",
				}).code,
				code,
			).to.equal(code);
		}
	});

	/**
	 * The collisions that matter — with a feature code, and with an extension — are facts about the
	 * whole tenant, so the compiler owns them. What the edge refuses is a string that is not a code
	 * at all.
	 */
	it("refuses a code that is not dialable", () => {
		// A bare `*` is NOT here: it is a dialable code, and whether it collides with a feature code
		// is a fact about the whole tenant that the compiler owns rather than a shape the edge can
		// judge. What this list holds is strings that are not codes at all.
		for (const code of ["head office", "01234567890123", "*1 2"]) {
			expect(
				() => parseDto(createSpeedDialDto, { code, label: "x", destinationType: "hangup" }),
				code,
			).to.throw(BadRequestException);
		}
	});
});

describe("translation rule DTO", () => {
	it("accepts a regex and a replacement, and has no match kind", () => {
		const parsed = parseDto(createTranslationRuleDto, {
			matchPattern: "^00(\\d+)$",
			replacement: "+$1",
			ordinal: 1,
		});
		expect(parsed.replacement).to.equal("+$1");
		expect(() =>
			parseDto(createTranslationRuleDto, {
				matchPattern: "^00",
				replacement: "+",
				ordinal: 1,
				matchKind: "prefix",
			}),
		).to.throw(BadRequestException);
	});

	/** An empty replacement is how a strip rule is written, so it must not be refused. */
	it("accepts an empty replacement", () => {
		expect(
			parseDto(createTranslationRuleDto, { matchPattern: "^9", replacement: "", ordinal: 0 })
				.replacement,
		).to.equal("");
	});
});

describe("organization limits", () => {
	it("treats an absent ceiling as no limit", () => {
		expect(() => assertWithinLimit("maxExtensions", null, 10_000)).to.not.throw();
		expect(() => assertWithinLimit("maxExtensions", undefined, 10_000)).to.not.throw();
	});

	/** `current` is the count BEFORE the insert, so at 50 of 50 the next one is the 51st. */
	it("refuses the create that would be one past the ceiling", () => {
		expect(() => assertWithinLimit("maxExtensions", 50, 49)).to.not.throw();
		let thrown: unknown;
		try {
			assertWithinLimit("maxExtensions", 50, 50);
		} catch (error) {
			thrown = error;
		}
		const body = (thrown as { getResponse?: () => Record<string, unknown> })?.getResponse?.();
		expect(body?.code).to.equal("PBX_LIMIT_REACHED");
		expect(body?.limit).to.equal("maxExtensions");
		expect(body?.ceiling).to.equal(50);
		expect(body?.current).to.equal(50);
	});

	it("reports a ratio only where there is a ceiling to divide by", () => {
		expect(usageEntry("maxTrunks", 3, 10)).to.deep.equal({
			limit: "maxTrunks",
			used: 3,
			ceiling: 10,
			ratio: 0.3,
		});
		expect(usageEntry("maxTrunks", 3, null).ratio).to.equal(null);
		// A zero ceiling is "none allowed", not "divide by zero".
		expect(usageEntry("maxTrunks", 0, 0).ratio).to.equal(null);
	});

	/**
	 * `null` removes a ceiling and absent leaves it alone — the one write DTO in this area where the
	 * two genuinely differ, because unlimited IS the default and there is nothing to reset to.
	 */
	it("distinguishes clearing a limit from leaving it alone", () => {
		expect(parseDto(writeOrgLimitsDto, { maxExtensions: null }).maxExtensions).to.equal(null);
		expect(Object.hasOwn(parseDto(writeOrgLimitsDto, {}), "maxExtensions")).to.equal(false);
	});
});

describe("the T2 admin block's permissions", () => {
	/**
	 * Twelve permissions for ten features, and the collapse is the point — see the ledger in
	 * `packages/auth/src/permissions.spec.ts`. Asserted by name so that a later wave splitting one of
	 * them out has to say so in the diff.
	 */
	it("declares exactly the twelve the wave budgeted for", () => {
		const added: Permission[] = [
			"call-flows.read",
			"call-flows.write",
			"call-flows.delete",
			"call-flows.toggle",
			"pin-sets.read",
			"pin-sets.write",
			"pin-sets.delete",
			"dial-plan.read",
			"dial-plan.write",
			"dial-plan.delete",
			"org-limits.read",
			"org-limits.write",
		];
		for (const permission of added) {
			expect(PERMISSIONS, permission).to.include(permission);
		}
		const declared = new Set<string>(PERMISSIONS);
		// The three features that spent nothing. Named so a later wave adding one of these notices it
		// is reversing a decision rather than filling a gap.
		for (const absent of ["translations.read", "phrases.read", "time-conditions.override"]) {
			expect(declared.has(absent), absent).to.equal(false);
		}
	});

	/** A quota an administrator can raise is not a quota. `owner` alone, until W14. */
	it("keeps the limit-raising grant off every role but the owner", () => {
		for (const template of SYSTEM_ROLE_TEMPLATES) {
			if (template.id === "owner") {
				expect(template.permissions).to.include("org-limits.write" as Permission);
				continue;
			}
			expect(template.permissions, template.id).to.not.include("org-limits.write" as Permission);
		}
	});
});
