import { expect } from "chai";
import {
	CdrCursorError,
	decodeCdrCursor,
	encodeCdrCursor,
	nextCursorFrom,
} from "../../src/cdr/query/cdr-cursor";
import {
	cdrListQuerySchema,
	DEFAULT_RANGE_HOURS,
	MAX_RANGE_DAYS,
	rangeDays,
	recordingListQuerySchema,
	resolveTimeRange,
} from "../../src/cdr/query/cdr.dto";

const NOW = new Date("2026-08-05T12:00:00.000Z");

describe("cdr cursor", () => {
	it("round trips a position", () => {
		const cursor = {
			startedAt: new Date("2026-08-05T10:00:00.000Z"),
			id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c",
		};
		const decoded = decodeCdrCursor(encodeCdrCursor(cursor));

		expect(decoded.startedAt.toISOString()).to.equal(cursor.startedAt.toISOString());
		expect(decoded.id).to.equal(cursor.id);
	});

	it("refuses anything that is not one of ours", () => {
		for (const bad of ["", "not-base64!!", Buffer.from("nope").toString("base64url")]) {
			expect(() => decodeCdrCursor(bad), bad).to.throw(CdrCursorError);
		}
	});

	it("refuses a cursor whose id is not a uuid", () => {
		const forged = Buffer.from("2026-08-05T10:00:00.000Z|1 OR 1=1", "utf8").toString("base64url");

		expect(() => decodeCdrCursor(forged)).to.throw(CdrCursorError);
	});

	it("reports no next page when the sentinel row did not come back", () => {
		const rows = [{ id: "a", startedAt: NOW }];

		// Asked for 2, got 1 — a full last page and an empty next page are indistinguishable by
		// length alone, which is why the fetched count is what decides.
		expect(nextCursorFrom(rows, 1, 1)).to.equal(null);
	});

	it("reports a next page when the sentinel row did come back", () => {
		const rows = [{ id: "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c", startedAt: NOW }];

		expect(nextCursorFrom(rows, 1, 2)).to.be.a("string");
	});
});

describe("cdr time range", () => {
	it("defaults to the last 24 hours", () => {
		const range = resolveTimeRange({}, NOW);

		expect(range.to.toISOString()).to.equal(NOW.toISOString());
		expect(range.to.getTime() - range.from.getTime()).to.equal(DEFAULT_RANGE_HOURS * 3600_000);
	});

	it("anchors the default window on an explicit `to`", () => {
		const range = resolveTimeRange({ to: "2026-07-01T00:00:00.000Z" }, NOW);

		expect(range.to.toISOString()).to.equal("2026-07-01T00:00:00.000Z");
		expect(range.from.toISOString()).to.equal("2026-06-30T00:00:00.000Z");
	});

	it("normalizes an inverted range instead of rejecting it", () => {
		const range = resolveTimeRange(
			{ from: "2026-08-05T12:00:00.000Z", to: "2026-08-01T00:00:00.000Z" },
			NOW,
		);

		expect(range.from.toISOString()).to.equal("2026-08-01T00:00:00.000Z");
		expect(range.to.toISOString()).to.equal("2026-08-05T12:00:00.000Z");
	});

	it("measures a range in whole days so the ceiling is comparable", () => {
		const range = resolveTimeRange(
			{ from: "2026-05-01T00:00:00.000Z", to: "2026-08-05T00:00:00.000Z" },
			NOW,
		);

		expect(rangeDays(range)).to.be.greaterThan(MAX_RANGE_DAYS);
	});
});

describe("cdr list query", () => {
	it("applies the default limit and leaves the range open", () => {
		const parsed = cdrListQuerySchema.parse({});

		expect(parsed.limit).to.equal(25);
		expect(parsed.from).to.equal(undefined);
	});

	it("caps the limit at the API's own ceiling", () => {
		expect(() => cdrListQuerySchema.parse({ limit: "500" })).to.throw();
	});

	it("coerces query strings, because query strings are strings", () => {
		const parsed = cdrListQuerySchema.parse({ limit: "50", recorded: "true" });

		expect(parsed.limit).to.equal(50);
		expect(parsed.recorded).to.equal(true);
	});

	it("refuses a value the column's check constraint would refuse", () => {
		expect(() => cdrListQuerySchema.parse({ disposition: "maybe" })).to.throw();
		expect(() => cdrListQuerySchema.parse({ direction: "sideways" })).to.throw();
	});

	it("treats a whitespace-only search as no search at all", () => {
		expect(cdrListQuerySchema.parse({ search: "   " }).search).to.equal(undefined);
	});

	it("refuses a dial filter that is not dialable", () => {
		expect(() => cdrListQuerySchema.parse({ extension: "1001; drop table" })).to.throw();
	});
});

describe("recording list query", () => {
	it("hides purged rows by default", () => {
		expect(recordingListQuerySchema.parse({}).includeDeleted).to.equal(false);
	});

	it("accepts the recording kinds cdr-db defines and nothing else", () => {
		expect(recordingListQuerySchema.parse({ kind: "voicemail" }).kind).to.equal("voicemail");
		expect(() => recordingListQuerySchema.parse({ kind: "screen" })).to.throw();
	});
});
