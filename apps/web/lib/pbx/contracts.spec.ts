import { describe, expect, it } from "bun:test";
import {
	AUDIT_ACTOR_TYPES as SERVER_AUDIT_ACTOR_TYPES,
	DESTINATION_TARGET_TABLES as SERVER_TARGET_TABLES,
	DESTINATION_TYPE_KINDS as SERVER_TYPE_KINDS,
	DESTINATION_TYPES as SERVER_DESTINATION_TYPES,
	FEATURE_CODE_ACTIONS as SERVER_FEATURE_CODE_ACTIONS,
	IVR_OPTION_MATCH_KINDS as SERVER_IVR_OPTION_MATCH_KINDS,
	MOH_SOURCES as SERVER_MOH_SOURCES,
	PROMPT_KINDS as SERVER_PROMPT_KINDS,
	QUEUE_AGENT_CONTACT_KINDS as SERVER_QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES as SERVER_QUEUE_AGENT_STATUSES,
	QUEUE_STRATEGIES as SERVER_QUEUE_STRATEGIES,
	RECORD_POLICIES as SERVER_RECORD_POLICIES,
	RING_GROUP_STRATEGIES as SERVER_RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS as SERVER_ROUTE_MATCH_KINDS,
	SIP_TRANSPORTS as SERVER_SIP_TRANSPORTS,
	TOLL_CLASSES as SERVER_TOLL_CLASSES,
	TRUNK_KINDS as SERVER_TRUNK_KINDS,
	TRUNK_STATUSES as SERVER_TRUNK_STATUSES,
	VOICEMAIL_EMAIL_MODES as SERVER_VOICEMAIL_EMAIL_MODES,
	VOICEMAIL_GREETING_KINDS as SERVER_VOICEMAIL_GREETING_KINDS,
} from "@optimiq-voice/pbx-db";
import {
	ROUTING_CONTEXTS as SERVER_ROUTING_CONTEXTS,
	ROUTING_TABLE_TO_ENTITY as SERVER_ROUTING_TABLES,
} from "@optimiq-voice/routing";
import { PBX_CHILDREN, PBX_RESOURCES } from "./client";
import {
	AUDIT_ACTOR_TYPES,
	DESTINATION_TYPE_KINDS,
	DESTINATION_TYPES,
	FEATURE_CODE_ACTIONS,
	IVR_OPTION_MATCH_KINDS,
	MOH_SOURCES,
	PROMPT_KINDS,
	QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES,
	QUEUE_STRATEGIES,
	RECORD_POLICIES,
	RING_GROUP_STRATEGIES,
	ROUTE_MATCH_KINDS,
	ROUTING_CONTEXTS,
	SIP_TRANSPORTS,
	TOLL_CLASSES,
	TRUNK_KINDS,
	TRUNK_STATUSES,
	VOICEMAIL_EMAIL_MODES,
	VOICEMAIL_GREETING_KINDS,
} from "./contracts";
import {
	DESTINATION_TYPE_LABELS,
	destinationTarget,
	selectableDestinationTypes,
} from "./destinations";

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

	/** Six of them, and the order is the order the strategy select reads. */
	it("queue strategies match, in order", () => {
		expect(QUEUE_STRATEGIES).toEqual([...SERVER_QUEUE_STRATEGIES]);
	});

	/**
	 * Agent status is what a wallboard colours a tile by, so a missing member is an agent state the
	 * UI renders as unknown while the engine is acting on it.
	 */
	it("queue agent statuses and contact kinds match", () => {
		expect(QUEUE_AGENT_STATUSES).toEqual([...SERVER_QUEUE_AGENT_STATUSES]);
		expect(QUEUE_AGENT_CONTACT_KINDS).toEqual([...SERVER_QUEUE_AGENT_CONTACT_KINDS]);
	});

	it("voicemail email modes match", () => {
		expect(VOICEMAIL_EMAIL_MODES).toEqual([...SERVER_VOICEMAIL_EMAIL_MODES]);
	});

	it("music-on-hold sources match", () => {
		expect(MOH_SOURCES).toEqual([...SERVER_MOH_SOURCES]);
	});

	it("prompt kinds match", () => {
		expect(PROMPT_KINDS).toEqual([...SERVER_PROMPT_KINDS]);
	});

	/**
	 * The four greeting slots.
	 *
	 * Order matters here for a reason beyond reading order: `temporary` WINS over `unavailable` at
	 * compile time (`VOICEMAIL_LEAVE_GREETING_PRECEDENCE` in `@optimiq-voice/routing`), which is what
	 * makes "I am away until Monday" a recording you add and delete rather than one you overwrite.
	 * A kind this app did not offer would be a slot nobody could fill.
	 */
	it("voicemail greeting kinds match", () => {
		expect(VOICEMAIL_GREETING_KINDS).toEqual([...SERVER_VOICEMAIL_GREETING_KINDS]);
	});

	/** Twenty of them. A missing one is a feature nobody can configure. */
	it("feature code actions match", () => {
		expect(FEATURE_CODE_ACTIONS).toEqual([...SERVER_FEATURE_CODE_ACTIONS]);
	});

	/**
	 * The ledger's actor types.
	 *
	 * A missing member is an audit entry this app renders as an unknown principal — on the one
	 * screen whose entire job is saying who did something.
	 */
	it("audit actor types match, in order", () => {
		expect(AUDIT_ACTOR_TYPES).toEqual([...SERVER_AUDIT_ACTOR_TYPES]);
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
	 * This test used to record `["queue", "conference", "park"]` — the three entity types P3 had no
	 * CRUD for — precisely so that it would FAIL when their endpoints landed and force the picker to
	 * be taught about them. They have landed, so the expectation is now empty: every type the server
	 * says is entity-backed has a list the picker can page through.
	 *
	 * It is kept rather than deleted because the next entity-backed type will arrive the same way,
	 * and this is what will say so.
	 */
	it("leaves no entity-backed destination type without a list to pick from", () => {
		const unbacked = SERVER_DESTINATION_TYPES.filter(
			(type) => SERVER_TYPE_KINDS[type] === "entity" && destinationTarget(type) === undefined,
		);
		expect([...unbacked]).toEqual([]);
	});

	/**
	 * The picker's target must be the list endpoint for the type's OWN table. Pointing `park` at the
	 * conference list would render a picker full of rows whose ids the compiler then rejects as
	 * dangling — a mistake no type check can catch, because both are `string`.
	 */
	it("points each type at the endpoint for its own table", () => {
		const expectedPath: Partial<Record<string, string>> = {
			extension: "/extensions",
			ivr: "/ivr-menus",
			"ring-group": "/ring-groups",
			queue: "/queues",
			voicemail: "/voicemail-boxes",
			conference: "/conferences",
			park: "/park-lots",
			"time-condition": "/time-conditions",
		};
		for (const type of SERVER_DESTINATION_TYPES) {
			const target = destinationTarget(type);
			if (target === undefined) {
				continue;
			}
			expect(target.path).toBe(expectedPath[type] as string);
		}
	});

	/** A type with a list is offerable; the guard exists for the next one that arrives without. */
	it("offers every entity-backed type in a fresh picker", () => {
		const offered = selectableDestinationTypes(null);
		for (const type of SERVER_DESTINATION_TYPES) {
			expect(offered).toContain(type);
		}
	});
});

