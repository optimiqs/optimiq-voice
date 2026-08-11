import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import {
	type ExtensionPresence,
	kvKeyFor,
	type LiveChannel,
	liveChannelSchema,
} from "@optimiq-voice/events";
import { getLogger } from "@optimiq-voice/logging";
import {
	aggregateDeviceState,
	type CallState,
	type DeviceState,
	isCallState,
} from "@optimiq-voice/telephony";
import { JetStreamService } from "../nats/jetstream.service";
import { ENGINE_ENV } from "../nats/nats.tokens";
import { RoutingArtifactSource } from "../routing/routing-artifact.source";
import type { EngineEnv } from "../config/engine-env";

/**
 * The presence publisher — the process that finally CALLS `aggregateDeviceState`.
 *
 * `packages/telephony` has had the aggregation, its seven-step precedence and its spec since the
 * beginning, and until now it had zero production callers: the function computed the value a
 * busy-lamp key renders and nothing wrote that value anywhere. `apps/sipd` provisions BLF keys onto
 * handsets and answers their SUBSCRIBEs; this is the other half — it fills the `presence` bucket
 * those subscriptions read.
 *
 * ## Why it watches `channels` rather than the orchestrator's registry
 *
 * The obvious wiring is a hook in `ChannelOrchestratorService.onCallStateChanged`, which is exactly
 * where a leg's `callState` moves. It is the wrong one, for three reasons that compound:
 *
 *  1. The registry is INSTANCE-LOCAL. An extension's channels are not all on one engine — a user on
 *     a call placed through replica A who receives a second call routed by replica B has two legs on
 *     two processes — and an aggregation over half the legs is a lamp that is confidently wrong. The
 *     `channels` bucket is the shared mirror of exactly the same snapshots, so watching it gives
 *     every replica the whole picture and makes them all compute the same answer.
 *  2. It survives a restart. A new instance replays the bucket and rebuilds presence for every live
 *     call, instead of knowing only about calls that arrived after it booted.
 *  3. It puts nothing on the call path. The orchestrator already mirrors every snapshot to KV; this
 *     service is a pure consumer of that mirror, so a slow or broken presence publisher cannot delay
 *     a call, and the call path did not have to change to gain a feature.
 *
 * The cost is latency — one KV round trip between a leg changing and a lamp moving — and redundant
 * writes, since every replica computes and writes the same value. Both are bounded and neither is
 * load-bearing: BLF has always been eventually consistent, and the write is debounced on value, so
 * the steady state is silence.
 *
 * ## Which extension a leg belongs to
 *
 * A channel snapshot names numbers, not extension rows: `profile.destinationNumber` is what this hop
 * is routing to, and `profile.callerIdNumber` is who placed it. A leg is attributed to BOTH, filtered
 * through the tenant's routing artifact so only real extensions produce a key. That filter is what
 * keeps the bucket from growing an entry per inbound PSTN caller — an unfiltered
 * `callerIdNumber` would key `presence` by every number that has ever dialled the tenant.
 */
@Injectable()
export class PresenceService implements OnModuleInit, OnApplicationShutdown {
	private readonly logger = getLogger("engine.presence");

	/**
	 * Every live leg this instance has been told about, by KV key.
	 *
	 * A full mirror of the `channels` bucket rather than a per-extension counter, because a watch
	 * delivers a whole snapshot and a DELETE delivers only a key: without the previous value there
	 * is no way to know which extensions a vanished leg was contributing to.
	 */
	private readonly channels = new Map<string, TrackedChannel>();
	/** `<orgId> <extensionNumber>` → the leg keys currently attributed to it. */
	private readonly byExtension = new Map<string, Set<string>>();
	/** The last value written per presence key, so an unchanged aggregate writes nothing. */
	private readonly published = new Map<string, string>();

