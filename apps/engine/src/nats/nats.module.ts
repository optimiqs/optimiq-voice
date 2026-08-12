import { Global, Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { loadEngineEnv } from "../config/engine-env";
import { CallEventPublisher } from "./call-event-publisher.service";
import { ENVELOPE_ONLY_SERIALIZER } from "./envelope.serializer";
import { JetStreamService } from "./jetstream.service";
import { CALL_EVENTS_CLIENT, ENGINE_ENV, ROUTING_RPC_CLIENT } from "./nats.tokens";
import { OriginateService } from "./originate.service";
import { ParkHandoffService } from "./park-handoff.service";
import { SessionAnnounceService } from "./session-announce.service";
import { SessionVerbService } from "./session-verb.service";
import { SipTransferService } from "./sip-transfer.service";
import type { EngineEnv } from "../config/engine-env";

/**
 * The NATS backbone, both halves of it.
 *
 * `@Global` because the environment and the publishers are cross-cutting: every feature module
 * would otherwise re-import this one, and the alternative — a second `loadEngineEnv()` per module
 * — would parse the environment several times and could disagree with itself.
 *
 * `ClientsModule` is RE-EXPORTED, not merely imported. A module's imports are private to it, so
 * without the re-export the client tokens resolve only inside this file, and the routing plane —
 * which needs one for `rpc.routing.v1.resolve` — would fail to construct at all.
 *
 * ## Why there are two clients on one broker
 *
 * They need different WIRE FORMATS, and the difference is not cosmetic.
 *
 * `ClientProxy.emit` runs the payload through a serializer, and Nest's default wraps it as
 * `{ pattern, data }`. For an EVENT that is wrong: `@optimiq-voice/events` specifies that a message
 * on `calls.evt.v1.…` *is* the envelope, the `CALLS` JetStream stream stores whatever is published
 * on those subjects, and a Go consumer — or the CDR writer, or a wallboard — would find an envelope
 * one level down from where the contract says it is. So the events client is given a serializer
 * that publishes the payload verbatim. It is still the Nest transport, per plan §3.5; it is a
 * three-line serializer, not a NATS framework.
 *
 * For a REQUEST-REPLY the wrapper is exactly right: the responder on the other side is a NestJS
 * microservice, and Nest's NATS server matches an inbound message by the `pattern` field and
 * correlates the reply by `id`. A bare request on the same subject is never answered, and the
 * caller waits out its deadline while somebody listens to silence. So the rpc client keeps the
 * default serializer, and the two concerns get one client each rather than one client and a bug.
 */
@Global()
@Module({
	imports: [
		ClientsModule.registerAsync([
			{
				name: CALL_EVENTS_CLIENT,
				useFactory: (env: EngineEnv) => ({
					transport: Transport.NATS as const,
					options: {
						servers: [env.NATS_URL],
						...natsConnectionOptions(env, "engine"),
						name: "optimiq-engine-events",
						maxReconnectAttempts: -1,
						reconnectTimeWait: 1_000,
						// Publish the envelope verbatim. See `envelope.serializer.ts`.
						serializer: ENVELOPE_ONLY_SERIALIZER,
					},
				}),
				inject: [ENGINE_ENV],
				extraProviders: [{ provide: ENGINE_ENV, useFactory: () => loadEngineEnv() }],
			},
			{
				name: ROUTING_RPC_CLIENT,
				useFactory: (env: EngineEnv) => ({
					transport: Transport.NATS as const,
					options: {
						servers: [env.NATS_URL],
						...natsConnectionOptions(env, "engine"),
						name: "optimiq-engine-rpc",
						maxReconnectAttempts: -1,
						reconnectTimeWait: 1_000,
					},
				}),
				inject: [ENGINE_ENV],
				extraProviders: [{ provide: ENGINE_ENV, useFactory: () => loadEngineEnv() }],
			},
		]),
	],
	providers: [
		{ provide: ENGINE_ENV, useFactory: () => loadEngineEnv() },
		JetStreamService,
		CallEventPublisher,
		OriginateService,
		ParkHandoffService,
		SessionAnnounceService,
		SessionVerbService,
		SipTransferService,
	],
	exports: [
		ClientsModule,
		ENGINE_ENV,
		JetStreamService,
		CallEventPublisher,
		OriginateService,
		ParkHandoffService,
		SessionAnnounceService,
		SessionVerbService,
		SipTransferService,
	],
})
export class NatsModule {}
