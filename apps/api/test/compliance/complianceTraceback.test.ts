import { expect } from "chai";
import { buildRightToUse } from "../../src/compliance/attestation/attestation-policy.service";
import { summariseAttestation } from "../../src/compliance/attestation/attestation-summary";
import { tracebackCsv, TRACEBACK_CSV_COLUMNS } from "../../src/compliance/traceback/traceback-csv";
import {
	TRACEBACK_MAX_RANGE_DAYS,
	tracebackQuerySchema,
	validateTraceback,
} from "../../src/compliance/traceback/traceback.dto";
import { parseDto } from "../../src/pbx/shared/dto";
import type { TracebackEntry } from "../../src/compliance/traceback/traceback.service";

/**
 * The traceback's two refusals, the CSV's escaping, and the two aggregations beside them.
 *
 * Every assertion here is about a pure function, in the style of `orgSettings.test.ts`, because that
 * is where the decisions are: what this endpoint will not run, what a spreadsheet does with a field
 * that came off a network we do not run, and which right-to-use wins when a number is both owned and
 * verified. The query itself is one indexed `select` and is covered by the live verify slice.
 */

const FROM = "2026-03-01T00:00:00.000Z";

describe("the traceback query contract", () => {
	it("refuses a window with neither number in it", () => {
		const query = parseDto(tracebackQuerySchema, { from: FROM, to: "2026-03-02T00:00:00.000Z" });
		let refused = false;
		try {
			validateTraceback(query);
		} catch (error) {
			refused = true;
			const body = (error as { getResponse: () => { code: string } }).getResponse();
			expect(body.code).to.equal("COMPLIANCE_TRACEBACK_UNBOUNDED");
		}
		// A window alone is "every call on this platform that day", which is not a traceback.
		expect(refused, "an unbounded traceback must be refused").to.equal(true);
	});

	it("refuses a window wider than a month, because the predicate has no tenant in it", () => {
		const query = parseDto(tracebackQuerySchema, {
			from: FROM,
			to: "2026-09-01T00:00:00.000Z",
			calledNumber: "+12125550100",
		});
		let refused = false;
		try {
			validateTraceback(query);
		} catch (error) {
			refused = true;
			const body = (
				error as { getResponse: () => { code: string; maxDays: number } }
			).getResponse();
			expect(body.code).to.equal("COMPLIANCE_RANGE_TOO_WIDE");
			expect(body.maxDays).to.equal(TRACEBACK_MAX_RANGE_DAYS);
		}
		expect(refused).to.equal(true);
	});

	it("accepts a bounded question, and normalises an inverted range rather than refusing it", () => {
		const query = parseDto(tracebackQuerySchema, {
			from: "2026-03-10T00:00:00.000Z",
			to: FROM,
			callingNumber: "+12125550100",
		});
		const range = validateTraceback(query);
		expect(range.from.toISOString()).to.equal(FROM);
		expect(range.to.toISOString()).to.equal("2026-03-10T00:00:00.000Z");
	});

	it("requires both bounds — a traceback names an instant somebody else gave us", () => {
		expect(tracebackQuerySchema.safeParse({ calledNumber: "+12125550100" }).success).to.equal(
			false,
		);
		expect(tracebackQuerySchema.safeParse({ from: FROM, calledNumber: "+1" }).success).to.equal(
			false,
		);
	});
});

describe("the traceback CSV", () => {
	function entry(overrides: Partial<TracebackEntry>): TracebackEntry {
		return {
			organizationId: "11111111-1111-4111-8111-111111111111",
			organizationName: "Acme",
			kycDecision: "approved",
			callId: "call-1",
			startedAt: new Date(FROM),
			direction: "outbound",
			fromNumber: "+12125550100",
			toNumber: "+441632960000",
			sipCallId: "abc@example",
			trunkRef: null,
			signalingAddress: "203.0.113.10",
			sipAttestation: "A",
			sipVerstat: "TN-Validation-Passed",
			sipOrigId: "orig-1",
			expectedAttestation: "A",
			callerIdRightToUse: "owned",
			disposition: "answered",
			durationMs: 42_000,
			...overrides,
		} as TracebackEntry;
	}

	it("defuses a formula-leading field so a spreadsheet renders it as text", () => {
		const csv = tracebackCsv([entry({ organizationName: "=cmd|'/c calc'!A1" })]);
		// The apostrophe is what every spreadsheet reads as "this is text", and it survives the round
		// trip visibly rather than silently.
		expect(csv).to.contain(`"'=cmd|'/c calc'!A1"`);
	});

	it("leaves an E.164 number alone, so the most-read column stays parseable", () => {
		const csv = tracebackCsv([entry({})]);
		expect(csv).to.contain('"+12125550100"');
		expect(csv).to.not.contain(`"'+12125550100"`);
	});

	it("doubles an embedded quote rather than breaking the row", () => {
		const csv = tracebackCsv([entry({ organizationName: 'Acme "Voice" Ltd' })]);
		expect(csv).to.contain('"Acme ""Voice"" Ltd"');
	});

	it("starts with a byte-order mark and the declared header, in order", () => {
		const csv = tracebackCsv([]);
		expect(csv.charCodeAt(0)).to.equal(0xfe_ff);
		const header = csv.slice(1).split("\r\n")[0];
		expect(header).to.equal(TRACEBACK_CSV_COLUMNS.map((column) => `"${column}"`).join(","));
	});
});

describe("the attestation right-to-use table", () => {
	it("maps owned numbers to owned and verified ones to verified", () => {
		const table = buildRightToUse([{ e164: "+12125550100" }], [{ e164: "+12125550199" }]);
		expect(table["+12125550100"]).to.equal("owned");
		expect(table["+12125550199"]).to.equal("verified");
	});

	it("lets owned win a collision — a DID that was also filed as a verified caller id", () => {
		const table = buildRightToUse([{ e164: "+12125550100" }], [{ e164: "+12125550100" }]);
		expect(table["+12125550100"]).to.equal("owned");
	});

	it("normalises both sides to the attestation key, so punctuation cannot hide a match", () => {
		const table = buildRightToUse([], [{ e164: "+1 (212) 555-0199" }]);
		expect(table["+12125550199"]).to.equal("verified");
	});
});

describe("the attestation summary", () => {
	it("aggregates by presented number, keeping unknown apart from C", () => {
		const rows = summariseAttestation([
			{
				fromNumber: "+12125550100",
				expectedAttestation: "A",
				callerIdRightToUse: "owned",
				calls: 10,
			},
			{ fromNumber: "+12125550100", expectedAttestation: "C", callerIdRightToUse: null, calls: 2 },
			{ fromNumber: "+12125550199", expectedAttestation: null, callerIdRightToUse: null, calls: 5 },
		]);

		// Ordered by call count descending, so the most-presented number reads first.
		expect(rows.map((row) => row.fromNumber)).to.deep.equal(["+12125550100", "+12125550199"]);
		expect(rows[0]?.calls).to.equal(12);
		expect(rows[0]?.attestation).to.deep.equal({ A: 10, B: 0, C: 2, unknown: 0 });
		expect(rows[0]?.rightToUse).to.deep.equal({ owned: 10 });
		// NULL is "nothing consulted the policy", not "we could not vouch for it".
		expect(rows[1]?.attestation).to.deep.equal({ A: 0, B: 0, C: 0, unknown: 5 });
		expect(rows[1]?.rightToUse).to.deep.equal({});
	});
});
