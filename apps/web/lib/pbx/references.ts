/**
 * Turning a refused delete into somewhere the user can go.
 *
 * A `PBX_REFERENCED` 409 names the rows that still point at the entity — `{ kind, id, name }` —
 * and the whole reason the API refuses rather than cascading is so the user can go and re-point
 * them while they still have the context. That is only true if the names are LINKS. A list of
 * "inbound-route 0193f2…" is a dead end wearing the costume of an explanation.
 *
 * Several kinds have no screen of their own yet (`queue`, `park-lot`, `conference`, and the two
 * child kinds whose parent is the linkable thing). Those resolve to their parent's list or to
 * nothing at all, and a reference with no destination renders as plain text rather than as a link
 * that goes nowhere.
 */

import { routes, routingTabHref } from "../routes";
import type { EntityReference } from "./contracts";

/** Human wording for a `kind` as it appears in a 409 or a diagnostic subject. */
export const REFERENCE_KIND_LABELS: Readonly<Record<string, string>> = {
	extension: "Extension",
	"phone-number": "Number",
	trunk: "Trunk",
	"inbound-route": "Inbound route",
	"outbound-route": "Outbound route",
	"time-condition": "Time condition",
	"feature-code": "Feature code",
	"ivr-menu": "IVR menu",
	"ivr-menu-option": "IVR menu option",
	"ring-group": "Ring group",
	"ring-group-destination": "Ring group member",
	queue: "Queue",
	"park-lot": "Park lot",
	conference: "Conference",
	"voicemail-box": "Voicemail box",
	"voicemail-option": "Voicemail option",
};

export function referenceKindLabel(kind: string): string {
	return REFERENCE_KIND_LABELS[kind] ?? kind;
}

/**
 * Where each kind is listed, and under which query key that list reads its search box.
 *
 * The search key is NOT always `q`. The four Routing tabs share one page, so each keeps its own
 * URL state under a prefix (`inq`, `outq`, `tcq`, `fcq`) — otherwise searching inbound routes
 * would page the outbound table too. A link that used `q` for all of them would land on the right
 * tab with an empty search box, which looks like the row is not there.
 */
interface KindListing {
	readonly path: string;
	readonly searchKey: string;
}

const KIND_LISTINGS: Readonly<Record<string, KindListing>> = {
	extension: { path: routes.extensions, searchKey: "q" },
	"phone-number": { path: routes.numbers, searchKey: "q" },
	trunk: { path: routes.trunks, searchKey: "q" },
	"inbound-route": { path: routingTabHref("inbound"), searchKey: "inq" },
	"outbound-route": { path: routingTabHref("outbound"), searchKey: "outq" },
	"time-condition": { path: routingTabHref("time-conditions"), searchKey: "tcq" },
	"feature-code": { path: routingTabHref("feature-codes"), searchKey: "fcq" },
	"ivr-menu": { path: routes.ivr, searchKey: "q" },
	"ivr-menu-option": { path: routes.ivr, searchKey: "q" },
	"ring-group": { path: routes.ringGroups, searchKey: "q" },
	"ring-group-destination": { path: routes.ringGroups, searchKey: "q" },
	queue: { path: routes.queues, searchKey: "q" },
	"park-lot": { path: routes.routing, searchKey: "q" },
	conference: { path: routes.conferences, searchKey: "q" },
	"voicemail-box": { path: routes.voicemail, searchKey: "q" },
	"voicemail-option": { path: routes.voicemail, searchKey: "q" },
};

/**
 * Where to send someone to fix a referring row.
 *
 * The three entities with a detail view get a direct link. Everything else lands on its list with
 * the row's name already in the search box — the list is where the row is editable, and arriving
 * with the search prefilled is the difference between "here is the page it is on" and "here it
 * is".
 */
export function referenceHref(reference: EntityReference): string | undefined {
	switch (reference.kind) {
		case "ivr-menu": {
			return routes.ivrMenu(reference.id);
		}
		case "ring-group": {
			return routes.ringGroup(reference.id);
		}
		case "time-condition": {
			return routes.timeCondition(reference.id);
		}
		default: {
			break;
		}
	}

	const listing = KIND_LISTINGS[reference.kind];
	if (listing === undefined) {
		return undefined;
	}
	if (!reference.name) {
		return listing.path;
	}
	const separator = listing.path.includes("?") ? "&" : "?";
	return `${listing.path}${separator}${listing.searchKey}=${encodeURIComponent(reference.name)}`;
}

/** The label shown for one reference: its name when it has one, otherwise a short id. */
export function referenceLabel(reference: EntityReference): string {
	return reference.name ?? `${reference.id.slice(0, 8)}…`;
}
