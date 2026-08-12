import { Global, Module } from "@nestjs/common";
import { RECORDING_PURGE_AUDIT } from "../cdr/recordings/purge-audit";
import { RECORDING_RETENTION_POLICY } from "../cdr/recordings/retention-policy";
import { OrgSettingsService } from "./org-settings/org-settings.service";
import { RecordingRetentionPolicyService } from "./org-settings/recording-retention-policy.service";
import { PbxModule } from "./pbx.module";
import { PBX_DATABASE } from "./shared/pbx.tokens";
import { RecordingPurgeAuditService } from "./shared/recording-purge-audit.service";
import type { RecordingPurgeAudit } from "../cdr/recordings/purge-audit";
import type { RecordingRetentionPolicy } from "../cdr/recordings/retention-policy";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

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
	imports: [PbxModule],
	providers: [
		{
			provide: RECORDING_RETENTION_POLICY,
			useFactory: (settings: OrgSettingsService): RecordingRetentionPolicy =>
				new RecordingRetentionPolicyService(settings),
			inject: [OrgSettingsService],
		},
		{
			provide: RECORDING_PURGE_AUDIT,
			useFactory: (database: PbxDatabaseClient): RecordingPurgeAudit =>
				new RecordingPurgeAuditService(database),
			inject: [PBX_DATABASE],
		},
	],
	exports: [RECORDING_RETENTION_POLICY, RECORDING_PURGE_AUDIT],
})
export class PbxCdrPortsModule {}
