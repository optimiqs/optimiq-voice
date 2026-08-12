import { describe, expect, it } from "bun:test";
import { FakeClaimBucket } from "../nats/claim-store.fake";
import { ClaimHeartbeatService } from "./claim-heartbeat.service";
import { CLAIM_HEARTBEAT_INTERVAL_MS } from "./claim-timing";
import { ConferenceRegistry } from "./conference-registry";
import { ParkRegistry } from "./park-registry";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "../nats/jetstream.service";
import type { ConferenceClaim, ParkClaim } from "@optimiq-voice/events";

/**
 * The bind-and-renew service.
 *
 * Two things are worth asserting and the rest is Nest plumbing: that the registries end up bound to
 * the buckets the JetStream service opened (an unbound registry in a clustered deployment takes
 * LOCAL claims, which is the split the buckets exist to prevent), and that a tick which throws does
 * not take the process down mid-shift.
 */

const LOT = { slotStart: 401, slotEnd: 403 };
const LOT_ID = "0195c0f0-1c2f-7000-8000-0000000000f1";
const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function env(overrides: Partial<EngineEnv> = {}): EngineEnv {
	return {
		ENGINE_INSTANCE_ID: "engine-a",
		ENGINE_CLAIM_HEARTBEAT_MS: CLAIM_HEARTBEAT_INTERVAL_MS,
		...overrides,
	} as EngineEnv;
}

function service(options: { readonly unconfigured?: boolean } = {}): {
	readonly heartbeat: ClaimHeartbeatService;
	readonly parks: ParkRegistry;
	readonly conferences: ConferenceRegistry;
	readonly parkBucket: FakeClaimBucket<ParkClaim>;
} {
	const unconfigured = options.unconfigured === true;
	const parkBucket = new FakeClaimBucket<ParkClaim>({ unconfigured });
	const conferenceBucket = new FakeClaimBucket<ConferenceClaim>({ unconfigured });
	const parks = new ParkRegistry();
	const conferences = new ConferenceRegistry();
	const jetstream = {
		parkClaims: parkBucket,
		conferenceClaims: conferenceBucket,
	} as unknown as JetStreamService;

	return {
		heartbeat: new ClaimHeartbeatService(env(), jetstream, parks, conferences),
		parks,
		conferences,
		parkBucket,
	};
}

function parkEntry(mediaChannelId: string) {
	return {
		parkLotId: LOT_ID,
		mediaChannelId,
		legId: `leg-${mediaChannelId}`,
		callId: `call-${mediaChannelId}`,
		organizationId: ORG,
		parkedAtMs: 1_000,
	};
}

describe("binding", () => {
	it("shares both registries' claims once the buckets are open", () => {
		const h = service();
		expect(h.parks.isShared).toBe(false);

		h.heartbeat.onApplicationBootstrap();
		expect(h.parks.isShared).toBe(true);
		expect(h.conferences.isShared).toBe(true);
		h.heartbeat.onApplicationShutdown();
	});

	it("leaves the registries local when no bucket is configured", () => {
		const h = service({ unconfigured: true });
		h.heartbeat.onApplicationBootstrap();
		expect(h.parks.isShared).toBe(false);
		expect(h.heartbeat.stats.shared).toBe(false);
		h.heartbeat.onApplicationShutdown();
	});

	it("writes this instance's id into the claims it takes", async () => {
		const h = service();
		h.heartbeat.onApplicationBootstrap();
		await h.parks.park(LOT, parkEntry("c1"));

		const claim = [...h.parkBucket.entries.values()][0]?.value as ParkClaim;
		expect(claim.instanceId).toBe("engine-a");
		h.heartbeat.onApplicationShutdown();
	});
});

describe("a tick", () => {
	it("renews what this instance holds", async () => {
		const h = service();
		h.heartbeat.onApplicationBootstrap();
		await h.parks.park(LOT, parkEntry("c1"));

		const before = [...h.parkBucket.entries.values()][0]?.revision as number;
		await h.heartbeat.tick();
		expect([...h.parkBucket.entries.values()][0]?.revision).toBeGreaterThan(before);
		h.heartbeat.onApplicationShutdown();
	});

	it("counts itself, which is what /healthz reads", async () => {
		const h = service();
		h.heartbeat.onApplicationBootstrap();
		await h.heartbeat.tick();
		expect(h.heartbeat.stats.ticks).toBe(1);
		expect(h.heartbeat.stats.failures).toBe(0);
		h.heartbeat.onApplicationShutdown();
	});

	it("survives a broker that throws, rather than taking the process down mid-shift", async () => {
		const parks = {
			isShared: true,
			bindClaims: () => undefined,
			heartbeat: async () => {
				throw new Error("broker unreachable");
			},
		} as unknown as ParkRegistry;
		const conferences = new ConferenceRegistry();
		const jetstream = {
			parkClaims: new FakeClaimBucket<ParkClaim>(),
			conferenceClaims: new FakeClaimBucket<ConferenceClaim>(),
		} as unknown as JetStreamService;
		const heartbeat = new ClaimHeartbeatService(env(), jetstream, parks, conferences);

		await heartbeat.tick();
		expect(heartbeat.stats.failures).toBe(1);
	});

	it("coalesces timer and explicit ticks while a renewal pass is still running", async () => {
		const parkStarted = deferred<void>();
		const finishPark = deferred<void>();
		let parkPasses = 0;
		let conferencePasses = 0;
		const parks = {
			isShared: true,
			bindClaims: () => undefined,
			heartbeat: async () => {
				parkPasses += 1;
				parkStarted.resolve();
				await finishPark.promise;
				return 0;
			},
		} as unknown as ParkRegistry;
		const conferences = {
			bindClaims: () => undefined,
			heartbeat: async () => {
				conferencePasses += 1;
				return 0;
			},
		} as unknown as ConferenceRegistry;
		const jetstream = {
			parkClaims: new FakeClaimBucket<ParkClaim>(),
			conferenceClaims: new FakeClaimBucket<ConferenceClaim>(),
		} as unknown as JetStreamService;
		const heartbeat = new ClaimHeartbeatService(env(), jetstream, parks, conferences);
		const originalSetInterval = globalThis.setInterval;
		let timerTick: (() => void) | undefined;
		globalThis.setInterval = ((callback: () => void) => {
			timerTick = callback;
			return 0 as unknown as ReturnType<typeof setInterval>;
		}) as typeof setInterval;

		try {
			heartbeat.onApplicationBootstrap();
			if (timerTick === undefined) {
				throw new Error("the heartbeat timer was not scheduled");
			}
			timerTick();
			await parkStarted.promise;
			const explicitTick = heartbeat.tick();
			timerTick();

			expect(parkPasses).toBe(1);
			expect(conferencePasses).toBe(0);
			finishPark.resolve();
			await explicitTick;
			expect(parkPasses).toBe(1);
			expect(conferencePasses).toBe(1);
			expect(heartbeat.stats.ticks).toBe(1);
		} finally {
			heartbeat.onApplicationShutdown();
			globalThis.setInterval = originalSetInterval;
		}
	});
});
