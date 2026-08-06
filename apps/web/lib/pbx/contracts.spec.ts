import { describe, expect, it } from "bun:test";
import {
	DESTINATION_TARGET_TABLES as SERVER_TARGET_TABLES,
	DESTINATION_TYPE_KINDS as SERVER_TYPE_KINDS,
	DESTINATION_TYPES as SERVER_DESTINATION_TYPES,
	FEATURE_CODE_ACTIONS as SERVER_FEATURE_CODE_ACTIONS,
	IVR_OPTION_MATCH_KINDS as SERVER_IVR_OPTION_MATCH_KINDS,
	RECORD_POLICIES as SERVER_RECORD_POLICIES,
	RING_GROUP_STRATEGIES as SERVER_RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS as SERVER_ROUTE_MATCH_KINDS,
	SIP_TRANSPORTS as SERVER_SIP_TRANSPORTS,
	TOLL_CLASSES as SERVER_TOLL_CLASSES,
	TRUNK_KINDS as SERVER_TRUNK_KINDS,
	TRUNK_STATUSES as SERVER_TRUNK_STATUSES,
	VOICEMAIL_EMAIL_MODES as SERVER_VOICEMAIL_EMAIL_MODES,
} from "@optimiq-voice/pbx-db";
import { ROUTING_CONTEXTS as SERVER_ROUTING_CONTEXTS } from "@optimiq-voice/routing";
import {
	DESTINATION_TYPE_KINDS,
	DESTINATION_TYPES,
	FEATURE_CODE_ACTIONS,
	IVR_OPTION_MATCH_KINDS,
	RECORD_POLICIES,
	RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS,
	ROUTING_CONTEXTS,
	SIP_TRANSPORTS,
	TOLL_CLASSES,
	TRUNK_KINDS,
	TRUNK_STATUSES,
	VOICEMAIL_EMAIL_MODES,
} from "./contracts";
import { DESTINATION_TYPE_LABELS, destinationTarget } from "./destinations";

/**
 * These tests exist to make drift LOUD.
 *
 * `./contracts.ts` restates closed sets that live in `@optimiq-voice/pbx-db` and
 * `@optimiq-voice/routing`. It restates rather than imports because importing would drag Drizzle
 * and a Postgres driver into the browser bundle — but a copy is a copy, and a copy that nobody
 * checks is a select that silently stops offering an option the server added.
 *
 * Importing the real packages HERE is safe and is the same trick `lib/permissions.spec.ts` uses:
 * they are devDependencies used by a test, so nothing they pull in reaches the client bundle.
 *
 * Order matters in several of these — `ORDER` in a select is the order a user reads — so they are
 * compared as arrays, not as sets.
 */

describe("closed sets mirrored from @optimiq-voice/pbx-db", () => {
	it("destination types match, in order", () => {
		expect(DESTINATION_TYPES).toEqual([...SERVER_DESTINATION_TYPES]);
	});

	/**
	 * The kind decides which half of the trio a form renders. Getting it wrong produces a 422 the
	 * user cannot act on — an `entity` type shown with a literal box, or the reverse.
	 */
	it("destination kinds match for every type", () => {
		expect(DESTINATION_TYPE_KINDS).toEqual({ ...SERVER_TYPE_KINDS });
	});

	it("toll classes match, in order — this is the anti-toll-fraud ladder", () => {
		expect(TOLL_CLASSES).toEqual([...SERVER_TOLL_CLASSES]);
	});

	it("record policies match", () => {
		expect(RECORD_POLICIES).toEqual([...SERVER_RECORD_POLICIES]);
	});

	it("trunk kinds, statuses and transports match", () => {
		expect(TRUNK_KINDS).toEqual([...SERVER_TRUNK_KINDS]);
		expect(TRUNK_STATUSES).toEqual([...SERVER_TRUNK_STATUSES]);
		expect(SIP_TRANSPORTS).toEqual([...SERVER_SIP_TRANSPORTS]);
	});

	it("route match kinds match", () => {
		expect(ROUTE_MATCH_KINDS).toEqual([...SERVER_ROUTE_MATCH_KINDS]);
	});

	it("IVR option match kinds match", () => {
		expect(IVR_OPTION_MATCH_KINDS).toEqual([...SERVER_IVR_OPTION_MATCH_KINDS]);
	});

	it("ring group strategies match", () => {
		expect(RING_GROUP_STRATEGIES).toEqual([...SERVER_RING_GROUP_STRATEGIES]);
	});

	it("voicemail email modes match", () => {
		expect(VOICEMAIL_EMAIL_MODES).toEqual([...SERVER_VOICEMAIL_EMAIL_MODES]);
	});

	/** Twenty of them. A missing one is a feature nobody can configure. */
	it("feature code actions match", () => {
		expect(FEATURE_CODE_ACTIONS).toEqual([...SERVER_FEATURE_CODE_ACTIONS]);
	});
});

describe("ROUTING_CONTEXTS mirrored from @optimiq-voice/routing", () => {
	it("matches, in order", () => {
		expect(ROUTING_CONTEXTS).toEqual([...SERVER_ROUTING_CONTEXTS]);
	});
});

describe("the destination picker's own tables", () => {
	it("labels every destination type, so no select ever shows a raw kebab-case kind", () => {
		for (const type of SERVER_DESTINATION_TYPES) {
			expect(DESTINATION_TYPE_LABELS[type]).toBeTruthy();
		}
	});

	/**
	 * The picker may only claim a target for a type that (a) the server says is entity-backed and
	 * (b) has a CRUD endpoint. Claiming one for a value-backed type would render a row picker where
	 * a literal belongs.
	 */
	it("only claims a picker target for entity-backed types", () => {
		for (const type of SERVER_DESTINATION_TYPES) {
			const target = destinationTarget(type);
			if (target === undefined) {
				continue;
			}
			expect(SERVER_TYPE_KINDS[type]).toBe("entity");
			expect(SERVER_TARGET_TABLES[type]).not.toBeNull();
		}
	});

	/**
	 * The three entity types P3 has no CRUD for. When their endpoints land, this test fails — which
	 * is the reminder to add them to `DESTINATION_TARGETS` rather than leaving the picker quietly
	 * unable to point at a queue.
	 */
	it("records exactly which entity types still have no management screen", () => {
		const unbacked = SERVER_DESTINATION_TYPES.filter(
			(type) => SERVER_TYPE_KINDS[type] === "entity" && destinationTarget(type) === undefined,
		);
		expect([...unbacked]).toEqual(["queue", "conference", "park"]);
	});
});
