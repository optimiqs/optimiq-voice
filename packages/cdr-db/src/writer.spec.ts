import { describe, expect, it } from "bun:test";
import {
	buildCallLegEnrichmentQuery,
	CdrWriterScopeError,
	ENRICHABLE_CALL_LEG_COLUMNS,
	withCdrWriterScope,
	type CdrWriterTransactionHandle,
} from "./writer";
import type { SQL } from "drizzle-orm";

const TARGET = {
	organizationId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
	callLegId: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
	startedAt: new Date("2026-08-05T10:00:00Z"),
} as const;

function queryText(query: SQL): string {
	return JSON.stringify(query.queryChunks);
}

describe("call-leg enrichment statement", () => {
	it("always scopes by organization and by the partition key", () => {
		const text = queryText(
			buildCallLegEnrichmentQuery(TARGET, { transcriptionStatus: "completed" }),
		);

		expect(text).toContain("organization_id");
		expect(text).toContain("started_at");
		expect(text).toContain("returning");
	});

	it("only assigns the columns the caller supplied", () => {
		const text = queryText(buildCallLegEnrichmentQuery(TARGET, { recordingKey: "org/leg.wav" }));

		expect(text).toContain("recording_key");
		expect(text).not.toContain("transcription_status");
		expect(text).not.toContain("packet_loss_pct");
	});

	it("treats an explicit null as a value to write, not as an omission", () => {
		const text = queryText(buildCallLegEnrichmentQuery(TARGET, { mos: null }));

		expect(text).toContain("mos");
	});

	it("refuses an enrichment that would set nothing", () => {
		expect(() => buildCallLegEnrichmentQuery(TARGET, {})).toThrow(CdrWriterScopeError);
	});

	it("refuses an unscoped enrichment", () => {
		expect(() =>
			buildCallLegEnrichmentQuery(
				{ ...TARGET, organizationId: "   " },
				{ transcriptionStatus: "failed" },
			),
		).toThrow(CdrWriterScopeError);
	});

	it("exposes exactly the late-arriving columns as enrichable", () => {
		expect([...ENRICHABLE_CALL_LEG_COLUMNS]).toEqual([
			"recording_key",
			"transcription_status",
			"mos",
			"jitter_ms",
			"packet_loss_pct",
		]);
	});
});

describe("writer scope", () => {
	it("tags the transaction with the organization before any work runs", async () => {
		const executed: SQL[] = [];
		const transaction: CdrWriterTransactionHandle = {
			execute: (query) => {
				executed.push(query);
				return Promise.resolve([]);
			},
		};

		const result = await withCdrWriterScope(
			{ transaction: async (work) => await work(transaction) },
			TARGET.organizationId,
			async (tx) => {
				await tx.execute(buildCallLegEnrichmentQuery(TARGET, { mos: 4.2 }));
				return "done";
			},
		);

		expect(result).toBe("done");
		expect(executed).toHaveLength(2);
		expect(queryText(executed[0] as SQL)).toContain("cdr_writer.organization_id");
		expect(queryText(executed[1] as SQL)).toContain("call_legs");
	});

	it("refuses to open an unscoped writer transaction", async () => {
		let opened = false;

		await expect(
			withCdrWriterScope(
				{
					transaction: async (work) => {
						opened = true;
						return await work({ execute: () => Promise.resolve([]) });
					},
				},
				"",
				async () => "unreachable",
			),
		).rejects.toThrow(CdrWriterScopeError);
		expect(opened).toBe(false);
	});
});
