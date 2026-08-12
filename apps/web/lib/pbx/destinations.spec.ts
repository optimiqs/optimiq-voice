import { describe, expect, it } from "bun:test";
import {
	DESTINATION_TYPE_LABELS,
	describeDestination,
	destinationFieldNames,
	destinationKind,
	destinationTarget,
	EMPTY_DESTINATION,
	readDestination,
	selectableDestinationTypes,
	validateDestinationValue,
	writeDestination,
} from "./destinations";
import type { DestinationValue } from "./destinations";

/**
 * The destination trio is where a client bug becomes a 422 the user cannot explain, so the two
 * translations — row to control, control to request body — are pinned here rather than trusted.
 */

describe("destinationFieldNames", () => {
	it("names the primary trio without a prefix", () => {
		expect(destinationFieldNames("")).toEqual({
			type: "destinationType",
			ref: "destinationRef",
			data: "destinationData",
		});
	});

	/**
	 * These strings are what the API puts in a `PBX_INVALID_DESTINATION` issue and in a compile
	 * diagnostic's `field`. If they drift, every server-side destination error silently stops
	 * landing on a control.
	 */
	it("names a secondary trio exactly as the API addresses it", () => {
		expect(destinationFieldNames("timeout")).toEqual({
			type: "timeoutDestinationType",
			ref: "timeoutDestinationRef",
			data: "timeoutDestinationData",
		});
		expect(destinationFieldNames("nomatch").ref).toBe("nomatchDestinationRef");
		expect(destinationFieldNames("failover").ref).toBe("failoverDestinationRef");
		expect(destinationFieldNames("invalid").data).toBe("invalidDestinationData");
	});

	/**
	 * The T2 admin block's two prefixes, and the only two REQUIRED secondary trios in the schema.
	 *
	 * A call flow's `night` is the other half of a switch and a stream's `fallback` is the branch
	 * taken when a driver cannot open a remote URL at all — neither is a "leave it unset and release
	 * the call" branch like `timeout` or `invalid`. The names are asserted for the reason the others
	 * are: they are what the server addresses an issue at, and a mismatch means a required-field error
	 * that lands on no control.
	 */
	it("names the call-flow and stream trios the API addresses", () => {
		expect(destinationFieldNames("night")).toEqual({
			type: "nightDestinationType",
			ref: "nightDestinationRef",
			data: "nightDestinationData",
		});
		expect(destinationFieldNames("fallback")).toEqual({
			type: "fallbackDestinationType",
			ref: "fallbackDestinationRef",
			data: "fallbackDestinationData",
		});
	});

	/**
	 * A queue's exit key, which is the second OPTIONAL trio on one row.
	 *
	 * Asserted on its own because `queue` is now the only entity carrying two of these — `timeout`
	 * and `exit` — and the whole reason the picker takes a prefix is that a form holding two trios
	 * must address them separately. A dialog that wrote both under `timeout` would silently make the
	 * exit key point wherever the wait cap does, which is a caller who pressed 2 being sent to the
	 * overflow they were trying to escape.
	 */
	it("names the queue's exit trio, the second optional one on a single row", () => {
		expect(destinationFieldNames("exit")).toEqual({
			type: "exitDestinationType",
			ref: "exitDestinationRef",
			data: "exitDestinationData",
		});
	});
});

describe("readDestination", () => {
	it("reads a trio off a row under any prefix", () => {
		const row = {
			destinationType: "ivr",
			destinationRef: "0193f2aa-0000-7000-8000-000000000001",
			destinationData: null,
			timeoutDestinationType: "voicemail",
			timeoutDestinationRef: "0193f2aa-0000-7000-8000-000000000002",
			timeoutDestinationData: null,
		};
		expect(readDestination(row, "")).toEqual({
			type: "ivr",
			ref: "0193f2aa-0000-7000-8000-000000000001",
			data: null,
		});
		expect(readDestination(row, "timeout").type).toBe("voicemail");
	});

	it("reads an absent trio as empty rather than as a partially filled one", () => {
		expect(readDestination({ destinationType: null }, "")).toEqual(EMPTY_DESTINATION);
		expect(readDestination(null, "timeout")).toEqual(EMPTY_DESTINATION);
	});
});

