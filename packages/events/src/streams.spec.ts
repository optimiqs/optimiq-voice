import { describe, expect, it } from "bun:test";
import { createEntityId } from "@optimiq-voice/identifiers";
import {
	assertStreamCompatible,
	AUDIT_STREAM,
	CALLS_STREAM,
	CDR_STREAM,
	ensureStreams,
	EVENT_STREAMS,
	isStreamNotFoundError,
	KV_BUCKETS,
	kvKeyFor,
	kvOptionsFor,
	millisToNanos,
	nanosToMillis,
	PROVISION_STREAM,
	QUEUES_STREAM,
	REGISTRATIONS_STREAM,
	StreamDefinitionConflictError,
	streamConfigFor,
	streamNeedsUpdate,
	withReplicas,
	type StreamConfigInput,
	type StreamDefinition,
} from "./streams";
import { matchesSubject, SubjectTokenError, subjectFor } from "./subjects";
import type { JetStreamManager } from "nats";

const ORG = createEntityId();

/** Minimal in-memory stand-in for the parts of `JetStreamManager` that `ensureStreams` calls. */
function stubManager(initial: readonly StreamConfigInput[] = []) {
	const streams = new Map<string, StreamConfigInput>(
		initial.map((config) => [config.name, config]),
	);
	const calls: string[] = [];

	const manager = {
		streams: {
			info(name: string) {
				calls.push(`info:${name}`);
				const config = streams.get(name);
				if (config === undefined) {
					const error = new Error("stream not found") as Error & {
						api_error: { err_code: number };
					};
					error.api_error = { err_code: 10059 };
					return Promise.reject(error);
				}
				return Promise.resolve({ config });
			},
			add(config: StreamConfigInput) {
				calls.push(`add:${config.name}`);
				streams.set(config.name, config);
				return Promise.resolve({ config });
			},
			update(name: string, config: Omit<StreamConfigInput, "name">) {
				calls.push(`update:${name}`);
				const merged = { ...config, name };
				streams.set(name, merged);
				return Promise.resolve({ config: merged });
			},
		},
	};

	return { manager: manager as unknown as JetStreamManager, streams, calls };
}

describe("duration conversion", () => {
	it("converts millis to JetStream nanoseconds and back", () => {
		expect(millisToNanos(1)).toBe(1_000_000);
		expect(nanosToMillis(millisToNanos(72 * 3_600_000))).toBe(72 * 3_600_000);
	});
});

describe("stream definitions", () => {
	it("declares the seven streams from plan §3.5", () => {
		expect(EVENT_STREAMS.map((stream) => stream.name)).toEqual([
			"CALLS",
			"REGISTRATIONS",
			"QUEUES",
			"VOICEMAIL",
			"CDR",
			"AUDIT",
			"PROVISION",
		]);
	});

	it("gives every stream a unique name and a description", () => {
		const names = new Set(EVENT_STREAMS.map((stream) => stream.name));
		expect(names.size).toBe(EVENT_STREAMS.length);
		for (const stream of EVENT_STREAMS) {
			expect(stream.description.length).toBeGreaterThan(10);
		}
	});

	it("claims disjoint subject space", () => {
		const samples = [
			subjectFor.call(ORG, createEntityId(), "channel.created"),
			subjectFor.registration(ORG, "a".repeat(32), "registered"),
			subjectFor.queue(ORG, createEntityId(), "caller.joined"),
			subjectFor.cdrLeg(ORG),
			subjectFor.audit(ORG),
			subjectFor.provision(ORG),
		];
		for (const sample of samples) {
			const owners = EVENT_STREAMS.filter((stream) =>
				stream.subjects.some((filter) => matchesSubject(filter, sample)),
			);
			expect(owners).toHaveLength(1);
		}
	});

	it("keeps the ledgers on discard:new and the live feeds on discard:old", () => {
		expect(CDR_STREAM.discard).toBe("new");
		expect(AUDIT_STREAM.discard).toBe("new");
		for (const stream of [CALLS_STREAM, REGISTRATIONS_STREAM, QUEUES_STREAM, PROVISION_STREAM]) {
			expect(stream.discard).toBe("old");
		}
	});

	it("keeps every stream file-backed with a dedupe window", () => {
		for (const stream of EVENT_STREAMS) {
			expect(stream.storage).toBe("file");
			expect(stream.retention).toBe("limits");
			expect(stream.duplicateWindowMs).toBeGreaterThanOrEqual(120_000);
			expect(stream.numReplicas).toBe(1);
		}
	});

	it("retains the CDR ledger long enough to rebuild the table", () => {
		expect(CDR_STREAM.maxAgeMs).toBe(30 * 24 * 3_600_000);
		expect(AUDIT_STREAM.maxAgeMs).toBeGreaterThan(365 * 24 * 3_600_000);
		// A crash-looping writer may retry the same leg minutes later.
		expect(CDR_STREAM.duplicateWindowMs).toBeGreaterThan(CALLS_STREAM.duplicateWindowMs);
	});

	it("translates a definition into the JetStream wire config", () => {
		expect(streamConfigFor(CALLS_STREAM)).toEqual({
			name: "CALLS",
			description: CALLS_STREAM.description,
			subjects: ["calls.evt.v1.>"],
			retention: "limits",
			storage: "file",
			discard: "old",
			max_age: millisToNanos(72 * 3_600_000),
			max_msgs: -1,
			max_bytes: 8 * 1024 * 1024 * 1024,
			max_msgs_per_subject: -1,
			duplicate_window: millisToNanos(120_000),
			num_replicas: 1,
		});
	});

	it("produces a production replica count without mutating the definition", () => {
		const replicated = withReplicas(CALLS_STREAM, 3);
		expect(replicated.numReplicas).toBe(3);
		expect(CALLS_STREAM.numReplicas).toBe(1);
	});

	it.each([0, 6, 2.5, Number.NaN])("rejects a replica count of %p", (replicas) => {
		expect(() => withReplicas(CALLS_STREAM, replicas)).toThrow(RangeError);
	});
});

