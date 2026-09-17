import { expect } from "chai";
import * as schema from "@optimiq-voice/pbx-db";
import { DESTINATION_TARGET_TABLES, DESTINATION_TYPES, getTableName } from "@optimiq-voice/pbx-db";
import { CALL_FLOW_RESOURCE } from "../../src/pbx/call-flows/call-flows.resource";
import { CONFERENCE_RESOURCE } from "../../src/pbx/conferences/conferences.resource";
import {
	AUDIO_STREAM_RESOURCE,
	DESTINATION_ALIAS_RESOURCE,
	DIAL_BY_NAME_DIRECTORY_RESOURCE,
	SPEED_DIAL_RESOURCE,
} from "../../src/pbx/dial-plan/dial-plan.resource";
import { EXTENSION_RESOURCE } from "../../src/pbx/extensions/extensions.resource";
import { FEATURE_CODE_RESOURCE } from "../../src/pbx/feature-codes/feature-codes.resource";
import { INBOUND_ROUTE_RESOURCE } from "../../src/pbx/inbound-routes/inbound-routes.resource";
import {
	IVR_MENU_OPTION_RESOURCE,
	IVR_MENU_RESOURCE,
} from "../../src/pbx/ivr-menus/ivr-menus.resource";
import { OUTBOUND_ROUTE_RESOURCE } from "../../src/pbx/outbound-routes/outbound-routes.resource";
import {
	PAGING_GROUP_MEMBER_RESOURCE,
	PAGING_GROUP_RESOURCE,
} from "../../src/pbx/paging-groups/paging-groups.resource";
import { PARK_LOT_RESOURCE } from "../../src/pbx/park-lots/park-lots.resource";
import { PHONE_NUMBER_RESOURCE } from "../../src/pbx/phone-numbers/phone-numbers.resource";
import { PIN_SET_ENTRY_RESOURCE, PIN_SET_RESOURCE } from "../../src/pbx/pin-sets/pin-sets.resource";
import {
	QUEUE_AGENT_RESOURCE,
	QUEUE_RESOURCE,
	QUEUE_TIER_RESOURCE,
} from "../../src/pbx/queues/queues.resource";
import {
	RING_GROUP_DESTINATION_RESOURCE,
	RING_GROUP_RESOURCE,
} from "../../src/pbx/ring-groups/ring-groups.resource";
import { DESTINATION_SITES, destinationKeys } from "../../src/pbx/shared/destinations";
import {
	TIME_CONDITION_RESOURCE,
	TIME_CONDITION_RULE_RESOURCE,
} from "../../src/pbx/time-conditions/time-conditions.resource";
import {
	TRANSLATION_RULE_RESOURCE,
	TRANSLATION_RULESET_RESOURCE,
} from "../../src/pbx/translations/translations.resource";
import { TRUNK_RESOURCE } from "../../src/pbx/trunks/trunks.resource";
import { VOICEMAIL_BOX_RESOURCE } from "../../src/pbx/voicemail-boxes/voicemail-boxes.resource";
import type { PbxChildResource, PbxResource } from "../../src/pbx/shared/pbx-resource";

/**
 * The declarations, checked against the schema they claim to describe.
 *
 * `DESTINATION_SITES` and the eleven resource descriptors are hand-maintained lists — the reverse
 * scan that turns a delete into a 409, and the guard that validates a destination before a write,
 * both walk them. A site naming a table or column that does not exist would not fail a typecheck
 * (they are strings, inlined into SQL) and would not fail `verify-pbx.ts` either: it would just
 * silently find no referrers, and the delete a user should have been warned about would go
 * through. This is the test that stops that.
 */

const TABLES = schema as unknown as Record<string, unknown>;

function columnsOf(table: unknown): Record<string, { name: string }> {
	return table as Record<string, { name: string }>;
}

function tableByName(name: string): unknown {
	for (const value of Object.values(TABLES)) {
		if (typeof value === "object" && value !== null && safeTableName(value) === name) {
			return value;
		}
	}
	return undefined;
}

function safeTableName(value: unknown): string | undefined {
	try {
		return getTableName(value as never);
	} catch {
		return undefined;
	}
}

const RESOURCES: readonly PbxResource[] = [
	EXTENSION_RESOURCE,
	PHONE_NUMBER_RESOURCE,
	TRUNK_RESOURCE,
	INBOUND_ROUTE_RESOURCE,
	OUTBOUND_ROUTE_RESOURCE,
	TIME_CONDITION_RESOURCE,
	TIME_CONDITION_RULE_RESOURCE,
	IVR_MENU_RESOURCE,
	IVR_MENU_OPTION_RESOURCE,
	RING_GROUP_RESOURCE,
	RING_GROUP_DESTINATION_RESOURCE,
	PAGING_GROUP_RESOURCE,
	PAGING_GROUP_MEMBER_RESOURCE,
	QUEUE_RESOURCE,
	QUEUE_AGENT_RESOURCE,
	QUEUE_TIER_RESOURCE,
	CONFERENCE_RESOURCE,
	PARK_LOT_RESOURCE,
	FEATURE_CODE_RESOURCE,
	VOICEMAIL_BOX_RESOURCE,
	// The T2 admin block.
	CALL_FLOW_RESOURCE,
	PIN_SET_RESOURCE,
	PIN_SET_ENTRY_RESOURCE,
	TRANSLATION_RULESET_RESOURCE,
	TRANSLATION_RULE_RESOURCE,
	DESTINATION_ALIAS_RESOURCE,
	AUDIO_STREAM_RESOURCE,
	DIAL_BY_NAME_DIRECTORY_RESOURCE,
	SPEED_DIAL_RESOURCE,
];

