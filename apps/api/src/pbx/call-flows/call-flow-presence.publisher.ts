import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { ensureKvBuckets, kvKeyFor, PRESENCE_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";

const logger = getLogger("api.pbx");

/**
 * The busy-lamp half of a call-flow toggle.
 *
 * ## Why this reuses the `presence` bucket instead of inventing one
 *
 * A BLF key is provisioned with a dialable string and SUBSCRIBEs to `sip:<that string>@<realm>`.
 * `apps/sipd` answers that subscription from one place — the `presence` KV bucket, keyed
 * `<orgId>.<dialable string>` — and maps the value's `state` onto an RFC 4235 `dialog-info+xml`
 * body. A phone watching `*281` is watching a presence key exactly like a phone watching `1001`, so
 * lighting a call flow's lamp is a write to that bucket and nothing else: no new bucket, no new
 * event package, no change to `sipd` at all.
 *
 * The engine is the bucket's only other writer and keys its entries by EXTENSION NUMBER, filtered
 * through the routing artifact so only real extensions produce a key. A call flow's toggle code is
 * not an extension number, so the two writers cannot collide — and the compiler refuses a toggle
 * code that IS an extension number, which is the case that would break that reasoning.
 *
 * ## Why `active` means "night"
 *
 * `aggregateDeviceState` maps a busy extension to `active`, and `sipd` maps `active` to a
 * `confirmed` dialog, which every handset renders as a SOLID lamp. Upstream lights the lamp in the
 * alternate (night) state, so night is `active` and day is a DELETE — an absent key renders dark,
 * which is what `sipd`'s `presence.Change.Deleted` path already produces, and it costs nothing to
 * store for the state a flow spends most of its life in.
 *
 * ## A failure here does not fail the toggle
 *
 * The mode is committed to Postgres and compiled into the artifact before this runs. A lamp that
 * did not move is a cosmetic defect; a 500 after the routing has already changed would report
 * "your change was not saved" about a change that was, which is the worse lie — the same call
 * `routing-cache.publisher.ts` makes for the artifact itself. Unlike that one, this has no outbox
 * behind it, because a stale lamp is self-correcting on the next toggle and a durable retry queue
 * for a light is more machinery than the problem deserves.
 */
@Injectable()
export class CallFlowPresencePublisher implements OnModuleInit, OnApplicationShutdown {
	private connection: NatsConnection | undefined;
	private bucket: KV | undefined;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	async onModuleInit(): Promise<void> {
		const url = this.env.NATS_URL;
		if (url === undefined || url.length === 0) {
			logger.warn("NATS_URL is not set; call-flow busy-lamp updates are disabled");
			return;
		}
		try {
			this.connection = await connect(natsConnectionOptions(this.env as never));
			const manager = await this.connection.jetstreamManager();
			await ensureKvBuckets(manager, [PRESENCE_KV]);
			this.bucket = await manager.jetstream().views.kv(PRESENCE_KV.name);
		} catch (cause) {
			logger.warn({ cause }, "could not open the presence bucket; busy lamps will not move");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		await this.connection?.drain().catch(() => undefined);
		this.connection = undefined;
		this.bucket = undefined;
	}

	/**
	 * Lights or darkens the lamp watching `presenceKey`.
	 *
	 * Returns whether the write happened, for the specs and for a diagnostic — never throws, and
	 * never for the caller to branch on: the toggle has already succeeded by the time this runs.
	 */
	async publish(input: {
		readonly organizationId: string;
		/** The flow's toggle code, or its dialable number when it has no code. */
		readonly presenceKey: string | null | undefined;
		readonly lit: boolean;
	}): Promise<boolean> {
		const bucket = this.bucket;
		const key = input.presenceKey?.trim();
		if (bucket === undefined || key === undefined || key.length === 0) {
			// A flow with neither a code nor a number is a flow nothing can watch. That is a valid
			// configuration — it is edited from the admin UI and never dialled — so it is silent.
			return false;
		}
		try {
			const kvKey = kvKeyFor.presence(input.organizationId, key);
			if (!input.lit) {
				await bucket.delete(kvKey);
				return true;
			}
			await bucket.put(
				kvKey,
				new TextEncoder().encode(
					JSON.stringify({
						orgId: input.organizationId,
						extensionNumber: key,
						state: "active",
						// One "channel": the flow itself. The field is required by the schema and means
						// "how many live legs the aggregation saw", which for a switch is the switch.
						channelCount: 1,
						writtenBy: "api",
						updatedAt: Date.now(),
					}),
				),
			);
			return true;
		} catch (cause) {
			logger.warn({ cause, key }, "could not update a call-flow busy lamp");
			return false;
		}
	}
}
