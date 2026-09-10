import { expect } from "chai";
import { REQUIRE_PERMISSIONS_METADATA } from "../../src/auth/require-permissions.decorator";
import { QueuesController } from "../../src/pbx/queues/queues.controller";
import type { QueueCallbacksClient } from "../../src/pbx/queues/queue-callbacks.client";
import type {
	QueueAgentsService,
	QueueTiersService,
	QueuesService,
} from "../../src/pbx/queues/queues.service";
import type { AppSession } from "@optimiq-voice/auth";

/**
 * `GET /api/v1/queues/:id/callbacks`.
 *
 * A callback token is the `callback` block on a resume tombstone in the `queue-waiting` bucket, so
 * the control plane cannot answer "who are we still going to ring back?" from the database — until
 * this route existed it answered 404 for a promise a caller had already been given. Three things
 * are worth proving without a broker: that it is behind `queues.read` (a pending callback is the
 * queue's own state and nothing more), that the QUEUE is fetched first so another tenant's id is a
 * 404 before the bucket is touched, and that a deployment with no broker lists nothing rather than
 * failing.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const QUEUE = "019fd3c2-4444-76be-a6b3-b0f1914e39b6";

const SESSION = {
	session: { id: "sess", activeOrganizationId: ORG },
	user: { id: "u" },
} as unknown as AppSession;

function controllerFor(
	options: {
		readonly queue?: () => Promise<{ data: Record<string, unknown> }>;
		readonly callbacks?: QueueCallbacksClient;
	} = {},
): { readonly controller: QueuesController; readonly fetched: string[] } {
	const fetched: string[] = [];
	const queues = {
		get: async (_session: AppSession, id: string) => {
			fetched.push(id);
			return await (options.queue ?? (async () => ({ data: { organizationId: ORG } })))();
		},
	} as unknown as QueuesService;
	return {
		controller: new QueuesController(queues, {} as unknown as QueueTiersService, options.callbacks),
		fetched,
	};
}

function tombstone(overrides: Record<string, unknown> = {}) {
	return {
		callerNumber: "+15551234567",
		joinedAt: 1_000,
		priority: 0,
		abandonedAt: 2_000,
		expiresAt: 900_000,
		attempts: 1,
		maxAttempts: 3,
		nextAttemptAt: 30_000,
		...overrides,
	};
}

describe("the queue callbacks listing", () => {
	it("is behind `queues.read`, the same grant the queue itself is", () => {
		expect(
			Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA, QueuesController.prototype.listCallbacks),
		).to.deep.equal(["queues.read"]);
	});

	it("fetches the queue first, so the tenancy check happens before the bucket is read", async () => {
		let asked = 0;
		const callbacks = {
			pendingFor: async () => {
				asked += 1;
				return [];
			},
		} as unknown as QueueCallbacksClient;
		const { controller, fetched } = controllerFor({
			queue: async () => {
				throw new Error("not found");
			},
			callbacks,
		});

		let threw = false;
		try {
			await controller.listCallbacks(SESSION, QUEUE);
		} catch {
			threw = true;
		}

		expect(threw).to.equal(true);
		expect(fetched).to.deep.equal([QUEUE]);
		expect(asked).to.equal(0);
	});

	it("lists what the queue still owes, under the organization the queue row names", async () => {
		const asked: { organizationId: string; queueId: string }[] = [];
		const callbacks = {
			pendingFor: async (organizationId: string, queueId: string) => {
				asked.push({ organizationId, queueId });
				return [tombstone(), tombstone({ callerNumber: "1002", nextAttemptAt: 10_000 })];
			},
		} as unknown as QueueCallbacksClient;
		const { controller } = controllerFor({ callbacks });

		const result = await controller.listCallbacks(SESSION, QUEUE);

		expect(asked).to.deep.equal([{ organizationId: ORG, queueId: QUEUE }]);
		expect(result.data).to.have.length(2);
	});

	it("lists nothing rather than failing when this deployment has no broker", async () => {
		const { controller } = controllerFor();

		expect(await controller.listCallbacks(SESSION, QUEUE)).to.deep.equal({ data: [] });
	});
});
