import { Module } from "@nestjs/common";
import { PresenceService } from "./presence.service";

/**
 * The presence plane: one service that turns the `channels` KV mirror into the `presence` KV read
 * model a busy-lamp key renders.
 *
 * A module of its own rather than a provider inside `CallsModule`, and that is the point of it. This
 * service must not be able to reach into the call path — it is a CONSUMER of state the orchestrator
 * already publishes, and keeping it in a separate module is what makes "presence cannot delay a
 * call" a structural fact rather than a promise in a comment. It depends only on the two `@Global`
 * providers it needs: the JetStream layer for both buckets, and the routing artifact source for the
 * "is this number an extension" filter.
 *
 * Not `@Global`: nothing depends on it. It is a leaf that writes to a bucket, and `apps/sipd` is the
 * reader.
 */
@Module({
	providers: [PresenceService],
	exports: [PresenceService],
})
export class PresenceModule {}
