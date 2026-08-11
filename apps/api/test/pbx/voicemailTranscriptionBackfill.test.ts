import { expect } from "chai";
import {
	buildBacklogClaim,
	type ClaimWindows,
	cutoffsFor,
	isClaimable,
} from "../../src/pbx/voicemail-boxes/voicemail-transcription-backfill";
import { VoicemailTranscriptionSweeper } from "../../src/pbx/voicemail-boxes/voicemail-transcription-sweeper.service";
import { loadTranscriptionEnv } from "../../src/transcription";
import type { VoicemailTranscriptionService } from "../../src/pbx/voicemail-boxes/voicemail-transcription.service";
import type { TranscriptionEnv } from "../../src/transcription";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The transcription BACK-FILL — the pass that runs when the in-memory queue did not.
 *
 * `voicemailTranscription.test.ts` covers the pipeline; this file covers the one question the
 * pipeline cannot answer about itself: what happens to a message the live worker never finished.
 * Three failures produce one, and all three are ordinary — a restart mid-transcription, a queue that
 * hit its ceiling, a provider that was down for an hour. Before the back-fill existed each of them
 * was permanent.
 *
 * What is asserted here is deliberately lopsided towards NOT taking a row. A back-fill that misses a
 * message costs a transcript, which is a convenience; one that takes a message somebody else is
 * already working on costs a second paid request to a speech-to-text endpoint for every message in
 * flight, on every sweep, forever. So the eligibility rule gets the arithmetic tests and the claim
 * gets the concurrency ones.
 *
 * The rule is expressed twice — as SQL for the database and as {@link isClaimable} for this file —
 * and that is stated in `voicemail-transcription-backfill.ts` rather than hidden. The alternative is
 * a rule exercised only against a live PostgreSQL, which is to say exercised in CI never.
 */

const ORGANIZATION_ID = "00000000-0000-7000-8000-0000000000a1";
const MAILBOX_ID = "00000000-0000-7000-8000-0000000000c3";

const NOW = new Date("2026-08-11T18:00:00.000Z");

const WINDOWS: ClaimWindows = {
	graceMs: 120_000,
	retryAfterMs: 3_600_000,
	claimTtlMs: 900_000,
	maxAttempts: 5,
	batch: 100,
};

const CUTOFFS = cutoffsFor(NOW, WINDOWS);

/** `NOW` minus a number of seconds, for rows whose age is the thing under test. */
function ago(seconds: number): Date {
	return new Date(NOW.getTime() - seconds * 1_000);
}

// ---------------------------------------------------------------------------------------------
// 1. Eligibility — which rows the back-fill is allowed to touch at all
// ---------------------------------------------------------------------------------------------

