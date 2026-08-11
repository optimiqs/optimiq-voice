import { Inject, Module, type OnApplicationShutdown } from "@nestjs/common";
import { getLogger } from "@optimiq-voice/logging";
import { createObjectStore, describeObjectStore, loadStorageEnv } from "../storage";
import {
	createTranscriptionProvider,
	describeTranscriptionProvider,
	loadTranscriptionEnv,
} from "../transcription";
import { AuditLogQueryService } from "./audit-log/audit-log-query.service";
import { AuditLogController } from "./audit-log/audit-log.controller";
import { CarrierWebhookController } from "./carrier/carrier-webhook.controller";
import { CarrierController, CarrierTrunkController } from "./carrier/carrier.controller";
import { carrierProviders } from "./carrier/carrier.providers";
import { CarrierService } from "./carrier/carrier.service";
import { ConferencePinService } from "./conferences/conference-pin.service";
import { ConferencesController } from "./conferences/conferences.controller";
import { ConferencesService } from "./conferences/conferences.service";
import { EmergencyAddressesController } from "./emergency-addresses/emergency-addresses.controller";
import { EmergencyAddressesService } from "./emergency-addresses/emergency-addresses.service";
import { EmergencyConsumer } from "./emergency-addresses/emergency-consumer.service";
import { EmergencyNotificationService } from "./emergency-addresses/emergency-notification.service";
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
import { OrgSettingsController } from "./org-settings/org-settings.controller";
import { OrgSettingsService } from "./org-settings/org-settings.service";
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
import { SipAclEntriesController } from "./security/sip-acl.controller";
import { SipAclEntriesService } from "./security/sip-acl.service";
import { SipAuthEventQueryService } from "./security/sip-auth-event-query.service";
import { SipAuthEventController } from "./security/sip-auth-event.controller";
import { SipAuthEventService } from "./security/sip-auth-event.service";
import { AuditLogService } from "./shared/audit-log.service";
import { createPbxDatabase } from "./shared/pbx-database";
import { loadPbxEnv } from "./shared/pbx-env";
import { makePbxRepositoryRuntime } from "./shared/pbx-runtime";
import {
	PBX_DATABASE,
	PBX_EFFECT_RUNTIME,
	PBX_ENV,
	PBX_MEDIA_STORE,
	PBX_TRANSCRIPTION_PROVIDER,
	PBX_TRANSCRIPTION_SETTINGS,
	PBX_VOICEMAIL_STORE,
} from "./shared/pbx.tokens";
import { dischargeProjection } from "./shared/projection-outbox";
import { ProjectionOutboxSweeper } from "./shared/projection-outbox.service";
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
import { VoicemailEmailService } from "./voicemail-boxes/voicemail-email.service";
import { VoicemailGreetingsController } from "./voicemail-boxes/voicemail-greetings.controller";
import { VoicemailGreetingsService } from "./voicemail-boxes/voicemail-greetings.service";
import { VoicemailMessagesController } from "./voicemail-boxes/voicemail-messages.controller";
import { VoicemailMessagesService } from "./voicemail-boxes/voicemail-messages.service";
import { VoicemailMwiPublisher } from "./voicemail-boxes/voicemail-mwi.publisher";
import { VoicemailPinService } from "./voicemail-boxes/voicemail-pin.service";
import { VoicemailRpcController } from "./voicemail-boxes/voicemail-rpc.controller";
import { VoicemailTranscriptionSweeper } from "./voicemail-boxes/voicemail-transcription-sweeper.service";
import { VoicemailTranscriptionService } from "./voicemail-boxes/voicemail-transcription.service";
import type { ObjectStore } from "../storage";
import type { TranscriptionEnv, TranscriptionProvider } from "../transcription";
import type { PbxEnv } from "./shared/pbx-env";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

