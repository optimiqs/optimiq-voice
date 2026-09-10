import { createHash } from "node:crypto";
import { sql } from "@optimiq-voice/cdr-db";
import type { ErasureSubject } from "./erasure.dto";
import type { SQL } from "@optimiq-voice/cdr-db";

/**
 * The statements an erasure runs, as values.
 *
 * Builders rather than methods on the service, on the shape `retention.ts` and `cdr.repository.ts`
 * already use in this area: a statement that destroys a person's records is worth being able to
 * assert on without a database, and a pure function is the only version of that which is honest.
 *
 * Every statement carries `organization_id = <caller's org>` in its own predicate, INCLUDING the
 * ones that run under `withTenantScope` where RLS would already have applied it. That is not
 * belt-and-braces for its own sake: the leg rewrite cannot run under the tenant role at all (see
 * {@link erasureLegRewriteQuery}), so the predicate is the boundary for at least one of these, and
 * a family of statements where some carry the tenant and some rely on the caller's scope is a
 * family where the reviewer has to know which is which.
 */

/** How the subject appears in `call_legs`: one string, compared for equality. */
export function subjectValue(subject: ErasureSubject): string {
	return subject.phoneNumber ?? subject.extension ?? "";
}

/** Which handle the request named. Used by the ledger, and by nothing that changes behaviour. */
export function subjectKind(subject: ErasureSubject): "phoneNumber" | "extension" {
	return subject.phoneNumber === undefined ? "extension" : "phoneNumber";
}

/**
 * `sha256:<first 24 hex of the sha256 of the value>` — what replaces an erased number.
 *
 * ## Why a hash and not a null
 *
 * `from_number` and `to_number` are `not null`, so null is not available without a migration; but
 * the reason to want the hash would survive one. A CDR row exists to be counted and billed, and
 * both operations need to know that two legs involved the SAME party without knowing who that party
 * was: "how many calls did this trunk carry", "was this a duplicate", "did this month's invoice
 * double-count a retry". Nulling every erased number collapses every erased party into one
 * indistinguishable value and silently merges their rows in any group-by. A hash keeps the join key
 * and destroys the identity, which is exactly the trade a billing ledger wants.
 *
 * ## Why it is truncated, and why that is not a weakening
 *
 * Twenty-four hex characters is 96 bits — far past any collision risk at this table's cardinality —
 * and the full digest would not have been more private in the way that matters. A phone number is
 * drawn from a space small enough to enumerate: anyone holding this column and a list of candidate
 * numbers can confirm a guess by hashing it, at ANY digest length, and that is a property of
 * hashing a low-entropy value rather than of the truncation. What the hash buys is that the number
 * is no longer READABLE and no longer exportable, joinable or greppable as a number — which is what
 * the erasure was asked for. A keyed HMAC would resist the guessing attack, and would then require
 * a key whose loss makes the ledger unjoinable and whose retention is itself personal data under
 * the same regulation. The `sha256:` prefix is there so nothing downstream mistakes the value for
 * a dialable number.
 */
