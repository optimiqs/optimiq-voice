import { Inject, Injectable } from "@nestjs/common";
import { requireActiveOrganizationId } from "@optimiq-voice/auth";
import { encryptSecret, loadSecretKey, openStoredSecret } from "@optimiq-voice/db";
import { getLogger } from "@optimiq-voice/logging";
import { actorFromSession, diffOf, insertAuditLog } from "../../pbx/shared/audit-log";
import { PBX_DATABASE } from "../../pbx/shared/pbx.tokens";
import {
	ComplianceKycNotFoundException,
	ComplianceSecretKeyMissingException,
} from "../compliance.errors";
import { selectKyc, selectKycForCipher, rewrapKycTaxId, upsertKyc } from "./kyc.repository";
import { kycAmendment, taxIdLast4 } from "./kyc.rules";
import type { UpsertKycDto } from "./kyc.dto";
import type { KycResponseRow } from "./kyc.repository";
import type { AppSession } from "@optimiq-voice/auth";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.compliance");

/**
 * The tenant's own know-your-customer file.
 *
 * ## The envelope, and why the tax id uses the platform's existing one
 *
 * `packages/db/src/secret-cipher.ts` exists for "the handful of columns that hold a credential this
 * platform must be able to PRESENT again". A tax id is not a credential, but it has the same
 * mechanical requirement — it must survive a round trip, so a hash is out — and the same threat
 * model: it is the one field in this file that identifies a real legal person to a tax authority,
 * and the row it lives in is readable by every principal with `SELECT` on `organization_kyc`.
 * Reusing the envelope rather than inventing a second one means one KEK, one rotation story and one
 * format to review.
 *
 * The **lazy migration** is copied from `platform-sso.ts` for the same reason it exists there: a
 * deployment that stored a tax id before the key was configured, or before this code shipped, has a
 * plaintext row. `openStoredSecret` returns it unchanged with `wasEncrypted: false`, and the read
 * path re-seals it in place. A one-shot migration would have to be run; this converges on its own.
 *
 * ## The plaintext leaves this class through exactly one door, and it is closed
 *
 * There is no method here that returns a decrypted tax id, and there is no route that could call
 * one. The only reason this service opens the ciphertext at all is to re-seal it. `KYC_RESPONSE_COLUMNS`
 * does not name the column, so even a bug in this file cannot put it in a body.
 */
@Injectable()
export class ComplianceKycService {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {}

	private organizationId(session: AppSession): string {
		return requireActiveOrganizationId(session);
	}

	/**
	 * The tenant's file, or a 404.
	 *
	 * A 404 rather than `{ data: null }` because "we have never filed one" is a STATE an onboarding
	 * screen routes on, and a 200 carrying a null is a state a client has to remember to check for.
	 * The same reason `PbxResourceService.get` 404s rather than returning an empty envelope.
	 */
	async get(session: AppSession): Promise<{ readonly data: KycResponseRow }> {
		const organizationId = this.organizationId(session);
		const row = await this.database.withTenantScope(
			organizationId,
			async (transaction) => await selectKyc(transaction, organizationId),
		);
		if (row === undefined) {
			throw new ComplianceKycNotFoundException(organizationId);
		}
		await this.rewrapIfLegacy(organizationId);
		return { data: row };
	}

	/**
	 * Files or amends the tenant's KYC.
	 *
	 * One transaction covering the read, the upsert and the ledger row, so an amendment that reset a
	 * decision either produces both the new file and the record of the reset, or neither. The same
	 * unit-of-work argument `AuditLogService` makes for every PBX mutation.
	 */
	async upsert(
		session: AppSession,
		body: UpsertKycDto,
	): Promise<{ readonly data: KycResponseRow }> {
		const organizationId = this.organizationId(session);
		const values = this.sealTaxId(body);
		const actor = actorFromSession(session);

		const row = await this.database.withTenantScope(organizationId, async (transaction) => {
			const before = await selectKyc(transaction, organizationId);
			const reset = kycAmendment(before);
			const written = await upsertKyc(transaction, organizationId, {
				...values,
				...reset,
			});
			// `taxId` is named as a secret column even though the projection above never selects it:
			// a future projection that DID would otherwise leak it into a table that outlives the row
			// and gets exported to a SIEM.
			const diff = diffOf(
				before as unknown as Record<string, unknown> | undefined,
				written as unknown as Record<string, unknown>,
				["taxId"],
			);
			await insertAuditLog(transaction, {
				organizationId,
				actor,
				action: before === undefined ? "compliance-kyc.create" : "compliance-kyc.update",
				resourceType: "organization_kyc",
				resourceRef: written.id,
				before: diff.before,
				after: diff.after,
			});
			return written;
		});

		if (reviewWasReset(row)) {
			logger.info(
				{ organizationId },
				"a decided KYC file was amended; its decision was reset to pending for re-review",
			);
		}
		return { data: row };
	}

	/**
	 * The DTO's values, with `taxId` sealed and its remainder derived.
	 *
	 * `taxId` absent from the body means "leave both columns alone", which is what lets a client PUT
	 * the file back without re-sending a secret it has never been able to read. `null` clears both.
	 */
	private sealTaxId(body: UpsertKycDto): Record<string, unknown> {
		const { taxId, ...rest } = body;
		if (!Object.hasOwn(body, "taxId")) {
			return rest;
		}
		if (taxId === null || taxId === undefined) {
			return { ...rest, taxId: null, taxIdLast4: null };
		}
		const key = loadSecretKey();
		if (key === null) {
			throw new ComplianceSecretKeyMissingException();
		}
		return { ...rest, taxId: encryptSecret(taxId, key), taxIdLast4: taxIdLast4(taxId) };
	}

	/**
	 * Seals a tax id that predates the envelope, in place, on read.
	 *
	 * Best-effort and deliberately silent about its own failure: a deployment with no key set still
	 * has to be able to READ its KYC file, and turning that read into a 501 because a legacy row
	 * cannot be upgraded would break the screen to fix the storage. `platform-sso.ts` migrates on
	 * exactly the same terms.
	 */
	private async rewrapIfLegacy(organizationId: string): Promise<void> {
		const key = loadSecretKey();
		if (key === null) {
			return;
		}
		try {
			await this.database.withTenantScope(organizationId, async (transaction) => {
				const stored = await selectKycForCipher(transaction, organizationId);
				if (stored?.taxId === null || stored?.taxId === undefined) {
					return;
				}
				const { plaintext, wasEncrypted } = openStoredSecret(stored.taxId, key);
				if (wasEncrypted) {
					return;
				}
				await rewrapKycTaxId(transaction, organizationId, encryptSecret(plaintext, key));
				logger.info({ organizationId }, "sealed a legacy plaintext KYC tax id");
			});
		} catch (error) {
			logger.warn({ organizationId, err: error }, "could not seal a legacy KYC tax id");
		}
	}
}

/** Whether the row that came back has no reviewer on it — the shape an amendment reset leaves. */
function reviewWasReset(row: KycResponseRow): boolean {
	return row.decision === "pending" && row.reviewedAt === null;
}
