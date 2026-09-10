import { expect } from "chai";
import { QUEUE_DISPOSITION_UNSET } from "@optimiq-voice/pbx-db";
import {
	QueueDispositionCodeUnknownException,
	QueueDispositionNoLiveCallException,
	QueueAgentSessionForbiddenException,
} from "../../src/pbx/queues/queue-agent-session.errors";
import { QueueAgentSessionService } from "../../src/pbx/queues/queue-agent-session.service";
import { submitQueueDispositionDto } from "../../src/pbx/queues/queues.dto";
import type { AgentStatePublisher } from "../../src/pbx/queues/agent-state.publisher";
import type { QueueDispositionLedger } from "../../src/pbx/queues/queue-disposition-cdr.port";
import type { AppSession } from "@optimiq-voice/auth";
import type { AgentStateEntry } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * Wrap-up codes: who may file one, against which call, and what happens to the three stores.
 *
 * The decisions pinned here are the ones a real database would not catch. That the code belongs to
 * the queue on the agent's LIVE entry (and not to a queue named in the body, because there is no
 * such field) is the one that matters most: every report groups by (queue, code), and a code filed
 * against the wrong queue is a number nobody can unpick afterwards. The SQL itself is exercised by
 * `verify-pbx.ts` against a real database.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const AGENT_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const OTHER_USER_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const QUEUE_ID = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const OTHER_QUEUE_ID = "019fd3c2-6666-76be-a6b3-b0f1914e39b6";
const CALL_ID = "019fd3c2-7777-76be-a6b3-b0f1914e39b6";
const OTHER_CALL_ID = "019fd3c2-8888-76be-a6b3-b0f1914e39b6";
const CODE_ID = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";

interface AgentRow {
	id: string;
	name: string;
	userId: string | null;
	status: string;
	statusChangedAt: Date | null;
	enabled: boolean;
}

const AGENT_ROW: AgentRow = {
	id: AGENT_ID,
	name: "Ada Lovelace",
	userId: USER_ID,
	status: "wrap-up",
	statusChangedAt: null,
	enabled: true,
};

function sessionFor(permissions: readonly string[], userId = USER_ID): AppSession {
	return {
		session: {
			id: "sess",
			userId,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORGANIZATION_ID,
		},
		user: { id: userId, email: "u@test", name: "U", emailVerified: true },
		permissions: permissions as never,
	};
}

function liveEntry(overrides: Partial<AgentStateEntry> = {}): AgentStateEntry {
	return {
		orgId: ORGANIZATION_ID,
		agentId: AGENT_ID,
		status: "wrap-up",
		since: "2026-08-06T09:00:00.000Z",
		queueId: QUEUE_ID,
		dispositionCallId: CALL_ID,
		source: "engine",
		...overrides,
	} as AgentStateEntry;
}

interface Written {
	readonly values: Record<string, unknown>;
	readonly conflict: "update" | "nothing";
}

/**
 * A database that answers the code lookup and records the upsert.
 *
 * `codes` is what the queue's ENABLED vocabulary contains; an empty list is a queue that asks no
 * question, which is the same refusal as a retired code and is deliberately not distinguished.
 */
