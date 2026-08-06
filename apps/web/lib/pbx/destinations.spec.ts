import { describe, expect, it } from "bun:test";
import {
	describeDestination,
	destinationFieldNames,
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
	 * `queue`, `conference` and `park` are entity-backed with no CRUD endpoint in P3. Offering them
	 * would produce a ref the user cannot populate and the compiler rejects as dangling.
	 */
	it("hides entity types that have no management screen", () => {
		const offered = selectableDestinationTypes(null);
		expect(offered).not.toContain("queue");
		expect(offered).not.toContain("conference");
		expect(offered).not.toContain("park");
		expect(offered).toContain("extension");
		expect(offered).toContain("external");
		expect(offered).toContain("hangup");
	});

	/** Otherwise an edit would silently re-point a seeded queue destination at whatever is first. */
	it("keeps the current value selectable even when it is not offered", () => {
		expect(selectableDestinationTypes("queue")).toContain("queue");
	});

	it("only claims a target for types the picker can actually populate", () => {
		expect(destinationTarget("extension")?.path).toBe("/extensions");
		expect(destinationTarget("queue")).toBeUndefined();
		expect(destinationTarget("external")).toBeUndefined();
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
