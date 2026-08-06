import { expect } from "chai";
import {
	AGENT_SESSION_ACTION_TARGET,
	planAgentSessionAction,
	type AgentSessionAction,
} from "@optimiq-voice/events/schemas";
import {
	AgentStateStoreUnavailableException,
	AgentTransitionRefusedException,
	QueueAgentNotFoundException,
	QueueAgentSessionForbiddenException,
} from "../../src/pbx/queues/queue-agent-session.errors";
import {
	emptyAgentSessionDto,
	pauseAgentSessionDto,
} from "../../src/pbx/queues/queue-agent-session.dto";
import { QueueAgentSessionService } from "../../src/pbx/queues/queue-agent-session.service";
import type { AgentStatePublisher } from "../../src/pbx/queues/agent-state.publisher";
import type { AppSession } from "@optimiq-voice/auth";
import type { AgentStateEntry } from "@optimiq-voice/events/schemas";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The agent-session surface's authorization and its state machine, over fakes.
 *
 * The point of these is the DECISIONS: who may move whose availability, what the machine refuses,
 * and that a refusal happens before anything is written. The KV round trip and the Postgres write
 * are `verify-live.ts`'s and `verify-pbx.ts`'s job, against a real broker and a real database.
 */

const ORGANIZATION_ID = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const AGENT_ID = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const USER_ID = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";
const OTHER_USER_ID = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

interface AgentRow {
	id: string;
	name: string;
	userId: string | null;
	status: string;
	statusChangedAt: Date | null;
	enabled: boolean;
}

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

/**
 * A database whose only job is to hand back rows.
 *
 * `withTenantScope` is faked rather than stubbed per-query because the service issues three
 * different reads and one write, and asserting on SQL here would be asserting on Drizzle. The
 * queries themselves are exercised against a real database by the verification scripts.
 */
function fakeDatabase(row: AgentRow | undefined): {
	database: PbxDatabaseClient;
	updates: { status: string }[];
} {
	const updates: { status: string }[] = [];
	const transaction = {
		select: (projection?: unknown) => ({
			from: () => ({
				where: () => ({
					limit: async () => (row === undefined ? [] : [row]),
					then: undefined,
				}),
			}),
		}),
		update: () => ({
			set: (values: { status: string }) => ({
				where: async () => {
					updates.push(values);
				},
			}),
		}),
	};
	const database = {
		withTenantScope: async <T>(
			_organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => await work(transaction as never),
	} as unknown as PbxDatabaseClient;
	return { database, updates };
}

/** A `withTenantScope` whose `select(...).from(...).where(...)` resolves as an array (no `limit`). */
function fakeDatabaseWithTiers(row: AgentRow | undefined, queueIds: readonly string[]) {
	const updates: { status: string }[] = [];
	const transaction = {
		select: (projection?: Record<string, unknown>) => ({
			from: () => {
				const isTierQuery = projection !== undefined && "queueId" in projection;
				const rows = isTierQuery ? queueIds.map((queueId) => ({ queueId })) : row === undefined ? [] : [row];
				const result = {
					limit: async () => rows,
					then: (resolve: (value: unknown) => void) => resolve(rows),
				};
				return { where: () => result };
			},
		}),
		update: () => ({
			set: (values: { status: string }) => ({
				where: async () => {
					updates.push(values);
				},
			}),
		}),
	};
	const database = {
		withTenantScope: async <T>(
			_organizationId: string,
			work: (tx: never) => Promise<T>,
		): Promise<T> => await work(transaction as never),
	} as unknown as PbxDatabaseClient;
	return { database, updates };
}

function fakePublisher(current: AgentStateEntry | undefined): {
	publisher: AgentStatePublisher;
	writes: { status: string; previousStatus?: string; reason?: string }[];
} {
	const writes: { status: string; previousStatus?: string; reason?: string }[] = [];
	const publisher = {
		read: async () => current,
		write: async (input: {
			status: string;
			previousStatus?: string;
			reason?: string;
			at: Date;
		}) => {
			writes.push({
				status: input.status,
				...(input.previousStatus === undefined ? {} : { previousStatus: input.previousStatus }),
				...(input.reason === undefined ? {} : { reason: input.reason }),
			});
			return {
				orgId: ORGANIZATION_ID,
				agentId: AGENT_ID,
				status: input.status,
				since: input.at.toISOString(),
				source: "api",
				...(input.reason === undefined ? {} : { reason: input.reason }),
			} as AgentStateEntry;
		},
	} as unknown as AgentStatePublisher;
	return { publisher, writes };
}

function agentRow(overrides: Partial<AgentRow> = {}): AgentRow {
	return {
		id: AGENT_ID,
		name: "Ada Lovelace",
		userId: USER_ID,
		status: "logged-out",
		statusChangedAt: null,
		enabled: true,
		...overrides,
	};
}

async function capture(work: () => Promise<unknown>): Promise<unknown> {
	try {
		await work();
		return undefined;
	} catch (error) {
		return error;
	}
}

describe("QueueAgentSessionService authorization", () => {
	it("lets a supervisor with queues.join move anybody", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ userId: OTHER_USER_ID }), []);
		const { publisher, writes } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(sessionFor(["queues.read", "queues.join"]), AGENT_ID, "login");
		expect(writes).to.have.length(1);
		expect(writes[0]?.status).to.equal("available");
	});

	it("lets queues.manage-agents do the same, since that is what its label promises", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ userId: OTHER_USER_ID }), []);
		const { publisher, writes } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(sessionFor(["queues.read", "queues.manage-agents"]), AGENT_ID, "login");
		expect(writes).to.have.length(1);
	});

	it("lets a linked agent move their OWN seat with queues.join.own", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow(), []);
		const { publisher, writes } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(sessionFor(["queues.read", "queues.join.own"]), AGENT_ID, "login");
		expect(writes).to.have.length(1);
	});

	it("refuses queues.join.own on somebody else's seat", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ userId: OTHER_USER_ID }), []);
		const { publisher, writes } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = await capture(() =>
			service.apply(sessionFor(["queues.read", "queues.join.own"]), AGENT_ID, "login"),
		);
		expect(thrown).to.be.instanceOf(QueueAgentSessionForbiddenException);
		expect(writes).to.have.length(0);
	});

	/**
	 * An unlinked seat cannot be "your own". The message says so rather than saying "forbidden",
	 * because linking it is a ten-second fix an admin can make and a bare 403 sends the user
	 * looking for a permission problem that is not theirs.
	 */
	it("refuses queues.join.own on an unlinked seat, and says why", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ userId: null }), []);
		const { publisher } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = (await capture(() =>
			service.apply(sessionFor(["queues.read", "queues.join.own"]), AGENT_ID, "login"),
		)) as QueueAgentSessionForbiddenException;
		expect(thrown).to.be.instanceOf(QueueAgentSessionForbiddenException);
		expect(JSON.stringify(thrown.getResponse())).to.contain("not linked");
	});

	it("refuses a caller holding neither join permission", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow(), []);
		const { publisher } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = await capture(() =>
			service.apply(sessionFor(["queues.read"]), AGENT_ID, "login"),
		);
		expect(thrown).to.be.instanceOf(QueueAgentSessionForbiddenException);
	});

	it("404s an agent this organization does not have, before authorizing anything", async () => {
		const { database } = fakeDatabaseWithTiers(undefined, []);
		const { publisher } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = await capture(() =>
			service.apply(sessionFor(["queues.read", "queues.join"]), AGENT_ID, "login"),
		);
		expect(thrown).to.be.instanceOf(QueueAgentNotFoundException);
	});
});

