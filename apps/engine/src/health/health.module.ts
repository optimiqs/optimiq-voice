import { Module } from "@nestjs/common";
import { AriModule } from "../ari/ari.module";
import { CallsModule } from "../calls/calls.module";
import { HealthController } from "./health.controller";

@Module({
	imports: [AriModule, CallsModule],
	controllers: [HealthController],
})
export class HealthModule {}
