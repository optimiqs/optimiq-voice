import { Module } from "@nestjs/common";
import { IdentityInviteController } from "./http/identity-invite.controller";
import { RecordingsController } from "./http/recordings.controller";
import { RuntimeHostService } from "./runtime/runtime-host.service";

@Module({
	controllers: [IdentityInviteController, RecordingsController],
	providers: [RuntimeHostService],
})
export class AppModule {}
