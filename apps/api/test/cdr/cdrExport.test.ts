import { BadRequestException } from "@nestjs/common";
import { expect } from "chai";
import {
	CDR_EXPORT_COLUMNS,
	csvField,
	csvFileName,
	csvHeader,
	csvRow,
	CSV_BYTE_ORDER_MARK,
} from "../../src/cdr/exports/cdr-export-csv";
import { CdrExportWorker } from "../../src/cdr/exports/cdr-export-worker.service";
import {
	CDR_EXPORT_MAX_PENDING,
	CDR_EXPORT_MAX_RANGE_DAYS,
	cdrExportListQuerySchema,
	createCdrExportDto,
} from "../../src/cdr/exports/cdr-exports.dto";
import {
	exportMediaPath,
	exportObjectKey,
	mintExportToken,
	verifyExportToken,
} from "../../src/cdr/exports/export-token";
import { MAX_CDR_LIMIT } from "../../src/cdr/query/cdr.dto";
import { mintRecordingToken } from "../../src/cdr/recordings/recording-token";
import { parseDto } from "../../src/pbx/shared/dto";
import type { CallLegListRow } from "../../src/cdr/query/cdr.repository";
import type { CdrEnv } from "../../src/cdr/shared/cdr-env";
import type { ObjectStore } from "../../src/storage";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";

/**
 * The asynchronous CDR export.
 *
 * Three layers, matching the shape the area already tests in: the CSV rendering as a pure
 * function, the token as a pure function, and the worker driven directly against fakes. Nothing
 * here needs a database, an object store or a timer — the worker's `tick()` is public precisely so
 * a harness can drive one pass rather than waiting one out.
 *
 * The bias of these cases: an export must never produce a file that LOOKS right and is not.
 * Truncation, a formula in a cell, a token that opens the wrong artefact and a job silently marked
 * done are the four ways that happens, and there is a case for each.
 */

const ORG = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const JOB = "0199c0de-1111-7222-8333-444455556666";
const SECRET = "a-secret-that-is-at-least-32-characters-long";

