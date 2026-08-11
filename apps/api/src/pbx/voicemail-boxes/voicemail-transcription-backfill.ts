import { sql } from "@optimiq-voice/pbx-db";
import type { PbxDatabase, SQL } from "@optimiq-voice/pbx-db";

/**
 * The transcription back-fill's one statement, and the reasoning behind its shape.
 *
 * `voicemail-transcription.service.ts` explains why the in-memory queue is not durable and why the
 * ROW is the queue of record: a message that owes a transcript is `pending` in the database from the
 * moment it exists, so a lost queue — a restart, an overflow, a shutdown that abandoned the backlog
 * — is a back-fill rather than a silent gap. This file is that back-fill's claim, split out from the
 * service that schedules it on the same terms as `projection-outbox.ts` is split from
 * `projection-outbox.service.ts`: the SQL is the part worth reading on its own, and keeping it out
 * of the sweeper leaves the sweeper about scheduling.
 *
 * ## Why a compare-and-set column and not a queue table
 *
 * The obvious shape is a second table with a lease, and it would be a second durable copy of a fact
 * `voicemail_message` already holds. `transcription_status` is a four-state column precisely so that
 * "this message owes a transcript" is a property OF the message; adding a queue row beside it would
 * introduce the one bug the four states exist to prevent — a row whose status and whose queue entry
 * disagree, with no way to tell which is right.
 *
 * ## Why not `SELECT … FOR UPDATE SKIP LOCKED` alone
 *
 * `SKIP LOCKED` IS used, and it is the liveness half: it stops two replicas sweeping at the same
 * instant from serialising on the same hundred rows. It cannot be the correctness half, because a
 * row lock lives and dies with its transaction, and holding a transaction open across a provider
 * request means a minute-long lock and a connection out of the control plane's pool for every
 * message in flight. So the claim is COMMITTED — `transcription_claimed_at = now()`, one statement,
 * transaction over — and the outer `WHERE` re-states the eligibility predicate so the update is a
 * compare-and-set. Under `READ COMMITTED` a concurrent updater's predicate is re-evaluated against
 * the winner's committed row version, which is what makes the loser claim nothing rather than claim
 * the same row.
 *
 * The claim is therefore never RELEASED. It expires, because the case it exists for is a process
 * that stopped existing, and a crashed process releases nothing.
 *
 * ## Why the untenanted handle
 *
 * "Which messages ANYWHERE still owe a transcript" is not a question a tenant-scoped transaction can
 * ask: `withTenantScope` sets one organization id and drops into `pbx_tenant_tls`, which is exactly
 * what this has to see past. It runs on `adminDb` for the same reason and with the same standing as
 * `readPendingProjections` — the connecting principal is not the tenant role and RLS is not forced
 * against it. Everything DOWNSTREAM of the claim is tenant-scoped again: the claim returns an
 * organization id, and the worker re-reads the object key inside `withTenantScope` before a byte of
 * audio is opened, so nothing here widens what the transcription path can reach.
 */

/** One message the back-fill has taken responsibility for. */
export interface ClaimedMessage {
	readonly organizationId: string;
	readonly mailboxId: string;
	readonly messageId: string;
	/** The claim's own attempt number, after the increment. Terminal at the configured ceiling. */
	readonly attempts: number;
	/** Whether the notification has already gone out. Diagnostics: the send re-checks it atomically. */
	readonly emailed: boolean;
}

export interface ClaimWindows {
	/** A `pending` row younger than this is presumed to be in a live queue and is left alone. */
	readonly graceMs: number;
	/** A `failed` row waits this long after its last claim before another attempt. */
	readonly retryAfterMs: number;
	/** A claim older than this is treated as abandoned — the worker that took it is gone. */
	readonly claimTtlMs: number;
	/** How many claims a message gets before `failed` is terminal. */
	readonly maxAttempts: number;
	/** How many rows one sweep takes. */
	readonly batch: number;
}

/**
 * Claims up to `batch` messages that still owe a transcript, oldest first.
 *
 * Reclaiming a `failed` row sets it back to `pending`, which is deliberate and is what lets the
 * whole worker path stay unchanged: `transcribeNow` refuses anything that is not `pending`, and the
 * alternative — teaching it a second entry state — would put the "may this be transcribed" decision
 * in two places. The status therefore reads as "somebody is working on this again", which is true,
 * and the attempt counter is what remembers that it has failed before.
 *
 * `excludedIds` is the in-process half of "do not take a message somebody is already holding". It is
 * exact for THIS process and says nothing about another replica, which is what the grace window and
 * the claim column are for; all three are cheap and none of them is sufficient alone.
 */
export async function claimTranscriptionBacklog(
	database: PbxDatabase,
	now: Date,
	windows: ClaimWindows,
	excludedIds: readonly string[] = [],
): Promise<readonly ClaimedMessage[]> {
	const rows = await database.execute<ClaimedRow>(buildBacklogClaim(now, windows, excludedIds));

	return rows.map((row) => ({
		organizationId: row.organization_id,
		mailboxId: row.mailbox_id,
		messageId: row.message_id,
		attempts: Number(row.attempts),
		emailed: row.emailed === true,
	}));
}

