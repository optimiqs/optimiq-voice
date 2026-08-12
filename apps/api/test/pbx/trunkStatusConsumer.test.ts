import { expect } from "chai";
import { TrunkStatusConsumer } from "../../src/pbx/trunks/trunk-status-consumer.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { TrunkStatusMessage } from "../../src/pbx/trunks/trunk-status-consumer.service";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The trunk status writer's decision layer, with a fake broker message and a fake database.
 *
 * The point of these is the SEAM, not the SQL: that the organization scoping the write comes from
 * the delivered subject (cross-checked against the envelope), that a message which can never be
 * filed is terminated rather than redelivered forever, that a redelivery cannot move
 * `status_changed_at` backwards, and that a transient database failure is NAKed so the transition
 * is not lost. The SQL itself is `verify-pbx.ts`'s business, against a real database.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";
const TRUNK = "0195c0f0-1c2f-7000-8000-0000000000b1";
const EVENT_ID = "0195c0f0-1c2f-7000-8000-0000000000e1";
const AT = "2026-08-11T12:00:00.000Z";

function env(): PbxEnv {
	// `dispatch` reads nothing from the environment; the connection lifecycle (which does) is the
	// gated integration suite's business.
	return {} as PbxEnv;
}

interface TrunkRow {
	readonly id: string;
	readonly statusChangedAt: Date | null;
}

interface FakeDatabase {
	readonly client: PbxDatabaseClient;
	readonly scopes: string[];
	readonly updates: Record<string, unknown>[];
}

/**
 * A `PbxDatabaseClient` made of a chainable stub, on the `webhookDispatcher.test.ts` pattern:
 * drizzle's builder is fluent and its terminal step differs per statement — `.limit()` for the
 * select, an awaited `.where()` for the update — so the stub returns itself from every step and
 * resolves whatever the last step set.
 */
function fakeDatabase(options: {
	readonly row?: TrunkRow | undefined;
	readonly selectThrows?: boolean;
}): FakeDatabase {
	const scopes: string[] = [];
	const updates: Record<string, unknown>[] = [];

	const client = {
		withTenantScope: async <T>(
			organizationId: string,
			run: (transaction: unknown) => Promise<T>,
		): Promise<T> => {
			scopes.push(organizationId);
			let pending: unknown;
			const chain: Record<string, unknown> = {};
			Object.assign(chain, {
				select: () => {
					if (options.selectThrows === true) {
						throw new Error("the pool is exhausted");
					}
					pending = options.row === undefined ? [] : [options.row];
					return chain;
				},
				from: () => chain,
				where: () => chain,
				limit: async () => await Promise.resolve(pending ?? []),
				update: () => {
					pending = undefined;
					return chain;
				},
				set: (values: Record<string, unknown>) => {
					updates.push(values);
					return chain;
				},
				then: (resolve: (value: unknown) => void) => {
					resolve(pending);
				},
			});
			return await run(chain);
		},
	} as unknown as PbxDatabaseClient;

	return { client, scopes, updates };
}

interface FakeMessage extends TrunkStatusMessage {
	readonly acked: () => number;
	readonly naked: () => number;
	readonly termed: () => number;
}

function message(subject: string, payload: unknown): FakeMessage {
	let acked = 0;
	let naked = 0;
	let termed = 0;
	return {
		subject,
		data: new TextEncoder().encode(typeof payload === "string" ? payload : JSON.stringify(payload)),
		ack: () => {
			acked += 1;
		},
		nak: () => {
			naked += 1;
		},
		term: () => {
			termed += 1;
		},
		acked: () => acked,
		naked: () => naked,
		termed: () => termed,
	};
}

function trunkSubject(organizationId: string, trunkId = TRUNK): string {
	return `trunk.evt.v1.${organizationId}.${trunkId}.status.changed`;
}

function envelope(
	subject: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: EVENT_ID,
		at: AT,
		orgId: ORG,
		subject,
		type: "status.changed",
		source: "engine",
		data: { status: "down", reason: "Unreachable", latencyMs: 1_240, endpoint: "carrier-a" },
		...overrides,
	};
}

