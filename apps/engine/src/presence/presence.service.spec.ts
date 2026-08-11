import { beforeEach, describe, expect, it } from "bun:test";
import {
	type ExtensionPresence,
	kvKeyFor,
	PRESENCE_DEVICE_STATES,
	extensionPresenceSchema,
} from "@optimiq-voice/events";
import { DEVICE_STATES } from "@optimiq-voice/telephony";
import { PresenceService } from "./presence.service";
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

function harness(extensions: readonly string[] = ["1001", "1002"]): {
	readonly service: PresenceService;
	readonly writes: Written[];
	readonly deletes: string[];
} {
	const writes: Written[] = [];
	const deletes: string[] = [];

	const presenceBucket = {
		put: async (key: string, value: Uint8Array) => {
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
			deletes.push(key);
		},
	};

	const jetstream = {
		channels: undefined,
		presence: presenceBucket,
	} as unknown as JetStreamService;

	const artifacts = {
		get: async (orgId: string) =>
			orgId === ORG
				? {
						extensionsByNumber: Object.fromEntries(
							extensions.map((number) => [number, { number }]),
						),
					}
				: undefined,
	} as unknown as RoutingArtifactSource;

	const service = new PresenceService(jetstream, artifacts, {
		ENGINE_INSTANCE_ID: "engine-a",
	} as EngineEnv);

	return { service, writes, deletes };
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

function put(service: PresenceService, options: ChannelOptions): void {
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
	service.applyEntry(
		kvKeyFor.channel(orgId, callId, options.channelId),
		"PUT",
		new TextEncoder().encode(JSON.stringify(snapshot)),
	);
}

function remove(service: PresenceService, options: ChannelOptions): void {
	const orgId = options.orgId ?? ORG;
	const callId = options.callId ?? "0195c0f0-1c2f-7000-8000-0000000000c1";
	service.applyEntry(kvKeyFor.channel(orgId, callId, options.channelId), "DEL", new Uint8Array());
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
		put(harnessed.service, {
			channelId: "a",
			callState: "active",
			callerIdNumber: "12125550100",
			destinationNumber: "1001",
		});
		await harnessed.service.flush();

		expect(harnessed.writes.map((write) => write.key)).toEqual([kvKeyFor.presence(ORG, "1001")]);
	});

	it("publishes nothing for a tenant whose routing artifact cannot be resolved", async () => {
		put(harnessed.service, {
			orgId: OTHER_ORG,
			channelId: "a",
			callState: "active",
			destinationNumber: "1001",
		});
		await harnessed.service.flush();

		expect(harnessed.writes).toEqual([]);
	});

	/**
	 * Two tenants numbering an extension `1001` are two keys. A derivation that lost the org would
	 * light one customer's lamps from another's calls.
	 */
	it("keys by tenant as well as by number", async () => {
		const both = harness(["1001"]);
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
	it("ignores a number that could not be a key token", async () => {
		put(harnessed.service, {
			channelId: "a",
			callState: "active",
			callerIdNumber: "1001.1002",
			destinationNumber: "1001",
		});
		await harnessed.service.flush();
		expect(harnessed.writes.map((write) => write.key)).toEqual([kvKeyFor.presence(ORG, "1001")]);
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
});
