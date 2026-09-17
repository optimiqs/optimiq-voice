import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import {
	CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS,
	CALL_BLOCK_MATCH_KINDS,
	getTableName,
} from "@optimiq-voice/pbx-db";
import {
	affectsRouting,
	ROUTING_TABLE_TO_ENTITY,
	SNAPSHOT_COLLECTIONS,
} from "@optimiq-voice/routing";
import {
	createCallBlockRuleDto,
	updateCallBlockRuleDto,
} from "../../src/pbx/call-block/call-block.dto";
import { CALL_BLOCK_RULE_RESOURCE } from "../../src/pbx/call-block/call-block.resource";
import { parseDto } from "../../src/pbx/shared/dto";

/**
 * Caller screening's CRUD half.
 *
 * The enforcement half has been live since `packages/routing` learned `checkCallBlock`, so the
 * cases below are not about whether a rule blocks a call — `resolve.spec.ts` and `scenario.spec.ts`
 * own that. They are about the seam this wave closed: a table the engine reads that nothing could
 * write, and the two ways adding a writer could get it wrong — accepting a field the engine does
 * not read, or failing to recompile the artifact on a save.
 */

describe("call block rule DTO", () => {
	it("accepts a minimal rule and lets the column defaults stand", () => {
		const parsed = parseDto(createCallBlockRuleDto, { pattern: "+12125550100" });
		expect(parsed.pattern).to.equal("+12125550100");
		// `matchKind`, `direction` and `action` are absent, so the row takes `exact`/`inbound`/`block`
		// from the schema rather than from a second copy of the defaults in this DTO.
		expect(parsed.matchKind).to.equal(undefined);
		expect(parsed.direction).to.equal(undefined);
		expect(parsed.action).to.equal(undefined);
	});

	it("accepts every value the schema's check constraints allow, and only those", () => {
		for (const matchKind of CALL_BLOCK_MATCH_KINDS) {
			expect(parseDto(createCallBlockRuleDto, { pattern: "1", matchKind }).matchKind).to.equal(
				matchKind,
			);
		}
		for (const direction of CALL_BLOCK_DIRECTIONS) {
			expect(parseDto(createCallBlockRuleDto, { pattern: "1", direction }).direction).to.equal(
				direction,
			);
		}
		for (const action of CALL_BLOCK_ACTIONS) {
			expect(parseDto(createCallBlockRuleDto, { pattern: "1", action }).action).to.equal(action);
		}
	});

	it("refuses a value the column's check constraint would reject", () => {
		// Without this the save is a 500 from Postgres rather than a 400 naming the field.
		for (const body of [
			{ pattern: "1", matchKind: "fuzzy" },
			{ pattern: "1", direction: "sideways" },
			{ pattern: "1", action: "explode" },
		]) {
			expect(() => parseDto(createCallBlockRuleDto, body), JSON.stringify(body)).to.throw(
				BadRequestException,
			);
		}
	});

	it("refuses an empty pattern", () => {
		expect(() => parseDto(createCallBlockRuleDto, { pattern: "" })).to.throw(BadRequestException);
	});

	/**
	 * The counters belong to the enforcement side.
	 *
	 * `strictObject` means a client that sends one gets a 400 naming the field rather than a silent
	 * drop — the difference between learning the server does not accept it and believing it was
	 * stored. A rule that could claim to have blocked four hundred calls is a rule an administrator
	 * would keep.
	 */
	it("refuses the hit counters the engine owns", () => {
		for (const body of [
			{ pattern: "1", hitCount: 400 },
			{ pattern: "1", lastHitAt: new Date().toISOString() },
		]) {
			expect(() => parseDto(createCallBlockRuleDto, body), JSON.stringify(body)).to.throw(
				BadRequestException,
			);
		}
	});

	it("refuses a tenant id from the body", () => {
		expect(() => parseDto(createCallBlockRuleDto, { pattern: "1", organizationId: "x" })).to.throw(
			BadRequestException,
		);
	});

	/**
	 * The rule `feature-codes.dto.ts` applies to `action`/`params` deliberately does NOT apply here.
	 *
	 * A pattern against an unknown match kind is merely unvalidated at the edge; the compile-on-write
	 * inside the transaction sees the MERGED row and refuses an unusable pattern with a 422 naming
	 * `pattern`. Refusing the half-patch would cost a client a round trip to protect a check that
	 * happens anyway.
	 */
	it("allows a patch that moves one half of the pattern pair", () => {
		expect(parseDto(updateCallBlockRuleDto, { pattern: "+1212555" }).pattern).to.equal("+1212555");
		expect(parseDto(updateCallBlockRuleDto, { matchKind: "prefix" }).matchKind).to.equal("prefix");
	});

	it("lets a patch clear the label and toggle the rule", () => {
		expect(parseDto(updateCallBlockRuleDto, { label: null }).label).to.equal(null);
		expect(parseDto(updateCallBlockRuleDto, { enabled: false }).enabled).to.equal(false);
	});
});

describe("call block rule resource", () => {
	it("names the table the routing snapshot loads", () => {
		expect(getTableName(CALL_BLOCK_RULE_RESOURCE.table as never)).to.equal(
			CALL_BLOCK_RULE_RESOURCE.tableName,
		);
	});

	/**
	 * The property that makes the CRUD worth having.
	 *
	 * `call_block_rule` is in `ROUTING_TABLE_TO_ENTITY`, so `requiresRecompile` is true and every
	 * write through the shared repository recompiles the tenant's artifact inside the write
	 * transaction and republishes it. A rule saved here is enforced on the next call — there is no
	 * separate publish step and no second write path to a routing input. If this ever went false,
	 * saving a block rule would appear to work and change nothing.
	 */
	it("is a routing input, so a save recompiles the artifact", () => {
		expect(affectsRouting(CALL_BLOCK_RULE_RESOURCE.tableName)).to.equal(true);
		expect(ROUTING_TABLE_TO_ENTITY[CALL_BLOCK_RULE_RESOURCE.tableName]).to.equal("callBlockRules");
		expect(SNAPSHOT_COLLECTIONS).to.include("callBlockRules");
	});

	it("orders the list by a column set that ends in the unique id", () => {
		const last = CALL_BLOCK_RULE_RESOURCE.orderBy.at(-1) as { name?: string } | undefined;
		expect(last?.name).to.equal("id");
	});

	it("searches the two columns a person would type into a filter box", () => {
		expect(
			CALL_BLOCK_RULE_RESOURCE.searchColumns.map((column) => (column as { name: string }).name),
		).to.deep.equal(["pattern", "label"]);
	});

	/**
	 * `action: "voicemail"` looks like it should carry a destination trio and does not — the
	 * compiler maps the action to a hangup cause or to the callee's own mailbox, never to a
	 * destination the rule picked. A trio here would make a screening entry a routing edge, and the
	 * reverse-reference scan that turns a delete into a 409 would have to treat it as one.
	 */
	it("declares no destination trio and is nothing's destination", () => {
		expect(CALL_BLOCK_RULE_RESOURCE.destinations).to.deep.equal([]);
		expect(CALL_BLOCK_RULE_RESOURCE.destinationType).to.equal(null);
	});

	/** The counters are readable and unwritable. Redacting them would hide a stale blocklist. */
	it("redacts nothing, so an administrator can see which rules ever matched", () => {
		expect(CALL_BLOCK_RULE_RESOURCE.secretColumns).to.equal(undefined);
	});
});
