import { expect } from "chai";
import { QueueAgentSessionService } from "../../src/pbx/queues/queue-agent-session.service";
import { QueueSurveyRpcController } from "../../src/pbx/queues/queue-survey-rpc.controller";
import type { AgentStatePublisher } from "../../src/pbx/queues/agent-state.publisher";
import type { QueueDispositionLedger } from "../../src/pbx/queues/queue-disposition-cdr.port";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The post-call survey: what the engine may file, and what it may not.
 *
 * The decisions pinned here are the ones a real database would not catch on its own. That a
 * `questionId` is checked against the QUEUE named in the report is the one that matters most: the
 * unique index is on `(org, call, question)` and knows nothing about which queue a question belongs
 * to, so without this check a report addressed to the wrong queue would file a perfectly valid row
 * against a question nobody can interpret. The SQL itself is exercised by `verify-pbx.ts` against a
 * real database.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const AGENT_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const QUEUE_ID = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const CALL_ID = "019fd3c2-7777-76be-a6b3-b0f1914e39b6";
const QUESTION_ONE = "019fd3c2-aaaa-76be-a6b3-b0f1914e39b6";
const QUESTION_TWO = "019fd3c2-bbbb-76be-a6b3-b0f1914e39b6";
const FOREIGN_QUESTION = "019fd3c2-cccc-76be-a6b3-b0f1914e39b6";

interface Inserted {
	readonly values: Record<string, unknown>[];
	readonly conflict: "nothing";
}

/**
 * A database whose survey questions are `known`, and which records the insert.
 *
 * `duplicates` is how many of the rows the unique index swallows, so a replay can be spelled
 * without a real index: `returning` answers with the rows that were actually written.
 */
function fakeDatabase(options: {
	readonly known?: readonly string[];
	readonly duplicates?: number;
}): { database: PbxDatabaseClient; inserted: Inserted[] } {
	const known = options.known ?? [QUESTION_ONE, QUESTION_TWO];
	const duplicates = options.duplicates ?? 0;
	const inserted: Inserted[] = [];
	const transaction = {
		select: () => ({
			from: () => ({
				where: async () => known.map((id) => ({ id })),
			}),
		}),
		insert: () => ({
			values: (values: Record<string, unknown>[]) => ({
				onConflictDoNothing: () => ({
					returning: async () => {
						inserted.push({ values, conflict: "nothing" });
						return values.slice(duplicates).map((_, index) => ({ id: `row-${String(index)}` }));
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
	return { database, inserted };
}

function serviceOver(database: PbxDatabaseClient): QueueAgentSessionService {
	const publisher = { read: async () => undefined } as unknown as AgentStatePublisher;
	const ledger: QueueDispositionLedger = { recordDisposition: async () => 0 };
	return new QueueAgentSessionService(database, publisher, ledger);
}

describe("recording a post-call survey", () => {
	it("writes one row per answer, against the queue and the agent who took the call", async () => {
		const { database, inserted } = fakeDatabase({});
		const result = await serviceOver(database).recordSurveyAnswers({
			organizationId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
			answers: [
				{ questionId: QUESTION_ONE, answer: 5 },
				{ questionId: QUESTION_TWO, answer: 3 },
			],
		});

		expect(result.recorded).to.equal(2);
		expect(result.reason).to.equal(undefined);
		expect(inserted[0]?.values).to.have.length(2);
		expect(inserted[0]?.values[0]).to.include({
			organizationId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			questionId: QUESTION_ONE,
			callId: CALL_ID,
			queueAgentId: AGENT_ID,
			answer: 5,
		});
		// `onConflictDoNothing`, never `DoUpdate`: the caller pressed once, so there is no second
		// opinion to record and a replay must not re-count the rating it already filed.
		expect(inserted[0]?.conflict).to.equal("nothing");
	});

	it("counts a replayed report once", async () => {
		const { database } = fakeDatabase({ duplicates: 2 });
		const result = await serviceOver(database).recordSurveyAnswers({
			organizationId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
			answers: [
				{ questionId: QUESTION_ONE, answer: 5 },
				{ questionId: QUESTION_TWO, answer: 3 },
			],
		});

		// Short of what was sent, and NOT an error: the rows are already there.
		expect(result.recorded).to.equal(0);
		expect(result.reason).to.equal(undefined);
	});

	it("refuses an answer to a question that is not this queue's, and says which", async () => {
		const { database, inserted } = fakeDatabase({});
		const result = await serviceOver(database).recordSurveyAnswers({
			organizationId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
			answers: [
				{ questionId: QUESTION_ONE, answer: 4 },
				{ questionId: FOREIGN_QUESTION, answer: 4 },
			],
		});

		// The good answer still lands: a partial survey is more data than none, which is the same
		// rule `runQueueSurvey` keeps when the caller hangs up mid-script.
		expect(result.recorded).to.equal(1);
		expect(inserted[0]?.values).to.have.length(1);
		expect(result.reason).to.contain(FOREIGN_QUESTION);
		expect(result.reason).to.contain("not a question of this queue");
	});

	it("refuses a digit outside 1-5 rather than letting the column's check reject it", async () => {
		const { database, inserted } = fakeDatabase({});
		const result = await serviceOver(database).recordSurveyAnswers({
			organizationId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
			answers: [{ questionId: QUESTION_ONE, answer: 9 }],
		});

		expect(result.recorded).to.equal(0);
		expect(inserted).to.have.length(0);
		expect(result.reason).to.contain("out of range");
	});
});

describe("the queue-survey responder", () => {
	it("answers a malformed report rather than throwing at the broker", async () => {
		const { database } = fakeDatabase({});
		const controller = new QueueSurveyRpcController(serviceOver(database));

		const reply = await controller.report({ orgId: ORGANIZATION_ID, answers: [] });

		expect(reply.recorded).to.equal(0);
		expect(reply.reason).to.be.a("string");
	});

	it("refuses a digit the survey never offered before it reaches the database", async () => {
		const { database, inserted } = fakeDatabase({});
		const controller = new QueueSurveyRpcController(serviceOver(database));

		const reply = await controller.report({
			orgId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
			answers: [{ questionId: QUESTION_ONE, digit: "7" }],
		});

		expect(reply.recorded).to.equal(0);
		expect(inserted).to.have.length(0);
	});

	it("converts the wire's digit to the integer the row stores", async () => {
		const { database, inserted } = fakeDatabase({});
		const controller = new QueueSurveyRpcController(serviceOver(database));

		const reply = await controller.report({
			orgId: ORGANIZATION_ID,
			queueId: QUEUE_ID,
			agentId: AGENT_ID,
			callId: CALL_ID,
			answers: [{ questionId: QUESTION_TWO, digit: "2" }],
		});

		expect(reply.recorded).to.equal(1);
		expect(inserted[0]?.values[0]).to.include({ answer: 2 });
	});
});
