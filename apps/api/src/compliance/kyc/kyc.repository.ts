import { eq, organizationKyc, sql } from "@optimiq-voice/pbx-db";
import type { KycDecision, PbxDatabase, PbxDatabaseTransaction } from "@optimiq-voice/pbx-db";

/**
 * The `organization_kyc` queries, as Drizzle over a transaction.
 *
 * Free functions rather than a class, following `cdr/query/cdr.repository.ts`: the caller opens the
 * scope (`withTenantScope` for a tenant, `adminDb` for the platform review queue), and everything
 * here is about the QUESTION rather than about the tenant. A repository that took an
 * `organizationId` and put it in a `where` clause would be a repository someone can call without
 * one — except on the untenanted path, where the id IS the question and is passed explicitly.
 *
 * ## Explicit column projections, twice, and they are not the same list
 *
 * `select *` would return `tax_id`. That column holds an envelope-encrypted tax identifier and its
 * plaintext must never reach a response body, so the read projection simply does not name it — the
 * same "one seam where a row becomes a body" rule `PbxResourceService.redact` states, enforced one
 * layer lower because there is no `PbxResource` declaration here to hang `secretColumns` on.
 * {@link selectKycForCipher} is the second projection: the one path that DOES need the ciphertext,
 * used only by the lazy re-encryption in `kyc.service.ts`.
 */

/** What a KYC file looks like on the wire. `taxId` is absent by construction, not by redaction. */
export const KYC_RESPONSE_COLUMNS = {
	id: organizationKyc.id,
	organizationId: organizationKyc.organizationId,
	legalEntityName: organizationKyc.legalEntityName,
	entityType: organizationKyc.entityType,
	taxIdLast4: organizationKyc.taxIdLast4,
	addressLine1: organizationKyc.addressLine1,
	addressLine2: organizationKyc.addressLine2,
	addressCity: organizationKyc.addressCity,
	addressRegion: organizationKyc.addressRegion,
	addressPostalCode: organizationKyc.addressPostalCode,
	addressCountry: organizationKyc.addressCountry,
	contactName: organizationKyc.contactName,
	contactEmail: organizationKyc.contactEmail,
	contactPhone: organizationKyc.contactPhone,
	websiteUrl: organizationKyc.websiteUrl,
	expectedTrafficProfile: organizationKyc.expectedTrafficProfile,
	expectedMonthlyMinutes: organizationKyc.expectedMonthlyMinutes,
	decision: organizationKyc.decision,
	reviewedBy: organizationKyc.reviewedBy,
	reviewedAt: organizationKyc.reviewedAt,
	reviewNotes: organizationKyc.reviewNotes,
	createdAt: organizationKyc.createdAt,
	updatedAt: organizationKyc.updatedAt,
} as const;

export type KycResponseRow = {
	[K in keyof typeof KYC_RESPONSE_COLUMNS]: (typeof KYC_RESPONSE_COLUMNS)[K]["_"]["data"];
};

/** One organization's file, or `undefined`. Inside a tenant scope, RLS is still the outer filter. */
export async function selectKyc(
	transaction: PbxDatabaseTransaction | PbxDatabase,
	organizationId: string,
): Promise<KycResponseRow | undefined> {
	const rows = await transaction
		.select(KYC_RESPONSE_COLUMNS)
		.from(organizationKyc)
		.where(eq(organizationKyc.organizationId, organizationId))
		.limit(1);
	return rows[0];
}

/** The ciphertext half, for the lazy re-encryption path and for nothing else. */
export async function selectKycForCipher(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
): Promise<{ readonly id: string; readonly taxId: string | null } | undefined> {
	const rows = await transaction
		.select({ id: organizationKyc.id, taxId: organizationKyc.taxId })
		.from(organizationKyc)
		.where(eq(organizationKyc.organizationId, organizationId))
		.limit(1);
	return rows[0];
}

