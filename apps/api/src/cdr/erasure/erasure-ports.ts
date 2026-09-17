import type { ErasureSubject } from "./erasure.dto";

/**
 * The two facts an erasure needs from the OTHER database, as the CDR area is allowed to reach them.
 *
 * Same wall and same crossing as `recordings/purge-audit.ts` and `retention/leg-retention-audit.ts`:
 * voicemail and `audit_log` live in `pbx-db`, this area declares the interface and imports nothing
 * from the PBX area, `pbx-cdr-ports.module.ts` implements them, and the service injects them
 * `@Optional()`.
 *
 * ## Why voicemail is a port and not a join
 *
 * "Erase everything about this person" reads as one transaction and cannot be one: recordings and
 * call legs are in `cdr-db`, messages are in `pbx-db`, and the two have separate pools by design
 * (see `shared/cdr-database.ts`). A query that spanned them would need a foreign-data wrapper and
 * would still not be atomic. So the erasure is a SEQUENCE of scoped deletions whose partial
 * completion is safe by construction: every step deletes the object before the row, so a failure
 * anywhere leaves rows that are still selected by the same predicate and a second apply finishes
 * the job. That property — not a transaction — is what makes this idempotent.
 *
 * ## Optional, and what absence means
 *
 * The retention sweepers treat an absent port as "keep sweeping, skip the ledger", because a
 * retention window that stops being enforced would be worse than an unrecorded purge. The reasoning
 * inverts for the voicemail port and does NOT invert for the audit one:
 *
 * - no voicemail port (a CDR-only deployment) means there is no voicemail in this deployment to
 *   erase, so zero is the true answer rather than a silence;
 * - no audit port means the erasure still runs. A deployment with no `audit_log` has nowhere to
 *   write, and refusing to honour a legal erasure request because the ledger is unreachable would
 *   be the tail wagging the dog — the same call `purge-audit.ts` makes, for a deletion that is
 *   even less postponable.
 */
export interface VoicemailErasure {
	/** How many messages the subject would lose. Reads only; never touches an object or a row. */
	count(organizationId: string, subject: ErasureSubject): Promise<number>;
	/** Object first, row second, per message. Returns what actually went. */
	erase(organizationId: string, subject: ErasureSubject): Promise<VoicemailErasureResult>;
}

export interface VoicemailErasureResult {
	readonly messages: number;
	readonly objects: number;
}

/** Nest injection token for {@link VoicemailErasure}. */
export const VOICEMAIL_ERASURE = Symbol("VOICEMAIL_ERASURE");

/**
 * One `audit_log` row per honoured erasure request.
 *
 * One row and not one per destroyed artefact, which is the opposite of `purge-audit.ts` and right
 * for the same reason that one is right: the ledger records the EVENT that happened. A retention
 * purge destroys recordings one at a time on a schedule nobody asked for, so each is its own fact
 * with its own `resource_ref`. An erasure is a single decision, made by a named person, about a
 * named subject, at one instant — and the question a regulator asks of it ("did you honour the
 * request, when, and what did it cover?") is answered by the counts, not by three hundred ids.
 *
 * The subject is recorded HASHED for the reason the whole endpoint exists: a ledger row containing
 * the plaintext number of somebody who asked to be forgotten is the erasure failing to erase, and
 * `audit_log` outlives every row this endpoint deletes.
 */
export interface ErasureAudit {
	recordErasure(organizationId: string, entry: ErasureAuditEntry): Promise<void>;
}

export interface ErasureAuditEntry {
	/** `phoneNumber` or `extension` — which handle the request named. */
	readonly selector: "phoneNumber" | "extension";
	/** `sha256:<24 hex>` of the selector; never the selector itself. See the interface header. */
	readonly subjectHash: string;
	readonly recordings: number;
	readonly voicemailMessages: number;
	readonly callLegs: number;
	readonly objects: number;
	/** The person who asked, as the ledger's actor derivation understands them. */
	readonly actorUserId: string | null;
}

/** Nest injection token for {@link ErasureAudit}. */
export const ERASURE_AUDIT = Symbol("ERASURE_AUDIT");