	private stopped = false;
	private watchAbort: (() => void) | undefined;
	private loop: Promise<void> | undefined;
	/** Extension keys whose aggregate has to be recomputed on the next flush. */
	private dirty = new Set<string>();
	private flushTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly jetstream: JetStreamService,
		private readonly artifacts: RoutingArtifactSource,
		@Inject(ENGINE_ENV) private readonly env: EngineEnv,
	) {}

	onModuleInit(): void {
		this.loop = this.runWatchLoop();
	}

	async onApplicationShutdown(): Promise<void> {
		this.stopped = true;
		if (this.flushTimer !== undefined) {
			clearTimeout(this.flushTimer);
			this.flushTimer = undefined;
		}
		this.watchAbort?.();
		this.watchAbort = undefined;
		// Deliberately NOT clearing the bucket. Another replica is still watching the same channels
		// and still writing the same values, and a shutting-down instance that deleted every key it
		// had written would blank the whole fleet's lamps on a rolling deploy. Entries this instance
		// wrote for calls that really are gone lapse on the bucket's five-minute TTL.
		await this.loop?.catch(() => undefined);
	}

	/** How many live legs this instance is tracking. Exposed for the specs and for diagnostics. */
	get trackedChannels(): number {
		return this.channels.size;
	}

	// -------------------------------------------------------------------------------------------
	// the watch
	// -------------------------------------------------------------------------------------------

	private async runWatchLoop(): Promise<void> {
		let attempt = 0;
		while (!this.stopped) {
			const bucket = this.jetstream.channels;
			if (bucket === undefined) {
				await sleep(backoffMs(attempt));
				attempt += 1;
				continue;
			}
			try {
				// No `updatesOnly`: the initial replay is how a starting instance learns about the
				// calls that were already up, which is the whole of its restart story.
				const watch = await bucket.watch();
				this.watchAbort = () => {
					watch.stop();
				};
				attempt = 0;
				this.logger.info("watching the channels KV bucket to publish presence");
				for await (const entry of watch) {
					if (this.stopped) {
						break;
					}
					this.apply(entry.key, entry.operation, entry.value);
				}
			} catch (error) {
				if (!this.stopped) {
					this.logger.warn(
						{ err: String(error) },
						"the channels watch ended; presence will be rebuilt on reconnect",
					);
				}
			}
			this.watchAbort = undefined;
			if (this.stopped) {
				return;
			}
			// Everything this instance believes about live legs is now unverified. The mirror is
			// dropped rather than kept: the reconnect replays the bucket from scratch, and holding
			// stale legs across the gap would mean publishing presence for calls that ended while
			// this process was not being told about them.
			this.channels.clear();
			this.byExtension.clear();
			await sleep(backoffMs(attempt));
			attempt += 1;
		}
	}

	/**
	 * Applies one watch entry. Exported to the specs through {@link applyEntry} so the whole
	 * derivation can be driven without a broker.
	 */
	private apply(key: string, operation: string, value: Uint8Array): void {
		if (operation !== "PUT" || value.length === 0) {
			this.forget(key);
			return;
		}
		const channel = this.parse(value);
		if (channel === undefined) {
			// A snapshot this build cannot read is treated as GONE rather than ignored. Ignoring it
			// would freeze whatever the leg last contributed for as long as the call lasts; forgetting
			// it at worst clears a lamp early, and the next good write restores it.
			this.forget(key);
			return;
		}
		this.remember(key, channel);
	}

	/** Test seam: drive the derivation with one watch entry. */
	applyEntry(key: string, operation: string, value: Uint8Array): void {
		this.apply(key, operation, value);
	}

	private parse(value: Uint8Array): LiveChannel | undefined {
		try {
			const parsed = liveChannelSchema.safeParse(JSON.parse(new TextDecoder().decode(value)));
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	}

	private remember(key: string, channel: LiveChannel): void {
		const tracked: TrackedChannel = {
			orgId: channel.organizationId,
			callState: callStateOf(channel),
			numbers: candidateNumbers(channel),
		};

		const previous = this.channels.get(key);
		this.channels.set(key, tracked);

		// Every extension the leg touched — before AND after — is dirty. A transferred leg changes
		// its destination number, and only marking the new one would leave the old lamp lit.
		for (const number of previous?.numbers ?? []) {
			this.detach(extensionKey(previous?.orgId ?? tracked.orgId, number), key);
		}
		for (const number of tracked.numbers) {
			this.attach(extensionKey(tracked.orgId, number), key);
		}
	}

	private forget(key: string): void {
		const previous = this.channels.get(key);
		if (previous === undefined) {
			return;
		}
		this.channels.delete(key);
		for (const number of previous.numbers) {
			this.detach(extensionKey(previous.orgId, number), key);
		}
	}

	private attach(extension: string, channelKey: string): void {
		let members = this.byExtension.get(extension);
		if (members === undefined) {
			members = new Set<string>();
			this.byExtension.set(extension, members);
		}
		members.add(channelKey);
		this.markDirty(extension);
	}

	private detach(extension: string, channelKey: string): void {
		const members = this.byExtension.get(extension);
		if (members === undefined) {
			return;
		}
		members.delete(channelKey);
		if (members.size === 0) {
			this.byExtension.delete(extension);
		}
		this.markDirty(extension);
	}

	// -------------------------------------------------------------------------------------------
	// publishing
	// -------------------------------------------------------------------------------------------

	private markDirty(extension: string): void {
		this.dirty.add(extension);
		if (this.flushTimer !== undefined || this.stopped) {
			return;
		}
		// A COALESCING window, not a rate limit. One call setup writes several channel snapshots in
		// quick succession — created, then ringing, then answered, plus the B-leg's own three — and
		// publishing after each would send a phone three NOTIFYs for one event, which on a busy
		// extension is a lamp that visibly flickers. The window is short enough that a human cannot
		// perceive it and long enough that a whole ARI burst lands inside one.
		this.flushTimer = setTimeout(() => {
			this.flushTimer = undefined;
			void this.flush();
		}, PRESENCE_COALESCE_MS);
	}

	/** Recomputes and publishes every dirty extension. Exposed so a spec need not wait on a timer. */
	async flush(): Promise<void> {
		const pending = this.dirty;
		this.dirty = new Set<string>();

		for (const extension of pending) {
			try {
				await this.publish(extension);
			} catch (error) {
				this.logger.warn({ extension, err: String(error) }, "failed to publish presence");
			}
		}
	}

	private async publish(extension: string): Promise<void> {
		const bucket = this.jetstream.presence;
		if (bucket === undefined) {
			return;
		}
		const [orgId, extensionNumber] = splitExtensionKey(extension);
		if (orgId === undefined || extensionNumber === undefined) {
			return;
		}
		if (!(await this.isExtension(orgId, extensionNumber))) {
			// Filtered here rather than at attach time on purpose: the routing artifact is fetched
			// asynchronously and may be a cache miss, and blocking the watch loop on an RPC would put
			// the control plane in the path of reading a channel update.
			return;
		}

		const key = kvKeyFor.presence(orgId, extensionNumber);
		const members = this.byExtension.get(extension);
		const callStates = [...(members ?? [])]
			.map((channelKey) => this.channels.get(channelKey)?.callState)
			.filter((state): state is CallState => state !== undefined);

		if (callStates.length === 0) {
			// No live legs. DELETED rather than written as `down`, because an absent key is what the
			// bucket's own TTL eventually produces anyway and a reader that handles one handles both
			// — and because an idle extension costs nothing to store rather than an entry per
			// extension in the tenant, forever.
			if (this.published.delete(key)) {
				await bucket.delete(key);
			}
			return;
		}

		const state: DeviceState = aggregateDeviceState(callStates);
		const value: ExtensionPresence = {
			orgId,
			extensionNumber,
			state,
			channelCount: callStates.length,
			callStates: [...callStates].sort(),
			writtenBy: this.env.ENGINE_INSTANCE_ID,
			updatedAt: Date.now(),
		};

		// The debounce, and the reason a reader can treat every revision as a real transition. The
		// signature excludes `updatedAt` and `writtenBy` — including them would make every
		// recomputation a change and defeat the whole thing.
		const signature = `${state}:${value.channelCount}:${value.callStates?.join(",")}`;
		if (this.published.get(key) === signature) {
			return;
		}
		this.published.set(key, signature);
		await bucket.put(key, new TextEncoder().encode(JSON.stringify(value)));
	}

	/**
	 * Whether a number is a real extension of the tenant.
	 *
	 * The routing artifact is the authority and is already cached and watched by
	 * {@link RoutingArtifactSource}, so this is a map lookup in the steady state. A tenant whose
	 * artifact cannot be resolved publishes NO presence rather than presence for every number it saw:
	 * an unfiltered fallback would key this bucket by every PSTN caller that has ever dialled in.
	 */
	private async isExtension(orgId: string, number: string): Promise<boolean> {
		const artifact = await this.artifacts.get(orgId);
		return artifact?.extensionsByNumber[number] !== undefined;
	}
}

