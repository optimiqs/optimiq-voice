import { outboundRoute, pinSet, pinSetEntry } from "@optimiq-voice/pbx-db";
import type { PbxChildResource, PbxResource } from "../shared/pbx-resource";

/**
 * Outbound authorisation codes.
 *
 * ## `scalarReferences`, because a PIN set is not a destination
 *
 * Nothing points at a PIN set with a destination trio — it is not somewhere a call goes, it is a
 * gate in front of somewhere. The pointer is `outbound_route.pin_set_id`, a plain foreign key, and
 * the generic reverse scan only knows about trios. Declaring it here is what turns "delete the set
 * three routes are gated by" into a 409 naming those routes instead of a silent widening of who may
 * dial internationally — which is the worst possible way for a delete to succeed.
 *
 * The column itself is `on delete set null` rather than `restrict`, so the database would allow it;
 * the refusal is a product decision made here, where it can name the routes.
 */
export const PIN_SET_RESOURCE: PbxResource = {
	kind: "pin-set",
	tableName: "pin_set",
	table: pinSet,
	searchColumns: [pinSet.name, pinSet.description],
	orderBy: [pinSet.name, pinSet.id],
	enabledColumn: pinSet.enabled,
	destinations: [],
	destinationType: null,
	scalarReferences: [
		{
			table: "outbound_route",
			kind: "outbound-route",
			column: "pin_set_id",
			nameColumn: "name",
		},
	],
};

/**
 * One authorisation code.
 *
 * `secretColumns` carries `pinHash`, for exactly the reason `voicemail_box.pin_hash` does: a digest
 * is not information an admin screen can use, it is offline-crackable by anyone who obtains it, and
 * a four-digit PIN behind scrypt is a few CPU-seconds of work once the digest is in hand. The write
 * DTOs exclude the column too — a code is set through the dedicated endpoint that hashes it — and
 * this is the read half of the same sentence.
 *
 * `ordinalColumn` earns the collection its `PUT …/reorder`, and the order is not cosmetic here: the
 * ordinal is the identity a CDR records ("code 3, the night desk"), so it is a value an
 * administrator chooses rather than a position a loader happens to return.
 */
export const PIN_SET_ENTRY_RESOURCE: PbxChildResource = {
	kind: "pin-set-entry",
	tableName: "pin_set_entry",
	table: pinSetEntry,
	searchColumns: [pinSetEntry.label],
	orderBy: [pinSetEntry.ordinal, pinSetEntry.id],
	ordinalColumn: pinSetEntry.ordinal,
	enabledColumn: pinSetEntry.enabled,
	destinations: [],
	destinationType: null,
	parentColumn: pinSetEntry.pinSetId,
	parentKind: "pin-set",
	parentTable: pinSet,
	secretColumns: ["pinHash"],
};

/** Re-exported so the resource file is the one place that names the referring table. */
export const PIN_SET_REFERRING_TABLE = outboundRoute;