describe("the transcription back-fill's eligibility rule", () => {
	it("leaves a freshly filed pending row alone, because the live queue is holding it", () => {
		// The grace window is the only cross-process evidence that somebody is already on this. A
		// message is marked `pending` by the INSERT and enqueued milliseconds later by the process that
		// filed it, so anything this young is almost certainly in a worker right now.
		expect(isClaimable(row({ receivedAt: ago(30) }), CUTOFFS, WINDOWS.maxAttempts)).to.equal(false);
	});

	it("takes a pending row once it is older than the grace window", () => {
		expect(isClaimable(row({ receivedAt: ago(180) }), CUTOFFS, WINDOWS.maxAttempts)).to.equal(true);
	});

	it("leaves a pending row that another replica claimed recently", () => {
		// The claim column is the guard that crosses a process boundary; the grace window says nothing
		// about a second API container that picked this up forty seconds ago.
		expect(
			isClaimable(
				row({ receivedAt: ago(3_600), transcriptionClaimedAt: ago(40) }),
				CUTOFFS,
				WINDOWS.maxAttempts,
			),
		).to.equal(false);
	});

	it("takes a pending row whose claim has expired, because a crashed worker releases nothing", () => {
		expect(
			isClaimable(
				row({ receivedAt: ago(3_600), transcriptionClaimedAt: ago(1_800) }),
				CUTOFFS,
				WINDOWS.maxAttempts,
			),
		).to.equal(true);
	});

	it("makes a failed row wait the longer retry window, not the grace window", () => {
		// A provider has already refused this message three times with backoff. Retrying it at the
		// sweep interval would turn a five-minute outage into a permanent request storm.
		const row300 = row({
			transcriptionStatus: "failed",
			receivedAt: ago(3_000),
			transcriptionClaimedAt: ago(300),
		});
		expect(isClaimable(row300, CUTOFFS, WINDOWS.maxAttempts)).to.equal(false);

		const row7200 = row({
			transcriptionStatus: "failed",
			receivedAt: ago(9_000),
			transcriptionClaimedAt: ago(7_200),
		});
		expect(isClaimable(row7200, CUTOFFS, WINDOWS.maxAttempts)).to.equal(true);
	});

	it("dates a failed row that predates the claim column from when it was received", () => {
		// Rows the pipeline failed before there was a column to record the attempt in. Falling back to
		// `received_at` is what lets an operator who fixes an endpoint retry the whole historic cohort.
		expect(
			isClaimable(
				row({
					transcriptionStatus: "failed",
					receivedAt: ago(86_400),
					transcriptionClaimedAt: null,
				}),
				CUTOFFS,
				WINDOWS.maxAttempts,
			),
		).to.equal(true);
	});

	it("makes failed TERMINAL at the attempt ceiling, in both statuses", () => {
		// The ceiling is the only thing standing between the back-fill and an infinite retry loop
		// wearing a schedule. A message whose audio a provider will never accept has to stop costing
		// requests, and `failed` is where it stops — visible, in the same column a UI already reads.
		const spent = { transcriptionAttempts: WINDOWS.maxAttempts, receivedAt: ago(86_400) };
		expect(
			isClaimable(row({ ...spent, transcriptionStatus: "failed" }), CUTOFFS, WINDOWS.maxAttempts),
		).to.equal(false);
		expect(
			isClaimable(row({ ...spent, transcriptionStatus: "pending" }), CUTOFFS, WINDOWS.maxAttempts),
		).to.equal(false);
		// One under the ceiling still gets its last attempt.
		expect(
			isClaimable(
				row({ ...spent, transcriptionAttempts: WINDOWS.maxAttempts - 1 }),
				CUTOFFS,
				WINDOWS.maxAttempts,
			),
		).to.equal(true);
	});

	it("never touches `done` or `disabled`, whatever their age", () => {
		// `disabled` is the state of a message nobody is coming for, and reclaiming it would be the
		// back-fill inventing work for every mailbox that never asked for transcription.
		for (const status of ["done", "disabled", "something-new"]) {
			expect(
				isClaimable(
					row({ transcriptionStatus: status, receivedAt: ago(86_400) }),
					CUTOFFS,
					WINDOWS.maxAttempts,
				),
				status,
			).to.equal(false);
		}
	});
});

// ---------------------------------------------------------------------------------------------
// 2. The claim statement — the half of the concurrency story that lives in the database
// ---------------------------------------------------------------------------------------------

/**
 * Asserted on the statement's own chunks rather than on a rendered string.
 *
 * Rendering needs a dialect, and a dialect imported here resolves to a DIFFERENT copy of
 * `drizzle-orm` than the one `@optimiq-voice/pbx-db` builds the fragment with — two structurally
 * identical `SQL` types the compiler will not unify. `schema.spec.ts` reads index predicates the same
 * way for the same reason, so this is the repo's existing answer rather than a new one.
 */
