import { sharedLine, sharedLineAppearance } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Shared line appearances (SLA / BLA), and the appearances that hang off one.
 *
 * ## Why neither table carries a destination trio, and why `destinationType` is null
 *
 * A shared line is a SHARED RESOURCE, not a way to REACH somebody. A ring group fans a call out and
 * is done the moment anyone answers; a shared line stays a single seizable thing whose state — who
 * holds it, whether it is on hold, when it recalls — every appearance can see. That state lives in a
 * KV claim the engine CAS-updates, not in a routing edge, so the line has nowhere to send a call
 * that goes unanswered: there is no branch to route out of, and `destinations` is empty on BOTH
 * tables for the same reason a paging group's are.
 *
 * `destinationType` is `null` because nothing points AT a shared line as a destination either. It is
 * reached by dialling its own `extensionNumber` (compiled straight from this table), never as an IVR
 * option or a time-condition branch — `DESTINATION_TYPES` has no `shared-line` member, so the generic
 * reverse scan has nothing to look for and a delete is never a 409 on this account.
 */
export const SHARED_LINE_RESOURCE: PbxResource = {
	kind: "shared-line",
	tableName: "shared_line",
	table: sharedLine,
	searchColumns: [sharedLine.name, sharedLine.extensionNumber],
	orderBy: [sharedLine.name, sharedLine.id],
	enabledColumn: sharedLine.enabled,
	/** A shared line never routes a call out — its state lives in a KV claim, not a trio. */
	destinations: [],
	destinationType: null,
};

/**
 * One appearance — one extension's button on the shared line.
 *
 * `ordinalColumn` is what earns this collection its `PUT …/reorder`, and here the ordinal is more
 * than a display order: it is the APPEARANCE INDEX the phone lights and the number sipd stamps into
 * the `Call-Info` header. Reordering the appearances renumbers the buttons, so it is the operator's
 * decision and rewritten wholesale in one transaction rather than PATCH by PATCH — the same argument
 * a ring group's and a paging group's members make, sharpened by the `(line, ordinal)` unique index
 * that would refuse most of the intermediate states a per-row shuffle would have to pass through.
 */
export const SHARED_LINE_APPEARANCE_RESOURCE: PbxChildResource = {
	kind: "shared-line-appearance",
	tableName: "shared_line_appearance",
	table: sharedLineAppearance,
	searchColumns: [],
	orderBy: [sharedLineAppearance.ordinal, sharedLineAppearance.id],
	ordinalColumn: sharedLineAppearance.ordinal,
	enabledColumn: sharedLineAppearance.enabled,
	destinations: [],
	destinationType: null,
	parentColumn: sharedLineAppearance.sharedLineId,
	parentKind: "shared-line",
	parentTable: sharedLine,
};