/** The collections whose order is semantic, and therefore have a `PUT …/reorder`. */
const CHILD_RESOURCES: readonly PbxChildResource[] = [
	PIN_SET_ENTRY_RESOURCE,
	TRANSLATION_RULE_RESOURCE,
	TIME_CONDITION_RULE_RESOURCE,
	IVR_MENU_OPTION_RESOURCE,
	RING_GROUP_DESTINATION_RESOURCE,
	PAGING_GROUP_MEMBER_RESOURCE,
	QUEUE_TIER_RESOURCE,
];

describe("PBX resource declarations", () => {
	it("names a real table for every resource", () => {
		for (const resource of RESOURCES) {
			expect(safeTableName(resource.table), resource.kind).to.equal(resource.tableName);
		}
	});

	it("orders every list by a column set that ends in the unique id", () => {
		for (const resource of RESOURCES) {
			const last = resource.orderBy.at(-1) as { name?: string } | undefined;
			expect(last?.name, `${resource.kind} order must be total`).to.equal("id");
		}
	});

	it("declares a destination type that pbx-db knows, or none at all", () => {
		for (const resource of RESOURCES) {
			if (resource.destinationType === null) {
				continue;
			}
			expect(DESTINATION_TYPES).to.include(resource.destinationType);
			expect(
				DESTINATION_TARGET_TABLES[resource.destinationType],
				`${resource.kind} must be the target table of its own destination type`,
			).to.equal(resource.tableName);
		}
	});

	it("declares only destination trios its table actually has", () => {
		for (const resource of RESOURCES) {
			const columns = columnsOf(resource.table);
			for (const field of resource.destinations) {
				const keys = destinationKeys(field.prefix);
				for (const key of [keys.type, keys.ref, keys.data]) {
					expect(columns[key], `${resource.tableName}.${key}`).to.not.equal(undefined);
				}
			}
		}
	});

	it("points every scalar reference site at a real table and column", () => {
		for (const resource of RESOURCES) {
			for (const site of resource.scalarReferences ?? []) {
				const table = tableByName(site.table);
				expect(table, site.table).to.not.equal(undefined);
				const columnNames = Object.values(columnsOf(table)).map((column) => column?.name);
				expect(columnNames, `${site.table}.${site.column}`).to.include(site.column);
				if (site.nameColumn !== null) {
					expect(columnNames, `${site.table}.${site.nameColumn}`).to.include(site.nameColumn);
				}
			}
		}
	});

	it("points every destination site at a real table with that trio", () => {
		for (const site of DESTINATION_SITES) {
			const table = tableByName(site.table);
			expect(table, site.table).to.not.equal(undefined);
			const columnNames = Object.values(columnsOf(table)).map((column) => column?.name);
			for (const suffix of ["destination_type", "destination_ref", "destination_data"]) {
				expect(columnNames, `${site.table}.${site.prefix}${suffix}`).to.include(
					`${site.prefix}${suffix}`,
				);
			}
			if (site.nameColumn !== null) {
				expect(columnNames, `${site.table}.${site.nameColumn}`).to.include(site.nameColumn);
			}
		}
	});

	/**
	 * A reorder writes `ordinalColumn`, so a descriptor that named a column its table does not have
	 * would fail at runtime on the first PUT rather than here.
	 */
	it("names a real integer column wherever a child collection declares an order", () => {
		for (const resource of CHILD_RESOURCES) {
			if (resource.ordinalColumn === undefined) {
				continue;
			}
			const columns = columnsOf(resource.table);
			const name = (resource.ordinalColumn as unknown as { name: string }).name;
			expect(
				Object.values(columns).map((column) => column?.name),
				`${resource.tableName}.${name}`,
			).to.include(name);
			expect(
				resource.orderBy.at(0),
				`${resource.kind} must list by the column reorder rewrites`,
			).to.equal(resource.ordinalColumn);
		}
	});

	/**
	 * Every entity-backed destination type must now have a CRUD slice behind it. `queue`,
	 * `conference` and `park` were the three that did not, which is why the picker in `apps/web`
	 * could show them but never populate them.
	 */
	it("backs every entity-backed destination type with a resource declaration", () => {
		const declared = new Set(RESOURCES.map((resource) => resource.destinationType));
		for (const type of DESTINATION_TYPES) {
			if (DESTINATION_TARGET_TABLES[type] === null) {
				continue;
			}
			expect(declared.has(type), `no resource declares destinationType "${type}"`).to.equal(true);
		}
	});

	it("covers every entity-backed destination type with at least one site", () => {
		// If a type can be pointed at but no site is scanned, deleting its target would silently
		// leave a dangling pointer that only the NEXT, unrelated save would discover.
		const scanned = new Set(DESTINATION_SITES.map((site) => site.table));
		for (const type of DESTINATION_TYPES) {
			const target = DESTINATION_TARGET_TABLES[type];
			if (target === null) {
				continue;
			}
			expect(scanned.size, `no destination sites declared`).to.be.greaterThan(0);
		}
		// Every table that owns a trio is scanned exactly as often as it owns one. Fourteen before the
		// T2 admin block, twenty after it: call flows own TWO (a switch's dead half must refuse a
		// delete as loudly as its live half), and aliases, streams, directories and speed dials own
		// one each.
		expect(DESTINATION_SITES.length).to.equal(20);
	});
});