describe("ensureStreams", () => {
	it("creates every stream on an empty broker", async () => {
		const { manager, streams, calls } = stubManager();
		const outcomes = await ensureStreams(manager);
		expect(outcomes.every((outcome) => outcome.action === "created")).toBe(true);
		expect(streams.size).toBe(EVENT_STREAMS.length);
		expect(calls.filter((call) => call.startsWith("add:"))).toHaveLength(EVENT_STREAMS.length);
	});

	it("is idempotent: a second run writes nothing", async () => {
		const { manager, calls } = stubManager();
		await ensureStreams(manager);
		calls.length = 0;
		const outcomes = await ensureStreams(manager);
		expect(outcomes.every((outcome) => outcome.action === "unchanged")).toBe(true);
		expect(calls.every((call) => call.startsWith("info:"))).toBe(true);
	});

	it("updates a stream whose mutable config drifted", async () => {
		const { manager, streams } = stubManager();
		await ensureStreams(manager);
		const drifted = { ...(streams.get("CALLS") as StreamConfigInput), max_bytes: 1 };
		streams.set("CALLS", drifted);

		const outcomes = await ensureStreams(manager);
		expect(outcomes.find((outcome) => outcome.name === "CALLS")?.action).toBe("updated");
		expect((streams.get("CALLS") as StreamConfigInput).max_bytes).toBe(
			streamConfigFor(CALLS_STREAM).max_bytes,
		);
		expect(
			outcomes.filter((outcome) => outcome.name !== "CALLS").every((o) => o.action === "unchanged"),
		).toBe(true);
	});

	it("refuses to silently recreate a stream whose retention changed", async () => {
		const { manager, streams } = stubManager();
		await ensureStreams(manager);
		streams.set("CALLS", {
			...(streams.get("CALLS") as StreamConfigInput),
			retention: "workqueue",
		});
		await expect(ensureStreams(manager)).rejects.toThrow(StreamDefinitionConflictError);
	});

	it("propagates an error that is not 'stream not found'", async () => {
		const manager = {
			streams: {
				info: () => Promise.reject(new Error("connection refused")),
				add: () => Promise.reject(new Error("unreachable")),
				update: () => Promise.reject(new Error("unreachable")),
			},
		} as unknown as JetStreamManager;
		await expect(ensureStreams(manager, [CALLS_STREAM])).rejects.toThrow("connection refused");
	});

	it("applies only the definitions it is handed", async () => {
		const { manager, streams } = stubManager();
		await ensureStreams(manager, [AUDIT_STREAM]);
		expect([...streams.keys()]).toEqual(["AUDIT"]);
	});
});

describe("stream reconciliation helpers", () => {
	const desired = streamConfigFor(CALLS_STREAM);

	it("reports no update when the live config matches", () => {
		expect(streamNeedsUpdate({ ...desired }, desired)).toBe(false);
	});

	it.each([
		["subjects", { subjects: ["calls.evt.v1.*"] }],
		["description", { description: "something else" }],
		["discard", { discard: "new" }],
		["max_age", { max_age: 1 }],
		["max_bytes", { max_bytes: 1 }],
		["duplicate_window", { duplicate_window: 1 }],
		["num_replicas", { num_replicas: 3 }],
	])("reports an update when %s drifted", (_label, override) => {
		expect(streamNeedsUpdate({ ...desired, ...override }, desired)).toBe(true);
	});

	it("ignores subject ordering", () => {
		const multi: StreamDefinition = { ...CALLS_STREAM, subjects: ["a.>", "b.>"] };
		const config = streamConfigFor(multi);
		expect(streamNeedsUpdate({ ...config, subjects: ["b.>", "a.>"] }, config)).toBe(false);
	});

	it("accepts a live config that omits the immutable fields", () => {
		expect(() => assertStreamCompatible("CALLS", {}, desired)).not.toThrow();
	});

	it.each([
		["not found", { message: "stream not found" }, true],
		["api err_code", { api_error: { err_code: 10059 } }, true],
		["api 404", { api_error: { code: 404 } }, true],
		["connection", { message: "connection refused" }, false],
		["not an object", "boom", false],
	])("classifies a %s error", (_label, error, expected) => {
		expect(isStreamNotFoundError(error)).toBe(expected);
	});
});

