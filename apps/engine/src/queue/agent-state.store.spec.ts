import { describe, expect, it } from "bun:test";
import { kvKeyFor } from "@optimiq-voice/events";
import { AgentStateStore } from "./agent-state.store";
import type { JetStreamService } from "../nats/jetstream.service";
import type { QueueEventPublisher } from "./queue-event-publisher.service";
import type { AgentStateEntry, AgentStatus } from "@optimiq-voice/events";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const AGENT = "0195c0f0-1c2f-7000-8000-0000000000a1";
const QUEUE = "0195c0f0-1c2f-7000-8000-0000000000e1";
const CALL_A = "0195c0f0-1c2f-7000-8000-0000000000c1";
const CALL_B = "0195c0f0-1c2f-7000-8000-0000000000c2";
const KEY = kvKeyFor.agentState(ORG, AGENT);
const SINCE = "2026-08-05T12:00:00.000Z";

interface StoredEntry {
	readonly value: Uint8Array;
	readonly revision: number;
}

interface WriteCall {
	readonly method: "create" | "put" | "update";
	readonly revision?: number;
}

class FakeAgentStateBucket {
	readonly writes: WriteCall[] = [];
	beforeNextWrite: (() => void) | undefined;
	readFailures = 0;

	private readonly entries = new Map<string, StoredEntry>();
	private nextRevision = 1;

	seed(entry: AgentStateEntry): void {
		this.write(KEY, entry);
	}

	controlPlaneWrite(entry: AgentStateEntry): void {
		this.write(KEY, entry);
	}

	current(): AgentStateEntry | undefined {
		const entry = this.entries.get(KEY);
		return entry === undefined
			? undefined
			: (JSON.parse(new TextDecoder().decode(entry.value)) as AgentStateEntry);
	}

	async get(key: string): Promise<StoredEntry | null> {
		if (this.readFailures > 0) {
			this.readFailures -= 1;
			throw new Error("broker unavailable");
		}
		const entry = this.entries.get(key);
		const snapshot =
			entry === undefined ? null : { value: entry.value.slice(), revision: entry.revision };
		// Both concurrent callers take their snapshot before either conditional write resumes.
		await Promise.resolve();
		return snapshot;
	}

	async create(key: string, value: Uint8Array): Promise<number> {
		this.writes.push({ method: "create" });
		this.runBeforeWrite();
		if (this.entries.has(key)) {
			throw conflict();
		}
		return this.writeBytes(key, value);
	}

	async update(key: string, value: Uint8Array, revision: number): Promise<number> {
		this.writes.push({ method: "update", revision });
		this.runBeforeWrite();
		if (this.entries.get(key)?.revision !== revision) {
			throw conflict();
		}
		return this.writeBytes(key, value);
	}

	async put(key: string, value: Uint8Array): Promise<number> {
		this.writes.push({ method: "put" });
		this.runBeforeWrite();
		return this.writeBytes(key, value);
	}

	private runBeforeWrite(): void {
		const callback = this.beforeNextWrite;
		this.beforeNextWrite = undefined;
		callback?.();
	}

	private write(key: string, value: AgentStateEntry): number {
		return this.writeBytes(key, new TextEncoder().encode(JSON.stringify(value)));
	}

	private writeBytes(key: string, value: Uint8Array): number {
		const revision = this.nextRevision++;
		this.entries.set(key, { value: value.slice(), revision });
		return revision;
	}
}

function conflict(): Error {
	return Object.assign(new Error("wrong last sequence"), {
		api_error: { err_code: 10071 },
	});
}

function available(callId?: string): AgentStateEntry {
	return {
		orgId: ORG,
		agentId: AGENT,
		status: "available",
		since: SINCE,
		source: "api",
		...(callId === undefined ? {} : { callId }),
	};
}

function loggedOut(): AgentStateEntry {
	return {
		orgId: ORG,
		agentId: AGENT,
		status: "logged-out",
		since: SINCE,
		source: "api",
	};
}

function owned(status: "ringing" | "on-call" | "wrap-up", callId: string): AgentStateEntry {
	return {
		orgId: ORG,
		agentId: AGENT,
		status,
		since: SINCE,
		callId,
		source: "engine",
	};
}

function storeOver(bucket: FakeAgentStateBucket): {
	readonly store: AgentStateStore;
	readonly events: AgentStatus[];
} {
	const events: AgentStatus[] = [];
	const jetstream = { agentState: bucket } as unknown as JetStreamService;
	const publisher = {
		agentState: async (input: { readonly status: AgentStatus }) => {
			events.push(input.status);
		},
	} as unknown as QueueEventPublisher;
	return { store: new AgentStateStore(jetstream, publisher), events };
}

function reserve(store: AgentStateStore, callId: string): Promise<AgentStateEntry | undefined> {
	return store.reserve({
		orgId: ORG,
		agentId: AGENT,
		to: "ringing",
		queueId: QUEUE,
		callId,
		now: Date.parse(SINCE) + 1_000,
	});
}

