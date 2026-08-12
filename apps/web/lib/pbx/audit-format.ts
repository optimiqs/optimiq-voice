/**
 * How a change-ledger entry reads.
 *
 * Pure, and separate from the screen for the reason `lib/cdr/format.ts` is separate from the call
 * history table: the same entry is rendered in a row, a diff and a filter option, and three copies
 * of "who did this" become three different answers the first time one is edited.
 *
 * ## The ledger stores identifiers, not names, and that is not a gap to paper over
 *
 * `actor_user_id` is a `user.id` and `resource_ref` is a row id. Resolving either to a display name
 * would mean a lookup per row against tables the ledger deliberately does not join to — the entry
 * has to stay readable after the row it describes has been deleted, which is the case an audit log
 * exists for. So the identifier is shown as an identifier, shortened for scanning with the whole
 * value available to copy, and the columns around it carry the meaning.
 */

import type { AuditActorType, AuditLogEntryRow } from "./contracts";

export const AUDIT_ACTOR_TYPE_LABELS: Readonly<Record<AuditActorType, string>> = {
	user: "Person",
	"api-key": "API key",
	service: "Service",
	system: "System",
};

/**
 * A physical table name as a sentence fragment: `org_setting` → "org setting".
 *
 * `resource_type` holds the TABLE name, which is what the ledger is indexed on and what the filter
 * takes. Underscores are the only thing between that and something readable, so that is all this
 * does — inventing prettier names per table would be a second vocabulary to keep in step with the
 * schema, and the filter would still take the real one.
 */
export function auditResourceLabel(resourceType: string): string {
	return resourceType.replaceAll("_", " ");
}

/**
 * The verb, split for display: `extension.update` → `{ entity: "extension", verb: "update" }`.
 *
 * Returns the whole string as the verb when there is no dot. The DTO's pattern guarantees one for
 * anything the FILTER accepts, but a row is whatever the writer stored, and a table that dropped a
 * malformed action would hide exactly the entry somebody is looking for.
 */
export function splitAuditAction(action: string): {
	readonly entity: string;
	readonly verb: string;
} {
	const dot = action.indexOf(".");
	return dot === -1
		? { entity: "", verb: action }
		: { entity: action.slice(0, dot), verb: action.slice(dot + 1) };
}

/**
 * Who did it, as the pair the ledger actually stores.
 *
 * `audit-log.ts` keeps the two principals apart on purpose: a person is `actor_user_id` with a NULL
 * `actor_ref`, and an API key or a service is `actor_ref` with a NULL `actor_user_id`. This returns
 * whichever is present rather than collapsing them, so a row can never claim a service was a person.
 * `system` legitimately has neither — a migration or a scheduled job has no principal to name.
 */
export function auditActorRef(row: AuditLogEntryRow): string | null {
	return row.actorUserId ?? row.actorRef;
}

/** An id, shortened for scanning. The full value stays in a `title` at the call site. */
export function shortId(value: string): string {
	return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`;
}

export interface AuditFieldChange {
	readonly field: string;
	/** `undefined` when the side has no entry for this column — a create has no before. */
	readonly before: unknown;
	readonly after: unknown;
}

/**
 * The columns an entry changed, as one row per column.
 *
 * `before` and `after` already hold the CHANGED columns only — the server diffs them at write time
 * — so this is a union of two key sets rather than a comparison. That distinction matters: a value
 * that appears on one side only is a create or a delete, not a column this function decided was
 * uninteresting.
 *
 * A secret column's VALUE never entered the table, but its NAME appears on both sides, so
 * "somebody rotated this extension's SIP password" stays auditable without the password being in
 * the ledger. Nothing here needs to redact anything; there is nothing to redact.
 *
 * The order is `before`'s keys first, then whatever only `after` has, which keeps a row's columns in
 * the same order across the entries of one edit instead of in whatever order a JSON object was
 * serialised in.
 */
export function auditFieldChanges(entry: AuditLogEntryRow): readonly AuditFieldChange[] {
	const before = entry.before ?? {};
	const after = entry.after ?? {};
	const fields = [...Object.keys(before), ...Object.keys(after).filter((key) => !(key in before))];
	return fields.map((field) => ({
		field,
		before: field in before ? before[field] : undefined,
		after: field in after ? after[field] : undefined,
	}));
}

/**
 * One side of a diff, as text.
 *
 * `undefined` — the column is absent from this side — reads as an em dash, and a stored `null`
 * reads as "null". They are different facts: the first means "this entry does not describe that
 * side", the second means the column was set to nothing.
 */
export function auditValueText(value: unknown): string {
	if (value === undefined) {
		return "—";
	}
	if (value === null) {
		return "null";
	}
	return typeof value === "string" ? value : JSON.stringify(value);
}
