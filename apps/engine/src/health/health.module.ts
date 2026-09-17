import { Module } from "@nestjs/common";
import { CallsModule } from "../calls/calls.module";
import { AriModule } from "../media/ari.module";
import { EngineMetrics } from "./engine-metrics.service";
import { EventLoopLagMonitor } from "./event-loop-lag";
import { HealthController } from "./health.controller";
import { ProfilingController } from "./profiling.controller";

@Module({
	imports: [AriModule, CallsModule],
	controllers: [HealthController, ProfilingController],
	providers: [EventLoopLagMonitor, EngineMetrics],
})
export class HealthModule {}