/**
 * Which writes evict the compile view.
 *
 * `ROUTING_TABLE_TO_ENTITY` is stated by `@optimiq-voice/routing` as the whole answer — "anything not
 * in this map is not a routing input and must not evict the cache" — and each descriptor restates it
 * for the endpoint in front of that table. Getting one wrong is invisible: too eager only wastes a
 * request, and too lax leaves the compile panel showing a hash for a configuration that no longer
 * exists, which is the one thing that panel is for.
 *
 * The key→table map is written HERE rather than derived, for the same reason `reference-kinds.ts`
 * exists: a list derived from the thing it checks proves nothing.
 */
const RESOURCE_TABLES: Readonly<Record<string, string>> = {
	extensions: "extension",
	"phone-numbers": "phone_number",
	trunks: "trunk",
	"inbound-routes": "inbound_route",
	"outbound-routes": "outbound_route",
	"time-conditions": "time_condition",
	"feature-codes": "feature_code",
	"ivr-menus": "ivr_menu",
	"ring-groups": "ring_group",
	queues: "queue",
	"queue-agents": "queue_agent",
	conferences: "conference",
	"park-lots": "park_lot",
	"voicemail-boxes": "voicemail_box",
	"moh-classes": "moh_class",
	/**
	 * `prompt` is deliberately absent from `ROUTING_TABLE_TO_ENTITY`, and the loop below asserts
	 * that the descriptor agrees. The reason it is absent is worth knowing before anyone "fixes" it:
	 * the compiler copies a `promptId` into a plan node VERBATIM and never resolves it, so renaming a
	 * prompt or re-uploading its audio changes nothing the artifact contains. The day the compiler
	 * starts resolving prompt ids to `object://` media refs — as it already does for `mohClassId` →
	 * class name — `prompt` has to be added to that map in the same commit, and this test is what
	 * will notice.
	 */
	prompts: "prompt",
	"emergency-addresses": "emergency_address",
};