describe("kv bucket definitions", () => {
	it("declares every bucket the backbone owns, in apply order", () => {
		expect(KV_BUCKETS.map((bucket) => bucket.name)).toEqual([
			"registrations",
			"channels",
			"presence",
			"agent-state",
			"routing-cache",
			"did-index",
			"queue-membership",
		]);
	});

	it("gives every bucket a single revision of history", () => {
		for (const bucket of KV_BUCKETS) {
			expect(bucket.history).toBe(1);
			expect(bucket.maxValueSizeBytes).toBeGreaterThan(0);
		}
	});

	/**
	 * The two CONFIGURATION buckets must not expire. `did-index` and `queue-membership` both hold
	 * derived configuration rather than live state, and an expired entry is an outage produced by a
	 * timer rather than by a change: an inbound call to a valid DID rejected with `INVALID_PROFILE`,
	 * or a staffed queue that suddenly has no agents and ejects every caller to its timeout branch.
	 *
	 * Everything else holds live state whose staleness self-corrects — a registration refreshes, a
	 * channel ends, an agent's status is rewritten on their next transition — so a TTL is a safety
	 * net rather than a hazard.
	 */
	const CONFIGURATION_BUCKETS = ["did-index", "queue-membership"];

	it("gives every LIVE-STATE bucket a TTL, and the configuration buckets none", () => {
		for (const bucket of KV_BUCKETS) {
			if (CONFIGURATION_BUCKETS.includes(bucket.name)) {
				expect(bucket.ttlMs).toBe(0);
				continue;
			}
			expect(bucket.ttlMs).toBeGreaterThan(0);
		}
	});

	it("keeps derived presence in memory and durable state on disk", () => {
		expect(KV_BUCKETS.find((bucket) => bucket.name === "presence")?.storage).toBe("memory");
		for (const name of [
			"registrations",
			"channels",
			"agent-state",
			"routing-cache",
			"did-index",
			"queue-membership",
		]) {
			expect(KV_BUCKETS.find((bucket) => bucket.name === name)?.storage).toBe("file");
		}
	});

	it("outlives a SIP registration refresh but not a shift", () => {
		const registrations = KV_BUCKETS.find((bucket) => bucket.name === "registrations");
		expect(registrations?.ttlMs).toBe(3_600_000);
	});

	it("translates a bucket into the KV wire options", () => {
		expect(kvOptionsFor(KV_BUCKETS[0] as never)).toEqual({
			description: KV_BUCKETS[0]?.description as string,
			ttl: 3_600_000,
			history: 1,
			storage: "file",
			replicas: 1,
			max_bytes: 256 * 1024 * 1024,
			maxValueSize: 8 * 1024,
		});
	});
});

describe("kvKeyFor", () => {
	const call = createEntityId();
	const leg = createEntityId();

	it("builds org-scoped keys", () => {
		expect(kvKeyFor.registration(ORG, "a".repeat(32))).toBe(`${ORG}.${"a".repeat(32)}`);
		expect(kvKeyFor.channel(ORG, call, leg)).toBe(`${ORG}.${call}.${leg}`);
		expect(kvKeyFor.presence(ORG, leg)).toBe(`${ORG}.${leg}`);
		expect(kvKeyFor.agentState(ORG, leg)).toBe(`${ORG}.${leg}`);
		expect(kvKeyFor.routingCache(ORG, "inbound", "15551230000")).toBe(`${ORG}.inbound.15551230000`);
		expect(kvKeyFor.routingCache(ORG, "dialplan")).toBe(`${ORG}.dialplan`);
	});

	it("puts a call's legs under a shared prefix", () => {
		const other = createEntityId();
		expect(kvKeyFor.channel(ORG, call, other).startsWith(`${ORG}.${call}.`)).toBe(true);
	});

	it("rejects a token that would break the key namespace", () => {
		expect(() => kvKeyFor.routingCache(ORG, "inbound.did")).toThrow(SubjectTokenError);
		expect(() => kvKeyFor.registration("", "abc")).toThrow(SubjectTokenError);
	});
});