describe("the transcription back-fill's claim statement", () => {
	const text = chunksOf(buildBacklogClaim(NOW, WINDOWS));

	it("locks the batch with SKIP LOCKED so two replicas do not queue behind each other", () => {
		expect(text).to.contain("for update skip locked");
	});

	it("re-states the eligibility predicate in the outer WHERE, which is the compare-and-set", () => {
		// The lock is liveness; THIS is correctness. Under READ COMMITTED the loser's predicate is
		// re-evaluated against the winner's committed row, so it matches nothing and claims nothing.
		// A claim that only filtered in its sub-select would let both replicas take the same row.
		// `coalesce(` appears exactly once per rendering of the predicate, so twice is the sub-select's
		// copy plus the outer one.
		expect(text.split("coalesce(").length - 1).to.equal(2);
	});

	it("flips a reclaimed row back to pending so the unchanged worker path accepts it", () => {
		// `transcribeNow` refuses anything that is not `pending`. Teaching it a second entry state
		// would put "may this be transcribed" in two places.
		expect(text).to.contain("set transcription_status = 'pending'");
	});

	it("spends an attempt at CLAIM time, not at completion", () => {
		// Otherwise a message that kills the worker is claimed forever: it never completes, so it never
		// counts, so the ceiling never bites.
		expect(text).to.contain("transcription_attempts = claimed.transcription_attempts + 1");
	});

	it("binds the three cutoffs the windows describe, and not `now` itself", () => {
		// A predicate that compared against `now()` in the database would be reading a clock this
		// process cannot see, which is how a sweep and its own logs end up disagreeing about what was
		// eligible.
		expect(text).to.contain(CUTOFFS.grace.toISOString().toLowerCase());
		expect(text).to.contain(CUTOFFS.claim.toISOString().toLowerCase());
		expect(text).to.contain(CUTOFFS.retry.toISOString().toLowerCase());
	});

	it("excludes the ids this process is already holding, by id", () => {
		const withHeld = chunksOf(buildBacklogClaim(NOW, WINDOWS, ["held-1", "held-2"]));
		expect(withHeld).to.contain("id not in");
		expect(withHeld).to.contain("held-1");
		expect(withHeld).to.contain("held-2");
	});

	it("asks for no exclusion at all when it is holding nothing", () => {
		expect(text).to.not.contain("id not in");
	});
});

// ---------------------------------------------------------------------------------------------
// 3. The sweeper — scheduling, and what it does with what it claimed
// ---------------------------------------------------------------------------------------------

