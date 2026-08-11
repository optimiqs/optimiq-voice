import { Module } from "@nestjs/common";
import { CallsModule } from "../calls/calls.module";
import { AriModule } from "../media/ari.module";
import { HealthController } from "./health.controller";

@Module({
	imports: [AriModule, CallsModule],
	controllers: [HealthController],
})
export class HealthModule {}
