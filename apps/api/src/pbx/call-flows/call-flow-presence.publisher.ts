import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { connect, type KV, type NatsConnection } from "nats";
import { natsConnectionOptions } from "@optimiq-voice/config/nats-credentials";
import { ensureKvBuckets, kvKeyFor, PRESENCE_KV } from "@optimiq-voice/events/streams";
import { getLogger } from "@optimiq-voice/logging";
import { PBX_ENV } from "../shared/pbx.tokens";
import type { PbxEnv } from "../shared/pbx-env";

const logger = getLogger("api.pbx");

/**
 * How often a lit lamp is re-published.
 *
 * Well inside `PRESENCE_KV.ttlMs` (five minutes), so a single missed tick — a slow broker, a paused
 * event loop — cannot let a key expire.
 */
const PRESENCE_REFRESH_MS = 60_000;

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
 * which is what `sipd`'s `presence.Change.Deleted` path already produces.
 *
 * ## Why there is a refresh loop
 *
 * `PRESENCE_KV` is `storage: "memory"` with a five-minute TTL, because its other writer — the
 * engine, off device-state events — re-publishes continuously and never notices. A call flow is
 * written ONCE per toggle, so without a refresh the lamp for a night mode set at 17:00 goes dark at
 * 17:05 while calls keep routing to the night destination for the next fifteen hours: the lamp then
 * means the opposite of the truth, and "self-correcting on the next toggle" does not save it,
 * because the stale state is dark and nobody toggles a lamp that is already off. So every lit key
 * this process wrote is re-put on an interval comfortably inside the TTL. Raising `ttlMs` is the
 * alternative and was not taken — the bucket belongs to the engine too.
 *
 * The set is per-process and in memory: a replica restart, or the replica that took the toggle going
 * away, loses the refresh and the lamp expires. That is the same exposure the write already had and
 * a durable one would need a reconciliation pass over every flow at boot.
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
	/** Every key this process has lit, by KV key, so the refresh can re-put it before the TTL. */
	private readonly lit = new Map<
		string,
		{ readonly organizationId: string; readonly key: string }
	>();
	private refresh: NodeJS.Timeout | undefined;

	constructor(@Inject(PBX_ENV) private readonly env: PbxEnv) {}

	async onModuleInit(): Promise<void> {
		const url = this.env.NATS_URL;
		if (url === undefined || url.length === 0) {
			logger.warn("NATS_URL is not set; call-flow busy-lamp updates are disabled");
			return;
		}
		try {
			// `natsConnectionOptions` returns credentials and TLS ONLY — never `servers` — so spreading
			// it into an object that supplies the URL and the service tag is the shape every other
			// call site uses. Passing it alone dialled the nats.js default `localhost:4222` under any
			// credentials `NATS_USER`/`NATS_PASS` happened to hold, which is a connection that fails at
			// boot in every deployment where the broker is not co-located — swallowed by the `catch`
			// below, leaving every busy lamp silently dead.
			this.connection = await connect({
				servers: url,
				...natsConnectionOptions(this.env, "api"),
				name: "optimiq-api-call-flow-presence",
			});
			const manager = await this.connection.jetstreamManager();
			await ensureKvBuckets(manager, [PRESENCE_KV]);
			this.bucket = await manager.jetstream().views.kv(PRESENCE_KV.name);
			this.refresh = setInterval(() => {
				void this.refreshLit();
			}, PRESENCE_REFRESH_MS);
			// A pending timer must not hold a process open that is otherwise finished.
			this.refresh.unref?.();
		} catch (cause) {
			logger.warn({ cause }, "could not open the presence bucket; busy lamps will not move");
		}
	}

	async onApplicationShutdown(): Promise<void> {
		if (this.refresh !== undefined) {
			clearInterval(this.refresh);
			this.refresh = undefined;
		}
		this.lit.clear();
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
				this.lit.delete(kvKey);
				await bucket.delete(kvKey);
				return true;
			}
			await bucket.put(kvKey, litValue(input.organizationId, key));
			this.lit.set(kvKey, { organizationId: input.organizationId, key });
			return true;
		} catch (cause) {
			logger.warn({ cause, key }, "could not update a call-flow busy lamp");
			return false;
		}
	}

	/** Re-puts every lit key so the bucket's TTL cannot darken a lamp whose state has not changed. */
	private async refreshLit(): Promise<void> {
		const bucket = this.bucket;
		if (bucket === undefined || this.lit.size === 0) {
			return;
		}
		for (const [kvKey, entry] of this.lit) {
			try {
				await bucket.put(kvKey, litValue(entry.organizationId, entry.key));
			} catch (cause) {
				// One key's failure must not stop the others: the next tick tries again, and there is a
				// whole TTL of them before the lamp is at risk.
				logger.warn({ cause, key: entry.key }, "could not refresh a call-flow busy lamp");
			}
		}
	}
}

/** The presence value a lit call-flow lamp carries. */
function litValue(organizationId: string, key: string): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			orgId: organizationId,
			extensionNumber: key,
			state: "active",
			// One "channel": the flow itself. The field is required by the schema and means "how many
			// live legs the aggregation saw", which for a switch is the switch.
			channelCount: 1,
			writtenBy: "api",
			updatedAt: Date.now(),
		}),
	);
}