describe("the voicemail transcription sweeper", () => {
	it("feeds every claimed message through the SAME worker entry point", async () => {
		// Not a second transcription implementation. The retry policy, the tenant-scoped key read and
		// the status writes are the pipeline's, and a back-fill that reimplemented any of them would be
		// a second place for "this may never cost a message" to be got wrong.
		const table = fakeTable([
			backlogRow({ id: "m-1", receivedAt: ago(600) }),
			backlogRow({ id: "m-2", receivedAt: ago(600) }),
		]);
		const { sweeper, enqueued } = harness(table);

		const result = await sweeper.sweep();

		expect(result.claimed).to.equal(2);
		expect(enqueued.map((job) => job.messageId)).to.deep.equal(["m-1", "m-2"]);
		expect(enqueued[0]?.organizationId).to.equal(ORGANIZATION_ID);
		expect(enqueued[0]?.mailboxId).to.equal(MAILBOX_ID);
	});

	it("claims only the eligible rows and leaves the rest exactly as they were", async () => {
		const table = fakeTable([
			backlogRow({ id: "fresh", receivedAt: ago(30) }),
			backlogRow({ id: "held-by-another", receivedAt: ago(600), transcriptionClaimedAt: ago(60) }),
			backlogRow({ id: "spent", receivedAt: ago(86_400), transcriptionAttempts: 5 }),
			backlogRow({ id: "done", receivedAt: ago(86_400), transcriptionStatus: "done" }),
			backlogRow({ id: "due", receivedAt: ago(600) }),
		]);
		const { sweeper, enqueued } = harness(table);

		await sweeper.sweep();

		expect(enqueued.map((job) => job.messageId)).to.deep.equal(["due"]);
		expect(table.rows.find((entry) => entry.id === "fresh")?.transcriptionAttempts).to.equal(0);
		expect(table.rows.find((entry) => entry.id === "spent")?.transcriptionClaimedAt).to.equal(null);
	});

	it("skips the rows its OWN queue is holding, which the age window cannot see", async () => {
		// The in-process guard. A message that has been in the worker for longer than the grace window
		// — a slow provider — is older than the window and would otherwise be reclaimed underneath the
		// worker that is mid-request on it.
		const table = fakeTable([
			backlogRow({ id: "in-flight", receivedAt: ago(600) }),
			backlogRow({ id: "abandoned", receivedAt: ago(600) }),
		]);
		const { sweeper, enqueued } = harness(table, { held: ["in-flight"] });

		await sweeper.sweep();

		expect(enqueued.map((job) => job.messageId)).to.deep.equal(["abandoned"]);
	});

	it("keeps `failed` terminal once the ceiling is spent, sweep after sweep", async () => {
		const table = fakeTable([
			backlogRow({
				id: "hopeless",
				transcriptionStatus: "failed",
				receivedAt: ago(86_400),
				transcriptionClaimedAt: ago(86_400),
				transcriptionAttempts: 4,
			}),
		]);
		const { sweeper, enqueued } = harness(table);

		// The last attempt is taken, and reported as the last one.
		const first = await sweeper.sweep();
		expect(first.claimed).to.equal(1);
		expect(first.terminal).to.equal(1);

		// The worker fails it again, an hour passes, and nothing picks it up ever again.
		table.rows[0] = {
			...(table.rows[0] as BacklogRow),
			transcriptionStatus: "failed",
			transcriptionClaimedAt: ago(86_400),
		};
		const second = await sweeper.sweep();

		expect(second.claimed).to.equal(0);
		expect(enqueued).to.have.length(1);
	});

	it("does nothing at all when no provider is configured", async () => {
		// Nothing marks a row `pending` without a provider, so a sweep here could only take rows a
		// deployment left behind when it turned the feature OFF — and turning it back on is what
		// should pick those up, not a back-fill quietly re-running them.
		const table = fakeTable([backlogRow({ id: "left-over", receivedAt: ago(86_400) })]);
		const { sweeper, enqueued } = harness(table, { enabled: false });

		const result = await sweeper.sweep();

		expect(result).to.deep.equal({ claimed: 0, terminal: 0 });
		expect(table.claims).to.equal(0);
		expect(enqueued).to.deep.equal([]);
	});

	it("refuses to run twice at once rather than queueing a second pass", async () => {
		const table = fakeTable([backlogRow({ id: "m-1", receivedAt: ago(600) })]);
		const { sweeper } = harness(table, { blockClaims: true });

		const first = sweeper.sweep();
		const second = await sweeper.sweep();
		table.release();
		await first;

		expect(second).to.deep.equal({ claimed: 0, terminal: 0 });
		expect(table.claims).to.equal(1);
	});

	it("survives a claim that throws, because the rows are still pending next time", async () => {
		const table = fakeTable([]);
		table.fail = new Error("the pool is gone");
		const { sweeper } = harness(table);

		const result = await sweeper.sweep();

		expect(result).to.deep.equal({ claimed: 0, terminal: 0 });
		expect(sweeper.stats.failed).to.equal(1);
	});

	it("stops sweeping after shutdown", async () => {
		const table = fakeTable([backlogRow({ id: "m-1", receivedAt: ago(600) })]);
		const { sweeper } = harness(table);

		sweeper.onApplicationShutdown();
		const result = await sweeper.sweep();

		expect(result.claimed).to.equal(0);
		expect(table.claims).to.equal(0);
	});
});

// ---------------------------------------------------------------------------------------------
// 4. Two replicas
// ---------------------------------------------------------------------------------------------