describe("the trunk status consumer", () => {
	it("writes the four status columns, scoped to the organization the subject names", async () => {
		const database = fakeDatabase({ row: { id: TRUNK, statusChangedAt: null } });
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const subject = trunkSubject(ORG);

		const outcome = await consumer.dispatch(message(subject, envelope(subject)));

		expect(outcome).to.equal("written");
		expect(database.scopes).to.deep.equal([ORG]);
		expect(database.updates).to.deep.equal([
			{
				status: "down",
				statusChangedAt: new Date(AT),
				statusReason: "Unreachable",
				statusLatencyMs: 1_240,
			},
		]);
		expect(consumer.stats.written).to.equal(1);
	});

	it("writes null reason and latency when the event carries neither", async () => {
		// The columns are nullable and a transition with no rider must CLEAR them: leaving last
		// outage's reason beside this recovery's status would be a row that lies.
		const database = fakeDatabase({ row: { id: TRUNK, statusChangedAt: null } });
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const subject = trunkSubject(ORG);

		await consumer.dispatch(message(subject, envelope(subject, { data: { status: "up" } })));

		expect(database.updates).to.deep.equal([
			{
				status: "up",
				statusChangedAt: new Date(AT),
				statusReason: null,
				statusLatencyMs: null,
			},
		]);
	});

	it("terminates a payload that is not readable as a trunk event", async () => {
		const database = fakeDatabase({ row: { id: TRUNK, statusChangedAt: null } });
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const delivery = message(trunkSubject(ORG), "not json");

		const outcome = await consumer.dispatch(delivery);

		expect(outcome).to.equal("terminated");
		expect(delivery.termed()).to.equal(1);
		expect(database.scopes).to.have.length(0);
	});

	it("terminates an envelope whose own subject disagrees with its delivery subject", async () => {
		// The only shape a cross-tenant write could take: nothing is looked up and nothing is
		// written under either organization.
		const database = fakeDatabase({ row: { id: TRUNK, statusChangedAt: null } });
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const delivered = trunkSubject(ORG);
		const forged = message(delivered, envelope(trunkSubject(OTHER_ORG), { orgId: OTHER_ORG }));

		const outcome = await consumer.dispatch(forged);

		expect(outcome).to.equal("terminated");
		expect(forged.termed()).to.equal(1);
		expect(database.scopes).to.have.length(0);
		expect(database.updates).to.have.length(0);
	});

	it("terminates a transition for a trunk that does not exist, rather than retrying forever", async () => {
		const database = fakeDatabase({ row: undefined });
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const subject = trunkSubject(ORG);

		const outcome = await consumer.dispatch(message(subject, envelope(subject)));

		expect(outcome).to.equal("unknown-trunk");
		expect(database.updates).to.have.length(0);
		expect(consumer.stats.terminated).to.equal(1);
	});

	it("acks a redelivery older than what the row already records, without writing", async () => {
		// JetStream re-offers a NAKed delivery AFTER newer messages have been consumed, so the
		// write refuses to move status_changed_at backwards.
		const database = fakeDatabase({
			row: { id: TRUNK, statusChangedAt: new Date("2026-08-11T12:05:00.000Z") },
		});
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const subject = trunkSubject(ORG);
		const delivery = message(subject, envelope(subject));

		const outcome = await consumer.dispatch(delivery);

		expect(outcome).to.equal("superseded");
		expect(delivery.acked()).to.equal(1);
		expect(database.updates).to.have.length(0);
		expect(consumer.stats.superseded).to.equal(1);
	});

	it("naks a transient database failure so the transition is redelivered, not lost", async () => {
		const database = fakeDatabase({ selectThrows: true });
		const consumer = new TrunkStatusConsumer(env(), database.client);
		const subject = trunkSubject(ORG);
		const delivery = message(subject, envelope(subject));

		const outcome = await consumer.dispatch(delivery);

		expect(outcome).to.equal("failed");
		expect(delivery.naked()).to.equal(1);
		expect(delivery.termed()).to.equal(0);
	});
});
