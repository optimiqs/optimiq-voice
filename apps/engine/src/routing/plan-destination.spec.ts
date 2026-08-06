import { describe, expect, it } from "bun:test";
import { PLAN_NODE_KINDS } from "@optimiq-voice/routing";
import { planDestinationOf } from "./plan-destination";
import {
	extensionNode,
	hangupNode,
	ivrMenuNode,
	playbackNode,
	ringGroupNode,
	timeConditionNode,
	trunkDialNode,
	voicemailNode,
} from "./plan-fixtures.fake";
import type { PlanNode } from "@optimiq-voice/routing";

/**
 * The projection the CDR's `destination_type` / `destination_ref` columns are filled from.
 *
 * The property that matters most is the last one in this file: EVERY plan-node kind is accounted
 * for. A kind added to `packages/routing` that nobody maps here would silently produce a CDR that
 * says `unknown` for a destination the system knows perfectly well.
 */

describe("planDestinationOf", () => {
	it("maps an extension to its row", () => {
		expect(planDestinationOf(extensionNode("e"))).toEqual({
			destinationType: "extension",
			destinationRef: "ext-e",
		});
	});

	it("maps a ring group to its row", () => {
		expect(planDestinationOf(ringGroupNode("g"))).toEqual({
			destinationType: "ring-group",
			destinationRef: "rg-g",
		});
	});

	it("maps an IVR menu to its row", () => {
		expect(planDestinationOf(ivrMenuNode("m"))).toEqual({
			destinationType: "ivr-menu",
			destinationRef: "ivr-m",
		});
	});

	it("maps a voicemail box to its row", () => {
		expect(planDestinationOf(voicemailNode("v"))).toEqual({
			destinationType: "voicemail",
			destinationRef: "vm-v",
		});
	});

	it("maps a trunk dial to the OUTBOUND ROUTE, which is the row a report joins on", () => {
		expect(planDestinationOf(trunkDialNode("t"))).toEqual({
			destinationType: "trunk-dial",
			destinationRef: "route-t",
		});
	});

	it("keeps kebab-case, because that is the vocabulary the column already speaks", () => {
		expect(planDestinationOf(ringGroupNode("g"))?.destinationType).toBe("ring-group");
	});

	it("reports a type but no ref for a value-backed destination", () => {
		expect(
			planDestinationOf({
				id: "x",
				kind: "external",
				destination: "+15551234567",
				viaOutboundRouting: false,
			} as PlanNode),
		).toEqual({ destinationType: "external" });
	});

	it("reports a type but no ref for a playback", () => {
		expect(planDestinationOf(playbackNode("p"))).toEqual({ destinationType: "playback" });
	});

	it("reports a type but no ref for an application", () => {
		expect(
			planDestinationOf({ id: "a", kind: "application", application: "autopilot" } as PlanNode),
		).toEqual({ destinationType: "application" });
	});

	it("does NOT treat a hangup terminal as a destination", () => {
		// Every path ends at one, so recording it would make every CDR in the system say `hangup`.
		expect(planDestinationOf(hangupNode("h", "NORMAL_CLEARING"))).toBeUndefined();
	});

	it("does NOT treat a time-condition gate as a destination", () => {
		expect(planDestinationOf(timeConditionNode("t", { matchNodeId: "x" }))).toBeUndefined();
	});

	it("maps a feature code to its row", () => {
		expect(
			planDestinationOf({
				id: "f",
				kind: "feature-code",
				featureCodeId: "fc-1",
				code: "*97",
				action: "voicemail-check",
			} as PlanNode),
		).toEqual({ destinationType: "feature-code", destinationRef: "fc-1" });
	});

	it("maps a queue, a conference and a park lot to their rows", () => {
		expect(planDestinationOf({ id: "q", kind: "queue", queueId: "q-1" } as PlanNode)).toEqual({
			destinationType: "queue",
			destinationRef: "q-1",
		});
		expect(
			planDestinationOf({ id: "c", kind: "conference", conferenceId: "c-1" } as PlanNode),
		).toEqual({ destinationType: "conference", destinationRef: "c-1" });
		expect(planDestinationOf({ id: "p", kind: "park", parkLotId: "p-1" } as PlanNode)).toEqual({
			destinationType: "park",
			destinationRef: "p-1",
		});
	});

	it("accounts for EVERY plan-node kind the compiler can produce", () => {
		const mapped = new Set<string>();
		for (const kind of PLAN_NODE_KINDS) {
			const destination = planDestinationOf({ id: "x", kind } as PlanNode);
			if (destination !== undefined) {
				expect(destination.destinationType).toBe(kind);
				mapped.add(kind);
			}
		}
		// The only two kinds that intentionally have no destination.
		expect([...PLAN_NODE_KINDS].filter((kind) => !mapped.has(kind)).sort()).toEqual([
			"hangup",
			"time-condition",
		]);
	});
});