describe("two api instances sweeping at the same time", () => {
	it("gives each message to exactly one of them", async () => {
		// The property the claim exists for. The fake models what PostgreSQL guarantees — a row is
		// updated by one statement or the other, never both — and what is under test is that the
		// sweeper takes its work FROM that guarantee rather than from a read it did earlier.
		const table = fakeTable([
			backlogRow({ id: "m-1", receivedAt: ago(600) }),
			backlogRow({ id: "m-2", receivedAt: ago(600) }),
			backlogRow({ id: "m-3", receivedAt: ago(600) }),
		]);
		const replicaA = harness(table);
		const replicaB = harness(table);

		const [resultA, resultB] = await Promise.all([
			replicaA.sweeper.sweep(),
			replicaB.sweeper.sweep(),
		]);

		const all = [...replicaA.enqueued, ...replicaB.enqueued].map((job) => job.messageId);
		expect(all.sort()).to.deep.equal(["m-1", "m-2", "m-3"]);
		expect(new Set(all).size).to.equal(3);
		expect(resultA.claimed + resultB.claimed).to.equal(3);
	});

	it("gives the loser of a one-row race nothing, rather than a duplicate", async () => {
		const table = fakeTable([backlogRow({ id: "only", receivedAt: ago(600) })]);
		const replicaA = harness(table);
		const replicaB = harness(table);

		const results = await Promise.all([replicaA.sweeper.sweep(), replicaB.sweeper.sweep()]);

		expect(results.map((entry) => entry.claimed).sort()).to.deep.equal([0, 1]);
		expect([...replicaA.enqueued, ...replicaB.enqueued]).to.have.length(1);
	});

	it("counts the claim once even when both replicas are pointed at the same message", async () => {
		const table = fakeTable([backlogRow({ id: "only", receivedAt: ago(600) })]);
		const replicaA = harness(table);
		const replicaB = harness(table);

		await replicaA.sweeper.sweep();
		await replicaB.sweeper.sweep();

		// The second sweep sees the first's committed claim, which is inside the TTL.
		expect(replicaB.enqueued).to.deep.equal([]);
		expect(table.rows[0]?.transcriptionAttempts).to.equal(1);
	});
});

// ---------------------------------------------------------------------------------------------
// 5. The deferred notification a reclaimed row still owes
// ---------------------------------------------------------------------------------------------

describe("what the back-fill does about a reclaimed message's notification", () => {
	it("asks the worker to settle the mail for a message that was never emailed", async () => {
		// The other half of what a lost queue costs: with the transcript wanted IN the mail, the send
		// is deferred to settlement, so a process that died holding one leaves a message that is filed,
		// pending, and un-notified. Nothing but this would ever send it.
		const table = fakeTable([backlogRow({ id: "never-mailed", receivedAt: ago(600) })]);
		const { sweeper, enqueued } = harness(table);

		await sweeper.sweep();

		expect(enqueued[0]?.options?.deferredEmail).to.equal(true);
	});

	it("does not arm a deferral for a message that has already been emailed", async () => {
		// The organization did not ask for the transcript in the mail, so it went at filing time. A
		// budget whose only possible outcome is a refused compare-and-set is a timer with no purpose.
		const table = fakeTable([
			backlogRow({ id: "already-mailed", receivedAt: ago(600), emailSentAt: ago(590) }),
		]);
		const { sweeper, enqueued } = harness(table);

		await sweeper.sweep();

		expect(enqueued[0]?.options?.deferredEmail).to.equal(false);
	});
});

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

interface BacklogRow {
	readonly id: string;
	readonly organizationId: string;
	readonly voicemailBoxId: string;
	readonly transcriptionStatus: string;
	readonly transcriptionAttempts: number;
	readonly transcriptionClaimedAt: Date | null;
	readonly receivedAt: Date;
	readonly emailSentAt: Date | null;
}

function backlogRow(overrides: Partial<BacklogRow> & { readonly id: string }): BacklogRow {
	return {
		organizationId: ORGANIZATION_ID,
		voicemailBoxId: MAILBOX_ID,
		transcriptionStatus: "pending",
		transcriptionAttempts: 0,
		transcriptionClaimedAt: null,
		receivedAt: ago(600),
		emailSentAt: null,
		...overrides,
	};
}

