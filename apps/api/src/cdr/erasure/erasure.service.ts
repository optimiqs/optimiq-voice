import { Inject, Injectable, Optional } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { purgedRecordingSoftDeleteQuery } from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logging";
import { CDR_DATABASE, CDR_RECORDING_STORE } from "../shared/cdr.tokens";
import { ERASURE_AUDIT, VOICEMAIL_ERASURE } from "./erasure-ports";
import {
	countOf,
	erasureHash,
	erasureLegCountQuery,
	erasureLegRewriteQuery,
	erasureRecordingsQuery,
	rowsOf,
	subjectKind,
	subjectValue,
} from "./erasure.repository";
import type { ObjectStore } from "../../storage";
import type { ErasureAudit, VoicemailErasure } from "./erasure-ports";
import type { ErasureCounts, ErasureSubject } from "./erasure.dto";
import type { ErasureRecordingRow } from "./erasure.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/**
 * GDPR Article 17 / CCPA §1798.105 erasure, over everything this platform records about a party.
 *
 * ## Three stores, one order, repeated
 *
 * Recordings (`cdr-db` + the recording object store), voicemail (`pbx-db` + the voicemail object
 * store, reached through a port) and call legs (`cdr-db`). Each of the first two follows the same
 * order — **delete the object, then the row** — and the order is the whole design, argued at length
 * in `recording-retention-sweeper.service.ts` and in `voicemail-messages.service.ts`: a row removed
 * while its object survives is a recording the API refuses to play while the audio is still in the
 * bucket, which is deleted for the data subject and retained for a subpoena. The inverse — an
 * object gone and a row still standing — is a 410, which is a state the whole codebase already
 * models and which the next apply cleans up.
 *
 * ## There is no transaction, and there could not be one
 *
 * The three stores are two databases with separate pools and two object stores; nothing spans them.
 * What replaces atomicity is that every step is selected by a predicate the step itself falsifies:
 * a tombstoned recording is no longer selected, a deleted message is no longer there, and a hashed
 * number no longer equals the subject. So a failure at any point leaves a request that finishes
 * correctly when it is run again — which is also, and not by coincidence, exactly the idempotence
 * the contract asks for. A second apply on a completed subject reports zeroes.
 *
 * ## Preview mutates nothing, and is gated as hard as the apply
 *
 * `recordings.delete` on BOTH routes. A preview is not a read of the caller's own data: it is a
 * count of how much of a named person's data this tenant holds, which is a question only somebody
 * already entitled to destroy it has business asking. Nothing weaker in the registry means "may
 * enumerate a third party's records", so the delete grant is the honest fit and no new permission
 * is invented for a surface that would then have to be granted separately to be useful.
 *
 * ## Always the caller's own organization
 *
 * `requireActiveOrganizationId(session)` and never an id from the body. Every read runs under
 * `withTenantScope` so RLS is the filter, and every statement carries the organization in its own
 * predicate as well — because the leg rewrite cannot run under the tenant role (`call_legs` is
 * append-only BY PRIVILEGE: `GRANT SELECT, INSERT`) and therefore runs on `adminDb`, where the
 * predicate is the only boundary there is. That is the same bargain `withCdrWriterScope` strikes,
 * for the same table, in the writer.
 */
@Injectable()
export class CdrErasureService {
	constructor(
		@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient,
		@Inject(CDR_RECORDING_STORE) private readonly store: ObjectStore,
		/** Voicemail lives in `pbx-db`; absent means this deployment has none. See the port. */
		@Optional() @Inject(VOICEMAIL_ERASURE) private readonly voicemail?: VoicemailErasure,
		/** The ledger, optional for the reason `purge-audit.ts` gives: the erasure runs regardless. */
		@Optional() @Inject(ERASURE_AUDIT) private readonly audit?: ErasureAudit,
	) {}

	/**
	 * What an apply would destroy. Reads only.
	 *
	 * The recording count is the LIVE rows — the ones an apply would tombstone — so it matches what
	 * the apply reports, and `objects` is the same number plus the voicemail objects, because in
	 * both stores a row and its object are one to one.
	 */
	async preview(
		session: AppSession,
		subject: ErasureSubject,
	): Promise<{ readonly data: ErasureCounts }> {
		const organizationId = requireActiveOrganizationId(session);
		const value = subjectValue(subject);

		const { recordings, callLegs } = await this.database.withTenantScope(
			organizationId,
			async (transaction) => ({
				recordings: rowsOf<ErasureRecordingRow>(
					await transaction.execute(erasureRecordingsQuery(organizationId, value)),
				).length,
				callLegs: countOf(await transaction.execute(erasureLegCountQuery(organizationId, value))),
			}),
		);
		const voicemailMessages = (await this.voicemail?.count(organizationId, subject)) ?? 0;

		return {
			data: {
				recordings,
				voicemailMessages,
				callLegs,
				objects: recordings + voicemailMessages,
			},
		};
	}