function fakeDatabase(options: { readonly codes?: readonly string[] } = {}): {
	database: PbxDatabaseClient;
	written: Written[];
} {
	const codes = options.codes ?? ["sale"];
	const written: Written[] = [];
	const transaction = {
		select: (projection?: Record<string, unknown>) => ({
			from: () => ({
				where: () => ({
					// The code lookup projects `{ id }`; the agent read projects the whole row.
					limit: async () =>
						projection !== undefined && Object.keys(projection).length === 1 && "id" in projection
							? codes.length > 0
								? [{ id: CODE_ID }]
								: []
							: [AGENT_ROW],
				}),
			}),
		}),
		insert: () => ({
			values: (values: Record<string, unknown>) => ({
				onConflictDoUpdate: async () => {
					written.push({ values, conflict: "update" });
				},
				onConflictDoNothing: () => ({
					returning: async () => {
						written.push({ values, conflict: "nothing" });
						return [{ id: CODE_ID }];
					},
				}),
			}),
		}),
	};
	const database = {
		withTenantScope: async <T>(
			_organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => await work(transaction as never),
	} as unknown as PbxDatabaseClient;
	return { database, written };
}

function fakePublisher(entry: AgentStateEntry | undefined): {
	publisher: AgentStatePublisher;
	stamped: { callId: string; code: string }[];
} {
	const stamped: { callId: string; code: string }[] = [];
	const publisher = {
		read: async () => entry,
		writeDisposition: async (input: { callId: string; code: string }) => {
			stamped.push({ callId: input.callId, code: input.code });
			return entry;
		},
	} as unknown as AgentStatePublisher;
	return { publisher, stamped };
}

function fakeLedger(result = 1): {
	ledger: QueueDispositionLedger;
	calls: { callId: string; code: string }[];
} {
	const calls: { callId: string; code: string }[] = [];
	return {
		ledger: {
			recordDisposition: async (input) => {
				calls.push({ callId: input.callId, code: input.code });
				return result;
			},
		},
		calls,
	};
}

describe("submitting a wrap-up code", () => {
	it("records the code against the queue on the agent's live entry", async () => {
		const { database, written } = fakeDatabase();
		const { publisher, stamped } = fakePublisher(liveEntry());
		const { ledger, calls } = fakeLedger();
		const service = new QueueAgentSessionService(database, publisher, ledger);

		const result = await service.submitDisposition(sessionFor(["queues.join.own"]), AGENT_ID, {
			callId: CALL_ID,
			code: "sale",
		});

		expect(result.data.code).to.equal("sale");
		expect(result.data.queueId).to.equal(QUEUE_ID);
		expect(result.data.auto).to.equal(false);
		expect(written[0]?.values.queueId).to.equal(QUEUE_ID);
		expect(written[0]?.values.codeId).to.equal(CODE_ID);
		// A correction inside the window overwrites; it never appends a second row.
		expect(written[0]?.conflict).to.equal("update");
		expect(stamped).to.deep.equal([{ callId: CALL_ID, code: "sale" }]);
		expect(calls).to.deep.equal([{ callId: CALL_ID, code: "sale" }]);
	});

	/**
	 * The same OR the four session actions are guarded by, and the reason it is not duplicated: a
	 * second copy of "join OR manage-agents, OR join.own and this seat is yours" is how the two
	 * spellings eventually disagree about an unlinked seat.
	 */
	it("lets a supervisor holding queues.join file for somebody else's seat", async () => {
		const { database } = fakeDatabase();
		const { publisher } = fakePublisher(liveEntry());
		const service = new QueueAgentSessionService(database, publisher, fakeLedger().ledger);
		const result = await service.submitDisposition(
			sessionFor(["queues.join"], OTHER_USER_ID),
			AGENT_ID,
			{ callId: CALL_ID, code: "sale" },
		);
		expect(result.data.agentId).to.equal(AGENT_ID);
	});

	it("refuses a self-scoped caller filing for somebody else's seat", async () => {
		const { database, written } = fakeDatabase();
		const { publisher } = fakePublisher(liveEntry());
		const service = new QueueAgentSessionService(database, publisher, fakeLedger().ledger);
		let caught: unknown;
		try {
			await service.submitDisposition(sessionFor(["queues.join.own"], OTHER_USER_ID), AGENT_ID, {
				callId: CALL_ID,
				code: "sale",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueAgentSessionForbiddenException);
		expect(written).to.have.length(0);
	});

	/**
	 * The console reads `dispositionCallId` off the same entry, so a mismatch means the agent has
	 * moved on. Landing it on the current call instead would silently attribute one caller's outcome
	 * to another.
	 */
	it("refuses a code for a call the agent is no longer finishing", async () => {
		const { database, written } = fakeDatabase();
		const { publisher } = fakePublisher(liveEntry({ dispositionCallId: OTHER_CALL_ID }));
		const service = new QueueAgentSessionService(database, publisher, fakeLedger().ledger);
		let caught: unknown;
		try {
			await service.submitDisposition(sessionFor(["queues.join.own"]), AGENT_ID, {
				callId: CALL_ID,
				code: "sale",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueDispositionNoLiveCallException);
		expect(written).to.have.length(0);
	});

	it("refuses when the agent has no live entry at all", async () => {
		const { database } = fakeDatabase();
		const { publisher } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher, fakeLedger().ledger);
		let caught: unknown;
		try {
			await service.submitDisposition(sessionFor(["queues.join.own"]), AGENT_ID, {
				callId: CALL_ID,
				code: "sale",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueDispositionNoLiveCallException);
	});

	it("refuses a code the queue does not offer, and writes nothing", async () => {
		const { database, written } = fakeDatabase({ codes: [] });
		const { publisher, stamped } = fakePublisher(liveEntry());
		const service = new QueueAgentSessionService(database, publisher, fakeLedger().ledger);
		let caught: unknown;
		try {
			await service.submitDisposition(sessionFor(["queues.join.own"]), AGENT_ID, {
				callId: CALL_ID,
				code: "retired",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueDispositionCodeUnknownException);
		expect(written).to.have.length(0);
		expect(stamped).to.have.length(0);
	});

	/**
	 * The durable write already succeeded. Refusing the request because the live entry could not be
	 * updated would tell the agent their code was not recorded when it was, and they would pick it
	 * again on a call that has moved on.
	 */
	it("still succeeds when the live entry cannot be stamped", async () => {
		const { database, written } = fakeDatabase();
		const publisher = {
			read: async () => liveEntry(),
			writeDisposition: async () => {
				throw new Error("no broker");
			},
		} as unknown as AgentStatePublisher;
		const service = new QueueAgentSessionService(database, publisher, fakeLedger().ledger);
		const result = await service.submitDisposition(sessionFor(["queues.join.own"]), AGENT_ID, {
			callId: CALL_ID,
			code: "sale",
		});
		expect(result.data.code).to.equal("sale");
		expect(written).to.have.length(1);
	});

	/** No CDR database is a supported deployment shape, not a degraded one. */
	it("records the code with no CDR ledger wired at all", async () => {
		const { database, written } = fakeDatabase();
		const { publisher } = fakePublisher(liveEntry());
		const service = new QueueAgentSessionService(database, publisher);
		const result = await service.submitDisposition(sessionFor(["queues.join.own"]), AGENT_ID, {
			callId: CALL_ID,
			code: "sale",
		});
		expect(result.data.code).to.equal("sale");
		expect(written).to.have.length(1);
	});
});

describe("the engine's auto-wrap report", () => {
	it("records unset with no code id and never overwrites a choice", async () => {
		const { database, written } = fakeDatabase();
		const { publisher, stamped } = fakePublisher(liveEntry());
		const { ledger, calls } = fakeLedger();
		const service = new QueueAgentSessionService(database, publisher, ledger);

		const result = await service.recordAutoDisposition({
			organizationId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
		});

		expect(result.recorded).to.equal(true);
		expect(written[0]?.values.code).to.equal(QUEUE_DISPOSITION_UNSET);
		expect(written[0]?.values.codeId).to.equal(null);
		expect(written[0]?.values.auto).to.equal(true);
		// `onConflictDoNothing`, not `DoUpdate`: a report arriving after the agent chose must lose.
		expect(written[0]?.conflict).to.equal("nothing");
		// The KV entry is NOT stamped — `agentStateEntrySchema` documents that `unset` is never
		// written there, and a console showing it would report the system giving up as a choice.
		expect(stamped).to.have.length(0);
		expect(calls[0]?.code).to.equal(QUEUE_DISPOSITION_UNSET);
	});
});

describe("the disposition DTO", () => {
	it("lower-cases the code so one outcome is not two in the report", () => {
		const parsed = submitQueueDispositionDto.parse({ callId: CALL_ID, code: "  SALE  " });
		expect(parsed.code).to.equal("sale");
	});

	it("refuses a code that is not a tag", () => {
		expect(
			submitQueueDispositionDto.safeParse({ callId: CALL_ID, code: "a sale" }).success,
		).to.equal(false);
	});

	it("refuses a body naming a queue, which would let a code be filed against the wrong one", () => {
		expect(
			submitQueueDispositionDto.safeParse({
				callId: CALL_ID,
				code: "sale",
				queueId: OTHER_QUEUE_ID,
			}).success,
		).to.equal(false);
	});
});
