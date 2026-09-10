import { Global, Module } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { decideAttestation } from "@optimiq-voice/routing";
import { AuthModule } from "../auth/auth.module";
import { CdrModule } from "../cdr/cdr.module";
import { CDR_ATTESTATION_STAMP } from "../cdr/writer/attestation-stamp.port";
import { PbxModule } from "../pbx/pbx.module";
import { AttestationPolicyService } from "./attestation/attestation-policy.service";
import { AttestationSummaryController } from "./attestation/attestation-summary.controller";
import { AttestationSummaryService } from "./attestation/attestation-summary.service";
import { VerifiedCallerIdsController } from "./caller-ids/caller-ids.controller";
import { VerifiedCallerIdsService } from "./caller-ids/caller-ids.service";
import { ComplianceKycController } from "./kyc/kyc.controller";
import { ComplianceKycService } from "./kyc/kyc.service";
import { PlatformKycController } from "./kyc/platform-kyc.controller";
import { PlatformKycService } from "./kyc/platform-kyc.service";
import { TracebackController } from "./traceback/traceback.controller";
import { TracebackService } from "./traceback/traceback.service";
import type {
	AttestationStamp,
	AttestationStampValues,
} from "../cdr/writer/attestation-stamp.port";

const logger = getLogger("api.compliance");

/**
 * The carrier-compliance area: who the customer is, what they may present, and who asked.
 *
 * ## Why it is its own module and not four more slices in `PbxModule`
 *
 * Because it is the only area that reaches all three bounded contexts at once. The KYC file and the
 * verified caller ids are `pbx-db` rows; the traceback and the attestation summary read `cdr-db`; and
 * both cross-tenant surfaces resolve an organization's NAME out of the better-auth database through
 * `AUTH_REPOSITORY`. `PbxModule` has no CDR handle and must not grow one — `pbx-cdr-ports.module.ts`
 * exists precisely to keep that edge from being drawn — so an area that genuinely needs both belongs
 * above them, which is where this module sits.
 *
 * It follows the same mounting rule as `PbxCdrPortsModule` and for the same reason: `main.ts`
 * composes it only when BOTH areas are enabled. With no PBX database there is no KYC table to serve,
 * and with no CDR database there are no legs to trace.
 *
 * ## Why it is `@Global()`
 *
 * For exactly one provider: {@link CDR_ATTESTATION_STAMP}. `CdrModule` cannot import this module —
 * that would be the PBX dependency the CDR area must not have, two hops removed — and `CdrLegWriter`
 * injects the token `@Optional()`. `@Global()` makes it visible to whatever tree this module is
 * mounted into, which is the same semantics `PbxCdrPortsModule` relies on: *if the compliance area is
 * present, this port exists; inject it if you care.*
 *
 * ## The route table
 *
 * ```
 * GET    /api/v1/compliance/kyc                                   compliance.read
 * PUT    /api/v1/compliance/kyc                                   compliance.write
 * GET    /api/v1/compliance/caller-ids                            compliance.read
 * GET    /api/v1/compliance/caller-ids/:id                        compliance.read
 * POST   /api/v1/compliance/caller-ids                            compliance.write
 * PATCH  /api/v1/compliance/caller-ids/:id                        compliance.write
 * DELETE /api/v1/compliance/caller-ids/:id                        compliance.write
 * GET    /api/v1/compliance/attestation-summary                   compliance.read
 * GET    /api/v1/platform/compliance/kyc                          compliance.review
 * POST   /api/v1/platform/compliance/kyc/:organizationId/decision compliance.review
 * GET    /api/v1/platform/traceback                               compliance.traceback
 * GET    /api/v1/platform/traceback/export.csv                    compliance.traceback
 * ```
 *
 * Everything under `/platform/` is cross-tenant and holds an owner-only permission; everything else is
 * scoped to the caller's active organization. The prefix and the permission always agree.
 */
@Global()
@Module({
	imports: [AuthModule, PbxModule, CdrModule],
	controllers: [
		ComplianceKycController,
		PlatformKycController,
		VerifiedCallerIdsController,
		AttestationSummaryController,
		TracebackController,
	],
	providers: [
		AttestationPolicyService,
		AttestationSummaryService,
		ComplianceKycService,
		PlatformKycService,
		TracebackService,
		VerifiedCallerIdsService,
		/**
		 * The CDR writer's attestation backfill, implemented over the compiled policy.
		 *
		 * A factory over a plain closure rather than an `@Injectable()` class, following every provider
		 * in `pbx-cdr-ports.module.ts`: the implementation is four lines and a `try`, and a class would
		 * add a file and a decorator to a thing whose entire content is "ask the policy service, and do
		 * not let it throw".
		 */
		{
			provide: CDR_ATTESTATION_STAMP,
			useFactory: (policies: AttestationPolicyService): AttestationStamp => ({
				stampOutbound: async (
					organizationId: string,
					fromNumber: string,
				): Promise<AttestationStampValues | undefined> => {
					try {
						const policy = await policies.policyFor(organizationId);
						// No main number: by the time a leg is filed, `from_number` IS what was presented,
						// so any `replace` the tenant's policy called for already happened upstream and
						// there is nothing left to substitute. See `attestation-stamp.port.ts`.
						const decision = decideAttestation(policy, fromNumber, undefined);
						return {
							expectedAttestation: decision.attestation,
							callerIdRightToUse: decision.rightToUse,
						};
					} catch (error) {
						logger.warn(
							{ organizationId, err: error },
							"could not reconstruct an attestation for a CDR leg; it was filed unstamped",
						);
						return undefined;
					}
				},
			}),
			inject: [AttestationPolicyService],
		},
	],
	exports: [AttestationPolicyService, CDR_ATTESTATION_STAMP],
})
export class ComplianceModule {
	constructor() {
		logger.info(
			"compliance area mounted on /api/v1/compliance, /api/v1/platform/compliance and /api/v1/platform/traceback",
		);
	}
}
