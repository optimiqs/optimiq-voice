import { expect } from "chai";
import { queueStatsQuerySchema, cdrCallQuerySchema } from "../../src/cdr/query/cdr.dto";
import { CdrService } from "../../src/cdr/query/cdr.service";
import { QueueSurveySourceService } from "../../src/pbx/shared/queue-survey-source.service";
import type { QueueSurveySource, QueueSurveySummary } from "../../src/cdr/query/queue-survey.port";
import type { AppSession, Permission } from "@optimiq-voice/auth";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The post-call survey on a report: the cross-database join, and the two ways it must not break a
 * report.
 *
 * The join is the whole subject. Answers live in `pbx-db` and the calls they are about live in
 * `cdr-db`, so there is no statement that can name both — the service asks each side its own
 * question and matches them by queue id and by call id in memory. What is pinned here is that it
 * matches on the right key, that a queue with no answers carries NO survey rather than an empty
 * one, and that an unreachable answer store costs the report its survey and nothing else.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const USER = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const QUEUE = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const OTHER_QUEUE = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const CALL = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const QUESTION_ONE = "019fd3c2-aaaa-76be-a6b3-b0f1914e39b6";
const QUESTION_TWO = "019fd3c2-bbbb-76be-a6b3-b0f1914e39b6";

function session(permissions: readonly Permission[] = ["cdr.read", "queues.monitor"]): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORG,
		},
		user: { id: USER, email: "u@test", name: "U", emailVerified: true },
		permissions,
	};
}

/** A CDR client that answers each `withTenantScope` callback from a queue of result sets. */
function fakeCdr(...resultSets: readonly unknown[][]): CdrDatabaseClient {
	const queue = [...resultSets];
	const builder: Record<string, unknown> = {};
	for (const method of ["select", "from", "where", "orderBy", "groupBy", "innerJoin", "leftJoin"]) {
		builder[method] = () => builder;
	}
	builder.limit = async () => queue.shift() ?? [];
	builder.then = (resolve: (rows: unknown[]) => unknown) => resolve(queue.shift() ?? []);
	return {
		withTenantScope: async <T>(_org: string, work: (t: never) => Promise<T>) =>
			await work(builder as never),
	} as unknown as CdrDatabaseClient;
}

/** A PBX client whose one select answers `rows`, recording the tenant it was scoped to. */
function fakePbx(rows: readonly Record<string, unknown>[]): {
	readonly client: PbxDatabaseClient;
	readonly scopes: string[];
} {
	const scopes: string[] = [];
	const builder: Record<string, unknown> = {};
	for (const method of ["select", "from", "innerJoin", "where", "groupBy"]) {
		builder[method] = () => builder;
	}
	builder.then = (resolve: (value: unknown) => unknown) => resolve(rows);
	const client = {
		withTenantScope: async <T>(organizationId: string, work: (t: never) => Promise<T>) => {
			scopes.push(organizationId);
			return await work(builder as never);
		},
	} as unknown as PbxDatabaseClient;
	return { client, scopes };
}

function summary(overrides: Partial<QueueSurveySummary> = {}): QueueSurveySummary {
	return {
		queueId: QUEUE,
		responses: 3,
		average: 4.3,
		questions: [
			{
				questionId: QUESTION_ONE,
				position: 1,
				label: "How did we do?",
				responses: 3,
				distribution: [0, 0, 1, 0, 2],
				average: 4.3,
			},
		],
		...overrides,
	};
}

function surveyPort(summaries: readonly QueueSurveySummary[]): QueueSurveySource {
	return {
		summaries: async () => summaries,
		answersForCalls: async ({ callIds }) =>
			callIds.includes(CALL)
				? [
						{
							callId: CALL,
							queueId: QUEUE,
							questionId: QUESTION_ONE,
							position: 1,
							label: "How did we do?",
							answer: 5,
							answeredAt: "2026-09-10T08:00:00.000Z",
						},
					]
				: [],
	};
}

const STATS = queueStatsQuerySchema.parse({});
const CALL_QUERY = cdrCallQuerySchema.parse({});