export function erasureHash(value: string): string {
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 24)}`;
}

/**
 * The one predicate that decides everything: a leg TOUCHED the subject.
 *
 * Equality on both number columns, and nothing cleverer. An extension selector is matched the same
 * way because an internal leg carries the extension number in `from_number`/`to_number` — the leg
 * table's only handle on an extension is `destination_ref`, which names the routing entity a call
 * resolved TO and is null on every leg a person placed. Matching on the number is therefore the
 * whole of what this ledger knows about "calls involving extension 1001", and pretending otherwise
 * by joining `destination_ref` would erase a strict subset while reporting a total.
 */
export function erasureLegMatch(subject: string): SQL {
	return sql`("from_number" = ${subject} or "to_number" = ${subject})`;
}

/** `count(*)` of the legs that would be rewritten. */
export function erasureLegCountQuery(organizationId: string, subject: string): SQL {
	return sql`
		select count(*)::int as "count"
		from "call_legs"
		where "organization_id" = ${organizationId}::uuid
			and ${erasureLegMatch(subject)}
	`;
}

/**
 * The PII rewrite. The legs SURVIVE it.
 *
 * ## Why the row is kept
 *
 * `call_legs` is the billing ledger. A month whose invoice was raised from N legs must still
 * contain N legs after an erasure or the platform cannot answer "why does this invoice not
 * reconcile?" — and the customer whose data was erased is rarely the customer being billed. The
 * regulation asks for the personal data to go, not for the counted fact that a call happened at a
 * time for a duration, which identifies nobody once the numbers and names are gone. Deleting the
 * row would also be a `DELETE` against a table that is partitioned and append-only precisely so
 * that it never has to be, leaving the dead-tuple bloat that design exists to avoid.
 *
 * ## Only the matching column is hashed
 *
 * A leg has two parties and the request is about one of them. Hashing both would erase a second
 * person's number on the strength of a request they did not make — which is not a conservative
 * choice, it is a different erasure performed without one.
 *
 * ## Idempotence falls out of the predicate
 *
 * After the rewrite the subject's number is a `sha256:` string, so `erasureLegMatch` no longer
 * selects the row and a second apply updates nothing and reports zero. Nothing tracks "already
 * erased"; the data itself is the record of it.
 *
 * `raw` is emptied rather than nulled, and the difference is a constraint and not a preference.
 * `call_legs.raw` is `jsonb NOT NULL`, so the contract's "raw -> null" is a statement Postgres
 * refuses with `23502`, and it refuses it AFTER the recordings and the voicemail have already been
 * destroyed — an erasure that reports a 500 having thrown away the audio and kept every number.
 * `'{}'::jsonb` carries no signalling payload, satisfies the column, and leaves a value a reader
 * can tell apart from a leg that was simply never populated (that one is absent, not empty).
 *
 * `to_name` is in the contract's list and is not in this table — there is no such column — so it is
 * not nulled here. Every other name-shaped or address-shaped column is.
 */
export function erasureLegRewriteQuery(organizationId: string, subject: string, hash: string): SQL {
	return sql`
		update "call_legs"
		set "from_number" = case when "from_number" = ${subject} then ${hash} else "from_number" end,
			"to_number" = case when "to_number" = ${subject} then ${hash} else "to_number" end,
			"from_name" = null,
			"sip_call_id" = null,
			"account_code" = null,
			"remote_media_address" = null,
			"raw" = '{}'::jsonb
		where "organization_id" = ${organizationId}::uuid
			and ${erasureLegMatch(subject)}
		returning "id"
	`;
}

/**
 * The recordings a subject appears in: every live recording of a call one of whose legs touched
 * them.
 *
 * By `call_id` rather than by `leg_id`, and the difference is a real one. A recording is attached
 * to the leg the media tap was on, which on an inbound call to a queue is the AGENT's leg — the
 * caller whose voice is on the tape never appears on it. Selecting by call is what makes "erase
 * this caller's recordings" erase the recordings of that caller.
 *
 * Tombstoned rows are excluded so a second apply finds nothing: the row is left behind by design
 * (see the service) and re-selecting it would make every subsequent apply report the same count
 * for ever.
 */
export function erasureRecordingsQuery(organizationId: string, subject: string): SQL {
	return sql`
		select r."id" as "id", r."object_key" as "object_key"
		from "recordings" r
		where r."organization_id" = ${organizationId}::uuid
			and r."deleted_at" is null
			and exists (
				select 1
				from "call_legs" l
				where l."organization_id" = r."organization_id"
					and l."call_id" = r."call_id"
					and (l."from_number" = ${subject} or l."to_number" = ${subject})
			)
		order by r."id"
	`;
}

export interface ErasureRecordingRow {
	readonly id: string;
	readonly object_key: string;
}

/**
 * Drizzle's `execute` returns the driver's shape: postgres.js yields an array, `pg` yields
 * `{ rows }`. Normalized here exactly as the two retention sweepers do for their own callers.
 */
export function rowsOf<T>(result: unknown): readonly T[] {
	if (Array.isArray(result)) {
		return result as readonly T[];
	}
	if (typeof result === "object" && result !== null && "rows" in result) {
		return ((result as { readonly rows?: readonly T[] }).rows ?? []) as readonly T[];
	}
	return [];
}

/** `count(*)` off a scalar-count statement, whatever the driver wrapped it in. */
export function countOf(result: unknown): number {
	const row = rowsOf<{ readonly count: string | number | null }>(result)[0];
	return row === undefined ? 0 : Number(row.count ?? 0);
}
