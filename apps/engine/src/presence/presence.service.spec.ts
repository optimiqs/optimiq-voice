import { beforeEach, describe, expect, it } from "bun:test";
import {
	type ExtensionPresence,
	kvKeyFor,
	PRESENCE_DEVICE_STATES,
	PRESENCE_KV,
	extensionPresenceSchema,
} from "@optimiq-voice/events";
import { DEVICE_STATES } from "@optimiq-voice/telephony";
import { PRESENCE_REFRESH_MS, PresenceService } from "./presence.service";
import type { EngineEnv } from "../config/engine-env";
import type { JetStreamService } from "../nats/jetstream.service";
import type { RoutingArtifactSource } from "../routing/routing-artifact.source";

/**
 * The presence publisher: `aggregateDeviceState`'s first production caller.
 *
 * The service is driven through its watch-entry seam rather than through a broker, because the thing
 * worth pinning is the DERIVATION — which legs belong to which extension, what they collapse to, and
 * when a write is suppressed — and none of that is about NATS. The two integration-shaped facts (the
 * bucket replay, the delete) are covered by feeding the same entries a watch would.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";

interface Written {
	readonly key: string;
	readonly value: ExtensionPresence;
}

interface HarnessOptions {
	readonly extensions?: readonly string[];
	readonly putFailures?: number;
	readonly deleteFailures?: number;
	readonly channels?: unknown;
	readonly resolveExtensions?: (orgId: string) => readonly string[] | undefined;
}

function harness(options: HarnessOptions = {}): {
	readonly service: PresenceService;
	readonly writes: Written[];
	readonly deletes: string[];
	readonly putAttempts: string[];
	readonly deleteAttempts: string[];
	readonly artifactLookups: string[];
	readonly failNextPut: () => void;
} {
	const writes: Written[] = [];
	const deletes: string[] = [];
	const putAttempts: string[] = [];
	const deleteAttempts: string[] = [];
	const artifactLookups: string[] = [];
	let putFailures = options.putFailures ?? 0;
	let deleteFailures = options.deleteFailures ?? 0;

	const presenceBucket = {
		put: async (key: string, value: Uint8Array) => {
			putAttempts.push(key);
			if (putFailures > 0) {
				putFailures -= 1;
				throw new Error("simulated presence put failure");
			}
			// Parsed through the CONTRACT on the way in, so a value this service writes and the
			// schema `apps/sipd` reads with cannot drift apart without a failure here.
			writes.push({
				key,
				value: extensionPresenceSchema.parse(
					JSON.parse(new TextDecoder().decode(value)),
				) as ExtensionPresence,
			});
			return 1;
		},
		delete: async (key: string) => {
			deleteAttempts.push(key);
			if (deleteFailures > 0) {
				deleteFailures -= 1;
				throw new Error("simulated presence delete failure");
			}
			deletes.push(key);
		},
	};

	const jetstream = {
		channels: options.channels,
		presence: presenceBucket,
	} as unknown as JetStreamService;

	const extensions = options.extensions ?? ["1001", "1002"];
	const resolveExtensions =
		options.resolveExtensions ?? ((orgId: string) => (orgId === ORG ? extensions : undefined));
	const artifacts = {
		get: async (orgId: string) => {
			artifactLookups.push(orgId);
			const resolvedExtensions = resolveExtensions(orgId);
			return resolvedExtensions === undefined
				? undefined
				: {
						extensionsByNumber: Object.fromEntries(
							resolvedExtensions.map((number) => [number, { number }]),
						),
					};
		},
	} as unknown as RoutingArtifactSource;

	const service = new PresenceService(jetstream, artifacts, {
		ENGINE_INSTANCE_ID: "engine-a",
	} as EngineEnv);

	return {
		service,
		writes,
		deletes,
		putAttempts,
		deleteAttempts,
		artifactLookups,
		failNextPut: () => {
			putFailures += 1;
		},
	};
}

interface ChannelOptions {
	readonly orgId?: string;
	readonly callId?: string;
	readonly channelId: string;
	readonly callState?: string;
	readonly destinationNumber?: string;
	readonly callerIdNumber?: string;
	readonly hangupAt?: number;
}

function channelPutEntry(options: ChannelOptions): {
	readonly key: string;
	readonly operation: "PUT";
	readonly value: Uint8Array;
} {
	const orgId = options.orgId ?? ORG;
	const callId = options.callId ?? "0195c0f0-1c2f-7000-8000-0000000000c1";
	const snapshot = {
		channelId: options.channelId,
		callId,
		organizationId: orgId,
		direction: "inbound",
		state: "executing",
		callState: options.callState ?? "ringing",
		flags: [],
		profile: {
			destinationNumber: options.destinationNumber,
			callerIdNumber: options.callerIdNumber,
			context: "optimiq-internal",
		},
		variables: {},
		createdAt: 1_785_000_000_000,
		hangupAt: options.hangupAt,
	};
	return {
		key: kvKeyFor.channel(orgId, callId, options.channelId),
		operation: "PUT",
		value: new TextEncoder().encode(JSON.stringify(snapshot)),
	};
}

function put(service: PresenceService, options: ChannelOptions): void {
	const entry = channelPutEntry(options);
	service.applyEntry(entry.key, entry.operation, entry.value);
}

function remove(service: PresenceService, options: ChannelOptions): void {
	const orgId = options.orgId ?? ORG;
	const callId = options.callId ?? "0195c0f0-1c2f-7000-8000-0000000000c1";
	service.applyEntry(kvKeyFor.channel(orgId, callId, options.channelId), "DEL", new Uint8Array());
}

interface FakeWatchEntry {
	readonly key: string;
	readonly operation: "PUT" | "DEL" | "PURGE";
	readonly value: Uint8Array;
}

function scriptedChannelWatches(replays: readonly (readonly FakeWatchEntry[])[]): {
	readonly bucket: unknown;
	readonly disconnects: (() => void)[];
} {
	const disconnects: (() => void)[] = [];
	const bucket = {
		watch: async (options?: { initializedFn?: () => void }) => {
			const entries = replays[disconnects.length] ?? [];
			let disconnect = (): void => undefined;
			const disconnected = new Promise<void>((resolve) => {
				disconnect = resolve;
			});
			disconnects.push(disconnect);
			return {
				stop: disconnect,
				async *[Symbol.asyncIterator]() {
					for (const entry of entries) {
						yield entry;
					}
					options?.initializedFn?.();
					await disconnected;
				},
			};
		},
	};
	return { bucket, disconnects };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("timed out waiting for presence state");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("the presence vocabulary", () => {
	/**
	 * `packages/events` copies `DEVICE_STATES` because `apps/sipd` needs a CLOSED vocabulary to map
	 * onto RFC 4235 dialog states, and the backbone contract must not depend on `packages/telephony`.
	 * This engine is the one place that legitimately imports both, so this is where the copy is
	 * pinned — the alternative is a lamp that stops moving the day somebody adds a device state.
	 */
	it("is the same list as the telephony package's, in the same order", () => {
		expect([...PRESENCE_DEVICE_STATES]).toEqual([...DEVICE_STATES]);
	});
});

