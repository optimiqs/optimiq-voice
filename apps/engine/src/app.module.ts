import { Module } from "@nestjs/common";
import { AriModule } from "./ari/ari.module";
import { CallsModule } from "./calls/calls.module";
import { HealthModule } from "./health/health.module";
import { NatsModule } from "./nats/nats.module";
import { RoutingModule } from "./routing/routing.module";

/**
 * The engine's module graph.
 *
 * `NatsModule` is `@Global` and therefore first: it owns the validated environment and both
 * publishers, which every other module needs. `RoutingModule` is `@Global` and second because it
 * depends on the NATS layer (KV and the request-reply client) and is depended on by the calls
 * slice. Everything else is a feature slice.
 */
@Module({
	imports: [NatsModule, RoutingModule, AriModule, CallsModule, HealthModule],
})
export class AppModule {}
