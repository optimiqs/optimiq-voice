import { describe, expect, it } from "bun:test";
import {
	AUDIT_ACTOR_TYPES as SERVER_AUDIT_ACTOR_TYPES,
	CALL_BLOCK_ACTIONS as SERVER_CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS as SERVER_CALL_BLOCK_DIRECTIONS,
	CALL_BLOCK_MATCH_KINDS as SERVER_CALL_BLOCK_MATCH_KINDS,
	CALL_FLOW_MODES as SERVER_CALL_FLOW_MODES,
	DESTINATION_TARGET_TABLES as SERVER_TARGET_TABLES,
	DIRECTORY_SEARCH_FIELDS as SERVER_DIRECTORY_SEARCH_FIELDS,
	TIME_CONDITION_OVERRIDES as SERVER_TIME_CONDITION_OVERRIDES,
	DESTINATION_TYPE_KINDS as SERVER_TYPE_KINDS,
	DESTINATION_TYPES as SERVER_DESTINATION_TYPES,
	FEATURE_CODE_ACTIONS as SERVER_FEATURE_CODE_ACTIONS,
	IVR_OPTION_MATCH_KINDS as SERVER_IVR_OPTION_MATCH_KINDS,
	MOH_SOURCES as SERVER_MOH_SOURCES,
	PROMPT_KINDS as SERVER_PROMPT_KINDS,
	QUEUE_AGENT_CONTACT_KINDS as SERVER_QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES as SERVER_QUEUE_AGENT_STATUSES,
	QUEUE_PRIORITY_MAX as SERVER_QUEUE_PRIORITY_MAX,
	QUEUE_PRIORITY_MIN as SERVER_QUEUE_PRIORITY_MIN,
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
	VOICEMAIL_TRANSCRIPTION_STATUSES as SERVER_VOICEMAIL_TRANSCRIPTION_STATUSES,
} from "@optimiq-voice/pbx-db";
import {
	ROUTING_CONTEXTS as SERVER_ROUTING_CONTEXTS,
	ROUTING_TABLE_TO_ENTITY as SERVER_ROUTING_TABLES,
} from "@optimiq-voice/routing";
import { PBX_CHILDREN, PBX_RESOURCES } from "./client";
import {
	AUDIT_ACTOR_TYPES,
	CALL_BLOCK_ACTIONS,
	CALL_BLOCK_DIRECTIONS,
	CALL_BLOCK_MATCH_KINDS,
	CALL_FLOW_MODES,
	DESTINATION_TYPE_KINDS,
	DESTINATION_TYPES,
	DIRECTORY_SEARCH_FIELDS,
	FEATURE_CODE_ACTIONS,
	ORG_LIMIT_NAMES,
	TIME_CONDITION_OVERRIDES,
	IVR_OPTION_MATCH_KINDS,
	MOH_SOURCES,
	PROMPT_KINDS,
	QUEUE_AGENT_CONTACT_KINDS,
	QUEUE_AGENT_STATUSES,
	QUEUE_EXIT_KEY_PATTERN,
	QUEUE_PRIORITY_MAX,
	QUEUE_PRIORITY_MIN,
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
	VOICEMAIL_TRANSCRIPTION_STATUSES,
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

	/**
	 * The three closed sets a screening rule is built from.
	 *
	 * `CALL_BLOCK_ACTIONS` is the one worth failing loudly on, and the reason is which member does
	 * what: `allow` WINS over `block` at the same specificity, so a select that offered the four in
	 * a drifted order — or dropped one — would be the control by which somebody re-admits a caller
	 * the organization decided to exclude, or fails to.
	 *
	 * `CALL_BLOCK_MATCH_KINDS` is deliberately NOT `ROUTE_MATCH_KINDS`: it has no `any`, because a
	 * screening rule that matched everything would be a tenant-wide outage. Comparing them
	 * separately is what stops the two lists being "tidied" into one.
	 */
	it("call block directions, actions and match kinds match, in order", () => {
		expect(CALL_BLOCK_DIRECTIONS).toEqual([...SERVER_CALL_BLOCK_DIRECTIONS]);
		expect(CALL_BLOCK_ACTIONS).toEqual([...SERVER_CALL_BLOCK_ACTIONS]);
		expect(CALL_BLOCK_MATCH_KINDS).toEqual([...SERVER_CALL_BLOCK_MATCH_KINDS]);
	});

	/** Stated on its own, because "they are both match kinds" is exactly the tidy-up to prevent. */
	it("keeps `any` out of the screening match kinds that routes have", () => {
		expect(ROUTE_MATCH_KINDS).toContain("any");
		expect([...CALL_BLOCK_MATCH_KINDS]).not.toContain("any");
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

	/**
	 * The priority scale, which is a RANGE rather than a set and drifts differently: nothing here
	 * would fail to render if the ceiling moved, the form would simply refuse a value the column
	 * accepts — or accept one the check constraint refuses, which is a 400 on a control that looked
	 * valid. The same 0-1000 is what `queue.caller.joined` publishes on, so the wallboard's live
	 * priority and the queue's configured default are the same number on the same scale.
	 */
	it("the caller-priority scale matches the column's own bounds", () => {
		expect(QUEUE_PRIORITY_MIN).toBe(SERVER_QUEUE_PRIORITY_MIN);
		expect(QUEUE_PRIORITY_MAX).toBe(SERVER_QUEUE_PRIORITY_MAX);
	});

	/**
	 * The exit key's shape, mirrored from `queue_exit_key_shape_check`.
	 *
	 * A regex mirror rather than an imported one, so what is asserted is that the two AGREE on the
	 * sixteen characters a phone can send. The engine compares the stored key against a digit with
	 * `===`: a browser that accepted a lower-case `d` or a two-character code would produce a queue
	 * whose exit key silently never fires.
	 */
	it("accepts exactly the sixteen DTMF digits, one at a time", () => {
		for (const digit of "0123456789*#ABCD") {
			expect(QUEUE_EXIT_KEY_PATTERN.test(digit)).toBe(true);
		}
		for (const refused of ["", "d", "E", "22", "*#", " 2", "2 "]) {
			expect(QUEUE_EXIT_KEY_PATTERN.test(refused)).toBe(false);
		}
	});

	it("voicemail email modes match", () => {
		expect(VOICEMAIL_EMAIL_MODES).toEqual([...SERVER_VOICEMAIL_EMAIL_MODES]);
	});

	/**
	 * The four transcription states.
	 *
	 * A drifted member here is worse than a missing label, because each of these drives a DIFFERENT
	 * thing on screen: `pending` is the only one a spinner belongs on, `disabled` is the only one
	 * that should render nothing at all, and `done` may legitimately carry an empty transcript. A UI
	 * that received a fifth status would fall through all four branches on the one message its user
	 * is actually asking about.
	 */
	it("voicemail transcription statuses match", () => {
		expect(VOICEMAIL_TRANSCRIPTION_STATUSES).toEqual([...SERVER_VOICEMAIL_TRANSCRIPTION_STATUSES]);
	});

	it("music-on-hold sources match", () => {
		expect(MOH_SOURCES).toEqual([...SERVER_MOH_SOURCES]);
	});

	it("prompt kinds match", () => {
		expect(PROMPT_KINDS).toEqual([...SERVER_PROMPT_KINDS]);
	});

	/**
	 * `phrase` stated on its own, because it is the member that changed a COLUMN's nullability.
	 *
	 * A phrase is a `prompt` row with no audio of its own, so `prompt.object_key` became nullable and
	 * `PromptRow.objectKey` is `string | null` in this app's mirror. Anything that renders or plays a
	 * key has to check the kind first. If this member ever leaves the set, that type narrows back and
	 * the check becomes dead code — which is a thing worth being told about rather than discovering.
	 */
	it("keeps the phrase kind, which is why a prompt's object key is nullable", () => {
		expect([...PROMPT_KINDS]).toContain("phrase");
	});

	/** The two positions of a call flow's switch. Order is the order the toggle button offers. */
	it("call flow modes match, in order", () => {
		expect(CALL_FLOW_MODES).toEqual([...SERVER_CALL_FLOW_MODES]);
	});

	/**
	 * The three override states.
	 *
	 * Order is load-bearing beyond reading order: the server's `nextTimeConditionOverride` walks this
	 * list as a RING when the endpoint is called with no target state, which is what a handset
	 * pressing the star code does. A reordered list here would leave the select's options in a
	 * different order from the cycle a phone walks, and the page tells the user they are the same.
	 */
	it("time condition overrides match, in order", () => {
		expect(TIME_CONDITION_OVERRIDES).toEqual([...SERVER_TIME_CONDITION_OVERRIDES]);
	});

	/** Which part of a name a dial-by-name directory matches keypad digits against. */
	it("directory search fields match, in order", () => {
		expect(DIRECTORY_SEARCH_FIELDS).toEqual([...SERVER_DIRECTORY_SEARCH_FIELDS]);
	});

	/**
	 * The four quota names, which are the one closed set in this file with NOTHING to pin against.
	 *
	 * `ORG_LIMIT_NAMES` lives in `apps/api/src/pbx/org-limits/org-limits.ts` — a Nest application, not
	 * a package — and `apps/api` is deliberately not a dependency of this app even for tests. So the
	 * assertion is a literal, restated here so that a reviewer comparing the two files can see the
	 * whole list on one screen, and so that adding a fifth quota to the mirror without a screen for it
	 * fails loudly.
	 *
	 * The value of a literal is real but bounded: it catches an edit to `contracts.ts`, and it cannot
	 * catch a fifth limit added on the server. The usage endpoint is what would notice that — it
	 * returns one entry per limit, and the page renders `ORG_LIMIT_NAMES` rather than the response, so
	 * an unknown entry is simply not shown. That trade is deliberate: rendering an entry this app has
	 * no label for would put a raw camelCase column name on a settings screen.
	 */
	it("organization limit names match the server's, restated", () => {
		expect([...ORG_LIMIT_NAMES]).toEqual([
			"maxExtensions",
			"maxTrunks",
			"maxConcurrentCalls",
			"maxStorageMb",
		]);
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
			"paging-group": "/paging-groups",
			"time-condition": "/time-conditions",
			// The T2 admin block's four. `alias` points at `/destination-aliases` and NOT at anything
			// under `/dial-plan` — the page is a tab strip over four collections, and the endpoint is
			// per collection.
			"call-flow": "/call-flows",
			stream: "/audio-streams",
			"dial-by-name": "/directories",
			alias: "/destination-aliases",
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
	 * `prompt` USED to be absent from `ROUTING_TABLE_TO_ENTITY`, and this comment used to explain
	 * why. It is worth keeping the history, because this is the test that caught the change.
	 *
	 * The old reason was sound: the compiler copies a `promptId` into a plan node verbatim and never
	 * resolves it, so renaming a prompt or re-uploading its audio changed nothing the artifact
	 * contained. What broke it is `phrase` — a phrase IS a `prompt` row, and which prompt ids are
	 * SEQUENCES is a compiled fact the artifact carries in its own table. The row cannot be told
	 * apart from an ordinary one without reading `kind`, so every write to this table now recompiles.
	 *
	 * The loop below is what noticed, and the descriptor was wrong until it did.
	 */
	prompts: "prompt",
	"emergency-addresses": "emergency_address",
	/**
	 * Neither of these is a routing input, and both are absent from `ROUTING_TABLE_TO_ENTITY` for
	 * the same reason: the compiler has no ACL input and no webhook input, so an artifact eviction
	 * per edit would evict a panel that did not change. The loop below is what holds that.
	 *
	 * `sip_acl_entry` is the one worth stating explicitly, because "not a routing input" is easy to
	 * misread as "has no effect on calls". It has a large one — it decides whether a phone may
	 * register or a carrier may deliver — but it reaches the media server through a generated
	 * configuration file rather than through the compiled artifact, which is why the screen says so
	 * and this map does not.
	 */
	"sip-acl-entries": "sip_acl_entry",
	"paging-groups": "paging_group",
	webhooks: "webhook_subscription",
	/**
	 * A screening rule IS a routing input — the compiler builds `checkCallBlock`'s tables from it and
	 * all three resolution paths consult them — so a save here republishes the artifact and the
	 * compile panel has to say so. That it is nevertheless gated by `call-block.*` rather than
	 * `routes.*` is a statement about who maintains it, not about what it feeds; the two questions
	 * are answered in different places on purpose, and this map only answers the second.
	 */
	"call-block-rules": "call_block_rule",

	// --- The T2 admin block ---------------------------------------------------------------------
	//
	// Every one of these is a routing input, which is the unusual part and is worth stating: seven
	// resources landed in one wave and not one of them is a `queue_agent` — nothing here is live
	// state the engine reads at dial time. The loop below holds each of them against
	// `ROUTING_TABLE_TO_ENTITY` rather than trusting this comment.
	"call-flows": "call_flow",
	"pin-sets": "pin_set",
	"translation-rulesets": "translation_ruleset",
	"destination-aliases": "destination_alias",
	"audio-streams": "audio_stream",
	directories: "dial_by_name_directory",
	"speed-dials": "speed_dial",
};

const CHILD_TABLES: Readonly<Record<string, string>> = {
	options: "ivr_menu_option",
	destinations: "ring_group_destination",
	rules: "time_condition_rule",
	tiers: "queue_tier",
	/**
	 * The two children whose `key` deliberately differs from their URL `segment`.
	 *
	 * A translation ruleset's collection is `/rules` on the wire, exactly as a time condition's is —
	 * and this map is keyed by `key`, so two children spelled `rules` would silently collapse into
	 * one entry and leave whichever descriptor lost unchecked. The descriptors carry
	 * `key: "translation-rules"` and `key: "pin-set-entries"` for that reason; the segments are
	 * untouched.
	 */
	"pin-set-entries": "pin_set_entry",
	"translation-rules": "translation_rule",
	/**
	 * The one ordered child that is NOT a `queue_tier` in disguise: `paging_group_member` is in
	 * `ROUTING_TABLE_TO_ENTITY`, so adding or reordering a handset republishes the artifact, while
	 * staffing a queue does not. The loop below is what holds the descriptor to that.
	 */
	members: "paging_group_member",
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
	 * The media library's two halves, stated on their own for the same reason the queue claim is —
	 * and now saying the OPPOSITE of what they said one wave ago, which is the whole value of the
	 * assertion.
	 *
	 * A hold-music class has always been a routing input: five node kinds carry its resolved NAME, so
	 * a rename has to reach the engine. The prompt library was not, because the compiler copied a
	 * `promptId` into a plan node verbatim — and it became one the day a PHRASE became a prompt row,
	 * because which ids are sequences is a compiled fact. Neither difference is visible in the UI,
	 * which is why both are asserted rather than left to a loop over twenty resources.
	 */
	it("says hold music and the prompt library both recompile", () => {
		expect(PBX_RESOURCES.mohClasses.affectsRouting).toBe(true);
		expect(PBX_RESOURCES.prompts.affectsRouting).toBe(true);
		expect(SERVER_ROUTING_TABLES.prompt).toBe("prompts");
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

	/**
	 * Screening, stated on its own for the same reason hold music is: the claim is easy to get
	 * backwards from the permission. `call-block.*` is a resource of its own precisely BECAUSE the
	 * people who maintain a blocklist are not the people who own the dial plan — which reads like
	 * "not a routing input" and is the opposite of true. Every rule saved here is compiled into the
	 * artifact inside the write transaction, so the compile view must be evicted with it.
	 */
	it("says a screening rule recompiles, even though it is not gated by routes.*", () => {
		expect(PBX_RESOURCES.callBlockRules.affectsRouting).toBe(true);
		expect(SERVER_ROUTING_TABLES.call_block_rule).toBeTruthy();
		expect(PBX_RESOURCES.callBlockRules.permissions.read).toBe("call-block.read");
	});

	/**
	 * The permission claims the T2 screens are built on, stated on their own rather than left to a
	 * loop, because each of the four is easy to get wrong in a way no type check would catch.
	 *
	 * A ruleset on `routes.*` looks like an oversight next to six siblings on their own resources,
	 * and it is the server's decision: a ruleset is only meaningful attached to a route or a trunk,
	 * so its power IS `routes.write`'s. It is also the fact that decided which page it lives on.
	 *
	 * The four dial-plan tables sharing one family is the collapse the registry asks every wave to
	 * justify, and it is what makes `/dial-plan` a single `PAGE_PERMISSIONS` entry over four tabs.
	 */
	it("says a translation ruleset rides the routes grants, which is why it is a Routing tab", () => {
		expect(PBX_RESOURCES.translationRulesets.permissions.read).toBe("routes.read");
		expect(PBX_RESOURCES.translationRulesets.permissions.write).toBe("routes.write");
		expect(PBX_RESOURCES.translationRulesets.permissions.delete).toBe("routes.delete");
	});

	it("puts all four dial-plan tables on one permission family", () => {
		for (const resource of [
			PBX_RESOURCES.destinationAliases,
			PBX_RESOURCES.audioStreams,
			PBX_RESOURCES.directories,
			PBX_RESOURCES.speedDials,
		]) {
			expect(resource.permissions.read).toBe("dial-plan.read");
			expect(resource.permissions.write).toBe("dial-plan.write");
			expect(resource.permissions.delete).toBe("dial-plan.delete");
		}
	});

	/**
	 * `call-flows.toggle` is NOT on the descriptor, and its absence is the contract.
	 *
	 * The descriptor describes CRUD. Toggling is a fourth verb on a route of its own, guarded by the
	 * one grant in this area a receptionist holds — so it is named by `toggleCallFlow` and by the
	 * screen's own `usePermission` call, never by `permissions.write`. Collapsing it here would make
	 * the mode button appear only for administrators, which is precisely the person who does not
	 * press it.
	 */
	it("keeps the call-flow toggle out of the CRUD grants", () => {
		expect(PBX_RESOURCES.callFlows.permissions.write).toBe("call-flows.write");
		expect(Object.values(PBX_RESOURCES.callFlows.permissions)).not.toContain("call-flows.toggle");
	});

	/** A PIN set gates money, which is why it is not a ride on `routes.*` like the ruleset is. */
	it("gives authorisation codes a resource of their own", () => {
		expect(PBX_RESOURCES.pinSets.permissions.read).toBe("pin-sets.read");
		expect(PBX_RESOURCES.pinSets.permissions.write).toBe("pin-sets.write");
		expect(PBX_RESOURCES.pinSets.permissions.delete).toBe("pin-sets.delete");
	});

	/**
	 * The one child in this app whose `segment` and `key` differ for a reason other than history.
	 *
	 * `CHILD_TABLES` above is keyed by `key`, and both `/time-conditions/:id/rules` and
	 * `/translation-rulesets/:id/rules` are spelled `rules` on the wire — so equal keys would have
	 * left one of the two unchecked by the loop that follows. Asserted rather than commented, because
	 * "make the key match the segment" is exactly the tidy-up somebody will attempt.
	 */
	it("keeps the two `rules` collections on distinct query keys", () => {
		expect(PBX_CHILDREN.translationRules.segment).toBe("rules");
		expect(PBX_CHILDREN.timeConditionRules.segment).toBe("rules");
		expect(PBX_CHILDREN.translationRules.key).not.toBe(PBX_CHILDREN.timeConditionRules.key);
	});

	it("says a queue recompiles and its agents and tiers do not", () => {
		expect(PBX_RESOURCES.queues.affectsRouting).toBe(true);
		expect(PBX_RESOURCES.queueAgents.affectsRouting).toBe(false);
		expect(PBX_CHILDREN.queueTiers.affectsRouting).toBe(false);
		expect("queue_agent" in SERVER_ROUTING_TABLES).toBe(false);
		expect("queue_tier" in SERVER_ROUTING_TABLES).toBe(false);
	});
});