const CHILD_TABLES: Readonly<Record<string, string>> = {
	options: "ivr_menu_option",
	destinations: "ring_group_destination",
	rules: "time_condition_rule",
	tiers: "queue_tier",
};

describe("affectsRouting, mirrored from @optimiq-voice/routing", () => {
	it("every resource has a table in the map above, so none can be quietly skipped", () => {
		for (const resource of Object.values(PBX_RESOURCES)) {
			expect(RESOURCE_TABLES[resource.key]).toBeTruthy();
		}
		for (const child of Object.values(PBX_CHILDREN)) {
			expect(CHILD_TABLES[child.key]).toBeTruthy();
		}
	});

	it("each resource agrees with the routing package about whether it is an input", () => {
		for (const resource of Object.values(PBX_RESOURCES)) {
			const table = RESOURCE_TABLES[resource.key] as string;
			expect({ key: resource.key, affectsRouting: resource.affectsRouting }).toEqual({
				key: resource.key,
				affectsRouting: table in SERVER_ROUTING_TABLES,
			});
		}
	});

	it("and so does each child collection", () => {
		for (const child of Object.values(PBX_CHILDREN)) {
			const table = CHILD_TABLES[child.key] as string;
			expect({ key: child.key, affectsRouting: child.affectsRouting }).toEqual({
				key: child.key,
				affectsRouting: table in SERVER_ROUTING_TABLES,
			});
		}
	});

	/**
	 * The claim the queues UI is built on, stated on its own so it fails loudly rather than as one
	 * line of a loop: staffing a queue is live state, not a dial-plan change. If the routing package
	 * ever starts compiling membership, the detail page's copy and its invalidation are both wrong.
	 */
	/**
	 * The media library's two halves, stated on their own for the same reason the queue claim is.
	 *
	 * A hold-music class IS a routing input: five node kinds carry its resolved NAME, so a rename has
	 * to reach the engine and the compile banner has to say so. A prompt is NOT, for the reason
	 * recorded beside `prompts` in `RESOURCE_TABLES` — and the difference is invisible in the UI, so
	 * it is asserted rather than left to a loop over fifteen resources.
	 */
	it("says hold music recompiles and the prompt library does not", () => {
		expect(PBX_RESOURCES.mohClasses.affectsRouting).toBe(true);
		expect(PBX_RESOURCES.prompts.affectsRouting).toBe(false);
	});

	/**
	 * E911 data became routing data when emergency routing landed: the compiler reads
	 * `emergency_address` (`ROUTING_TABLE_TO_ENTITY.emergency_address → "emergencyAddresses"`)
	 * to build the emergency match tables and select the ELIN, so an address save must
	 * invalidate the compile view.
	 */
	it("says a dispatchable location is a routing input", () => {
		expect(PBX_RESOURCES.emergencyAddresses.affectsRouting).toBe(true);
		expect(SERVER_ROUTING_TABLES.emergency_address).toBe("emergencyAddresses");
	});

	it("says a queue recompiles and its agents and tiers do not", () => {
		expect(PBX_RESOURCES.queues.affectsRouting).toBe(true);
		expect(PBX_RESOURCES.queueAgents.affectsRouting).toBe(false);
		expect(PBX_CHILDREN.queueTiers.affectsRouting).toBe(false);
		expect("queue_agent" in SERVER_ROUTING_TABLES).toBe(false);
		expect("queue_tier" in SERVER_ROUTING_TABLES).toBe(false);
	});
});
