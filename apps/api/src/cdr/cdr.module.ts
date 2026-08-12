import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { createObjectStore, describeObjectStore, loadStorageEnv } from "../storage";
import { CdrController } from "./query/cdr.controller";
import { CdrService } from "./query/cdr.service";
import { LastCallerRpcController } from "./query/last-caller-rpc.controller";
import { LastCallerService } from "./query/last-caller.service";
import { CdrRecordingRetentionSweeper } from "./recordings/recording-retention-sweeper.service";
import { CdrRecordingsController } from "./recordings/recordings.controller";
import { RecordingsService } from "./recordings/recordings.service";
import { createCdrDatabase } from "./shared/cdr-database";
import { loadCdrEnv } from "./shared/cdr-env";
import { CDR_DATABASE, CDR_ENV, CDR_RECORDING_STORE } from "./shared/cdr.tokens";
import { CdrLegWriter } from "./writer/cdr-writer.service";
import { CdrRecordingWriter } from "./writer/recording-writer.service";
import type { ObjectStore } from "../storage";
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
	controllers: [
		CdrController,
		CdrRecordingsController,
		/**
		 * `*69`, answered from the ledger this area already owns.
		 *
		 * The area's first broker responder, and it needs no transport: the microservice
		 * `registerPbxTransport` connects is application-wide. See `last-caller.service.ts` for why the
		 * read lives here rather than in `PbxModule` beside the feature WRITE it is paired with.
		 */
		LastCallerRpcController,
	],
	providers: [
		{ provide: CDR_ENV, useFactory: (): CdrEnv => loadCdrEnv() },
		{
			provide: CDR_DATABASE,
			useFactory: (env: CdrEnv): CdrDatabaseClient => createCdrDatabase(env),
			inject: [CDR_ENV],
		},
		/**
		 * The recording object store, rooted at `CDR_RECORDING_ROOT`.
		 *
		 * `loadStorageEnv()` is parsed here rather than injected from a shared module because the
		 * storage contract is a handful of unprefixed process variables with no state behind them,
		 * and a `StorageModule` whose only job was to hold one parsed object would be a module for
		 * `main.ts` and both areas to import in order to avoid calling one pure function twice. The
		 * boot preflight in `main.ts` parses it too, and the two parses cannot disagree: neither
		 * mutates anything.
		 */
		{
			provide: CDR_RECORDING_STORE,
			useFactory: (env: CdrEnv): ObjectStore => {
				const storage = loadStorageEnv();
				const store = createObjectStore(storage, { root: env.CDR_RECORDING_ROOT });
				logger.info(
					{ root: env.CDR_RECORDING_ROOT, driver: store.driver },
					`recording objects: ${describeObjectStore(store, storage)}`,
				);
				return store;
			},
			inject: [CDR_ENV],
		},
		CdrService,
		LastCallerService,
		RecordingsService,
		CdrLegWriter,
		CdrRecordingWriter,
		CdrRecordingRetentionSweeper,
	],
	exports: [
		CDR_ENV,
		CDR_DATABASE,
		CDR_RECORDING_STORE,
		CdrService,
		LastCallerService,
		RecordingsService,
		CdrRecordingRetentionSweeper,
	],
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