describe("writeDestination", () => {
	/**
	 * The bug this exists to prevent: the user picks `extension`, chooses one, then switches to
	 * `external`. A body that still carried the ref is a 422 with `unexpected-ref` that the user
	 * did not cause — the select did.
	 */
	it("drops the ref when the type is value-backed", () => {
		const value: DestinationValue = {
			type: "external",
			ref: "0193f2aa-0000-7000-8000-000000000001",
			data: { value: "+12125550100" },
		};
		expect(writeDestination(value, "")).toEqual({
			destinationType: "external",
			destinationRef: null,
			destinationData: { value: "+12125550100" },
		});
	});

	it("drops a literal payload when the type is entity-backed", () => {
		const value: DestinationValue = {
			type: "extension",
			ref: "0193f2aa-0000-7000-8000-000000000001",
			data: { value: "leftover" },
		};
		expect(writeDestination(value, "failover")).toEqual({
			failoverDestinationType: "extension",
			failoverDestinationRef: "0193f2aa-0000-7000-8000-000000000001",
			failoverDestinationData: null,
		});
	});

	it("keeps only the cause on a hangup", () => {
		const value: DestinationValue = {
			type: "hangup",
			ref: null,
			data: { value: "ignored", cause: "USER_BUSY" },
		};
		expect(writeDestination(value, "timeout")).toEqual({
			timeoutDestinationType: "hangup",
			timeoutDestinationRef: null,
			timeoutDestinationData: { cause: "USER_BUSY" },
		});
	});

	/** `{}` reads back as a payload that exists; "no data" has to be `null`. */
	it("collapses an all-blank payload to null", () => {
		expect(writeDestination({ type: "hangup", ref: null, data: { cause: "  " } }, "")).toEqual({
			destinationType: "hangup",
			destinationRef: null,
			destinationData: null,
		});
	});

	it("clears the whole trio when there is no destination", () => {
		expect(writeDestination(EMPTY_DESTINATION, "nomatch")).toEqual({
			nomatchDestinationType: null,
			nomatchDestinationRef: null,
			nomatchDestinationData: null,
		});
	});

	it("trims the literal value, because a trailing space in a dialled number is a failed call", () => {
		expect(
			writeDestination({ type: "external", ref: null, data: { value: " +12125550100 " } }, ""),
		).toMatchObject({ destinationData: { value: "+12125550100" } });
	});
});

describe("validateDestinationValue", () => {
	it("requires a destination only where one is required", () => {
		expect(validateDestinationValue(EMPTY_DESTINATION, { required: true })?.field).toBe("type");
		expect(validateDestinationValue(EMPTY_DESTINATION, { required: false })).toBeUndefined();
	});

	it("requires a ref for an entity destination", () => {
		expect(
			validateDestinationValue({ type: "ring-group", ref: null, data: null }, { required: true })
				?.field,
		).toBe("ref");
	});

	it("requires a literal for a value destination", () => {
		expect(
			validateDestinationValue({ type: "external", ref: null, data: null }, { required: false })
				?.field,
		).toBe("data");
	});

	it("accepts a hangup with nothing at all", () => {
		expect(
			validateDestinationValue({ type: "hangup", ref: null, data: null }, { required: true }),
		).toBeUndefined();
	});
});

