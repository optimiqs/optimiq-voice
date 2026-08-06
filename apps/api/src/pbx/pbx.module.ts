import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logger";
import { CarrierWebhookController } from "./carrier/carrier-webhook.controller";
import { CarrierController, CarrierTrunkController } from "./carrier/carrier.controller";
import { carrierProviders } from "./carrier/carrier.providers";
import { CarrierService } from "./carrier/carrier.service";
import { ConferencePinService } from "./conferences/conference-pin.service";
import { ConferencesController } from "./conferences/conferences.controller";
import { ConferencesService } from "./conferences/conferences.service";
import { EmergencyAddressesController } from "./emergency-addresses/emergency-addresses.controller";
import { EmergencyAddressesService } from "./emergency-addresses/emergency-addresses.service";
import { ExtensionsController } from "./extensions/extensions.controller";
import { ExtensionsService } from "./extensions/extensions.service";
import { FeatureCodesController } from "./feature-codes/feature-codes.controller";
import { FeatureCodesService } from "./feature-codes/feature-codes.service";
import { InboundRoutesController } from "./inbound-routes/inbound-routes.controller";
import { InboundRoutesService } from "./inbound-routes/inbound-routes.service";
import { IvrMenusController } from "./ivr-menus/ivr-menus.controller";
import { IvrMenuOptionsService, IvrMenusService } from "./ivr-menus/ivr-menus.service";
import { MohClassesController } from "./moh-classes/moh-classes.controller";
import { MohClassesService } from "./moh-classes/moh-classes.service";
import { OutboundRoutesController } from "./outbound-routes/outbound-routes.controller";
import { OutboundRoutesService } from "./outbound-routes/outbound-routes.service";
import { ParkLotsController } from "./park-lots/park-lots.controller";
import { ParkLotsService } from "./park-lots/park-lots.service";
import { PhoneNumbersController } from "./phone-numbers/phone-numbers.controller";
import { PhoneNumbersService } from "./phone-numbers/phone-numbers.service";
import { PromptsController } from "./prompts/prompts.controller";
import { PromptsService } from "./prompts/prompts.service";
import { AgentStatePublisher } from "./queues/agent-state.publisher";
import { QueueAgentSessionController } from "./queues/queue-agent-session.controller";
import { QueueAgentSessionService } from "./queues/queue-agent-session.service";
import {
	affectsQueueMembership,
	QueueMembershipPublisher,
} from "./queues/queue-membership.publisher";
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
import { SipCredentialsResponder } from "./sip-credentials/sip-credentials.responder";
import { SipCredentialsService } from "./sip-credentials/sip-credentials.service";
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
import { VoicemailGreetingsController } from "./voicemail-boxes/voicemail-greetings.controller";
import { VoicemailGreetingsService } from "./voicemail-boxes/voicemail-greetings.service";
import { VoicemailMessagesController } from "./voicemail-boxes/voicemail-messages.controller";
import { VoicemailMessagesService } from "./voicemail-boxes/voicemail-messages.service";
import { VoicemailMwiPublisher } from "./voicemail-boxes/voicemail-mwi.publisher";
import { VoicemailPinService } from "./voicemail-boxes/voicemail-pin.service";
import { VoicemailRpcController } from "./voicemail-boxes/voicemail-rpc.controller";
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
		QueueAgentSessionController,
		ConferencesController,
		ParkLotsController,
		/**
		 * The media library, and the dispatchable locations.
		 *
		 * `MohClassesController` serves two resources on one prefix — the class, and the `prompt`
		 * rows under it — because a class's files are created by an UPLOAD and the child-resource
		 * machinery has no seam for a multipart request. See its header.
		 */
		MohClassesController,
		PromptsController,
		EmergencyAddressesController,
		FeatureCodesController,
		VoicemailBoxesController,
		/**
		 * The contents of a mailbox, on the same prefix as its configuration.
		 *
		 * `GET /voicemail-boxes/media` and `GET /voicemail-boxes/:id` are declared in two different
		 * classes and would collide under a router that resolved by declaration order. Fastify's
		 * (`find-my-way`) is a radix tree that prefers a STATIC segment over a parametric one
		 * regardless of order, so the literal wins and the media route is reachable — which is what
		 * makes splitting the two controllers safe rather than a trap. Stated here because it is a
		 * property of the router we are relying on, not of the code.
		 */
		VoicemailMessagesController,
		/**
		 * The mailbox's GREETINGS, on the same prefix again.
		 *
		 * A third lifecycle on `/voicemail-boxes`: the box row is CRUD through the Effect
		 * repository, a message is not a routing input at all, and a greeting is a routing input
		 * whose activation is inherently a two-row write and therefore cannot go through the
		 * repository. Three lifecycles, three controllers, one prefix.
		 *
		 * `GET /voicemail-boxes/greetings/media` and `GET /voicemail-boxes/:id/messages` coexist for
		 * the reason recorded above `VoicemailMessagesController`: Fastify's radix router prefers a
		 * static segment over a parametric one at every level, regardless of declaration order.
		 */
		VoicemailGreetingsController,
		RoutingController,
		RoutingRpcController,
		VoicemailRpcController,
		/**
		 * The carrier slice mounts unconditionally, even without a `TELNYX_API_KEY`.
		 *
		 * That is the opposite of how the area itself is gated, and deliberately so. `PbxModule` is
		 * skipped without `PBX_DATABASE_URL` because there is nothing it could answer; the carrier
		 * endpoints, by contrast, have a useful answer for an unconfigured deployment — a 503 with
		 * `CARRIER_NOT_CONFIGURED`, which `apps/web` renders as "connect a carrier". A 404 would tell
		 * an admin the feature does not exist and send them looking for a version to upgrade to.
		 */
		CarrierController,
		CarrierTrunkController,
		CarrierWebhookController,
	],
	providers: [
		...carrierProviders,
		CarrierService,
		SipCredentialsService,
		SipCredentialsResponder,
		{ provide: PBX_ENV, useFactory: (): PbxEnv => loadPbxEnv() },
		{
			provide: PBX_DATABASE,
			useFactory: (env: PbxEnv): PbxDatabaseClient => createPbxDatabase(env),
			inject: [PBX_ENV],
		},
		RoutingCachePublisher,
		DidIndexPublisher,
		QueueMembershipPublisher,
		AgentStatePublisher,
		{
			provide: PBX_EFFECT_RUNTIME,
			useFactory: (
				database: PbxDatabaseClient,
				publisher: RoutingCachePublisher,
				didIndex: DidIndexPublisher,
				queueMembership: QueueMembershipPublisher,
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
						// Fire-and-forget by design (the mutation already committed), but a bare
						// `void` promise turns NATS's CONNECTION_DRAINING during shutdown into an
						// unhandled rejection that kills the process — the publish must observe
						// its own failure.
						publisher.publish(compiled.cacheKey, compiled.artifact).catch((cause) => {
							logger.error(`routing cache publish failed for ${compiled.cacheKey}`, cause);
						});
						didIndex.syncOrganization(compiled.artifact).catch((cause) => {
							logger.error(`did-index sync failed for ${compiled.cacheKey}`, cause);
						});
					},
					/**
					 * The queue roster rides on a SEPARATE seam from the artifact, and it has to.
					 *
					 * `affectsRouting("queue_agent")` is false by design — `packages/routing` calls
					 * agent membership live state the engine reads at dial time, so logging somebody in
					 * must not evict a tenant's compiled artifact — which means `onArtifactCompiled`
					 * never fires for the two tables that change a roster most often. Hanging the
					 * publish off `onMutation` instead is what makes "add an agent to a tier" reach the
					 * engine at all.
					 *
					 * Fire-and-forget with an explicit `catch`, for the reason recorded above: the
					 * mutation already committed, and a bare `void` turns NATS's CONNECTION_DRAINING
					 * during shutdown into an unhandled rejection that kills the process.
					 */
					onMutation: (event) => {
						if (!affectsQueueMembership(event.tableName)) {
							return;
						}
						queueMembership.syncOrganization(event.organizationId).catch((cause) => {
							logger.error(
								`queue-membership sync failed for organization ${event.organizationId} ` +
									`after a ${event.operation} on ${event.tableName}`,
								cause,
							);
						});
					},
				}),
			inject: [PBX_DATABASE, RoutingCachePublisher, DidIndexPublisher, QueueMembershipPublisher],
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
		QueueAgentSessionService,
		ConferencesService,
		ConferencePinService,
		ParkLotsService,
		PromptsService,
		MohClassesService,
		EmergencyAddressesService,
		FeatureCodesService,
		VoicemailBoxesService,
		VoicemailPinService,
		VoicemailMwiPublisher,
		VoicemailMessagesService,
		VoicemailGreetingsService,
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
		QueueMembershipPublisher,
		AgentStatePublisher,
		VoicemailMessagesService,
		VoicemailMwiPublisher,
		PromptsService,
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