describe("QueueAgentSessionService transitions", () => {
	const supervisor = () => sessionFor(["queues.read", "queues.join"]);

	function entry(status: string): AgentStateEntry {
		return {
			orgId: ORGANIZATION_ID,
			agentId: AGENT_ID,
			status,
			since: "2026-08-06T09:00:00.000Z",
		} as AgentStateEntry;
	}

	it("carries the pause reason onto the write", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ status: "available" }), []);
		const { publisher, writes } = fakePublisher(entry("available"));
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(supervisor(), AGENT_ID, "pause", { reason: "Lunch" });
		expect(writes[0]).to.deep.equal({
			status: "on-break",
			previousStatus: "available",
			reason: "Lunch",
		});
	});

	/** A reason belongs to a break. Attaching one to a login would put "Lunch" on a wallboard. */
	it("drops a reason on any action but pause", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ status: "on-break" }), []);
		const { publisher, writes } = fakePublisher(entry("on-break"));
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(supervisor(), AGENT_ID, "resume", { reason: "Lunch" });
		expect(writes[0]?.reason).to.equal(undefined);
	});

	/**
	 * The bucket is written by two processes and the column by one, so a disagreement means the
	 * column is behind — never ahead. Planning against the column would let a stale "available"
	 * approve a transition the live state forbids.
	 */
	it("plans against the KV entry, not the persisted column", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow({ status: "available" }), []);
		const { publisher, writes } = fakePublisher(entry("on-call"));
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = await capture(() => service.apply(supervisor(), AGENT_ID, "pause"));
		expect(thrown).to.be.instanceOf(AgentTransitionRefusedException);
		expect(writes).to.have.length(0);
	});

	it("refuses a transition the machine does not have, and writes nothing", async () => {
		const { database, updates } = fakeDatabaseWithTiers(agentRow({ status: "on-call" }), []);
		const { publisher, writes } = fakePublisher(entry("on-call"));
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = (await capture(() =>
			service.apply(supervisor(), AGENT_ID, "pause"),
		)) as AgentTransitionRefusedException;
		expect(thrown).to.be.instanceOf(AgentTransitionRefusedException);
		expect(JSON.stringify(thrown.getResponse())).to.contain("not-adjacent");
		expect(writes).to.have.length(0);
		expect(updates).to.have.length(0);
	});

	/**
	 * A button pressed twice, two tabs, a retried request. Answering with the state that is already
	 * true is idempotent AND keeps the transition log free of edges that did not happen.
	 */
	it("treats a repeated action as a no-op rather than an error", async () => {
		const { database, updates } = fakeDatabaseWithTiers(agentRow({ status: "available" }), []);
		const { publisher, writes } = fakePublisher(entry("available"));
		const service = new QueueAgentSessionService(database, publisher);
		const result = await service.apply(supervisor(), AGENT_ID, "login");
		expect(result.changed).to.equal(false);
		expect(writes).to.have.length(0);
		expect(updates).to.have.length(0);
		expect(result.data.status).to.equal("available");
	});

	it("mirrors the new status onto the persisted column", async () => {
		const { database, updates } = fakeDatabaseWithTiers(agentRow(), []);
		const { publisher } = fakePublisher(undefined);
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(supervisor(), AGENT_ID, "login");
		expect(updates[0]?.status).to.equal("available");
	});

	it("names the queues the agent serves, so a per-queue consumer can filter", async () => {
		const queueId = "019fd3c2-9999-76be-a6b3-b0f1914e39b6";
		const { database } = fakeDatabaseWithTiers(agentRow(), [queueId]);
		let seen: readonly string[] | undefined;
		const publisher = {
			read: async () => undefined,
			write: async (input: { queueIds?: readonly string[]; at: Date; status: string }) => {
				seen = input.queueIds;
				return {
					orgId: ORGANIZATION_ID,
					agentId: AGENT_ID,
					status: input.status,
					since: input.at.toISOString(),
				} as AgentStateEntry;
			},
		} as unknown as AgentStatePublisher;
		const service = new QueueAgentSessionService(database, publisher);
		await service.apply(supervisor(), AGENT_ID, "login");
		expect(seen).to.deep.equal([queueId]);
	});

	/**
	 * The one write in the PBX area whose failure the CALLER has to hear about: distribution reads
	 * the bucket and nothing else, so a login that "worked" without reaching it leaves an agent by
	 * a phone that will never ring.
	 */
	it("surfaces an unreachable store as a 503 rather than a silent success", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow(), []);
		const publisher = {
			read: async () => undefined,
			write: async () => {
				const { AgentStateUnavailableError } = await import(
					"../../src/pbx/queues/agent-state.publisher"
				);
				throw new AgentStateUnavailableError();
			},
		} as unknown as AgentStatePublisher;
		const service = new QueueAgentSessionService(database, publisher);
		const thrown = await capture(() => service.apply(supervisor(), AGENT_ID, "login"));
		expect(thrown).to.be.instanceOf(AgentStateStoreUnavailableException);
	});

	it("reports whether the state is live or only the last known column value", async () => {
		const cold = fakeDatabaseWithTiers(agentRow({ status: "available" }), []);
		const service = new QueueAgentSessionService(cold.database, fakePublisher(undefined).publisher);
		const view = await service.get(supervisor(), AGENT_ID);
		expect(view.data.live).to.equal(false);
		expect(view.data.status).to.equal("available");
	});

	it("tells the caller what it may do, so a console renders only the buttons it holds", async () => {
		const { database } = fakeDatabaseWithTiers(agentRow(), []);
		const service = new QueueAgentSessionService(database, fakePublisher(undefined).publisher);
		const own = await service.get(sessionFor(["queues.read", "queues.join.own"]), AGENT_ID);
		expect(own.data.canManage).to.equal(false);
		expect(own.data.canManageSelf).to.equal(true);
		expect(own.data.self).to.equal(true);
	});
});