/**
 * The upsert, keyed on `organization_kyc_organization_key`.
 *
 * One statement rather than a select-then-branch, because the unique index makes the race real: two
 * concurrent submissions of a first file would both see no row and both insert, and the second
 * would get a 23505 the caller cannot act on. `onConflictDoUpdate` turns that into "the later write
 * wins", which is what a form submission means.
 *
 * `values` carries whatever the caller decided to write — including, when the amendment rule fires,
 * the reviewer trio set back to null. That decision is made in {@link kycAmendment}, which is pure
 * and therefore testable; this function only puts the answer in the table.
 */
export async function upsertKyc(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
	values: Record<string, unknown>,
): Promise<KycResponseRow> {
	const written = await transaction
		.insert(organizationKyc)
		.values({ ...values, organizationId } as never)
		.onConflictDoUpdate({
			target: organizationKyc.organizationId,
			set: { ...values, updatedAt: new Date() } as never,
		})
		.returning(KYC_RESPONSE_COLUMNS);
	const row = written[0];
	if (row === undefined) {
		// Unreachable with a returning upsert; thrown rather than non-null-asserted so a future
		// driver that stops returning rows fails loudly instead of producing `undefined` downstream.
		throw new Error(`the KYC upsert for organization ${organizationId} returned no row`);
	}
	return row;
}

/** Re-writes an opened-and-re-sealed tax id in place. Never touches any other column. */
export async function rewrapKycTaxId(
	transaction: PbxDatabaseTransaction,
	organizationId: string,
	ciphertext: string,
): Promise<void> {
	await transaction
		.update(organizationKyc)
		.set({ taxId: ciphertext })
		.where(eq(organizationKyc.organizationId, organizationId));
}

/**
 * The reviewer's write. Untenanted: the caller is holding `adminDb`.
 *
 * Returns `undefined` when the organization has no file, so the controller can answer 404 rather
 * than reporting a decision that landed nowhere.
 */
export async function writeKycDecision(
	database: PbxDatabase,
	organizationId: string,
	decision: KycDecision,
	reviewedBy: string | null,
	reviewNotes: string | null,
): Promise<KycResponseRow | undefined> {
	const written = await database
		.update(organizationKyc)
		.set({ decision, reviewedBy, reviewedAt: new Date(), reviewNotes, updatedAt: new Date() })
		.where(eq(organizationKyc.organizationId, organizationId))
		.returning(KYC_RESPONSE_COLUMNS);
	return written[0];
}

/**
 * The platform review queue: every organization's file, across tenants.
 *
 * On `adminDb` and therefore outside RLS, which is the only way this listing can exist at all — the
 * tenant role's policy answers "your own row" by construction. `packages/db`'s client header states
 * the contract this relies on: the admin handle is *untenanted* and every use of it must make the
 * scope explicit in the statement. Here the scope is deliberately "all", and the guard is
 * `compliance.review`, an owner-only permission.
 *
 * Ordered by `updated_at` ascending so the file that has waited longest is first — a review queue
 * sorted newest-first is a queue whose tail is never reached.
 */
export async function listPlatformKyc(
	database: PbxDatabase,
	filter: { readonly decision?: KycDecision; readonly page: number; readonly limit: number },
): Promise<{ readonly rows: readonly KycResponseRow[]; readonly total: number }> {
	const where =
		filter.decision === undefined ? undefined : eq(organizationKyc.decision, filter.decision);
	const rows = await database
		.select(KYC_RESPONSE_COLUMNS)
		.from(organizationKyc)
		.where(where)
		.orderBy(organizationKyc.updatedAt, organizationKyc.id)
		.limit(filter.limit)
		.offset((filter.page - 1) * filter.limit);
	const counted = await database
		.select({ total: sql<number>`count(*)::int` })
		.from(organizationKyc)
		.where(where);
	return { rows, total: counted[0]?.total ?? 0 };
}