describe("CDR export CSV", () => {
	it("quotes every field, including ones that would not need it", () => {
		// Uniform quoting is the rule. `+12125550100` unquoted is a number, a date or scientific
		// notation depending on the spreadsheet — which is the bug this removes wholesale.
		expect(csvField("+12125550100")).to.equal('"+12125550100"');
		expect(csvField(42)).to.equal('"42"');
		expect(csvField(null)).to.equal('""');
		expect(csvField(undefined)).to.equal('""');
	});

	it("doubles an embedded quote, which is the whole of RFC 4180's escape", () => {
		expect(csvField('Ann "The Closer" Lee')).to.equal('"Ann ""The Closer"" Lee"');
	});

	it("keeps a comma or a newline inside one field", () => {
		expect(csvField("Lee, Ann")).to.equal('"Lee, Ann"');
		expect(csvField("one\r\ntwo")).to.equal('"one\r\ntwo"');
	});

	/**
	 * The one that is a security case rather than a formatting one.
	 *
	 * A caller's display name arrives in the SIP `From` header from a network we do not run, so a
	 * stranger chooses it. `=cmd|'/c calc'!A1` in a cell is executed by Excel and Google Sheets on
	 * open, quoted or not — quoting is a CSV concern and this is a spreadsheet one.
	 */
	it("defuses a value a spreadsheet would execute as a formula", () => {
		expect(csvField("=1+1")).to.equal(`"'=1+1"`);
		expect(csvField("+SUM(A1:A9)")).to.equal(`"'+SUM(A1:A9)"`);
		expect(csvField("-2+3")).to.equal(`"'-2+3"`);
		// The carve-out: a sign followed only by digits is every E.164 number in the file, and it
		// cannot be a formula. Defusing those would put an apostrophe in the most-read column.
		expect(csvField("+12125550100")).to.equal('"+12125550100"');
		expect(csvField("-42")).to.equal('"-42"');
		expect(csvField("@import")).to.equal(`"'@import"`);
		// A leading tab or CR is the classic bypass: the spreadsheet skips it and reads the `=`.
		expect(csvField("\t=1+1")).to.equal(`"'\t=1+1"`);
	});

	it("leaves an ordinary value alone apart from the quotes", () => {
		expect(csvField("Reception")).to.equal('"Reception"');
	});

	it("renders an ISO instant for a Date so the column sorts as text", () => {
		expect(csvField(new Date("2026-08-12T09:30:00.000Z"))).to.equal('"2026-08-12T09:30:00.000Z"');
	});

	it("writes the header in the declared column order", () => {
		const header = csvHeader();
		expect(header.endsWith("\r\n")).to.equal(true);
		expect(header.trimEnd().split(",")).to.deep.equal(
			CDR_EXPORT_COLUMNS.map((column) => `"${column}"`),
		);
	});

	it("renders a leg with one cell per declared column", () => {
		const row = csvRow(leg());
		expect(row.trimEnd().split(",")).to.have.length(CDR_EXPORT_COLUMNS.length);
	});

	it("reports durations in seconds and rounds rather than truncating", () => {
		const cells = csvRow(leg({ durationMs: 1_999, billsecMs: 1_400 }))
			.trimEnd()
			.split(",");
		const duration = CDR_EXPORT_COLUMNS.indexOf("durationSeconds");
		const billable = CDR_EXPORT_COLUMNS.indexOf("billableSeconds");
		expect(cells[duration]).to.equal('"2"');
		expect(cells[billable]).to.equal('"1"');
	});

	/**
	 * The object key is an internal path. Publishing it in a file that leaves the building tells a
	 * reader where the audio lives and gives them no way to reach it, which is the worst trade
	 * available — so the column is a boolean.
	 */
	it("reports whether a leg was recorded, never where the audio is", () => {
		const recorded = CDR_EXPORT_COLUMNS.indexOf("recorded");
		expect(
			csvRow(leg({ recordingKey: `${ORG}/c/r.wav` }))
				.trimEnd()
				.split(",")[recorded],
		).to.equal('"true"');
		expect(csvRow(leg()).trimEnd().split(",")[recorded]).to.equal('"false"');
		expect(csvRow(leg()).includes(`${ORG}/c/r.wav`)).to.equal(false);
	});

	it("names the file by its window rather than by the job id", () => {
		const name = csvFileName({
			from: new Date("2026-01-01T00:00:00.000Z"),
			to: new Date("2026-03-31T23:59:59.000Z"),
		});
		expect(name).to.equal("cdr-2026-01-01-2026-03-31.csv");
		expect(name.includes(JOB)).to.equal(false);
	});
});

describe("CDR export DTO", () => {
	it("accepts the reporting screen's filters unchanged", () => {
		const parsed = parseDto(createCdrExportDto, {
			from: "2026-01-01T00:00:00.000Z",
			to: "2026-02-01T00:00:00.000Z",
			direction: "inbound",
			disposition: "answered",
			extension: "1001",
			search: "  Ann  ",
			label: "  January inbound  ",
		});
		expect(parsed.direction).to.equal("inbound");
		expect(parsed.extension).to.equal("1001");
		// `search` trims through the shared transform, so "cleared the box" is not "match ''".
		expect(parsed.search).to.equal("Ann");
		expect(parsed.label).to.equal("January inbound");
	});

	/**
	 * `limit` and `cursor` describe a PAGE. An export is not paged, and accepting `limit: 25` would
	 * be accepting a plausible request whose only possible answer is the wrong one.
	 */
	it("refuses the paging fields the list DTO carries", () => {
		for (const body of [{ limit: 25 }, { cursor: "abc" }]) {
			expect(() => parseDto(createCdrExportDto, body), JSON.stringify(body)).to.throw(
				BadRequestException,
			);
		}
	});

	it("refuses an unknown filter rather than dropping it", () => {
		expect(() => parseDto(createCdrExportDto, { directoin: "inbound" })).to.throw(
			BadRequestException,
		);
	});

	it("allows a window wider than the synchronous list's ceiling", () => {
		// 92 days is the list's cap; the export's is a year. This asymmetry IS the feature.
		expect(CDR_EXPORT_MAX_RANGE_DAYS).to.be.greaterThan(92);
		expect(CDR_EXPORT_MAX_PENDING).to.be.greaterThan(0);
	});

	it("defaults the export listing to a bounded page", () => {
		const parsed = parseDto(cdrExportListQuerySchema, {});
		expect(parsed.limit).to.equal(25);
		expect(parsed.cursor).to.equal(undefined);
	});
});