describe("the session DTOs", () => {
	it("accepts a pause with no reason", () => {
		expect(pauseAgentSessionDto.parse({})).to.deep.equal({});
	});

	it("trims and bounds a reason", () => {
		expect(pauseAgentSessionDto.parse({ reason: "  Lunch  " }).reason).to.equal("Lunch");
		expect(pauseAgentSessionDto.safeParse({ reason: "x".repeat(129) }).success).to.equal(false);
	});

	/**
	 * The ACTION is in the path, and it is the only thing that decides the target status. A body
	 * that could name one would be a second, unguarded way to write the machine.
	 */
	it("refuses a body that tries to name a status", () => {
		expect(emptyAgentSessionDto.safeParse({ status: "available" }).success).to.equal(false);
		expect(pauseAgentSessionDto.safeParse({ status: "on-break" }).success).to.equal(false);
	});
});

describe("the action vocabulary the surface exposes", () => {
	/** Four routes, four actions, four targets — and `ringing` is not reachable from any of them. */
	it("cannot reach the engine's own status", () => {
		for (const action of Object.keys(AGENT_SESSION_ACTION_TARGET) as AgentSessionAction[]) {
			expect(AGENT_SESSION_ACTION_TARGET[action]).to.not.equal("ringing");
		}
	});

	it("lets a logged-out agent log in and a ringing agent log out", () => {
		expect(planAgentSessionAction("login", "logged-out").outcome).to.equal("apply");
		expect(planAgentSessionAction("logout", "ringing").outcome).to.equal("apply");
	});
});
