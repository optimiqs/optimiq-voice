import { expect } from "chai";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { QueueSupervisionController } from "../../src/pbx/queues/queue-supervision.controller";
import {
	QueueSupervisionNoAgentException,
	QueueSupervisionNoExtensionException,
	QueueSupervisionQueueNotFoundException,
} from "../../src/pbx/queues/queue-supervision.errors";
import { QueueSupervisionService } from "../../src/pbx/queues/queue-supervision.service";
import { superviseCallDto } from "../../src/pbx/queues/queues.dto";
import type { CallsService } from "../../src/pbx/calls/calls.service";
import type { AgentStatePublisher } from "../../src/pbx/queues/agent-state.publisher";
import type { AppSession } from "@optimiq-voice/auth";
import type { AgentStateEntry } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * Supervisor whisper / barge from the wallboard.
 *
 * Three things are worth pinning, and none of them is the originate itself (`calls.service.ts` has
 * its own tests and this service only calls it):
 *
 * 1. **The dialled string is the `*0` feature code.** It is the ONE path that runs the engine's
 *    authorize → tap chain, and a bespoke command would be a second place the rules could be wrong.
 * 2. **The path's `queueId` is load-bearing.** Without the check that the live entry names it, a
 *    supervisor holding `queues.monitor` reaches every live call in the tenant by guessing a call id.
 * 3. **Every attempt is audited, refusals included.** A supervision attempt is one person listening
 *    to another's conversation; "who tried" is as much of the record as "who succeeded".
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const QUEUE_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const OTHER_QUEUE_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const CALL_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";
const AGENT_ID = "019fd3c2-5555-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-6666-76be-a6b3-b0f1914e39b6";

function session(): AppSession {
	return {
		session: {
			id: "sess",
			userId: USER_ID,
			token: "t",
			expiresAt: new Date(Date.now() + 3_600_000),
			activeOrganizationId: ORGANIZATION_ID,
		},
		user: { id: USER_ID, email: "u@test", name: "U", emailVerified: true },
		permissions: ["queues.monitor", "calls.originate"] as never,
	};
}

function liveEntry(overrides: Partial<AgentStateEntry> = {}): AgentStateEntry {
	return {
		orgId: ORGANIZATION_ID,
		agentId: AGENT_ID,
		status: "on-call",
		since: "2026-08-06T09:00:00.000Z",
		callId: CALL_ID,
		queueId: QUEUE_ID,
		source: "engine",
		...overrides,
	} as AgentStateEntry;
}

interface AuditRow {
	action: string;
	before: Record<string, unknown> | null;
}

/**
 * A database standing in for three reads and one ledger insert.
 *
 * The reads are told apart by their projections rather than by their SQL, which is the same trade
 * `queueAgentSession.test.ts` makes: asserting on the WHERE clause here would be asserting on
 * Drizzle, and the queries themselves run against a real database in `verify-pbx.ts`.
 */