describe("CDR export token", () => {
	it("round-trips a payload it signed", () => {
		const expiry = Math.floor(Date.now() / 1000) + 300;
		const result = verifyExportToken(mintExportToken({ x: JOB, o: ORG, e: expiry }, SECRET), {
			current: SECRET,
		});
		expect(result.ok).to.equal(true);
		expect(result.payload?.x).to.equal(JOB);
		expect(result.payload?.o).to.equal(ORG);
	});

	it("refuses a token signed with another key", () => {
		const expiry = Math.floor(Date.now() / 1000) + 300;
		const token = mintExportToken(
			{ x: JOB, o: ORG, e: expiry },
			"another-secret-of-32-characters!!",
		);
		expect(verifyExportToken(token, { current: SECRET }).failure).to.equal("bad-signature");
	});

	it("still accepts a token minted under the previous key during a rotation", () => {
		const previous = "the-previous-secret-of-32-characters!";
		const expiry = Math.floor(Date.now() / 1000) + 300;
		const token = mintExportToken({ x: JOB, o: ORG, e: expiry }, previous);
		expect(verifyExportToken(token, { current: SECRET, previous }).ok).to.equal(true);
	});

	it("refuses an expired token", () => {
		const expiry = Math.floor(Date.now() / 1000) - 1;
		const token = mintExportToken({ x: JOB, o: ORG, e: expiry }, SECRET);
		expect(verifyExportToken(token, { current: SECRET }).failure).to.equal("expired");
	});

	/**
	 * The property the two token modules exist separately to guarantee.
	 *
	 * Both are signed with the same secret, so the signature alone cannot tell them apart. The
	 * payload SHAPE does: a recording token carries `r` and an export token carries `x`, and
	 * neither verifier accepts the other's field. Without this a `recordings.download` grant would
	 * reach the whole call ledger as a CSV.
	 */
	it("refuses a recording token even though the secret verifies", () => {
		const expiry = Math.floor(Date.now() / 1000) + 300;
		const recordingToken = mintRecordingToken({ r: JOB, o: ORG, e: expiry }, SECRET);
		const result = verifyExportToken(recordingToken, { current: SECRET });
		expect(result.ok).to.equal(false);
		expect(result.failure).to.equal("malformed");
	});

	it("refuses an oversized token before doing any HMAC work", () => {
		expect(verifyExportToken("x".repeat(4_096), { current: SECRET }).failure).to.equal("malformed");
		expect(verifyExportToken("", { current: SECRET }).failure).to.equal("malformed");
	});

	it("derives a tenant-prefixed object key from ids the client never supplied", () => {
		expect(exportObjectKey(ORG, JOB)).to.equal(`exports/${ORG}/${JOB}.csv`);
	});

	it("carries the token as a query parameter, not a path segment", () => {
		const path = exportMediaPath("a.b");
		expect(path.startsWith("/api/v1/cdr/exports/media?token=")).to.equal(true);
	});
});