describe("agent state transition concurrency", () => {
	it("lets only one simultaneous available-to-ringing reservation succeed", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed(available());
		const { store, events } = storeOver(bucket);

		const results = await Promise.all([reserve(store, CALL_A), reserve(store, CALL_B)]);

		expect(results.filter((result) => result !== undefined)).toHaveLength(1);
		expect(bucket.current()).toMatchObject({ status: "ringing" });
		expect([CALL_A, CALL_B]).toContain(bucket.current()?.callId as string);
		expect(events).toEqual(["ringing"]);
		expect(bucket.writes.filter((call) => call.method === "update")).toHaveLength(2);
		expect(bucket.writes.some((call) => call.method === "put")).toBe(false);
	});

	it("does not let a later caller adopt the winning caller's ringing entry", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed(available());
		const { store, events } = storeOver(bucket);

		expect(await reserve(store, CALL_A)).toMatchObject({ callId: CALL_A, status: "ringing" });
		expect(await reserve(store, CALL_B)).toBeUndefined();
		expect(bucket.current()).toMatchObject({ callId: CALL_A, status: "ringing" });
		expect(events).toEqual(["ringing"]);
	});

	it("atomically adopts an expired wrap-up owned by an old call", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed({
			...owned("wrap-up", CALL_A),
			availableAt: new Date(Date.parse(SINCE) + 500).toISOString(),
		});
		const { store, events } = storeOver(bucket);

		const results = await Promise.all([reserve(store, CALL_B), reserve(store, CALL_A)]);

		expect(results.filter((result) => result !== undefined)).toHaveLength(1);
		expect(bucket.current()).toMatchObject({
			status: "ringing",
			previousStatus: "wrap-up",
		});
		expect(events).toEqual(["ringing"]);
		expect(bucket.writes.filter((call) => call.method === "update")).toHaveLength(2);
	});

	it("does not adopt wrap-up before its deadline", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed({
			...owned("wrap-up", CALL_A),
			availableAt: new Date(Date.parse(SINCE) + 2_000).toISOString(),
		});
		const { store, events } = storeOver(bucket);

		expect(await reserve(store, CALL_B)).toBeUndefined();
		expect(bucket.current()).toMatchObject({ status: "wrap-up", callId: CALL_A });
		expect(bucket.writes).toEqual([]);
		expect(events).toEqual([]);
	});

	it("does not overwrite a logout written after the transition read", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed(available());
		const { store, events } = storeOver(bucket);
		bucket.beforeNextWrite = () => {
			bucket.controlPlaneWrite(loggedOut());
		};

		expect(await reserve(store, CALL_A)).toBeUndefined();
		expect(bucket.current()).toEqual(loggedOut());
		expect(events).toEqual([]);
	});
});

describe("point reads", () => {
	it("distinguishes confirmed absence from an unavailable bucket", async () => {
		const bucket = new FakeAgentStateBucket();
		const { store } = storeOver(bucket);

		expect(await store.readState(ORG, AGENT)).toEqual({ kind: "absent" });
		bucket.readFailures = 1;
		expect(await store.readState(ORG, AGENT)).toEqual({ kind: "unavailable" });
	});
});

describe("call ownership", () => {
	it("refuses to promote another call's ringing agent to on-call", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed(owned("ringing", CALL_A));
		const { store, events } = storeOver(bucket);

		expect(
			await store.transition({
				orgId: ORG,
				agentId: AGENT,
				to: "on-call",
				queueId: QUEUE,
				callId: CALL_B,
			}),
		).toBeUndefined();
		expect(bucket.current()).toEqual(owned("ringing", CALL_A));
		expect(bucket.writes).toEqual([]);
		expect(events).toEqual([]);
	});

	for (const [from, to] of [
		["ringing", "available"],
		["on-call", "wrap-up"],
		["wrap-up", "available"],
	] as const) {
		it(`refuses stale ${from}-to-${to} cleanup from another call`, async () => {
			const bucket = new FakeAgentStateBucket();
			bucket.seed(owned(from, CALL_A));
			const { store, events } = storeOver(bucket);

			expect(
				await store.transition({
					orgId: ORG,
					agentId: AGENT,
					to,
					queueId: QUEUE,
					callId: CALL_B,
				}),
			).toBeUndefined();
			expect(bucket.current()).toEqual(owned(from, CALL_A));
			expect(bucket.writes).toEqual([]);
			expect(events).toEqual([]);
		});
	}
});

describe("absent and logged-out agents", () => {
	it("continues to treat an absent agent as logged out without creating an entry", async () => {
		const bucket = new FakeAgentStateBucket();
		const { store } = storeOver(bucket);

		expect(await reserve(store, CALL_A)).toBeUndefined();
		expect(bucket.current()).toBeUndefined();
		expect(bucket.writes).toEqual([]);
	});

	it("refuses to reserve an explicitly logged-out agent", async () => {
		const bucket = new FakeAgentStateBucket();
		bucket.seed(loggedOut());
		const { store } = storeOver(bucket);

		expect(await reserve(store, CALL_A)).toBeUndefined();
		expect(bucket.current()).toEqual(loggedOut());
		expect(bucket.writes).toEqual([]);
	});
});
