import { Global, Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { and, eq, inArray, voicemailBox, voicemailMessage } from "@optimiq-voice/pbx-db";
import { CdrModule } from "../cdr/cdr.module";
import { ERASURE_AUDIT, VOICEMAIL_ERASURE } from "../cdr/erasure/erasure-ports";
import { CDR_QUEUE_SURVEY } from "../cdr/query/queue-survey.port";
import { CDR_SELF_PARTIES } from "../cdr/query/self-parties";
import { RECORDING_ACCESS_AUDIT } from "../cdr/recordings/access-audit";
import { RECORDING_PURGE_AUDIT } from "../cdr/recordings/purge-audit";
import { RECORDING_RETENTION_POLICY } from "../cdr/recordings/retention-policy";
import { CDR_LEG_RETENTION_AUDIT } from "../cdr/retention/leg-retention-audit";
import { CDR_DATABASE } from "../cdr/shared/cdr.tokens";
import { OrgSettingsService } from "./org-settings/org-settings.service";
import { RecordingRetentionPolicyService } from "./org-settings/recording-retention-policy.service";
import { PbxModule } from "./pbx.module";
import {
	QUEUE_DISPOSITION_LEDGER,
	QueueDispositionLedgerService,
} from "./queues/queue-disposition-cdr.port";
import { asUuid, insertAuditLog } from "./shared/audit-log";
import { CdrLegRetentionAuditService } from "./shared/cdr-leg-retention-audit.service";
import { CdrSelfPartiesService } from "./shared/cdr-self-parties.service";
import { FraudCdrService } from "./shared/fraud-cdr.service";
import { PBX_DATABASE } from "./shared/pbx.tokens";
import { PBX_VOICEMAIL_STORE } from "./shared/pbx.tokens";
import { QueueSurveySourceService } from "./shared/queue-survey-source.service";
import { RecordingAccessAuditService } from "./shared/recording-access-audit.service";
import { RecordingPurgeAuditService } from "./shared/recording-purge-audit.service";
import { FRAUD_CDR_SOURCE } from "./toll-fraud/fraud-cdr.port";
import type {
	ErasureAudit,
	ErasureAuditEntry,
	VoicemailErasure,
	VoicemailErasureResult,
} from "../cdr/erasure/erasure-ports";
import type { ErasureSubject } from "../cdr/erasure/erasure.dto";
import type { QueueSurveySource } from "../cdr/query/queue-survey.port";
import type { CdrSelfParties } from "../cdr/query/self-parties";
import type { RecordingAccessAudit } from "../cdr/recordings/access-audit";
import type { RecordingPurgeAudit } from "../cdr/recordings/purge-audit";
import type { RecordingRetentionPolicy } from "../cdr/recordings/retention-policy";
import type { CdrLegRetentionAudit } from "../cdr/retention/leg-retention-audit";
import type { ObjectStore } from "../storage";
import type { QueueDispositionLedger } from "./queues/queue-disposition-cdr.port";
import type { FraudCdrSource } from "./toll-fraud/fraud-cdr.port";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";
import type { PbxDatabaseClient, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

/**
 * The PBX → CDR ports: PBX-owned facts, delivered under CDR-owned tokens.
 *
 * ## Why a third module exists at all
 *
 * `PbxModule` and `CdrModule` are SIBLINGS, composed conditionally in `main.ts` — each mounts on
 * its own database URL, and each must keep booting when the other is absent. The recording write
 * path (CDR) needs two facts the PBX area owns: the tenant's retention window (`org_setting`) and
 * a ledger to record purges in (`audit_log`). A direct import in either direction would couple the
 * areas' boot conditions; this module is the seam that avoids both. The CDR area declares the
 * interfaces and the tokens (`cdr/recordings/retention-policy.ts`, `cdr/recordings/purge-audit.ts`)
 * and injects them `@Optional()`; this module implements them out of `PbxModule`'s exports.
 *
 * ## Why it is `@Global()`
 *
 * `CdrModule` cannot import this module — that would be the PBX dependency it must not have, one
 * hop removed — and `main.ts` composes modules into a generated root rather than a hand-written
 * imports graph. `@Global()` makes the two tokens visible to every module in whatever tree this
 * one is mounted into, which is exactly the semantics wanted: "if the PBX area is present, these
 * ports exist; inject them if you care." It is mounted from `main.ts` only when BOTH areas are
 * enabled, because with either absent it would provide answers nothing asks for (no CDR) or could
 * not construct them (no PBX).
 *
 * Both providers use factories rather than `@Injectable()` classes so the implementations stay
 * plain classes a test can construct with fakes — the retention policy's clock and TTL are
 * constructor options, not injection tokens.
 */
@Global()
@Module({
	// `CdrModule` for `CDR_DATABASE` alone, and it is not the dependency this module exists to avoid:
	// the forbidden edge is CdrModule -> PbxModule, which would couple the CDR area's boot to the
	// PBX area's. This module already sits above both and is mounted only when both are enabled.
	imports: [PbxModule, CdrModule],
	providers: [
		{
			provide: RECORDING_RETENTION_POLICY,
			useFactory: (settings: OrgSettingsService): RecordingRetentionPolicy =>
				new RecordingRetentionPolicyService(settings),
			inject: [OrgSettingsService],
		},
		{
			provide: CDR_SELF_PARTIES,
			useFactory: (database: PbxDatabaseClient): CdrSelfParties =>
				new CdrSelfPartiesService(database),
			inject: [PBX_DATABASE],
		},
		{
			provide: CDR_QUEUE_SURVEY,
			useFactory: (database: PbxDatabaseClient): QueueSurveySource =>
				new QueueSurveySourceService(database),
			inject: [PBX_DATABASE],
		},
		/**
		 * The one port in this module that runs the OTHER way.
		 *
		 * Everything else here hands a PBX-owned fact to the CDR area under a CDR-owned token. This
		 * hands a CDR-owned aggregate to the PBX area's toll-fraud detector, and it belongs in this
		 * module for exactly the reason the rest do: it is the only place allowed to hold both
		 * database handles at once. The detector injects it `@Optional()`, so a deployment with no
		 * CDR database boots with the token absent and the detector stands down.
		 */
		{
			provide: FRAUD_CDR_SOURCE,
			useFactory: (database: CdrDatabaseClient): FraudCdrSource => new FraudCdrService(database),
			inject: [CDR_DATABASE],
		},
		{
			provide: CDR_LEG_RETENTION_AUDIT,
			useFactory: (database: PbxDatabaseClient): CdrLegRetentionAudit =>
				new CdrLegRetentionAuditService(database),
			inject: [PBX_DATABASE],
		},
		{
			provide: VOICEMAIL_ERASURE,
			useFactory: (database: PbxDatabaseClient, store: ObjectStore): VoicemailErasure =>
				new VoicemailErasureService(database, store),
			inject: [PBX_DATABASE, PBX_VOICEMAIL_STORE],
		},
		{
			provide: ERASURE_AUDIT,
			useFactory: (database: PbxDatabaseClient): ErasureAudit => new ErasureAuditService(database),
			inject: [PBX_DATABASE],
		},
		{
			provide: RECORDING_ACCESS_AUDIT,
			useFactory: (database: PbxDatabaseClient): RecordingAccessAudit =>
				new RecordingAccessAuditService(database),
			inject: [PBX_DATABASE],
		},
		/**
		 * The ONE port pointing the other way: a PBX write into the CDR ledger.
		 *
		 * Every other provider here is a PBX-owned fact delivered under a CDR-owned token. This is a
		 * queues-area interface implemented over `CDR_DATABASE`, and it is in this module for the
		 * same reason the rest are: it is the only place that can see both areas, and it is mounted
		 * only when both are enabled. `QueueAgentSessionService` injects the token `@Optional()`, so
		 * a deployment without a CDR database keeps recording dispositions in `queue_call_disposition`
		 * and simply has no reporting copy — which is what the agent-statistics breakdown degrades to.
		 */
		{
			provide: QUEUE_DISPOSITION_LEDGER,
			useFactory: (database: CdrDatabaseClient): QueueDispositionLedger =>
				new QueueDispositionLedgerService(database),
			inject: [CDR_DATABASE],
		},
		{
			provide: RECORDING_PURGE_AUDIT,
			useFactory: (database: PbxDatabaseClient): RecordingPurgeAudit =>
				new RecordingPurgeAuditService(database),
			inject: [PBX_DATABASE],
		},
	],
	exports: [
		QUEUE_DISPOSITION_LEDGER,
		RECORDING_RETENTION_POLICY,
		RECORDING_PURGE_AUDIT,
		RECORDING_ACCESS_AUDIT,
		CDR_LEG_RETENTION_AUDIT,
		CDR_SELF_PARTIES,
		CDR_QUEUE_SURVEY,
		FRAUD_CDR_SOURCE,
		VOICEMAIL_ERASURE,
		ERASURE_AUDIT,
	],
})
export class PbxCdrPortsModule {}

/**
 * The PBX side of {@link VoicemailErasure}: a subject's messages, object before row.
 *
 * ## Why the implementation is here and not in `voicemail-messages.service.ts`
 *
 * That service is the mailbox's read model, and every operation on it names a BOX and proves the
 * caller may reach it — which is the correct rule for someone reading their own voicemail and the
 * wrong one for an erasure, whose whole job is to sweep every mailbox in the organization for one
 * party. Reusing it would mean either weakening its box proof or enumerating boxes to call it once
 * each, and both are worse than a query that says what it means.
 *
 * ## The two selectors mean different things here
 *
 * A NUMBER matches `caller_id_number`: the messages this outside party LEFT. An EXTENSION matches
 * the mailbox: the messages in that extension's box, whoever left them. That asymmetry is the
 * subject relationship, not an inconsistency — an outside caller's personal data in this table is
 * the recording of their voice and their number, and an extension holder's is the contents of
 * their mailbox.
 *
 * ## What this deliberately does not do
 *
 * It does not republish MWI. A lamp that still says "3 new" after an erasure is a display that
 * corrects itself on the mailbox's next read, and a broker publish that failed is not a reason to
 * leave a message the tenant is legally obliged to destroy.
 */
class VoicemailErasureService implements VoicemailErasure {
	constructor(
		private readonly database: PbxDatabaseClient,
		private readonly store: ObjectStore,
	) {}

	async count(organizationId: string, subject: ErasureSubject): Promise<number> {
		return await this.database.withTenantScope(
			organizationId,
			async (transaction) => (await matchingMessages(transaction, organizationId, subject)).length,
		);
	}

	async erase(organizationId: string, subject: ErasureSubject): Promise<VoicemailErasureResult> {
		const due = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await matchingMessages(transaction, organizationId, subject),
		);
		if (due.length === 0) {
			return { messages: 0, objects: 0 };
		}

		// The object first, on the order `voicemail-messages.service.ts` and the retention sweeps both
		// argue for: a row deleted while its audio survives is a message erased for the data subject
		// and retained for anyone with the bucket. A message whose object refused is left whole and
		// still selected, so the next apply finishes it.
		const removed: string[] = [];
		for (const row of due) {
			try {
				await this.store.delete(row.objectKey);
				removed.push(row.id);
			} catch (error) {
				logger.warn(
					{ organizationId, messageId: row.id, err: String(error) },
					"an erasure could not remove a voicemail object; the message was left in place",
				);
			}
		}
		if (removed.length === 0) {
			return { messages: 0, objects: 0 };
		}

		const deleted = await this.database.withTenantScope(organizationId, async (transaction) =>
			transaction
				.delete(voicemailMessage)
				.where(inArray(voicemailMessage.id, removed))
				.returning({ id: voicemailMessage.id }),
		);
		return { messages: deleted.length, objects: removed.length };
	}
}

/** The rows one subject owns in one organization. Inside a tenant scope; RLS is the outer filter. */
async function matchingMessages(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
	subject: ErasureSubject,
): Promise<readonly { id: string; objectKey: string }[]> {
	const columns = { id: voicemailMessage.id, objectKey: voicemailMessage.objectKey };
	if (subject.phoneNumber !== undefined) {
		return await transaction
			.select(columns)
			.from(voicemailMessage)
			.where(
				and(
					eq(voicemailMessage.organizationId, organizationId),
					eq(voicemailMessage.callerIdNumber, subject.phoneNumber),
				),
			);
	}
	const boxes = await transaction
		.select({ id: voicemailBox.id })
		.from(voicemailBox)
		.where(
			and(
				eq(voicemailBox.organizationId, organizationId),
				eq(voicemailBox.mailboxNumber, subject.extension ?? ""),
			),
		);
	if (boxes.length === 0) {
		return [];
	}
	return await transaction
		.select(columns)
		.from(voicemailMessage)
		.where(
			and(
				eq(voicemailMessage.organizationId, organizationId),
				inArray(
					voicemailMessage.voicemailBoxId,
					boxes.map((box) => box.id),
				),
			),
		);
}

/**
 * The PBX side of {@link ErasureAudit}: one `audit_log` row per honoured request.
 *
 * Over `insertAuditLog` rather than `AuditLogService.recordMutation`, for the reason
 * `recording-purge-audit.service.ts` sets out at length: the mutation happened in another database,
 * it cannot roll back, and there is no `PbxResource` declaration for a `cdr-db` table to diff.
 *
 * `resource_ref` is null and that is the honest value. The ledger's ref column names ONE row, and
 * an erasure is a decision about a person that touched three tables in two databases — putting any
 * one of the affected ids there would make the other two invisible to the lookup it is for.
 * `before` carries the counts and the HASHED subject, never the number: `audit_log` outlives every
 * row this erasure deleted, and a ledger entry containing the plaintext number of somebody who
 * asked to be forgotten is the erasure failing at the last step.
 *
 * The actor is reconstructed from the user id rather than derived from the session, because the
 * port deliberately does not carry a session across the area wall. That loses the api-key/user
 * distinction `actorFromSession` makes; the id is still the person, and the alternative — pushing
 * an `AppSession` through a CDR-owned interface — would put the auth model in a port whose whole
 * point is that the two areas share nothing.
 */
class ErasureAuditService implements ErasureAudit {
	constructor(private readonly database: PbxDatabaseClient) {}

	async recordErasure(organizationId: string, entry: ErasureAuditEntry): Promise<void> {
		await this.database.withTenantScope(organizationId, async (transaction) => {
			await insertAuditLog(transaction, {
				organizationId,
				actor: {
					type: "user",
					userId: asUuid(entry.actorUserId),
					ref: null,
					ipAddress: null,
					userAgent: null,
					requestId: null,
				},
				action: "recording.erasure",
				resourceType: "recordings",
				resourceRef: null,
				before: {
					selector: entry.selector,
					subject: entry.subjectHash,
					recordings: entry.recordings,
					voicemailMessages: entry.voicemailMessages,
					callLegs: entry.callLegs,
					objects: entry.objects,
				},
				after: null,
			});
		});
		logger.info(
			{ organizationId, subject: entry.subjectHash },
			"recorded an honoured erasure request in the audit ledger",
		);
	}
}
