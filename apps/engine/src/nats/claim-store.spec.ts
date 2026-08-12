import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { KvClaimBucket } from "./claim-store";
import { FakeClaimBucket } from "./claim-store.fake";
import type { KV } from "nats";

describe("claim release fencing", () => {
	it("makes the fake reject a stale release revision", async () => {
		const bucket = new FakeClaimBucket<number>();
		const created = await bucket.create("claim", 1);
		if (created.kind !== "written") {
			throw new Error(`expected a write, got ${created.kind}`);
		}
		const updated = await bucket.update("claim", 2, created.revision);
		if (updated.kind !== "written") {
			throw new Error(`expected an update, got ${updated.kind}`);
		}

		expect(await bucket.release("claim", created.revision)).toBe(false);
		expect(await bucket.get("claim")).toMatchObject({ kind: "present", claim: { value: 2 } });
		expect(await bucket.release("claim", updated.revision)).toBe(true);
	});

	it("passes the expected revision to JetStream delete", async () => {
		const deletes: unknown[][] = [];
		const kv = {
			delete: async (...args: unknown[]) => {
				deletes.push(args);
			},
		} as unknown as KV;
		const bucket = new KvClaimBucket(kv, z.number(), "claims");

		expect(await bucket.release("claim", 42)).toBe(true);
		expect(deletes).toEqual([["claim", { previousSeq: 42 }]]);
	});

	it("reports a stale JetStream delete as a lost release", async () => {
		const kv = {
			delete: async () => {
				throw Object.assign(new Error("wrong last sequence"), {
					api_error: { err_code: 10071 },
				});
			},
		} as unknown as KV;
		const bucket = new KvClaimBucket(kv, z.number(), "claims");

		expect(await bucket.release("claim", 42)).toBe(false);
	});
});

describe("claim reads", () => {
	it("distinguishes absent, unavailable, and present in the fake", async () => {
		const bucket = new FakeClaimBucket<number>();
		expect(await bucket.get("claim")).toEqual({ kind: "absent" });
		await bucket.create("claim", 7);
		expect(await bucket.get("claim")).toMatchObject({ kind: "present", claim: { value: 7 } });
		bucket.failing = true;
		expect(await bucket.get("claim")).toMatchObject({ kind: "unavailable" });
	});

	it("reports broker and parse failures as unavailable rather than absent", async () => {
		const brokenBroker = new KvClaimBucket(
			{ get: async () => Promise.reject(new Error("broker unreachable")) } as unknown as KV,
			z.number(),
			"claims",
		);
		expect(await brokenBroker.get("claim")).toMatchObject({ kind: "unavailable" });

		const invalidValue = new KvClaimBucket(
			{
				get: async () => ({
					value: new TextEncoder().encode(JSON.stringify("not-a-number")),
					revision: 4,
				}),
			} as unknown as KV,
			z.number(),
			"claims",
		);
		expect(await invalidValue.get("claim")).toMatchObject({ kind: "unavailable" });
	});
});