/**
 * The claim statement itself, separated from its execution so it can be read — and asserted on —
 * without a database.
 *
 * The two properties worth guarding are both visible here and neither is visible in a mock's return
 * value: `for update skip locked` inside the sub-select, and the eligibility predicate restated in
 * the outer `WHERE`. Losing either turns a correct claim into a silent double-transcription, so
 * `voicemailTranscriptionBackfill.test.ts` asserts on the statement's own chunks rather than trusting
 * a fake to have been written the same way.
 */
export function buildBacklogClaim(
	now: Date,
	windows: ClaimWindows,
	excludedIds: readonly string[] = [],
): SQL {
	const eligible = (prefix: string): SQL => eligibility(prefix, cutoffsFor(now, windows), windows);
	const excluded =
		excludedIds.length === 0
			? sql`true`
			: sql`id not in (${sql.join(
					excludedIds.map((id) => sql`${id}`),
					sql`, `,
				)})`;

	return sql`
		update voicemail_message as claimed
		set transcription_status = 'pending',
			transcription_claimed_at = ${now},
			transcription_attempts = claimed.transcription_attempts + 1
		from (
			select id
			from voicemail_message
			where ${eligible("")} and ${excluded}
			order by received_at asc
			limit ${windows.batch}
			for update skip locked
		) as due
		where claimed.id = due.id and ${eligible("claimed.")}
		returning
			claimed.id as message_id,
			claimed.organization_id as organization_id,
			claimed.voicemail_box_id as mailbox_id,
			claimed.transcription_attempts as attempts,
			(claimed.email_sent_at is not null) as emailed
	`;
}

/** The three instants the predicate compares against, derived once so both languages agree. */
export interface ClaimCutoffs {
	/** A `pending` row must have been received at or before this to be presumed unattended. */
	readonly grace: Date;
	/** A claim taken at or before this is treated as abandoned. */
	readonly claim: Date;
	/** A `failed` row's last attempt must be at or before this. */
	readonly retry: Date;
}

export function cutoffsFor(now: Date, windows: ClaimWindows): ClaimCutoffs {
	return {
		grace: new Date(now.getTime() - windows.graceMs),
		claim: new Date(now.getTime() - windows.claimTtlMs),
		retry: new Date(now.getTime() - windows.retryAfterMs),
	};
}

/**
 * The eligibility rule in TypeScript — the specification the SQL below transliterates.
 *
 * Two expressions of one rule is a real cost, and it is paid deliberately: the rule is the part of
 * this file that decides whether a message is transcribed twice, never, or once, and a rule that can
 * only be exercised against a live PostgreSQL is a rule that is exercised in CI never. Both are
 * built from the same {@link ClaimCutoffs}, so the half that drifts most easily — which window
 * anchors which status — cannot drift silently.
 */
export function isClaimable(
	row: {
		readonly transcriptionStatus: string;
		readonly transcriptionAttempts: number;
		readonly transcriptionClaimedAt: Date | null;
		readonly receivedAt: Date;
	},
	cutoffs: ClaimCutoffs,
	maxAttempts: number,
): boolean {
	if (row.transcriptionAttempts >= maxAttempts) {
		return false;
	}
	if (row.transcriptionStatus === "pending") {
		return (
			row.receivedAt <= cutoffs.grace &&
			(row.transcriptionClaimedAt === null || row.transcriptionClaimedAt <= cutoffs.claim)
		);
	}
	if (row.transcriptionStatus === "failed") {
		return (row.transcriptionClaimedAt ?? row.receivedAt) <= cutoffs.retry;
	}
	// `done` and `disabled` are not backlog. Neither is any status this file has not heard of.
	return false;
}

/**
 * The eligibility predicate, stated once and interpolated twice.
 *
 * Once inside the locking sub-select, which is what bounds the batch, and once in the outer `WHERE`,
 * which is the compare-and-set. They MUST be the same predicate — a claim whose outer check is
 * weaker than its inner one is not a claim at all — so it is one function taking the alias prefix
 * rather than two hand-kept-in-sync copies.
 *
 * The two branches read differently on purpose:
 *
 * - **`pending`** is anchored on `received_at` because the risk is taking a message the live queue
 *   still holds, and the message's age is the only cross-process evidence of that.
 * - **`failed`** is anchored on the CLAIM, falling back to `received_at` for rows that failed before
 *   this column existed. A provider has already refused this message with backoff; the question is
 *   how long ago somebody last tried, not how old the voicemail is.
 */
function eligibility(prefix: string, cutoffs: ClaimCutoffs, windows: ClaimWindows): SQL {
	const column = (name: string): SQL => sql.raw(`${prefix}${name}`);

	return sql`(
		${column("transcription_attempts")} < ${windows.maxAttempts}
		and (
			(
				${column("transcription_status")} = 'pending'
				and ${column("received_at")} <= ${cutoffs.grace}
				and (
					${column("transcription_claimed_at")} is null
					or ${column("transcription_claimed_at")} <= ${cutoffs.claim}
				)
			)
			or (
				${column("transcription_status")} = 'failed'
				and coalesce(${column("transcription_claimed_at")}, ${column("received_at")}) <= ${cutoffs.retry}
			)
		)
	)`;
}

/**
 * The claim's row shape. Snake case: this is what `returning` puts on the wire.
 *
 * A type alias over an index signature rather than an interface, because `execute`'s parameter is
 * constrained to `Record<string, unknown>` and an interface has no implicit index signature.
 */
type ClaimedRow = {
	readonly message_id: string;
	readonly organization_id: string;
	readonly mailbox_id: string;
	readonly attempts: number | string;
	readonly emailed: boolean;
};
