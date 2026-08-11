import { z } from "zod/v4";
import { AUDIT_ACTOR_TYPES } from "@optimiq-voice/pbx-db";

/**
 * The query contract for the change ledger.
 *
 * ## The window is bounded, with a default rather than a demand
 *
 * `audit_log` grows with every mutation in the tenant and is never pruned by the API, so an
 * unbounded listing is a table scan waiting for a large enough tenant. Rather than requiring a
 * range — which produces exactly one client that forgets, in production, on the biggest
 * organization — the window DEFAULTS to {@link DEFAULT_RANGE_DAYS} and the server ECHOES the
 * window it actually applied in the response envelope. A defaulted filter the caller cannot see
 * is the thing that makes "why is my change missing?" unanswerable; a defaulted filter that comes
 * back in the body is a control the UI can render.
 *
 * ## The filters are exact, and they are the columns the ledger is indexed on
 *
 * Four questions get asked of an audit log — "what did this person do", "what happened to this
 * row", "who touched extensions at all", "what happened between these two times" — and each one
 * is a column with an index behind it (`security-schema.ts`). There is deliberately no free-text
 * `search`: the only text columns worth matching are `user_agent` and the `before`/`after` jsonb,
 * and an `ilike` over either is a sequential scan of the whole window dressed up as a feature.
 *
 * ## `actorUserId` and `actorRef` are two filters because they are two principals
 *
 * `audit-log.ts` keeps them apart on purpose: a person is `actor_user_id` with a NULL
 * `actor_ref`, and an API key or a service is `actor_ref` with a NULL `actor_user_id`. Collapsing
 * them into one `actor` parameter would either require the server to guess which column a value
 * belongs in, or make "everything this key did" unaskable.
 */

/**
 * Thirty days.
 *
 * The same figure `audit-log.ts` uses when it argues the diff is small enough to keep ("thirty
 * days of it costs nothing") — and the window an operator actually means by "recently". Anything
 * older is an investigation, and an investigation names its dates.
 */
export const DEFAULT_RANGE_DAYS = 30;

/**
 * One year and a day, so a caller asking for "the last year" is never off by a leap day.
 *
 * A ceiling rather than a policy about retention: it is a promise that ONE request cannot turn
 * into a scan of the tenant's whole history. A caller who wants more pages through it with the
 * cursor, which is the shape that stays cheap.
 */
export const MAX_RANGE_DAYS = 366;

export const DEFAULT_AUDIT_LIMIT = 25;
export const MAX_AUDIT_LIMIT = 100;

const isoDateTime = z.iso.datetime({ offset: true }).or(z.iso.datetime());

/**
 * A dotted verb exactly as the writer spells it — `extension.update`, `org-setting.create`.
 *
 * Exact rather than prefix: `resourceType` is already the "everything that happened to
 * extensions" filter, and two controls that both do partial matching on overlapping columns is
 * how a filter panel starts returning results nobody can explain.
 */
const auditAction = z
	.string()
	.min(3)
	.max(64)
	.regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/u, "must be a dotted verb, e.g. extension.update")
	.optional();

/** A physical table name, which is what the ledger stores in `resource_type`. */
const auditResourceType = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/u, "must be a table name, e.g. extension")
	.optional();

export const auditLogQuerySchema = z.object({
	/** Inclusive lower bound on `occurred_at`. Defaults to {@link DEFAULT_RANGE_DAYS} before `to`. */
	from: isoDateTime.optional(),
	/** Inclusive upper bound on `occurred_at`. Defaults to now. */
	to: isoDateTime.optional(),

	/** `user` / `api-key` / `service` / `system`, from the column's own closed set. */
	actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
	/** A person, by `user.id`. Never matches an API key — see the header. */
	actorUserId: z.uuid().optional(),
	/** An API key id or a service name. Never matches a person. */
	actorRef: z.string().min(1).max(128).optional(),

	action: auditAction,
	resourceType: auditResourceType,
	/** One row's whole history: every change ever recorded against this id. */
	resourceRef: z.uuid().optional(),

	limit: z.coerce.number().int().min(1).max(MAX_AUDIT_LIMIT).default(DEFAULT_AUDIT_LIMIT),
	/** Opaque keyset handle from the previous page's `nextCursor`. */
	cursor: z.string().max(256).optional(),
});

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;

export interface ResolvedAuditRange {
	readonly from: Date;
	readonly to: Date;
}

/**
 * Turns the optional `from`/`to` pair into a concrete window.
 *
 * Returns the range rather than throwing on a too-wide one: the service decides which exception
 * the area raises, and keeping this function total is what lets it be tested without a Nest
 * context. An inverted range (`from` after `to`) is normalized by swapping rather than rejected —
 * it is always a client that wired the two date controls in the wrong order, and the intent is
 * unambiguous.
 */
export function resolveAuditRange(
	query: { readonly from?: string; readonly to?: string },
	now: Date = new Date(),
): ResolvedAuditRange {
	const to = query.to === undefined ? now : new Date(query.to);
	const from =
		query.from === undefined
			? new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000)
			: new Date(query.from);
	return from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from };
}

/** Whole days the range spans, rounded up — what {@link MAX_RANGE_DAYS} is compared against. */
export function auditRangeDays(range: ResolvedAuditRange): number {
	return Math.ceil((range.to.getTime() - range.from.getTime()) / (24 * 60 * 60 * 1000));
}
