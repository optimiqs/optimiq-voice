import { Module } from "@nestjs/common";
import { AriModule } from "./ari/ari.module";
import { CallsModule } from "./calls/calls.module";
import { HealthModule } from "./health/health.module";
import { NatsModule } from "./nats/nats.module";

/**
 * The engine's module graph.
 *
 * `NatsModule` is `@Global` and therefore first: it owns the validated environment and both
 * publishers, which every other module needs. Everything else is a feature slice.
 */
@Module({
	imports: [NatsModule, AriModule, CallsModule, HealthModule],
})
export class AppModule {}