describe("CDR export worker", () => {
	it("arms no timer when the poll is disabled or the writers are off", () => {
		const armed = (overrides: Partial<CdrEnv>): boolean => {
			const worker = new CdrExportWorker(env(overrides), fakeDatabase().database, fakeStore());
			worker.onModuleInit();
			const running = (worker as unknown as { timer: unknown }).timer !== undefined;
			worker.onApplicationShutdown();
			return running;
		};

		expect(armed({ CDR_EXPORT_POLL_INTERVAL_MS: 0 })).to.equal(false);
		expect(armed({ CDR_WRITER_ENABLED: false })).to.equal(false);
		expect(armed({})).to.equal(true);
	});

	it("does nothing when there is no claimable job", async () => {
		const { database } = fakeDatabase();
		const store = fakeStore();
		const worker = new CdrExportWorker(env(), database, store);

		const result = await worker.tick();

		expect(result.exported).to.equal(0);
		expect(store.puts).to.have.length(0);
	});

	/**
	 * The paging walk, driven through the real `listCallLegs`.
	 *
	 * The first page comes back with one row more than the page size, which is precisely how
	 * `nextCursorFrom` decides there is another page — asking for `limit + 1` and getting it. So the
	 * first scripted page is `FULL_PAGE` rows and the second is short, and the walk has to make two
	 * round trips and concatenate them.
	 */
	it("walks every page and stores one object with a header and a row per leg", async () => {
		const first = Array.from({ length: FULL_PAGE }, (_unused, index) => leg({ id: legId(index) }));
		const { database, completed } = fakeDatabase({
			claim: claimable(),
			pages: [first, [leg({ id: legId(FULL_PAGE) })]],
		});
		const store = fakeStore();
		const worker = new CdrExportWorker(env(), database, store);

		const result = await worker.tick();

		expect(result.exported).to.equal(1);
		expect(store.puts).to.have.length(1);
		const body = store.puts[0]?.bytes.toString("utf8") ?? "";
		expect(body.startsWith(CSV_BYTE_ORDER_MARK)).to.equal(true);
		// The header plus one row per leg. The first page yields PAGE_SIZE rows (the sentinel is
		// sliced off by `listCallLegs`), the second yields one.
		expect(body.trimEnd().split("\r\n")).to.have.length(PAGE_SIZE + 2);
		expect(store.puts[0]?.objectKey).to.equal(exportObjectKey(ORG, JOB));
		expect(completed).to.deep.equal([{ id: JOB, rowCount: PAGE_SIZE + 1 }]);
	});

	/**
	 * The case the row cap exists for.
	 *
	 * A truncated CSV is a plausible-looking file with no marker saying where it stopped, and
	 * somebody will total a column in it. So the job fails, no object is written, and the detail
	 * says what to do about it.
	 */
	it("fails the job rather than truncating when the row cap is passed", async () => {
		const first = Array.from({ length: FULL_PAGE }, (_unused, index) => leg({ id: legId(index) }));
		const { database, failures } = fakeDatabase({ claim: claimable(), pages: [first, first] });
		const store = fakeStore();
		const worker = new CdrExportWorker(env({ CDR_EXPORT_MAX_ROWS: PAGE_SIZE }), database, store);

		const result = await worker.tick();

		expect(result.exported).to.equal(0);
		expect(store.puts, "no partial file may be stored").to.have.length(0);
		expect(failures).to.have.length(1);
		expect(failures[0]?.reason).to.equal("too-many-rows");
		expect(failures[0]?.detail).to.match(/narrow the date range/iu);
	});

	/**
	 * The lease hands a job back after a crash; `attempts` is what turns "again" into "eventually,
	 * no". Without this bound one poisonous job is the only thing this worker ever does.
	 */
	it("abandons a job the lease has handed back too many times", async () => {
		const { database, failures } = fakeDatabase({ claim: claimable({ attempts: 9 }) });
		const worker = new CdrExportWorker(env(), database, fakeStore());

		await worker.tick();

		expect(failures[0]?.reason).to.equal("internal");
		expect(failures[0]?.detail).to.match(/abandoned/iu);
	});

	it("fails a job whose stored filters no longer parse instead of querying with them", async () => {
		const { database, failures, pageCalls } = fakeDatabase({
			claim: claimable({ filters: { direction: "sideways" } }),
			pages: [[leg()]],
		});
		const worker = new CdrExportWorker(env(), database, fakeStore());

		await worker.tick();

		expect(pageCalls.count, "the ledger must not be queried with an invalid filter").to.equal(0);
		expect(failures[0]?.reason).to.equal("internal");
	});

	it("refuses to run two passes at once and does nothing after shutdown", async () => {
		const { database } = fakeDatabase({ claim: claimable(), pages: [[leg()]] });
		const worker = new CdrExportWorker(env(), database, fakeStore());

		const first = worker.tick();
		const second = await worker.tick();
		await first;
		expect(second.exported).to.equal(0);

		worker.onApplicationShutdown();
		expect((await worker.tick()).exported).to.equal(0);
	});

	it("survives a pass that throws so the interval keeps running", async () => {
		const database = {
			adminDb: {
				execute: async () => {
					await Promise.resolve();
					throw new Error("the pool is gone");
				},
			},
			withTenantScope: async () => await Promise.resolve(undefined),
		} as unknown as CdrDatabaseClient;
		const worker = new CdrExportWorker(env(), database, fakeStore());

		const result = await worker.tick();

		expect(result.exported).to.equal(0);
	});

	/**
	 * Objects first, row second — inverted in consequence from the recording sweep. A row cleared
	 * before its object leaves a CSV of somebody's call history that nothing points at, which means
	 * nothing will ever find it again: the expiry sweep finds files THROUGH their rows.
	 */
	it("deletes an expired export's object before it forgets the key", async () => {
		const { database, statements } = fakeDatabase({
			expired: [{ id: JOB, object_key: exportObjectKey(ORG, JOB) }],
		});
		const store = fakeStore();
		const worker = new CdrExportWorker(env(), database, store);

		const result = await worker.tick();

		expect(store.deleted).to.deep.equal([exportObjectKey(ORG, JOB)]);
		expect(result.expired).to.equal(1);
		// Claim, expiry select, expiry clear. The clear is last, which is the whole assertion.
		expect(statements.at(-1)).to.match(/set object_key = null/iu);
	});

	it("leaves the row pointing at a file the store refused to delete", async () => {
		const key = exportObjectKey(ORG, JOB);
		const { database } = fakeDatabase({ expired: [{ id: JOB, object_key: key }] });
		const store = fakeStore([key]);
		const worker = new CdrExportWorker(env(), database, store);

		const result = await worker.tick();

		expect(store.deleted).to.have.length(0);
		expect(result.expired).to.equal(0);
	});
});

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