function fakeDatabase(options: {
	readonly queueExists?: boolean;
	readonly agentExtension?: string | undefined;
	readonly supervisorExtension?: string | undefined;
}): { database: PbxDatabaseClient; audits: AuditRow[] } {
	const audits: AuditRow[] = [];
	let numberReads = 0;
	const transaction = {
		select: (projection?: Record<string, unknown>) => ({
			from: () => {
				const isQueueRead = projection !== undefined && "id" in projection;
				const chain = {
					limit: async () => {
						if (isQueueRead) {
							return options.queueExists === false ? [] : [{ id: QUEUE_ID }];
						}
						// The agent's extension is read first, the supervisor's second.
						numberReads += 1;
						const number = numberReads === 1 ? options.agentExtension : options.supervisorExtension;
						return number === undefined ? [] : [{ number }];
					},
				};
				return {
					where: () => chain,
					innerJoin: () => ({ where: () => chain }),
				};
			},
		}),
		insert: () => ({
			values: async (values: AuditRow) => {
				audits.push(values);
			},
		}),
	};
	const database = {
		withTenantScope: async <T>(
			_organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => await work(transaction as never),
	} as unknown as PbxDatabaseClient;
	return { database, audits };
}

function fakeCalls(): { calls: CallsService; placed: { from: string; to: string }[] } {
	const placed: { from: string; to: string }[] = [];
	const calls = {
		originate: async (_session: AppSession, request: { from: string; to: string }) => {
			placed.push(request);
			return {
				callId: CALL_ID,
				legId: CALL_ID,
				originateId: CALL_ID,
				from: request.from,
				to: request.to,
			};
		},
	} as unknown as CallsService;
	return { calls, placed };
}

function fakeAgentState(entry: AgentStateEntry | undefined): AgentStatePublisher {
	return { findByCall: async () => entry } as unknown as AgentStatePublisher;
}

describe("supervising a live queue call", () => {
	it("dials the *0 feature code from the supervisor's own extension", async () => {
		const { database, audits } = fakeDatabase({
			agentExtension: "1001",
			supervisorExtension: "1900",
		});
		const { calls, placed } = fakeCalls();
		const service = new QueueSupervisionService(database, fakeAgentState(liveEntry()), calls);

		const result = await service.supervise(session(), QUEUE_ID, CALL_ID, "monitor");

		expect(placed).to.deep.equal([{ from: "1900", to: "*01001" }]);
		expect(result.ok).to.equal(true);
		expect(result.agentExtension).to.equal("1001");
		expect(audits.some((row) => row.action === "queue.supervise")).to.equal(true);
	});

	/**
	 * `*0` always starts SILENT and the supervisor escalates with DTMF. The endpoint returns the
	 * digit and does NOT claim the mode is applied — a `barge` that reported success while the
	 * supervisor was still inaudible would be an API describing a state the platform is not in.
	 */
	it("returns the escalation digit for each mode without applying it", async () => {
		const digits: Record<string, string> = {};
		for (const mode of ["monitor", "whisper", "barge"] as const) {
			const { database } = fakeDatabase({
				agentExtension: "1001",
				supervisorExtension: "1900",
			});
			const { calls, placed } = fakeCalls();
			const service = new QueueSupervisionService(database, fakeAgentState(liveEntry()), calls);
			const result = await service.supervise(session(), QUEUE_ID, CALL_ID, mode);
			digits[mode] = result.escalationDigit;
			// Same dial string for every mode: nothing about the request changes what is placed.
			expect(placed[0]?.to).to.equal("*01001");
		}
		expect(digits).to.deep.equal({ monitor: "4", whisper: "5", barge: "6" });
	});

	it("refuses a call the queue on the path did not distribute", async () => {
		const { database, audits } = fakeDatabase({
			agentExtension: "1001",
			supervisorExtension: "1900",
		});
		const { calls, placed } = fakeCalls();
		const service = new QueueSupervisionService(
			database,
			fakeAgentState(liveEntry({ queueId: OTHER_QUEUE_ID })),
			calls,
		);
		let caught: unknown;
		try {
			await service.supervise(session(), QUEUE_ID, CALL_ID, "monitor");
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueSupervisionNoAgentException);
		expect(placed).to.have.length(0);
		// The refusal is in the ledger too — an attempt to reach another queue's call is exactly the
		// thing an audit trail exists to have a record of.
		expect(audits[0]?.before?.outcome).to.equal("wrong-queue");
	});

	it("refuses when nobody is on that call, and audits the attempt", async () => {
		const { database, audits } = fakeDatabase({
			agentExtension: "1001",
			supervisorExtension: "1900",
		});
		const { calls, placed } = fakeCalls();
		const service = new QueueSupervisionService(database, fakeAgentState(undefined), calls);
		let caught: unknown;
		try {
			await service.supervise(session(), QUEUE_ID, CALL_ID, "whisper");
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueSupervisionNoAgentException);
		expect(placed).to.have.length(0);
		expect(audits[0]?.before?.outcome).to.equal("no-agent");
	});

	it("404s a queue from another tenant before the bucket is scanned", async () => {
		const { database } = fakeDatabase({ queueExists: false });
		const { calls, placed } = fakeCalls();
		const service = new QueueSupervisionService(database, fakeAgentState(liveEntry()), calls);
		let caught: unknown;
		try {
			await service.supervise(session(), QUEUE_ID, CALL_ID, "monitor");
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueSupervisionQueueNotFoundException);
		expect(placed).to.have.length(0);
	});

	it("refuses when the agent is external and has no extension to monitor", async () => {
		const { database, audits } = fakeDatabase({
			agentExtension: undefined,
			supervisorExtension: "1900",
		});
		const { calls, placed } = fakeCalls();
		const service = new QueueSupervisionService(database, fakeAgentState(liveEntry()), calls);
		let caught: unknown;
		try {
			await service.supervise(session(), QUEUE_ID, CALL_ID, "monitor");
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueSupervisionNoExtensionException);
		expect(placed).to.have.length(0);
		expect(audits[0]?.before?.outcome).to.equal("agent-has-no-extension");
	});

	it("refuses when the supervisor's account is linked to no extension", async () => {
		const { database, audits } = fakeDatabase({
			agentExtension: "1001",
			supervisorExtension: undefined,
		});
		const { calls, placed } = fakeCalls();
		const service = new QueueSupervisionService(database, fakeAgentState(liveEntry()), calls);
		let caught: unknown;
		try {
			await service.supervise(session(), QUEUE_ID, CALL_ID, "monitor");
		} catch (error) {
			caught = error;
		}
		expect(caught).to.be.instanceOf(QueueSupervisionNoExtensionException);
		expect(placed).to.have.length(0);
		expect(audits[0]?.before?.outcome).to.equal("no-supervisor-extension");
	});
});

describe("the supervision surface", () => {
	it("is behind queues.monitor", () => {
		const granted = Reflect.getMetadata(
			REQUIRE_PERMISSIONS_METADATA,
			QueueSupervisionController.prototype.supervise,
		) as readonly string[] | undefined;
		expect(granted).to.deep.equal(["queues.monitor"]);
	});

	it("accepts exactly three modes", () => {
		expect(superviseCallDto.safeParse({ mode: "barge" }).success).to.equal(true);
		expect(superviseCallDto.safeParse({ mode: "record" }).success).to.equal(false);
		expect(superviseCallDto.safeParse({}).success).to.equal(false);
	});
});
