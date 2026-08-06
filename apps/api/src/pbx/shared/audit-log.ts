import { auditLog } from "@optimiq-voice/pbx-db";
import { API_KEY_PRINCIPAL_ROLE } from "../../auth/auth-http.plugin";
import type { AppSession } from "@optimiq-voice/auth";
import type { AuditActorType, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The `audit_log` writer's pure half — who did it, what changed, and what is safe to keep.
 *
 * ## Why this file has no database in it beyond one insert
 *
 * `security-schema.ts` calls `audit_log` an append-only ledger and backs that with privileges:
 * `pbx_tenant_tls` holds `SELECT, INSERT` and nothing else, under two policies rather than one
 * `FOR ALL`. A ledger with those properties is only worth having if the rows in it are *provable*
 * — which means the decision about what a row contains has to be testable without a broker, a
 * pool or a session. So the shaping (actor derivation, the diff, the redaction) is plain
 * functions here, and {@link insertAuditLog} is the four lines that put the result in the table.
 *
 * ## The diff is the CHANGED columns, never the whole row
 *
 * A ledger that stores both full rows on every PATCH is a second copy of the database with worse
 * indexes. `before`/`after` therefore carry only the keys whose value actually moved, which is
 * what an operator reading "who turned outbound calling off?" needs and is small enough that
 * thirty days of it costs nothing. A create has no `before` and an after of the row as inserted;
 * a delete has the row as it last was and no `after`.
 *
 * ## `secretColumns` is honoured here, not hoped for
 *
 * {@link PbxResource.secretColumns} exists because a value may go IN through a DTO and must never
 * come back OUT — `sip_password_ha1`, `sip_secret_ref`, `pin_hash`, `provisioning_token_hash`.
 * A ledger is an "out": it is queryable by anyone with `SELECT` on the table, it is what gets
 * exported to a SIEM, and it is the one place a redaction bug survives for thirty days instead of
 * for one response. So every secret column is dropped from BOTH sides of the diff, and its
 * presence is recorded as the column NAME in the changed list — "somebody rotated this
 * extension's SIP password" is the auditable fact; the password is not.
 *
 * ## The timestamps are not changes
 *
 * `updated_at` moves on every single update (Drizzle refreshes it), so including it would put one
 * meaningless key in every diff and make "did anything really change?" unanswerable at a glance.
 * `created_at`, `id` and `organization_id` are excluded on the same grounds: the ledger row
 * already carries the tenant, the resource and the instant.
 */

/** Row keys that are never a "change" worth recording. See the header. */
const IGNORED_KEYS: ReadonlySet<string> = new Set([
	"id",
	"organizationId",
	"createdAt",
	"updatedAt",
]);

/** What the ledger writes into `action`, appended to the resource kind. */
export type AuditAction = "create" | "update" | "delete" | "reorder";

/**
 * The principal behind a mutation, already narrowed to what the ledger's columns accept.
 *
 * Built by {@link actorFromSession} at the one layer that has a session — never inferred deeper
 * down, for the same reason the repository never infers a tenant.
 */
export interface AuditActor {
	readonly type: AuditActorType;
	/** `user.id` in the auth database, or `null` for a principal with no person behind it. */
	readonly userId: string | null;
	/** `api_key.id` for an API-key caller; the service name for a service. `null` for a user. */
	readonly ref: string | null;
	readonly ipAddress: string | null;
	readonly userAgent: string | null;
	readonly requestId: string | null;
}

/** One ledger row, fully shaped. Nothing below this interface makes a decision. */
export interface AuditLogEntry {
	readonly organizationId: string;
	readonly actor: AuditActor;
	/** Dotted verb: `extension.update`, `org-setting.create`. */
	readonly action: string;
	/** Physical table name, e.g. `extension`. */
	readonly resourceType: string;
	readonly resourceRef: string | null;
	readonly before: Record<string, unknown> | null;
	readonly after: Record<string, unknown> | null;
}

/** The service principal every non-request writer uses. Kept here so the name has one spelling. */
export function serviceActor(name: string): AuditActor {
	return {
		type: "service",
		userId: null,
		ref: name,
		ipAddress: null,
		userAgent: null,
		requestId: null,
	};
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * The value, if it is a UUID; `null` otherwise.
 *
 * `actor_user_id`, `resource_ref` and `request_id` are native `uuid` columns, and the ledger write
 * shares the mutation's transaction — so a value Postgres cannot cast would not "lose an audit
 * row", it would roll the user's write back with a 22P02. Every id that reaches a uuid column is
 * therefore checked here first, and an unparseable one degrades to `null` rather than to a 500.
 */
export function asUuid(value: string | null | undefined): string | null {
	return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

/**
 * The value, if it is plausibly an address `inet` will accept; `null` otherwise.
 *
 * Same argument as {@link asUuid}, one column over. Deliberately a shape check and not a parser:
 * the point is to keep a header-derived string from failing the transaction, not to validate
 * anybody's network.
 */
export function asInetAddress(value: string | null | undefined): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > 45) {
		return null;
	}
	// IPv4, IPv6, or either with a prefix length. Anything else is not worth a round trip.
	return /^[0-9a-f:.]+(\/\d{1,3})?$/iu.test(trimmed) ? trimmed : null;
}

function truncate(value: string | null | undefined, max: number): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		return null;
	}
	return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * The actor a request's session represents.
 *
 * Two principals reach this API and the ledger keeps them apart, because "an admin changed the
 * outbound route" and "a script changed the outbound route" are different incidents:
 *
 * - a **person** — `actor_type = user`, `actor_user_id` is their `user.id`, `actor_ref` is null
 *   (the schema reserves `actor_ref` for the non-user cases);
 * - an **API key** — `auth-http.plugin.ts` synthesises a session whose `user.role` is
 *   `API_KEY_PRINCIPAL_ROLE` and whose ids are the KEY's id, with no `user` row behind them. That
 *   becomes `actor_type = api-key` with the key id in `actor_ref` and `actor_user_id` NULL,
 *   because writing a key id into a column documented as `user.id` is how a join silently starts
 *   attributing machine traffic to whichever person shares that uuid.
 *
 * `ipAddress` / `userAgent` come off the session record rather than off the request, so this stays
 * a pure function of the session and every caller gets the same answer.
 */