function env(overrides: Partial<CdrEnv> = {}): CdrEnv {
	return {
		CDR_WRITER_ENABLED: true,
		CDR_EXPORT_POLL_INTERVAL_MS: 15_000,
		CDR_EXPORT_LEASE_MS: 600_000,
		CDR_EXPORT_MAX_ROWS: 100_000,
		CDR_EXPORT_TTL_HOURS: 168,
		...overrides,
	} as CdrEnv;
}

/** A distinct, well-formed uuid v7 per row — the keyset cursor refuses anything else. */
function legId(index: number): string {
	return `0199c0de-2222-7222-8333-${index.toString(16).padStart(12, "0")}`;
}

function leg(overrides: Partial<CallLegListRow> = {}): CallLegListRow {
	return {
		id: "0199c0de-2222-7222-8333-444455556666",
		callId: "0199c0de-3333-7222-8333-444455556666",
		leg: "a",
		originatingLegId: null,
		bridgeLegId: null,
		direction: "inbound",
		fromNumber: "+12125550100",
		fromName: "Ann Lee",
		toNumber: "1001",
		destinationType: "extension",
		destinationRef: null,
		startedAt: new Date("2026-08-12T09:30:00.000Z"),
		answeredAt: new Date("2026-08-12T09:30:04.000Z"),
		endedAt: new Date("2026-08-12T09:31:00.000Z"),
		durationMs: 60_000,
		billsecMs: 56_000,
		hangupCause: "normal-clearing",
		hangupCauseCode: 16,
		hangupSide: "callee",
		disposition: "answered",
		recordingKey: null,
		transcriptionStatus: "none",
		...overrides,
	} as unknown as CallLegListRow;
}

function claimable(
	overrides: Partial<{
		readonly attempts: number;
		readonly filters: Record<string, unknown>;
	}> = {},
): Record<string, unknown> {
	return {
		id: JOB,
		organization_id: ORG,
		filters: overrides.filters ?? {},
		range_from: "2026-08-01T00:00:00.000Z",
		range_to: "2026-08-12T00:00:00.000Z",
		attempts: overrides.attempts ?? 1,
	};
}

/** The page size the worker walks with, and one more than it — the "there is another page" signal. */
const PAGE_SIZE = MAX_CDR_LIMIT;
const FULL_PAGE = PAGE_SIZE + 1;

interface FakeDatabaseScript {
	readonly claim?: Record<string, unknown> | undefined;
	/** Raw row arrays, as the ledger query would return them. `FULL_PAGE` long means "more follows". */
	readonly pages?: readonly (readonly CallLegListRow[])[];
	readonly expired?: readonly Record<string, string>[];
}