/** The coalescing window for a burst of channel updates, in millis. */
export const PRESENCE_COALESCE_MS = 120;

interface TrackedChannel {
	readonly orgId: string;
	readonly callState: CallState | undefined;
	readonly numbers: readonly string[];
}

/**
 * The call state a leg contributes, or `undefined` when it contributes nothing.
 *
 * A leg in teardown contributes nothing at all rather than `hangup`. That looks like it contradicts
 * `aggregateDeviceState`, which has a whole precedence step for "every channel has hung up" — but the
 * two agree: the aggregation's `hangup` exists for the instant between a leg ending and it being
 * reaped, and the `channels` bucket represents that instant as a DELETE. Feeding it back in as a
 * lingering `hangup` would hold an extension at `hangup` for as long as the mirror lagged.
 */
function callStateOf(channel: LiveChannel): CallState | undefined {
	if (channel.hangupAt !== undefined) {
		return undefined;
	}
	const state = channel.callState;
	if (state === undefined || !isCallState(state)) {
		return undefined;
	}
	return state === "hangup" ? undefined : state;
}

/**
 * The numbers a leg may belong to.
 *
 * Both ends, deliberately. `destinationNumber` covers a leg ringing an extension (the lamp lights for
 * the person being called) and `callerIdNumber` covers a leg placed BY one (the lamp lights while
 * they are dialling, which FreeSWITCH's own device-state model does and users expect). Whether either
 * is really an extension is settled later against the routing artifact.
 */
function candidateNumbers(channel: LiveChannel): readonly string[] {
	const numbers = new Set<string>();
	for (const candidate of [channel.profile?.destinationNumber, channel.profile?.callerIdNumber]) {
		const trimmed = candidate?.trim();
		if (trimmed !== undefined && trimmed !== "" && isKeyToken(trimmed)) {
			numbers.add(trimmed);
		}
	}
	return [...numbers];
}

/**
 * Whether a number can be a KV key token at all.
 *
 * `kvKeyFor.presence` throws on anything with a dot, a space or a wildcard, and a throw inside the
 * watch loop over a caller-id string somebody dialled in with would stop presence for the whole
 * deployment. Checked here so the key builder is only ever called with something it accepts.
 */
function isKeyToken(value: string): boolean {
	return value.length <= 64 && !/[\s.*>]/.test(value);
}

function extensionKey(orgId: string, extensionNumber: string): string {
	return `${orgId} ${extensionNumber}`;
}

function splitExtensionKey(key: string): [string | undefined, string | undefined] {
	const [orgId, extensionNumber] = key.split(" ");
	return [orgId, extensionNumber];
}

function backoffMs(attempt: number): number {
	return Math.min(30_000, 500 * 2 ** Math.min(attempt, 6));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