export function actorFromSession(session: AppSession): AuditActor {
	const isApiKey = session.user.role === API_KEY_PRINCIPAL_ROLE;
	return {
		type: isApiKey ? "api-key" : "user",
		userId: isApiKey ? null : (asUuid(session.user.id) ?? asUuid(session.session.userId)),
		ref: isApiKey ? truncate(session.user.id, 128) : null,
		ipAddress: asInetAddress(session.session.ipAddress),
		userAgent: truncate(session.session.userAgent, 512),
		requestId: null,
	};
}

/** A value the `jsonb` columns can hold: `Date` becomes an instant, anything exotic becomes a tag. */
function toJsonValue(value: unknown): unknown {
	if (value === null || value === undefined) {
		return null;
	}
	if (value instanceof Date) {
		return value.toISOString();
	}
	if (typeof value === "bigint") {
		return value.toString();
	}
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		Array.isArray(value) ||
		typeof value === "object"
	) {
		return value;
	}
	// Functions and symbols cannot appear in a Drizzle row; recorded rather than dropped so a
	// future column type that does produce one is visible in the ledger instead of invisible.
	return "[unserializable]";
}

function sameValue(left: unknown, right: unknown): boolean {
	const a = toJsonValue(left);
	const b = toJsonValue(right);
	if (a === b) {
		return true;
	}
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
		return false;
	}
	return JSON.stringify(a) === JSON.stringify(b);
}

/** What a secret column's value is replaced by. The NAME stays; the value never appears. */
export const REDACTED = "[redacted]";

/**
 * The names of the columns that moved, secrets INCLUDED.
 *
 * The name of a secret column is not a secret — "the SIP password was rotated" is precisely the
 * fact a ledger exists to record — so the changed list names it while {@link diffOf} keeps its
 * value out of `before`/`after`. `id`, `organization_id` and the timestamps never appear.
 */
export function changedColumns(
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown> | undefined,
): readonly string[] {
	const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
	const changed: string[] = [];
	for (const key of keys) {
		if (IGNORED_KEYS.has(key)) {
			continue;
		}
		if (!sameValue(before?.[key], after?.[key])) {
			changed.push(key);
		}
	}
	return changed.sort();
}

/**
 * The redacted projection of `row` over `keys` — the shape both sides of a diff take.
 *
 * A secret column keeps its KEY and loses its value to {@link REDACTED}: the diff still says "the
 * SIP password changed", which is the auditable fact, and the digest itself never reaches a table
 * anyone can `SELECT`.
 *
 * `null` when nothing survives, so a diff that consisted only of ignored keys stores a NULL rather
 * than an empty object that reads like "nothing changed".
 */
export function projectRow(
	row: Record<string, unknown> | undefined,
	keys: readonly string[],
	secretColumns: readonly string[] | undefined,
): Record<string, unknown> | null {
	if (row === undefined) {
		return null;
	}
	const secrets = secretColumns ?? [];
	const projected: Record<string, unknown> = {};
	for (const key of keys) {
		if (IGNORED_KEYS.has(key) || !(key in row)) {
			continue;
		}
		projected[key] = secrets.includes(key) ? REDACTED : toJsonValue(row[key]);
	}
	return Object.keys(projected).length === 0 ? null : projected;
}

/** `before` / `after` for one mutation, already redacted and already narrowed to what changed. */
export interface AuditDiff {
	readonly changed: readonly string[];
	readonly before: Record<string, unknown> | null;
	readonly after: Record<string, unknown> | null;
}

export function diffOf(
	before: Record<string, unknown> | undefined,
	after: Record<string, unknown> | undefined,
	secretColumns: readonly string[] | undefined,
): AuditDiff {
	const changed = changedColumns(before, after);
	return {
		changed,
		before: projectRow(before, changed, secretColumns),
		after: projectRow(after, changed, secretColumns),
	};
}

/**
 * Appends one row to the ledger, inside whatever transaction it is handed.
 *
 * The caller owns the transaction on purpose — see `AuditLogService` for why the write is part of
 * the mutation's unit of work rather than a continuation of it.
 */
export async function insertAuditLog(
	transaction: PbxDatabaseTransaction,
	entry: AuditLogEntry,
): Promise<void> {
	await transaction.insert(auditLog).values({
		organizationId: entry.organizationId,
		actorType: entry.actor.type,
		actorUserId: entry.actor.userId,
		actorRef: entry.actor.ref,
		action: entry.action,
		resourceType: entry.resourceType,
		resourceRef: entry.resourceRef,
		before: entry.before,
		after: entry.after,
		ipAddress: entry.actor.ipAddress,
		userAgent: entry.actor.userAgent,
		requestId: entry.actor.requestId,
		occurredAt: new Date(),
	});
}