describe("selectableDestinationTypes", () => {
	/**
	 * `queue`, `conference` and `park` were entity-backed with no CRUD endpoint, so offering them
	 * would have produced a ref the user could not populate and the compiler rejects as dangling.
	 * Their endpoints have landed, so they are offered — and the RULE has not changed: a type is
	 * offered when, and only when, it has a list behind it.
	 */
	it("offers every entity type that has a management screen", () => {
		const offered = selectableDestinationTypes(null);
		expect(offered).toContain("queue");
		expect(offered).toContain("conference");
		expect(offered).toContain("park");
		expect(offered).toContain("extension");
		expect(offered).toContain("external");
		expect(offered).toContain("hangup");
	});

	/**
	 * The rule itself, stated without naming a type: an entity-backed type with no target is still
	 * hidden. This is what keeps the next such type from being offered before it can be populated.
	 */
	it("still hides an entity type with no target", () => {
		const offered = selectableDestinationTypes(null);
		for (const type of offered) {
			if (destinationKind(type) !== "entity") {
				continue;
			}
			expect(destinationTarget(type)).toBeDefined();
		}
	});

	/** Otherwise an edit would silently re-point a destination at whatever is first in the select. */
	it("keeps the current value selectable", () => {
		expect(selectableDestinationTypes("queue")).toContain("queue");
	});

	it("only claims a target for types the picker can actually populate", () => {
		expect(destinationTarget("extension")?.path).toBe("/extensions");
		expect(destinationTarget("queue")?.path).toBe("/queues");
		expect(destinationTarget("conference")?.path).toBe("/conferences");
		expect(destinationTarget("park")?.path).toBe("/park-lots");
		// Value- and terminal-backed types have no row to pick, and never gain one.
		expect(destinationTarget("external")).toBeUndefined();
		expect(destinationTarget("application")).toBeUndefined();
		expect(destinationTarget("hangup")).toBeUndefined();
	});

	/**
	 * The T2 admin block's four, every one of them entity-backed and every one offerable from the day
	 * it landed — unlike `queue`, `conference` and `park`, which spent a wave hidden because they had
	 * no list to populate from.
	 *
	 * `alias` is the one worth asserting rather than assuming. It compiles FLAT — an alias produces no
	 * plan node, it resolves to whatever its target resolved to — so there is a real temptation to
	 * treat it as something other than an ordinary entity destination. It is not: it has a ref, a
	 * table and a list, and the picker needs to know nothing else about it.
	 */
	it("offers the admin block's four, alias included", () => {
		const offered = selectableDestinationTypes(null);
		expect(offered).toContain("call-flow");
		expect(offered).toContain("stream");
		expect(offered).toContain("dial-by-name");
		expect(offered).toContain("alias");

		expect(destinationTarget("call-flow")?.path).toBe("/call-flows");
		expect(destinationTarget("stream")?.path).toBe("/audio-streams");
		expect(destinationTarget("dial-by-name")?.path).toBe("/directories");
		expect(destinationTarget("alias")?.path).toBe("/destination-aliases");
	});

	/**
	 * Named for what it DOES rather than for its table.
	 *
	 * "Destination alias" is the row's name, and in a select of places a call can go it would read as
	 * a synonym for the word above it. The label is asserted because it is the sort of thing a
	 * consistency pass would "correct" back to the table name.
	 */
	it("labels an alias as a named destination rather than as its table", () => {
		expect(DESTINATION_TYPE_LABELS.alias).toBe("Named destination");
	});
});

describe("describeDestination", () => {
	it("summarises each kind for a table cell", () => {
		expect(describeDestination(EMPTY_DESTINATION)).toBe("—");
		expect(
			describeDestination({ type: "external", ref: null, data: { value: "+12125550100" } }),
		).toBe("External number: +12125550100");
		expect(describeDestination({ type: "hangup", ref: null, data: { cause: "USER_BUSY" } })).toBe(
			"Hang up (USER_BUSY)",
		);
	});

	it("uses a resolved name when one is available, and a short id when not", () => {
		const value: DestinationValue = {
			type: "ring-group",
			ref: "0193f2aa-0000-7000-8000-000000000001",
			data: null,
		};
		expect(describeDestination(value, () => "Sales")).toBe("Ring group: Sales");
		expect(describeDestination(value)).toBe("Ring group: 0193f2aa");
	});
});