describe("the queue survey summary, out of the PBX database", () => {
	it("counts each answer, averages what was given, and never invents a zero", async () => {
		const pbx = fakePbx([
			{
				queueId: QUEUE,
				questionId: QUESTION_TWO,
				position: 2,
				label: "Was it resolved?",
				responses: "2",
				total: "3",
				answer1: "1",
				answer2: "1",
				answer3: "0",
				answer4: "0",
				answer5: "0",
			},
			{
				queueId: QUEUE,
				questionId: QUESTION_ONE,
				position: 1,
				label: "How did we do?",
				responses: "3",
				total: "13",
				answer1: "0",
				answer2: "0",
				answer3: "1",
				answer4: "0",
				answer5: "2",
			},
		]);

		const summaries = await new QueueSurveySourceService(pbx.client).summaries({
			organizationId: ORG,
			from: new Date("2026-09-09T00:00:00.000Z"),
			to: new Date("2026-09-11T00:00:00.000Z"),
		});

		expect(pbx.scopes).to.deep.equal([ORG]);
		expect(summaries).to.have.length(1);
		const queue = summaries[0];
		expect(queue?.queueId).to.equal(QUEUE);
		// Five answers over two questions, mean 16/5.
		expect(queue?.responses).to.equal(5);
		expect(queue?.average).to.equal(3.2);
		// In the order the caller was asked, not the order the aggregate came back.
		expect(queue?.questions.map((question) => question.position)).to.deep.equal([1, 2]);
		expect(queue?.questions[0]?.distribution).to.deep.equal([0, 0, 1, 0, 2]);
		expect(queue?.questions[0]?.average).to.equal(4.3);
		expect(queue?.questions[1]?.average).to.equal(1.5);
	});

	it("asks the database nothing when there are no calls to ask about", async () => {
		const pbx = fakePbx([]);
		const answers = await new QueueSurveySourceService(pbx.client).answersForCalls({
			organizationId: ORG,
			callIds: [],
		});

		expect(answers).to.deep.equal([]);
		expect(pbx.scopes).to.deep.equal([]);
	});
});

describe("the queue statistics report with a survey on it", () => {
	it("attaches each queue's survey by queue id, and leaves an unrated queue without one", async () => {
		const service = new CdrService(
			fakeCdr([
				{ queueId: QUEUE, offered: 4, answered: 4 },
				{ queueId: OTHER_QUEUE, offered: 2, answered: 2 },
			]),
			undefined,
			surveyPort([summary()]),
		);

		const envelope = await service.queueStats(session(), STATS);

		expect(envelope.data).to.have.length(2);
		expect(envelope.data[0]).to.have.nested.property("survey.average", 4.3);
		// Absent, not an empty summary: "no survey configured" and "a survey nobody answered" are
		// different facts and the UI must be able to tell them apart.
		expect(envelope.data[1]).to.not.have.property("survey");
	});

	it("serves the service level without a survey when the answer store cannot be read", async () => {
		const service = new CdrService(
			fakeCdr([{ queueId: QUEUE, offered: 4, answered: 4 }]),
			undefined,
			{
				summaries: async () => {
					throw new Error("pbx-db unreachable");
				},
				answersForCalls: async () => [],
			},
		);

		const envelope = await service.queueStats(session(), STATS);

		expect(envelope.data).to.have.length(1);
		expect(envelope.data[0]).to.not.have.property("survey");
	});

	it("serves the report unchanged when the PBX area is not mounted at all", async () => {
		const service = new CdrService(fakeCdr([{ queueId: QUEUE, offered: 4, answered: 4 }]));

		const envelope = await service.queueStats(session(), STATS);

		expect(envelope.data[0]).to.not.have.property("survey");
	});
});

describe("a call's own survey answers", () => {
	it("joins the answers to the call by call id", async () => {
		const legs = [
			{
				id: "019fd3c2-cccc-76be-a6b3-b0f1914e39b6",
				callId: CALL,
				fromNumber: "2003",
				toNumber: "2910",
				destinationType: "queue",
				destinationRef: null,
			},
		];
		const service = new CdrService(fakeCdr(legs, []), undefined, surveyPort([]));

		const envelope = await service.getCall(session(), CALL, CALL_QUERY);

		expect(envelope.data.survey).to.have.length(1);
		expect(envelope.data.survey[0]).to.include({ answer: 5, label: "How did we do?" });
	});

	it("carries an empty survey for a call nobody was asked about", async () => {
		const legs = [
			{
				id: "019fd3c2-cccc-76be-a6b3-b0f1914e39b6",
				callId: "019fd3c2-9999-76be-a6b3-b0f1914e39b6",
				fromNumber: "2003",
				toNumber: "2910",
				destinationType: "extension",
				destinationRef: null,
			},
		];
		const service = new CdrService(fakeCdr(legs, []), undefined, surveyPort([]));

		const envelope = await service.getCall(
			session(),
			"019fd3c2-9999-76be-a6b3-b0f1914e39b6",
			CALL_QUERY,
		);

		expect(envelope.data.survey).to.deep.equal([]);
	});
});
