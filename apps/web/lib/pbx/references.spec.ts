import { describe, expect, it } from "bun:test";
import { DESTINATION_SITE_KINDS } from "./reference-kinds";
import {
	REFERENCE_KIND_LABELS,
	referenceHref,
	referenceKindLabel,
	referenceLabel,
} from "./references";
import type { EntityReference } from "./contracts";

/**
 * A `PBX_REFERENCED` 409 exists so the user can go and fix the rows that refused the delete. That
 * is only true if the names are links, so the kind→destination mapping is what these tests hold:
 * a kind the API can emit but this module has never heard of renders as dead text.
 */

function reference(kind: string, name: string | null = "Main line"): EntityReference {
	return { kind, id: "0193f2aa-0000-7000-8000-000000000002", name, field: "destination_ref" };
}

describe("referenceHref", () => {
	it("links the four entities with a detail view straight at the row", () => {
		expect(referenceHref(reference("ivr-menu"))).toBe("/ivr/0193f2aa-0000-7000-8000-000000000002");
		expect(referenceHref(reference("ring-group"))).toBe(
			"/ring-groups/0193f2aa-0000-7000-8000-000000000002",
		);
		expect(referenceHref(reference("queue"))).toBe("/queues/0193f2aa-0000-7000-8000-000000000002");
		expect(referenceHref(reference("time-condition"))).toBe(
			"/routing/time-conditions/0193f2aa-0000-7000-8000-000000000002",
		);
	});

	/**
	 * `park-lot` used to land on `/routing` — the closest thing to a home it had while lots were
	 * unmanageable. It has its own route now, and a stale mapping would send someone refused a
	 * delete to a page their lot is not on, which is worse than no link at all.
	 */
	it("sends a park lot to its own list rather than to the routing page", () => {
		expect(referenceHref(reference("park-lot", "Reception"))).toBe("/park-lots?q=Reception");
		expect(referenceHref(reference("conference", "All hands"))).toBe("/conferences?q=All%20hands");
	});

	/**
	 * An agent is deliberately NOT here. Nothing may point at one as a destination — a call is
	 * offered to a queue and the queue picks the agent — and `queue_tier.queue_agent_id` cascades, so
	 * the API has no reason to name an agent in a 409. A listing for a kind the server cannot emit
	 * would be a mapping nobody can reach and nobody can check.
	 */
	it("has no listing for kinds the API never emits as a reference", () => {
		expect(referenceHref(reference("queue-agent"))).toBeUndefined();
		expect(referenceHref(reference("queue-tier"))).toBeUndefined();
	});

	/**
	 * Everything else lands on its list with the row's name already in the search box — the list is
	 * where the row is editable, and arriving prefilled is the difference between "here is the page
	 * it is on" and "here it is".
	 */
	it("lands on the list with the name prefilled", () => {
		expect(referenceHref(reference("extension", "1001"))).toBe("/extensions?q=1001");
		expect(referenceHref(reference("phone-number", "+12125550100"))).toBe(
			"/numbers?q=%2B12125550100",
		);
	});

	/**
	 * The four Routing tabs share one page, so each keeps its URL state under its own prefix. A
	 * link that used `q` for all of them would land on the right tab with an EMPTY search box —
	 * which reads as "the row is not here", the opposite of what the 409 just said.
	 */
	it("uses each routing tab's own search key, and appends to an existing query string", () => {
		expect(referenceHref(reference("inbound-route", "Main line"))).toBe("/routing?inq=Main%20line");
		expect(referenceHref(reference("outbound-route", "National"))).toBe(
			"/routing?tab=outbound&outq=National",
		);
		expect(referenceHref(reference("feature-code", "*97"))).toBe(
			"/routing?tab=feature-codes&fcq=*97",
		);
	});

	it("falls back to the bare list when the row has no name to search for", () => {
		expect(referenceHref(reference("extension", null))).toBe("/extensions");
		expect(referenceHref(reference("outbound-route", null))).toBe("/routing?tab=outbound");
	});

	/** A child kind's parent is the linkable thing; the option itself has no page of its own. */
	it("sends a child kind to its parent's list", () => {
		expect(referenceHref(reference("ivr-menu-option", null))).toBe("/ivr");
		expect(referenceHref(reference("ring-group-destination", null))).toBe("/ring-groups");
	});

	it("returns nothing for a kind it has never heard of, so the UI renders plain text", () => {
		expect(referenceHref(reference("something-new"))).toBeUndefined();
	});
});

describe("referenceKindLabel", () => {
	/**
	 * The API can emit any of these kinds in a 409 or a diagnostic subject — the list comes from
	 * `DESTINATION_SITES` in `apps/api/src/pbx/shared/destinations.ts` plus the scalar reference
	 * sites. An unlabelled kind shows a raw `ring-group-destination` to a user.
	 */
	it("has human wording for every kind the API can emit", () => {
		for (const kind of DESTINATION_SITE_KINDS) {
			expect(REFERENCE_KIND_LABELS[kind]).toBeTruthy();
		}
	});

	it("degrades to the raw kind rather than to nothing", () => {
		expect(referenceKindLabel("something-new")).toBe("something-new");
	});
});

describe("referenceLabel", () => {
	it("prefers the name, and shortens the id when there is none", () => {
		expect(referenceLabel(reference("extension", "1001"))).toBe("1001");
		expect(referenceLabel(reference("ring-group-destination", null))).toBe("0193f2aa…");
	});
});
