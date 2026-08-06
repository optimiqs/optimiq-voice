import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logger";
import { ConferencesController } from "./conferences/conferences.controller";
import { ConferencesService } from "./conferences/conferences.service";
import { ExtensionsController } from "./extensions/extensions.controller";
import { ExtensionsService } from "./extensions/extensions.service";
import { FeatureCodesController } from "./feature-codes/feature-codes.controller";
import { FeatureCodesService } from "./feature-codes/feature-codes.service";
import { InboundRoutesController } from "./inbound-routes/inbound-routes.controller";
import { InboundRoutesService } from "./inbound-routes/inbound-routes.service";
import { IvrMenusController } from "./ivr-menus/ivr-menus.controller";
import { IvrMenuOptionsService, IvrMenusService } from "./ivr-menus/ivr-menus.service";
import { OutboundRoutesController } from "./outbound-routes/outbound-routes.controller";
import { OutboundRoutesService } from "./outbound-routes/outbound-routes.service";
import { ParkLotsController } from "./park-lots/park-lots.controller";
import { ParkLotsService } from "./park-lots/park-lots.service";
import { PhoneNumbersController } from "./phone-numbers/phone-numbers.controller";
import { PhoneNumbersService } from "./phone-numbers/phone-numbers.service";
import { QueueAgentsController, QueuesController } from "./queues/queues.controller";
import { QueueAgentsService, QueueTiersService, QueuesService } from "./queues/queues.service";
import { RingGroupsController } from "./ring-groups/ring-groups.controller";
import { RingGroupDestinationsService, RingGroupsService } from "./ring-groups/ring-groups.service";
import { DidIndexPublisher } from "./routing/did-index.publisher";
import { RoutingCachePublisher } from "./routing/routing-cache.publisher";
import { RoutingRpcController } from "./routing/routing-rpc.controller";
import { RoutingController } from "./routing/routing.controller";
import { RoutingService } from "./routing/routing.service";
import { createPbxDatabase } from "./shared/pbx-database";
import { loadPbxEnv } from "./shared/pbx-env";
import { makePbxRepositoryRuntime } from "./shared/pbx-runtime";
import { PBX_DATABASE, PBX_EFFECT_RUNTIME, PBX_ENV } from "./shared/pbx.tokens";
import { TimeConditionsController } from "./time-conditions/time-conditions.controller";
import {
	TimeConditionRulesService,
	TimeConditionsService,
} from "./time-conditions/time-conditions.service";
import { TrunksController } from "./trunks/trunks.controller";
import { TrunksService } from "./trunks/trunks.service";
import { VoicemailBoxesController } from "./voicemail-boxes/voicemail-boxes.controller";
import { VoicemailBoxesService } from "./voicemail-boxes/voicemail-boxes.service";
import { VoicemailConsumer } from "./voicemail-boxes/voicemail-consumer.service";
import type { PbxEnv } from "./shared/pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger({ service: "api", filePath: import.meta.filename });

/**
 * The PBX area.
 *
 * ## One module for fourteen slices
 *
 * The oikos convention is one Nest module per feature slice, and its purpose is that a slice's
 * wiring is declared where the slice lives. Here every slice shares the same three things — one
 * `PbxDatabaseClient` (one connection pool, not fourteen), one `ModuleEffectRuntime` over one
 * repository layer, and one `RoutingCachePublisher` — so fourteen modules would each be an
 * `imports` line pointing at whichever module owned the shared providers, plus fourteen chances for
 * one of them to build a second pool by accident. The slices keep their own directories, DTOs, resource
 * declarations, services and controllers; what they share is stated once, here.
 *
 * The Effect runtime is provided under a **Symbol token via `useFactory`** per the oikos seam
 * (§3): `ModuleEffectRuntime` implements `OnApplicationShutdown`, so Nest disposes it — and runs
 * the layer's finalizers — exactly once, at shutdown.
 *
 * ## The publish seam
 *
 * `onArtifactCompiled` is handed to the repository as a plain callback rather than injected as a
 * dependency, which keeps the repository (and therefore every test of it) free of any knowledge of
 * NATS. It fires **after** the write transaction has committed — see `compile-on-write.ts` for why
 * publishing from inside it would be wrong — and the publisher swallows its own failures, so a
 * broker outage degrades the cache rather than the API.
 */
@Module({
	controllers: [
		ExtensionsController,
		PhoneNumbersController,
		TrunksController,
		InboundRoutesController,
		OutboundRoutesController,
		TimeConditionsController,
		IvrMenusController,
		RingGroupsController,
		QueuesController,
		QueueAgentsController,
		ConferencesController,
		ParkLotsController,
		FeatureCodesController,
		VoicemailBoxesController,
		RoutingController,
		RoutingRpcController,
	],
	providers: [
		{ provide: PBX_ENV, useFactory: (): PbxEnv => loadPbxEnv() },
		{
			provide: PBX_DATABASE,
			useFactory: (env: PbxEnv): PbxDatabaseClient => createPbxDatabase(env),
			inject: [PBX_ENV],
		},
		RoutingCachePublisher,
		DidIndexPublisher,
		{
			provide: PBX_EFFECT_RUNTIME,
			useFactory: (
				database: PbxDatabaseClient,
				publisher: RoutingCachePublisher,
				didIndex: DidIndexPublisher,
			) =>
				makePbxRepositoryRuntime({
					database,
					onArtifactCompiled: (compiled) => {
						if (!compiled.changed) {
							// A recompile that produced the same `snapshotHash` describes a cache entry that
							// is already correct. `compiledAt` is the artifact's only non-derived field, so
							// skipping the write is a provable no-op rather than a heuristic.
							//
							// The DID index rides on the same evidence: the set of phone numbers is part of
							// the hashed snapshot, so an unchanged hash means an unchanged index.
							return;
						}
						void publisher.publish(compiled.cacheKey, compiled.artifact);
						void didIndex.syncOrganization(compiled.artifact);
					},
				}),
			inject: [PBX_DATABASE, RoutingCachePublisher, DidIndexPublisher],
		},
		ExtensionsService,
		PhoneNumbersService,
		TrunksService,
		InboundRoutesService,
		OutboundRoutesService,
		TimeConditionsService,
		TimeConditionRulesService,
		IvrMenusService,
		IvrMenuOptionsService,
		RingGroupsService,
		RingGroupDestinationsService,
		QueuesService,
		QueueAgentsService,
		QueueTiersService,
		ConferencesService,
		ParkLotsService,
		FeatureCodesService,
		VoicemailBoxesService,
		VoicemailConsumer,
		RoutingService,
	],
	exports: [
		PBX_ENV,
		PBX_DATABASE,
		PBX_EFFECT_RUNTIME,
		RoutingService,
		RoutingCachePublisher,
		DidIndexPublisher,
	],
})
export class PbxModule implements OnApplicationShutdown {
	constructor(@Inject(PBX_DATABASE) private readonly database: PbxDatabaseClient) {
		logger.info("PBX area mounted on /api/v1/*");
	}

	/** The area owns its Postgres pool, so shutdown is deterministic rather than process-exit. */
	async onApplicationShutdown(): Promise<void> {
		await this.database.close();
	}
}
