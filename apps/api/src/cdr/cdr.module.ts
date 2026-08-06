import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { CdrController } from "./query/cdr.controller";
import { CdrService } from "./query/cdr.service";
import { CdrRecordingsController } from "./recordings/recordings.controller";
import { RecordingsService } from "./recordings/recordings.service";
import { createCdrDatabase } from "./shared/cdr-database";
import { loadCdrEnv } from "./shared/cdr-env";
import { CDR_DATABASE, CDR_ENV } from "./shared/cdr.tokens";
import { CdrLegWriter } from "./writer/cdr-writer.service";
import { CdrRecordingWriter } from "./writer/recording-writer.service";
import type { CdrEnv } from "./shared/cdr-env";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

const logger = getLogger("api.cdr");

/**
 * The CDR area — reporting reads, and the durable writers that fill the ledger.
 *
 * ## Why the writers live in the same module as the API
 *
 * They share the one thing that is expensive to have two of: the connection pool. `cdr-db` has its
 * own database and its own connection budget by design ("it never shares a pool with
 * @optimiq-voice/db or pbx-db"), and splitting the writer into its own module would either build a
 * second pool against the same database or require a third module to own the first — which is the
 * shape `pbx.module.ts` already rejected for fourteen slices, for the same reason.
 *
 * They are still separable at RUNTIME rather than at module boundaries: `CDR_WRITER_ENABLED=false`
 * turns both consumers into no-ops and leaves the reporting API untouched, which is the split an
 * operator actually wants (one writer deployment, N API replicas) and which a module boundary would
 * not have given.
 *
 * ## Two consumers, not one
 *
 * `CdrLegWriter` consumes `CDR` (the ledger) and `CdrRecordingWriter` consumes the record events on
 * `CALLS`. They are separate durables because they are separate streams with different retention,
 * different volumes and different failure consequences — a `CALLS` backlog must never hold up the
 * billing ledger, and one consumer straddling both would make that impossible to guarantee.
 */
@Module({
	controllers: [CdrController, CdrRecordingsController],
	providers: [
		{ provide: CDR_ENV, useFactory: (): CdrEnv => loadCdrEnv() },
		{
			provide: CDR_DATABASE,
			useFactory: (env: CdrEnv): CdrDatabaseClient => createCdrDatabase(env),
			inject: [CDR_ENV],
		},
		CdrService,
		RecordingsService,
		CdrLegWriter,
		CdrRecordingWriter,
	],
	exports: [CDR_ENV, CDR_DATABASE, CdrService, RecordingsService],
})
export class CdrModule implements OnApplicationShutdown {
	constructor(@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient) {
		logger.info("CDR area mounted on /api/v1/cdr and /api/v1/recordings");
	}

	/** The area owns its Postgres pool, so shutdown is deterministic rather than process-exit. */
	async onApplicationShutdown(): Promise<void> {
		await this.database.close();
	}
}