/** The shape {@link isClaimable} reads, for the arithmetic tests. */
function row(overrides: {
	readonly transcriptionStatus?: string;
	readonly transcriptionAttempts?: number;
	readonly transcriptionClaimedAt?: Date | null;
	readonly receivedAt?: Date;
}): {
	transcriptionStatus: string;
	transcriptionAttempts: number;
	transcriptionClaimedAt: Date | null;
	receivedAt: Date;
} {
	return {
		transcriptionStatus: overrides.transcriptionStatus ?? "pending",
		transcriptionAttempts: overrides.transcriptionAttempts ?? 0,
		transcriptionClaimedAt:
			overrides.transcriptionClaimedAt === undefined ? null : overrides.transcriptionClaimedAt,
		receivedAt: overrides.receivedAt ?? ago(600),
	};
}

interface FakeTable {
	rows: BacklogRow[];
	/** How many claim statements were executed against it. */
	claims: number;
	/** Set to make the next claim throw. */
	fail?: Error;
	/** Holds the next claim open, so re-entrancy can be observed. */
	release(): void;
	gate?: Promise<void>;
}

/**
 * A `voicemail_message` table that models the ONE guarantee this design leans on.
 *
 * Not a SQL engine: the fake evaluates {@link isClaimable} — the same specification the statement is
 * built from — and applies the update atomically with respect to other callers, which is exactly
 * what `UPDATE … WHERE <predicate> RETURNING` gives under READ COMMITTED. Everything a fake could
 * get wrong about SQL is asserted on the rendered statement instead, in section 2 above.
 */
function fakeTable(rows: readonly BacklogRow[]): FakeTable {
	let release = (): void => {};
	const table: FakeTable = {
		rows: [...rows],
		claims: 0,
		release: () => {
			release();
		},
	};

	table.gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	return table;
}

interface EnqueuedJob {
	readonly organizationId: string;
	readonly mailboxId: string;
	readonly messageId: string;
	readonly options?: { readonly deferredEmail?: boolean };
}

function harness(
	table: FakeTable,
	options: {
		readonly held?: readonly string[];
		readonly enabled?: boolean;
		readonly blockClaims?: boolean;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): { sweeper: VoicemailTranscriptionSweeper; enqueued: EnqueuedJob[] } {
	const enqueued: EnqueuedJob[] = [];
	const settings: TranscriptionEnv = loadTranscriptionEnv(
		options.env ?? {
			TRANSCRIBE_BASE_URL: "https://api.example.test/v1",
			TRANSCRIBE_MODEL: "whisper-1",
		},
	);

	const database = {
		adminDb: {
			execute: async <T>(): Promise<T[]> => {
				if (options.blockClaims === true) {
					await table.gate;
				}
				if (table.fail !== undefined) {
					throw table.fail;
				}
				table.claims += 1;
				const excluded = new Set(options.held ?? []);
				const claimed: T[] = [];
				table.rows = table.rows.map((entry) => {
					if (claimed.length >= settings.sweepBatch) {
						return entry;
					}
					if (excluded.has(entry.id) || !isClaimable(entry, CUTOFFS, settings.sweepMaxAttempts)) {
						return entry;
					}
					const attempts = entry.transcriptionAttempts + 1;
					claimed.push({
						message_id: entry.id,
						organization_id: entry.organizationId,
						mailbox_id: entry.voicemailBoxId,
						attempts,
						emailed: entry.emailSentAt !== null,
					} as T);
					return {
						...entry,
						transcriptionStatus: "pending",
						transcriptionAttempts: attempts,
						transcriptionClaimedAt: NOW,
					};
				});
				return claimed;
			},
		},
	} as unknown as PbxDatabaseClient;

	const transcription = {
		enabled: options.enabled !== false,
		heldMessageIds: () => options.held ?? [],
		enqueue: (
			organizationId: string,
			mailboxId: string,
			messageId: string,
			enqueueOptions?: { readonly deferredEmail?: boolean },
		) => {
			enqueued.push({ organizationId, mailboxId, messageId, options: enqueueOptions });
		},
	} as unknown as VoicemailTranscriptionService;

	return {
		sweeper: new VoicemailTranscriptionSweeper(database, settings, transcription),
		enqueued,
	};
}

/** The statement's literal fragments and bound values, flattened for substring assertions. */
function chunksOf(statement: { readonly queryChunks: unknown }): string {
	return JSON.stringify(statement.queryChunks).toLowerCase();
}