describe("PresenceService", () => {
	let harnessed: ReturnType<typeof harness>;

	beforeEach(() => {
		harnessed = harness();
	});

	it("publishes a ringing extension from the leg dialling it", async () => {
		put(harnessed.service, { channelId: "a", callState: "ringing", destinationNumber: "1001" });
		await harnessed.service.flush();

		expect(harnessed.writes).toHaveLength(1);
		const written = harnessed.writes[0];
		expect(written?.key).toBe(kvKeyFor.presence(ORG, "1001"));
		expect(written?.value.state).toBe("ringing");
		expect(written?.value.channelCount).toBe(1);
		expect(written?.value.extensionNumber).toBe("1001");
		expect(written?.value.writtenBy).toBe("engine-a");
	});

	/**
	 * Both ends of a leg, deliberately. A key must light while its owner is DIALLING, not only while
	 * they are being called — FreeSWITCH's own device-state model does this and users expect it.
	 */
	it("attributes a leg to the extension that placed it as well as the one it rings", async () => {
		put(harnessed.service, {
			channelId: "a",
			callState: "active",
			callerIdNumber: "1001",
			destinationNumber: "1002",
		});
		await harnessed.service.flush();

		const keys = harnessed.writes.map((write) => write.key).sort();
		expect(keys).toEqual([kvKeyFor.presence(ORG, "1001"), kvKeyFor.presence(ORG, "1002")].sort());
		for (const write of harnessed.writes) {
			expect(write.value.state).toBe("active");
		}
	});

	/**
	 * The precedence that makes `aggregateDeviceState` worth having rather than "pick the highest
	 * state": two answered calls are materially different from one, and a phone renders them
	 * differently.
	 */
	it("collapses several legs through the telephony precedence", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		put(harnessed.service, { channelId: "b", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();

		expect(harnessed.writes.at(-1)?.value.state).toBe("active-multi");
		expect(harnessed.writes.at(-1)?.value.channelCount).toBe(2);
	});

	it("prefers an answered leg over a held one, and a held one over an alerting one", async () => {
		put(harnessed.service, { channelId: "a", callState: "held", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes.at(-1)?.value.state).toBe("held");

		put(harnessed.service, { channelId: "b", callState: "ringing", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes.at(-1)?.value.state).toBe("held");

		put(harnessed.service, { channelId: "c", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes.at(-1)?.value.state).toBe("active");
	});

	/**
	 * The debounce a reader depends on: `apps/sipd` turns one KV revision into one NOTIFY, so an
	 * unchanged aggregate must not produce a revision. A bridge change or a variable set rewrites the
	 * channel snapshot without moving the call state, and that must be silent.
	 */
	it("writes nothing when a channel update does not move the aggregate", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes).toHaveLength(1);

		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes).toHaveLength(1);

		put(harnessed.service, { channelId: "a", callState: "held", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes).toHaveLength(2);
		expect(harnessed.writes.at(-1)?.value.state).toBe("held");
	});

	it("periodically republishes unchanged active presence before the bucket TTL", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes).toHaveLength(1);

		harnessed.service.refreshActivePresence();
		await harnessed.service.flush();

		expect(PRESENCE_REFRESH_MS).toBeLessThan(PRESENCE_KV.ttlMs);
		expect(harnessed.writes).toHaveLength(2);
		expect(harnessed.writes[1]).toMatchObject({
			key: kvKeyFor.presence(ORG, "1001"),
			value: { state: "active", channelCount: 1 },
		});
	});

	it("retries a failed periodic refresh without another channel event", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();
		harnessed.failNextPut();

		harnessed.service.refreshActivePresence();
		await harnessed.service.flush();
		expect(harnessed.writes).toHaveLength(1);
		expect(harnessed.putAttempts).toHaveLength(2);

		await waitFor(() => harnessed.writes.length === 2);
		expect(harnessed.putAttempts).toHaveLength(3);
	});

	it("requeues a failed put and records it as published only after the retry succeeds", async () => {
		const failing = harness({ putFailures: 1 });
		put(failing.service, { channelId: "a", callState: "active", destinationNumber: "1001" });

		await failing.service.flush();
		expect(failing.putAttempts).toHaveLength(1);
		expect(failing.writes).toEqual([]);
		await Promise.resolve();
		expect(failing.putAttempts).toHaveLength(1);

		await waitFor(() => failing.writes.length === 1);
		expect(failing.putAttempts).toHaveLength(2);
		expect(failing.writes).toHaveLength(1);

		put(failing.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await failing.service.flush();
		expect(failing.putAttempts).toHaveLength(2);
	});

	/**
	 * Teardown CLEARS the key rather than writing `down`. An absent key is what the bucket's own
	 * five-minute TTL produces anyway, so a reader that handles absence handles both — and an idle
	 * extension then costs nothing to store.
	 */
	it("deletes the key when the last leg ends", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();

		remove(harnessed.service, { channelId: "a" });
		await harnessed.service.flush();

		expect(harnessed.deletes).toEqual([kvKeyFor.presence(ORG, "1001")]);
		expect(harnessed.service.trackedChannels).toBe(0);
	});

	it("requeues a failed delete and forgets the published key only after success", async () => {
		const failing = harness({ deleteFailures: 1 });
		put(failing.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await failing.service.flush();

		remove(failing.service, { channelId: "a" });
		await failing.service.flush();
		expect(failing.deleteAttempts).toHaveLength(1);
		expect(failing.deletes).toEqual([]);
		await Promise.resolve();
		expect(failing.deleteAttempts).toHaveLength(1);

		await waitFor(() => failing.deletes.length === 1);
		expect(failing.deleteAttempts).toHaveLength(2);
		expect(failing.deletes).toEqual([kvKeyFor.presence(ORG, "1001")]);

		await failing.service.flush();
		expect(failing.deleteAttempts).toHaveLength(2);
	});

	it("does not delete a key it never wrote", async () => {
		remove(harnessed.service, { channelId: "ghost" });
		await harnessed.service.flush();
		expect(harnessed.deletes).toEqual([]);
	});

	/**
	 * A leg carrying `hangupAt` is gone even though the snapshot is still in the bucket — the
	 * orchestrator writes the hangup and deletes the key in two steps. Counting it would hold the
	 * extension `active` for the gap between them.
	 */
	it("treats a leg in teardown as already gone", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();
		expect(harnessed.writes).toHaveLength(1);

		put(harnessed.service, {
			channelId: "a",
			callState: "active",
			destinationNumber: "1001",
			hangupAt: 1_785_000_000_500,
		});
		await harnessed.service.flush();
		expect(harnessed.deletes).toEqual([kvKeyFor.presence(ORG, "1001")]);
	});

	/**
	 * A transfer moves a leg's destination. Only marking the new extension dirty would leave the old
	 * lamp lit for the life of the call.
	 */
	it("clears the previous extension when a leg is re-targeted", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();

		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1002" });
		await harnessed.service.flush();

		expect(harnessed.deletes).toEqual([kvKeyFor.presence(ORG, "1001")]);
		expect(harnessed.writes.at(-1)?.key).toBe(kvKeyFor.presence(ORG, "1002"));
	});

	/**
	 * THE filter. Without it every inbound PSTN caller's number would become a presence key, and the
	 * bucket would grow an entry per number that has ever dialled the tenant.
	 */
	it("publishes nothing for a number that is not an extension of the tenant", async () => {
		const resolved = harness({ extensions: [] });
		put(resolved.service, {
			channelId: "a",
			callState: "active",
			destinationNumber: "1001",
		});
		await resolved.service.flush();
		await resolved.service.flush();

		expect(resolved.writes).toEqual([]);
		expect(resolved.artifactLookups).toEqual([ORG]);
	});

	it("retries an artifact outage and publishes after recovery without another channel event", async () => {
		let available = false;
		const recovering = harness({
			resolveExtensions: (orgId) => (orgId === ORG && available ? ["1001"] : undefined),
		});
		put(recovering.service, {
			channelId: "a",
			callState: "active",
			destinationNumber: "1001",
		});

		await recovering.service.flush();
		expect(recovering.writes).toEqual([]);
		expect(recovering.artifactLookups).toEqual([ORG]);
		await Promise.resolve();
		expect(recovering.artifactLookups).toEqual([ORG]);

		available = true;
		await waitFor(() => recovering.writes.length === 1);
		expect(recovering.artifactLookups).toEqual([ORG, ORG]);
		expect(recovering.writes[0]?.key).toBe(kvKeyFor.presence(ORG, "1001"));
	});

	/**
	 * Two tenants numbering an extension `1001` are two keys. A derivation that lost the org would
	 * light one customer's lamps from another's calls.
	 */
	it("keys by tenant as well as by number", async () => {
		const both = harness({
			extensions: ["1001"],
			resolveExtensions: (orgId) => (orgId === ORG ? ["1001"] : []),
		});
		put(both.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		put(both.service, {
			orgId: OTHER_ORG,
			channelId: "b",
			callState: "active",
			destinationNumber: "1001",
		});
		await both.service.flush();

		expect(both.writes).toHaveLength(1);
		expect(both.writes[0]?.value.orgId).toBe(ORG);
		expect(both.writes[0]?.value.channelCount).toBe(1);
	});

	/**
	 * A number that cannot be a KV key token must never reach the key builder: it throws, and a throw
	 * inside the watch loop over a caller-id string somebody dialled in with would stop presence for
	 * the whole deployment.
	 */
	it("permanently skips an invalid Local dial string before key or artifact lookup", async () => {
		const unavailable = harness({ resolveExtensions: () => undefined });
		put(unavailable.service, {
			channelId: "a",
			callState: "active",
			destinationNumber: "Local/1001@optimiq-internal",
		});
		await unavailable.service.flush();
		unavailable.service.refreshActivePresence();
		await unavailable.service.flush();

		expect(unavailable.artifactLookups).toEqual([]);
		expect(unavailable.putAttempts).toEqual([]);
	});

	/**
	 * A snapshot from a future engine release that this build cannot parse is treated as GONE rather
	 * than ignored. Ignoring it freezes whatever the leg last contributed for the life of the call;
	 * forgetting it at worst clears a lamp early, and the next good write restores it.
	 */
	it("forgets a leg whose snapshot will not parse", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		await harnessed.service.flush();

		harnessed.service.applyEntry(
			kvKeyFor.channel(ORG, "0195c0f0-1c2f-7000-8000-0000000000c1", "a"),
			"PUT",
			new TextEncoder().encode("{not json"),
		);
		await harnessed.service.flush();

		expect(harnessed.deletes).toEqual([kvKeyFor.presence(ORG, "1001")]);
		expect(harnessed.service.trackedChannels).toBe(0);
	});

	it("carries the collapsed call states for diagnosis", async () => {
		put(harnessed.service, { channelId: "a", callState: "active", destinationNumber: "1001" });
		put(harnessed.service, { channelId: "b", callState: "ringing", destinationNumber: "1001" });
		await harnessed.service.flush();

		expect(harnessed.writes.at(-1)?.value.callStates).toEqual(["active", "ringing"]);
	});

	it("deletes stale presence when a reconnect replay no longer contains a tracked call", async () => {
		const watches = scriptedChannelWatches([
			[channelPutEntry({ channelId: "a", callState: "active", destinationNumber: "1001" })],
			[],
		]);
		const watched = harness({ channels: watches.bucket });
		watched.service.onModuleInit();
		expect(watched.service.refreshScheduled).toBe(true);

		try {
			await waitFor(() => watched.writes.length === 1);
			expect(watched.service.trackedChannels).toBe(1);

			watches.disconnects[0]?.();
			await waitFor(() => watches.disconnects.length >= 2);
			await waitFor(() => watched.deletes.length === 1);

			expect(watched.deletes).toEqual([kvKeyFor.presence(ORG, "1001")]);
			expect(watched.service.trackedChannels).toBe(0);
		} finally {
			await watched.service.onApplicationShutdown();
			expect(watched.service.refreshScheduled).toBe(false);
		}
	});
});