	/**
	 * Honours the request.
	 *
	 * The order between the three stores is deliberate and is not the order of the counts: MEDIA
	 * first (recordings, then voicemail), legs last. Media is the material a person actually asks to
	 * have destroyed — their recorded voice — and the leg rewrite is what makes them unfindable. If
	 * only one half can happen, the tape going first is the half that matters, and a leg still
	 * carrying the number is what lets the next apply find the rest.
	 */
	async apply(
		session: AppSession,
		subject: ErasureSubject,
	): Promise<{ readonly data: ErasureCounts }> {
		const organizationId = requireActiveOrganizationId(session);
		const value = subjectValue(subject);
		const hash = erasureHash(value);

		const recordings = await this.eraseRecordings(organizationId, value);
		const voicemail = (await this.voicemail?.erase(organizationId, subject)) ?? {
			messages: 0,
			objects: 0,
		};
		// `adminDb`, not the tenant scope: `call_legs` grants the tenant role SELECT and INSERT only,
		// so this UPDATE is not something a request-scoped principal can perform at all. The
		// organization predicate inside the statement is the tenancy boundary here.
		const callLegs = rowsOf(
			await this.database.adminDb.execute(erasureLegRewriteQuery(organizationId, value, hash)),
		).length;

		const counts: ErasureCounts = {
			recordings: recordings.rows,
			voicemailMessages: voicemail.messages,
			callLegs,
			objects: recordings.objects + voicemail.objects,
		};

		logger.info(
			{ organizationId, actorId: session.user.id, subject: hash, ...counts },
			"an erasure request was honoured",
		);
		await this.recordAudit(organizationId, session, subject, hash, counts);
		return { data: counts };
	}

	/**
	 * Objects first, then one tombstone statement for the ids whose object actually went.
	 *
	 * A recording whose object the store refused is left LIVE and still selected, exactly as the
	 * retention sweep leaves it: reporting it as erased while the audio sits in the bucket is the
	 * one outcome this endpoint must never produce, and the next apply picks it up.
	 *
	 * The row is tombstoned rather than deleted — `deleted_at`, the existing marker — because
	 * `call_legs.recording_key` points at the object and a leg whose recording reference resolves to
	 * nothing at all cannot tell a reader whether the recording was destroyed or never made. The
	 * tombstone is what makes the 410 expressible, and it holds no personal data: an id, a key and a
	 * duration, on a row whose leg has just had its numbers hashed.
	 */
	private async eraseRecordings(
		organizationId: string,
		value: string,
	): Promise<{ readonly rows: number; readonly objects: number }> {
		const due = await this.database.withTenantScope(organizationId, async (transaction) =>
			rowsOf<ErasureRecordingRow>(
				await transaction.execute(erasureRecordingsQuery(organizationId, value)),
			),
		);
		if (due.length === 0) {
			return { rows: 0, objects: 0 };
		}

		const removed: string[] = [];
		for (const row of due) {
			try {
				// Idempotent on all three drivers — an object that is already gone is the state we
				// wanted — so a retry after a partial failure costs nothing.
				await this.store.delete(row.object_key);
				removed.push(row.id);
			} catch (error) {
				logger.warn(
					{ organizationId, recordingId: row.id, err: String(error) },
					"an erasure could not remove a recording object; the row was left live",
				);
			}
		}

		const rows = await this.database.withTenantScope(
			organizationId,
			async (transaction) =>
				rowsOf(await transaction.execute(purgedRecordingSoftDeleteQuery(new Date(), removed)))
					.length,
		);
		return { rows, objects: removed.length };
	}

	/** The ledger, last, and never able to fail the erasure it records. See `purge-audit.ts`. */
	private async recordAudit(
		organizationId: string,
		session: AppSession,
		subject: ErasureSubject,
		hash: string,
		counts: ErasureCounts,
	): Promise<void> {
		if (this.audit === undefined) {
			return;
		}
		try {
			await this.audit.recordErasure(organizationId, {
				selector: subjectKind(subject),
				subjectHash: hash,
				actorUserId: session.user.id,
				...counts,
			});
		} catch (error) {
			logger.error(
				{ organizationId, err: String(error) },
				"an honoured erasure could not be recorded in the audit ledger",
			);
		}
	}
}
