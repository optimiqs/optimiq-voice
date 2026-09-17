import { expect } from "chai";
import { mohLibraryObjectKey, mohLibraryPlan } from "../../src/pbx/media/moh-library";
import { renderMusicOnHoldConf } from "../../src/pbx/media/musiconhold-conf";
import type { MohClassRow } from "../../src/pbx/media/musiconhold-conf";

/**
 * Publishing a tenant's hold-music class under the name the media plane asks for.
 *
 * The live failure this closes: a queue with a perfectly configured class produced
 * `no such prompt: sound:moh/RT-Hold`, because `mediad` resolves a class as one path element under
 * `moh/` while the upload path stores it at `moh/<org>/<classId>/<promptId>.wav`. Every case here
 * is about WHICH classes may claim a name — the copy itself is a `put` and has nothing to decide.
 */
describe("music-on-hold library", () => {
	const ORG_A = "01a08708-4cd4-76b9-b56d-d26ebf326b0a";
	const ORG_B = "01a08708-4cd4-76b9-b56d-d26ebf326b0b";

	function aClass(overrides: Partial<MohClassRow> = {}): MohClassRow {
		return {
			id: "class-1",
			organizationId: ORG_A,
			name: "RT-Hold",
			source: "library",
			streamUri: null,
			shuffle: false,
			sampleRateHz: 8000,
			enabled: true,
			fileCount: 1,
			...overrides,
		};
	}

	/** The gate the plan reads, computed the same way production computes it. */
	function plan(
		classes: readonly MohClassRow[],
		files: ReadonlyMap<string, readonly { id: string; objectKey: string }[]>,
	) {
		const render = renderMusicOnHoldConf(classes, { containerObjectRoot: "/objects" });
		return mohLibraryPlan(classes, render.declared, files);
	}

	it("publishes an enabled library class at the key the media plane resolves", () => {
		const result = plan(
			[aClass()],
			new Map([["class-1", [{ id: "p-1", objectKey: `moh/${ORG_A}/class-1/p-1.wav` }]]]),
		);

		expect(result.entries).to.have.lengthOf(1);
		expect(result.entries[0]?.sourceObjectKey).to.equal(`moh/${ORG_A}/class-1/p-1.wav`);
		// `mediad`'s `loadMOH` turns `moh:RT-Hold` into exactly this. It is the regression pin.
		expect(mohLibraryObjectKey("RT-Hold")).to.equal("moh/RT-Hold.wav");
	});

	it("picks the same file every run, so an unchanged database publishes no writes", () => {
		const files = new Map([
			[
				"class-1",
				[
					{ id: "p-2", objectKey: "second.wav" },
					{ id: "p-1", objectKey: "first.wav" },
				],
			],
		]);
		expect(plan([aClass()], files).entries[0]?.sourceObjectKey).to.equal("first.wav");
	});

	it("refuses a name two organizations claim, exactly as the Asterisk conf does", () => {
		const classes = [
			aClass({ id: "class-1", organizationId: ORG_A }),
			aClass({ id: "class-2", organizationId: ORG_B }),
		];
		const result = plan(
			classes,
			new Map([
				["class-1", [{ id: "p-1", objectKey: "a.wav" }]],
				["class-2", [{ id: "p-2", objectKey: "b.wav" }]],
			]),
		);

		expect(result.entries).to.deep.equal([]);
		expect(result.skipped.map((skip) => skip.reason)).to.deep.equal([
			"name-conflict",
			"name-conflict",
		]);
	});

	it("never lets a tenant claim `default`, which is the platform's own asset", () => {
		const result = plan(
			[aClass({ name: "default" })],
			new Map([["class-1", [{ id: "p-1", objectKey: "a.wav" }]]]),
		);

		expect(result.entries).to.deep.equal([]);
		expect(result.skipped[0]?.reason).to.equal("name-conflict");
	});

	it("skips a disabled class, so the compiler's warning and the mount agree", () => {
		const result = plan(
			[aClass({ enabled: false })],
			new Map([["class-1", [{ id: "p-1", objectKey: "a.wav" }]]]),
		);
		expect(result.skipped[0]?.reason).to.equal("disabled");
	});

	it("skips a stream class — mediad plays files, not shell commands", () => {
		const result = plan(
			[aClass({ source: "stream", streamUri: "http://example.test/hold", fileCount: 0 })],
			new Map(),
		);
		expect(result.skipped[0]?.reason).to.equal("stream");
	});

	it("skips a class nobody has uploaded audio to yet", () => {
		const result = plan([aClass({ fileCount: 0 })], new Map());
		expect(result.skipped[0]?.reason).to.equal("no-files");
	});
});
