import { Global, Module } from "@nestjs/common";
import { ClientsModule, Transport } from "@nestjs/microservices";
import { loadEngineEnv } from "../config/engine-env";
import { CallEventPublisher } from "./call-event-publisher.service";
import { JetStreamService } from "./jetstream.service";
import { CALL_EVENTS_CLIENT, ENGINE_ENV } from "./nats.tokens";
import type { EngineEnv } from "../config/engine-env";

/**
 * The NATS backbone, both halves of it.
 *
 * `@Global` because the environment and the two publishers are cross-cutting: every feature module
 * would otherwise re-import this one, and the alternative — a second `loadEngineEnv()` per module
 * — would parse the environment several times and could disagree with itself.
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
						name: "optimiq-engine-events",
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
	],
	exports: [ENGINE_ENV, JetStreamService, CallEventPublisher],
})
export class NatsModule {}
