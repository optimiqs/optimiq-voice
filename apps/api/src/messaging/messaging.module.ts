import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { PbxModule } from "../pbx/pbx.module";
import { MessagingEventPublisher } from "./messaging-event.publisher";
import { MessagingInboundService } from "./messaging-inbound.service";
import { MessagingRegistrationPoller } from "./messaging-registration-poller.service";
import { MessagingRegistrationController } from "./messaging-registration.controller";
import { MessagingRegistrationService } from "./messaging-registration.service";
import { MessagingRetentionSweeper } from "./messaging-retention-sweeper.service";
import { MessagingSendWorker } from "./messaging-send-worker.service";
import { MessagingWebhookController } from "./messaging-webhook.controller";
import { MessagingController } from "./messaging.controller";
import { messagingProviders } from "./messaging.providers";
import { MessagingService } from "./messaging.service";

/**
 * Two-way SMS/MMS on business numbers, and the A2P registration behind it.
 *
 * # Why messaging is its own area and not a slice of `PbxModule`
 *
 * Every other feature under `src/pbx` is part of the dial plan: it routes a call, or it configures
 * something a call passes through, and it participates in compile-on-write. Messaging does neither.
 * A text has no dialog, never reaches the media plane, and is not a destination anything can be
 * pointed at — which is why nothing in `apps/engine`, `apps/sipd` or `apps/mediad` touches it and
 * why the broker's grants for `messaging.evt.v1` name `apps/api` and nobody else.
 *
 * What it DOES share with the PBX area is the database and the DIDs, which is why this module
 * imports `PbxModule` rather than opening a second pool: `messaging_number` is a row about a
 * `phone_number`, and a second connection would be a second RLS session to get wrong. It is
 * mounted beside `PbxModule` in `main.ts` on the same two conditions — the telephony database and
 * the auth slice — because without the first there is nothing to read and without the second these
 * routes would publish a tenant's conversations unauthenticated.
 *
 * # What is deliberately absent
 *
 * No live-gateway publisher. An open thread updating without a refresh is worth having and is not
 * here: the platform events (`message.received`, `message.delivered`) are published, and a live
 * fan-out is a consumer of them rather than a second write path. Building it as a third publisher
 * beside the JetStream one is how a thread ends up updating in the UI for a message the webhook
 * subscriber never heard about.
 */
@Module({
	imports: [AuthModule, PbxModule],
	controllers: [MessagingController, MessagingRegistrationController, MessagingWebhookController],
	providers: [
		...messagingProviders,
		MessagingService,
		MessagingRegistrationService,
		MessagingInboundService,
		MessagingEventPublisher,
		/**
		 * The three background workers. Each arms itself from its own env switch and each is a no-op
		 * when messaging is unconfigured, so mounting them unconditionally costs a deployment with no
		 * messaging exactly three constructed objects and no timers.
		 */
		MessagingSendWorker,
		MessagingRegistrationPoller,
		MessagingRetentionSweeper,
	],
	exports: [MessagingService, MessagingInboundService, MessagingSendWorker],
})
export class MessagingModule {}