const logger = getLogger("api.pbx");

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
		/**
		 * The settings cascade's middle level.
		 *
		 * In the PBX area rather than beside the auth slice because `org_setting` is a `pbx-db`
		 * table under the same RLS policy as every other resource here, and because
		 * `affectsRouting("org_setting")` is TRUE — a settings write recompiles the tenant's routing
		 * artifact through the same repository the other eleven resources use. Mounting it anywhere
		 * else would mean a second write path to a routing input.
		 */
		OrgSettingsController,
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
		 * The change ledger's read surface.
		 *
		 * In the PBX area rather than beside the reporting one because `audit_log` is a `pbx-db`
		 * table under `pbx_tenant_tls` and the same RLS machinery every other resource here uses —
		 * it shares this module's pool and its tenant scope, and mounting it in `CdrModule` would
		 * mean a second connection budget against a database that area does not otherwise touch.
		 * It is a listing and nothing else: the table is append-only in the database, so there is
		 * no write for a controller to expose.
		 */
		AuditLogController,
		/**
		 * The SIP edge's network policy, and the record of what it refused.
		 *
		 * Two controllers rather than one because they are two lifecycles on the same subject, in the
		 * shape this area already uses for `/voicemail-boxes`: `sip_acl_entry` is ordinary read-write
		 * CRUD through the Effect repository, and `sip_auth_event` is an append-only ledger with no
		 * write surface at all — the same split as `AuditLogController` beside the rest of the area.
		 */
		SipAclEntriesController,
		SipAuthEventController,
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
		/**
		 * Two object stores, because there are two nameable ROOTS — not because there are two stores.
		 *
		 * `PBX_MEDIA_OBJECT_ROOT` and `PBX_VOICEMAIL_MEDIA_ROOT` default to the same directory in
		 * every shipped configuration, and `pbx-env.ts` explains at length why they should stay that
		 * way: **there is one object store**, the media server mounts it once as
		 * `ENGINE_MEDIA_OBJECT_ROOT`, and a deployment that split them would produce a library whose
		 * files exist, whose rows are correct, and whose audio Asterisk cannot find. They are
		 * separately nameable so an operator who genuinely splits them can, and so a deployment with
		 * the PBX area and no CDR area has somewhere to inherit from — which is exactly why two
		 * providers rather than one.
		 *
		 * Both are Asterisk-shared classes and therefore always filesystem-backed; with
		 * `STORAGE_DRIVER=s3` each also mirrors to the bucket. See
		 * `src/storage/object-store.factory.ts` for the object-class map and the signed-URL decision.
		 */
		{
			provide: PBX_MEDIA_STORE,
			useFactory: (env: PbxEnv): ObjectStore => {
				const storage = loadStorageEnv();
				const store = createObjectStore(storage, { root: env.PBX_MEDIA_OBJECT_ROOT });
				logger.info(
					{ root: env.PBX_MEDIA_OBJECT_ROOT, driver: store.driver },
					`media library objects: ${describeObjectStore(store, storage)}`,
				);
				return store;
			},
			inject: [PBX_ENV],
		},
		{
			provide: PBX_VOICEMAIL_STORE,
			useFactory: (env: PbxEnv): ObjectStore =>
				createObjectStore(loadStorageEnv(), { root: env.PBX_VOICEMAIL_MEDIA_ROOT }),
			inject: [PBX_ENV],
		},
		/**
		 * Voicemail transcription: the settings, and the provider they select.
		 *
		 * Two providers rather than one carrying both, for the reason `pbx.tokens.ts` records: the
		 * endpoint and the credential belong to the DRIVER, while the retry budget, the queue ceiling
		 * and the size cap belong to the PIPELINE and mean something even when the driver is
		 * `disabled`.
		 *
		 * `loadTranscriptionEnv()` is called here as well as in `main.ts`, on the same terms as
		 * `loadStorageEnv()` above: the preflight in `main.ts` is what turns a half-configured
		 * environment into a refusal to boot, and this call is what the module actually uses. They
		 * parse the same `process.env` with the same schema, so they cannot disagree.
		 */
		{
			provide: PBX_TRANSCRIPTION_SETTINGS,
			useFactory: (): TranscriptionEnv => loadTranscriptionEnv(),
		},
		{
			provide: PBX_TRANSCRIPTION_PROVIDER,
			useFactory: (settings: TranscriptionEnv): TranscriptionProvider => {
				const provider = createTranscriptionProvider(settings);
				logger.info({ driver: provider.driver }, describeTranscriptionProvider(provider, settings));
				return provider;
			},
			inject: [PBX_TRANSCRIPTION_SETTINGS],
		},
		RoutingCachePublisher,
		DidIndexPublisher,
		QueueMembershipPublisher,
		AgentStatePublisher,
		ProjectionOutboxSweeper,
		AuditLogService,
		{
			provide: PBX_EFFECT_RUNTIME,
			useFactory: (
				database: PbxDatabaseClient,
				publisher: RoutingCachePublisher,
				didIndex: DidIndexPublisher,
				queueMembership: QueueMembershipPublisher,
				env: PbxEnv,
				audit: AuditLogService,
			) => {
				/**
				 * The fast path's second half: mark the obligation the write recorded.
				 *
				 * `cutoff` is captured by the CALLER, before the publish starts, and passed in — see
				 * `shared/projection-outbox.ts`. Marking a cutoff taken afterwards would discharge
				 * obligations recorded by writes that this publish never saw.
				 *
				 * Its own `catch`, on the same terms as the publishes it follows: this is a
				 * fire-and-forget continuation of a request that already returned, and an unobserved
				 * rejection during shutdown kills the process. A discharge that fails is also the
				 * benign direction — the row stays pending and the sweeper republishes, which is
				 * idempotent.
				 */
				const discharge = (
					organizationId: string,
					projection: "routing-cache" | "did-index" | "queue-membership",
					cutoff: Date,
				): void => {
					if (env.NATS_URL === undefined) {
						return;
					}
					dischargeProjection(database.adminDb, organizationId, projection, cutoff).catch(
						(cause) => {
							logger.error(
								cause,
								`could not mark the ${projection} outbox row discharged for organization ` +
									`${organizationId}; the sweeper will republish it`,
							);
						},
					);
				};

				return makePbxRepositoryRuntime({
					database,
					/**
					 * The change ledger, and the ONE seam here that is inside the write.
					 *
					 * `onArtifactCompiled` and `onMutation` above are fire-and-forget continuations of a
					 * request that already returned; this is not. It is awaited, it shares the mutation's
					 * transaction, and a failure fails the write — which is the point, and the reason it
					 * is passed as a plain function rather than being reached for by the repository:
					 * `audit-log.service.ts` owns the argument, the repository owns the transaction, and
					 * a spec can assert the seam with neither.
					 */
					recordAudit: async (transaction, input) => await audit.recordMutation(transaction, input),
					/**
					 * Recorded only when there is a broker. Without `NATS_URL` there is no bucket for a
					 * projection to be stale in, and enqueueing anyway would accumulate obligations on
					 * every developer machine that nothing could ever discharge.
					 */
					outboxEnabled: env.NATS_URL !== undefined,
					onArtifactCompiled: (compiled) => {
						if (!compiled.changed) {
							// A recompile that produced the same `snapshotHash` describes a cache entry that
							// is already correct. `compiledAt` is the artifact's only non-derived field, so
							// skipping the write is a provable no-op rather than a heuristic.
							//
							// The DID index rides on the same evidence: the set of phone numbers is part of
							// the hashed snapshot, so an unchanged hash means an unchanged index.
							//
							// `projectionsOwedBy` uses this exact predicate, so nothing was enqueued either
							// and there is nothing here to discharge.
							return;
						}
						const cutoff = new Date();
						const { organizationId } = compiled.artifact;
						// Fire-and-forget by design (the mutation already committed), but a bare
						// `void` promise turns NATS's CONNECTION_DRAINING during shutdown into an
						// unhandled rejection that kills the process — the publish must observe
						// its own failure.
						publisher
							.publish(compiled.cacheKey, compiled.artifact)
							.then((published) => {
								if (published) {
									discharge(organizationId, "routing-cache", cutoff);
								}
							})
							.catch((cause) => {
								logger.error(
									{ err: cause },
									`routing cache publish failed for ${compiled.cacheKey}`,
								);
							});
						didIndex
							.syncOrganization(compiled.artifact)
							.then((result) => {
								// A conflict means the bucket and the database's global unique index disagree,
								// which `did-index.publisher.ts` says is a human decision. Leaving the row
								// pending is what puts it in front of one: the sweeper retries, fails the same
								// way, and eventually logs it as stuck with the rebuild script named.
								if (!result.skipped && result.conflicts.length === 0) {
									discharge(organizationId, "did-index", cutoff);
								}
							})
							.catch((cause) => {
								logger.error({ err: cause }, `did-index sync failed for ${compiled.cacheKey}`);
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
						const cutoff = new Date();
						queueMembership
							.syncOrganization(event.organizationId)
							.then((result) => {
								if (!result.skipped) {
									discharge(event.organizationId, "queue-membership", cutoff);
								}
							})
							.catch((cause) => {
								logger.error(
									cause,
									`queue-membership sync failed for organization ${event.organizationId} ` +
										`after a ${event.operation} on ${event.tableName}`,
								);
							});
					},
				});
			},
			inject: [
				PBX_DATABASE,
				RoutingCachePublisher,
				DidIndexPublisher,
				QueueMembershipPublisher,
				PBX_ENV,
				AuditLogService,
			],
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
		/**
		 * Kari's Law delivery: the consumer of `call.emergency.dialed`.
		 *
		 * Mounted beside the dispatchable locations because that is what the notification is
		 * ABOUT — the event names an `emergency_address.id` and this is the slice that owns the
		 * table it resolves against. Registered unconditionally: without `NATS_URL` the consumer
		 * logs once at boot and stays idle, which is a deployment discovering that its
		 * notifications are not wired rather than a provider silently absent from the container.
		 */
		EmergencyNotificationService,
		EmergencyConsumer,
		FeatureCodesService,
		OrgSettingsService,
		VoicemailBoxesService,
		VoicemailPinService,
		VoicemailMwiPublisher,
		VoicemailMessagesService,
		VoicemailGreetingsService,
		VoicemailEmailService,
		VoicemailTranscriptionService,
		VoicemailTranscriptionSweeper,
		VoicemailConsumer,
		RoutingService,
		SipAclEntriesService,
		/**
		 * The attack log's writer and its reader, on the same terms as the change ledger's pair below:
		 * two classes sharing a table and nothing else, so a reader cannot reach the writer's insert.
		 *
		 * `SipAuthEventService` is EXPORTED because the surfaces that refuse an authentication attempt
		 * do not all live in this module — `ProvisioningModule` owns the one endpoint on this platform
		 * that answers without a session, and it is therefore the surface with the most to record.
		 */
		SipAuthEventService,
		SipAuthEventQueryService,
		/**
		 * The ledger READER, beside the writer it never talks to.
		 *
		 * `AuditLogService` (above) appends inside a mutation's transaction; this one opens its own
		 * `withTenantScope` and only ever selects. They share a table and nothing else, which is why
		 * they are two classes rather than one with a `list()` on it — a reader that could reach the
		 * writer's insert is a reader somebody can make write.
		 */
		AuditLogQueryService,
	],
	exports: [
		AuditLogService,
		SipAuthEventService,
		OrgSettingsService,
		PBX_ENV,
		PBX_DATABASE,
		PBX_EFFECT_RUNTIME,
		PBX_MEDIA_STORE,
		PBX_VOICEMAIL_STORE,
		RoutingService,
		RoutingCachePublisher,
		DidIndexPublisher,
		QueueMembershipPublisher,
		AgentStatePublisher,
		ProjectionOutboxSweeper,
		VoicemailMessagesService,
		VoicemailMwiPublisher,
		VoicemailTranscriptionSweeper,
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
