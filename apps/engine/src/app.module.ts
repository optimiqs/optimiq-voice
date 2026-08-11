import { Module } from "@nestjs/common";
import { CallsModule } from "./calls/calls.module";
import { HealthModule } from "./health/health.module";
import { AriModule } from "./media/ari.module";
import { NatsModule } from "./nats/nats.module";
import { PresenceModule } from "./presence/presence.module";
import { QueueModule } from "./queue/queue.module";
import { RoutingModule } from "./routing/routing.module";

/**
 * The engine's module graph.
 *
 * `NatsModule` is `@Global` and therefore first: it owns the validated environment and both
 * publishers, which every other module needs. `RoutingModule` is `@Global` and second because it
 * depends on the NATS layer (KV and the request-reply client) and is depended on by the calls
 * slice. `QueueModule` is `@Global` and third for the same reason one layer up: it depends on the
 * NATS layer for two KV buckets and the queue event publisher, and the calls slice hands it to
 * every plan walk. Everything else is a feature slice.
 *
 * `PresenceModule` is last and is deliberately not `@Global`: it CONSUMES the `channels` bucket the
 * calls slice mirrors into and writes the `presence` bucket `apps/sipd` reads, and nothing in this
 * process depends on it. Placing it after `CallsModule` is not an ordering requirement — it talks to
 * the calls slice only through KV — it is a statement of which way the arrow points.
 */
@Module({
	imports: [
		NatsModule,
		RoutingModule,
		QueueModule,
		AriModule,
		CallsModule,
		PresenceModule,
		HealthModule,
	],
})
export class AppModule {}
