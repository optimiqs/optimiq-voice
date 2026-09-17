import { verifiedCallerId } from "@optimiq-voice/pbx-db";
import type { PbxResource } from "../../pbx/shared/pbx-resource";

/**
 * `verified_caller_id` — the numbers a tenant may present that it does not own.
 *
 * ## Why this is a `PbxResource` when the rest of the compliance area is hand-written
 *
 * Because it is exactly the shape the descriptor was built for, and `pbx-resource.ts` argues the
 * case better than a restatement would: ten structurally identical CRUD slices "would be ten copies
 * of the same forty lines, and a fix to the paging window would have to be applied ten times or,
 * more likely, nine". This slice is the eleventh — tenant-scoped rows, paging, search, an audit row
 * per mutation — so it declares rather than implements. The KYC file is a singleton with an
 * encrypted column and a review workflow, and the traceback crosses tenants against a different
 * database; neither fits, and both are hand-written for that reason rather than out of preference.
 *
 * The audit rows come free with the base class, which matters more here than for most resources:
 * "who told us this tenant may present +1 212 555 0100, and when" is precisely the question a
 * traceback asks six months later.
 *
 * ## No destination trio, no scalar references, no `enabled` column
 *
 * Nothing points at a verified caller id — it is not a place a call goes, and no other row carries
 * its id. Its lifecycle is expressed by `expires_at` instead of by an `enabled` flag, deliberately:
 * a right-to-use that a carrier or a document established has a natural end date, and "disabled" is
 * a third state with no evidentiary meaning. `AttestationPolicyService` reads a non-expired row as
 * `verified` and an expired one as nothing at all.
 *
 * ## What this table is NOT in
 *
 * `verified_caller_id` is not in `ROUTING_TABLE_TO_ENTITY`, so a write here does not recompile the
 * tenant's routing artifact. The attestation policy is compiled separately and cached with a short
 * TTL (`attestation/attestation-policy.service.ts`), which is the right coupling: a caller-id
 * verification changes what may be PRESENTED, not where a call goes, and putting it in the routing
 * snapshot would make every verification a recompile of the whole dial plan.
 */
export const VERIFIED_CALLER_ID_RESOURCE: PbxResource = {
	kind: "verified-caller-id",
	tableName: "verified_caller_id",
	table: verifiedCallerId,
	searchColumns: [
		verifiedCallerId.e164,
		verifiedCallerId.label,
		verifiedCallerId.verificationReference,
	],
	orderBy: [verifiedCallerId.e164, verifiedCallerId.id],
	destinations: [],
	destinationType: null,
};