/**
 * A database whose admin statements are answered from the script and whose tenant scope hands the
 * callback a drizzle-shaped transaction returning the next scripted page.
 *
 * The walk runs through the REAL `listCallLegs` — its predicates, its `limit + 1` and its slicing
 * are all exercised — because the property under test is that the worker pages correctly, and a
 * fake that returned pre-paged results would be testing the fake.
 *
 * Statements are recognised by their rendered SQL rather than by call order, so the fixed sequence
 * the worker happens to use today is not frozen into the harness.
 */
function fakeDatabase(script: FakeDatabaseScript = {}): {
	readonly database: CdrDatabaseClient;
	readonly statements: string[];
	readonly completed: { readonly id: string; readonly rowCount: number }[];
	readonly failures: { readonly reason: string; readonly detail: string }[];
	readonly pageCalls: { count: number };
} {
	const statements: string[] = [];
	const completed: { readonly id: string; readonly rowCount: number }[] = [];
	const failures: { readonly reason: string; readonly detail: string }[] = [];
	const pageCalls = { count: 0 };
	const pages = [...(script.pages ?? [])];

	/**
	 * The SQL text, taken from the literal chunks only.
	 *
	 * `JSON.stringify` over `queryChunks` is what `recordingRetentionSweeper.test.ts` does and it
	 * cannot be reused here: these statements interpolate the TABLE rather than only its columns,
	 * and a drizzle table holds a reference cycle through its columns. Reading the string parts is
	 * both cycle-free and closer to what the assertions mean — "does this say `skip locked`" is a
	 * question about the SQL, not about the AST.
	 */
	const render = (query: unknown): string => {
		const chunks = (query as { queryChunks?: readonly unknown[] }).queryChunks;
		if (!Array.isArray(chunks)) {
			return "";
		}
		return chunks
			.map((chunk) => {
				if (typeof chunk === "string") {
					return chunk;
				}
				const value = (chunk as { value?: unknown }).value;
				return Array.isArray(value) ? value.join("") : "";
			})
			.join(" ");
	};

	const adminExecute = async (query: unknown): Promise<unknown> => {
		const text = render(query);
		statements.push(text);
		await Promise.resolve();
		if (text.includes("skip locked")) {
			return script.claim === undefined ? [] : [script.claim];
		}
		if (text.includes("as object_key")) {
			return [...(script.expired ?? [])];
		}
		if (text.includes("set object_key = null")) {
			// `returning id` — the count is what the worker reports as `expired`.
			return (script.expired ?? []).map((row) => ({ id: row.id }));
		}
		return [];
	};

	const transaction: Record<string, unknown> = {};
	Object.assign(transaction, {
		select: () => transaction,
		from: () => transaction,
		where: () => transaction,
		orderBy: () => transaction,
		limit: () => {
			pageCalls.count += 1;
			return pages.shift() ?? [];
		},
		update: () => transaction,
		set: (values: Record<string, unknown>) => {
			if (values.status === "succeeded") {
				completed.push({ id: JOB, rowCount: Number(values.rowCount) });
			}
			if (values.status === "failed") {
				failures.push({
					reason: String(values.failureReason),
					detail: String(values.failureDetail),
				});
			}
			return transaction;
		},
	});

	const database = {
		adminDb: { execute: adminExecute },
		withTenantScope: async <T>(
			_organizationId: string,
			run: (handle: unknown) => Promise<T>,
		): Promise<T> => await run(transaction),
	} as unknown as CdrDatabaseClient;

	return { database, statements, completed, failures, pageCalls };
}

function fakeStore(refuse: readonly string[] = []): ObjectStore & {
	readonly deleted: string[];
	readonly puts: { readonly objectKey: string; readonly bytes: Buffer }[];
} {
	const deleted: string[] = [];
	const puts: { readonly objectKey: string; readonly bytes: Buffer }[] = [];
	return {
		driver: "local",
		deleted,
		puts,
		put: async (objectKey: string, bytes: Buffer) => {
			puts.push({ objectKey, bytes });
			await Promise.resolve();
		},
		delete: async (objectKey: string) => {
			if (refuse.includes(objectKey)) {
				throw new Error("the bucket is unreachable");
			}
			deleted.push(objectKey);
			await Promise.resolve();
		},
	} as unknown as ObjectStore & {
		readonly deleted: string[];
		readonly puts: { readonly objectKey: string; readonly bytes: Buffer }[];
	};
}
