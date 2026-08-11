import { expect } from "chai";
import { WebhookDispatcher } from "../../src/pbx/webhooks/webhook-dispatcher.service";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { WebhookFetch } from "../../src/pbx/webhooks/webhook-delivery";
import type { DispatchMessage } from "../../src/pbx/webhooks/webhook-dispatcher.service";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The dispatcher's decision layer, with a fake broker message and a fake database.
 *
 * The point of these is the SEAM, not the SQL: that the organization comes from the delivered
 * subject and is what scopes the query, that a selector never chooses a tenant, that a message which
 * can never be delivered is terminated rather than redelivered forever, and that a failing endpoint
 * eventually stops consuming delivery slots. The SQL is `verify-pbx.ts`'s job, against a real
 * database.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-000000000002";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";
const SUBSCRIPTION = "0195c0f0-1c2f-7000-8000-0000000000a1";

function env(overrides: Partial<PbxEnv> = {}): PbxEnv {
	return {
		PBX_WEBHOOKS_ENABLED: true,
		PBX_WEBHOOK_TIMEOUT_MS: 1_000,
		PBX_WEBHOOK_MAX_ATTEMPTS: 1,
		PBX_WEBHOOK_RETRY_BASE_MS: 0,
		PBX_WEBHOOK_MAX_BACKOFF_MS: 0,
		PBX_WEBHOOK_CONCURRENCY: 4,
		PBX_WEBHOOK_FAILURE_LIMIT: 20,
		PBX_WEBHOOK_CACHE_TTL_MS: 30_000,
		PBX_WEBHOOK_ALLOW_INSECURE_URLS: false,
		...overrides,
	} as PbxEnv;
}

interface SubscriptionRow {
	readonly id: string;
	readonly url: string;
	readonly secret: string;
	readonly eventSelectors: readonly string[];
}

interface FakeDatabase {
	readonly client: PbxDatabaseClient;
	readonly scopes: string[];
	readonly selects: number;
	readonly updates: Record<string, unknown>[];
}

/**
 * A `PbxDatabaseClient` made of a chainable stub.
 *
 * Drizzle's builder is fluent and its terminal step differs per statement — `.limit()` for the
 * select, an awaited `.where()` for one update and `.returning()` for the other — so the stub
 * returns itself from every step and resolves whatever the last step set.
 */
function fakeDatabase(options: {
	readonly rows?: readonly SubscriptionRow[];
	readonly selectThrows?: boolean;
	readonly enabledAfterUpdate?: boolean;
}): FakeDatabase {
	const scopes: string[] = [];
	const updates: Record<string, unknown>[] = [];
	let selects = 0;

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
					selects += 1;
					if (options.selectThrows === true) {
						throw new Error("the pool is exhausted");
					}
					pending = options.rows ?? [];
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
				returning: async () =>
					await Promise.resolve([{ enabled: options.enabledAfterUpdate ?? true }]),
				then: (resolve: (value: unknown) => void) => {
					resolve(pending);
				},
			});
			return await run(chain);
		},
	} as unknown as PbxDatabaseClient;

	return {
		client,
		scopes,
		get selects() {
			return selects;
		},
		updates,
	};
}

interface FakeMessage extends DispatchMessage {
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

function callSubject(organizationId: string, event = "channel.answered"): string {
	return `calls.evt.v1.${organizationId}.${CALL}.${event}`;
}

function envelope(subject: string, type = "channel.answered"): Record<string, unknown> {
	return { id: "evt-1", at: "2026-08-11T12:00:00.000Z", orgId: ORG, subject, type, data: {} };
}

function recordingFetch(status = 200): {
	readonly fetchImpl: WebhookFetch;
	readonly urls: string[];
} {
	const urls: string[] = [];
	return {
		urls,
		fetchImpl: async (url) => {
			urls.push(url);
			return { status };
		},
	};
}

const SUBSCRIPTION_ROW: SubscriptionRow = {
	id: SUBSCRIPTION,
	url: "https://example.test/hook",
	secret: "whsec_test",
	eventSelectors: ["calls.evt.v1.>"],
};

describe("the webhook dispatcher", () => {
	it("scopes the subscription lookup to the organization the SUBJECT names", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const transport = recordingFetch();
		const dispatcher = new WebhookDispatcher(env(), database.client, transport.fetchImpl);
		const subject = callSubject(ORG);

		await dispatcher.dispatch(message(subject, envelope(subject)), "call");

		// The tenancy assertion: the query ran under the subject's organization, not under anything
		// the subscription or the payload asked for.
		expect(database.scopes[0]).to.equal(ORG);
		expect(transport.urls).to.deep.equal([SUBSCRIPTION_ROW.url]);
		expect(dispatcher.stats.delivered).to.equal(1);
	});

	it("terminates a payload whose envelope subject disagrees with its delivery subject", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const transport = recordingFetch();
		const dispatcher = new WebhookDispatcher(env(), database.client, transport.fetchImpl);
		const delivered = callSubject(ORG);
		const forged = message(delivered, envelope(callSubject(OTHER_ORG)));

		await dispatcher.dispatch(forged, "call");

		// Nothing was looked up and nothing was sent: this is the only shape a cross-tenant delivery
		// could take, and it never reaches a URL.
		expect(database.scopes).to.have.length(0);
		expect(transport.urls).to.have.length(0);
		expect(forged.termed()).to.equal(1);
	});

	it("acks without delivering when no subscription selected the event", async () => {
		const database = fakeDatabase({
			rows: [{ ...SUBSCRIPTION_ROW, eventSelectors: ["calls.evt.v1.channel.hangup"] }],
		});
		const transport = recordingFetch();
		const dispatcher = new WebhookDispatcher(env(), database.client, transport.fetchImpl);
		const subject = callSubject(ORG, "channel.answered");
		const delivery = message(subject, envelope(subject, "channel.answered"));

		await dispatcher.dispatch(delivery, "call");

		expect(transport.urls).to.have.length(0);
		expect(delivery.acked()).to.equal(1);
	});

	it("terminates a subject outside the taxonomy rather than redelivering it forever", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch().fetchImpl);
		const delivery = message("nonsense.subject", envelope("nonsense.subject"));

		await dispatcher.dispatch(delivery, "call");

		expect(delivery.termed()).to.equal(1);
		expect(delivery.naked()).to.equal(0);
	});

	it("terminates a message whose family disagrees with the consumer that delivered it", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch().fetchImpl);
		const subject = callSubject(ORG);
		const delivery = message(subject, envelope(subject));

		await dispatcher.dispatch(delivery, "queue");

		expect(delivery.termed()).to.equal(1);
		expect(database.scopes).to.have.length(0);
	});

	it("terminates an unreadable payload", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch().fetchImpl);
		const delivery = message(callSubject(ORG), "{not json");

		await dispatcher.dispatch(delivery, "call");

		expect(delivery.termed()).to.equal(1);
	});

	it("NAKs when the subscriptions cannot be read, because that is transient", async () => {
		const database = fakeDatabase({ selectThrows: true });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch().fetchImpl);
		const subject = callSubject(ORG);
		const delivery = message(subject, envelope(subject));

		await dispatcher.dispatch(delivery, "call");

		expect(delivery.naked()).to.equal(1);
		expect(delivery.acked()).to.equal(0);
		expect(delivery.termed()).to.equal(0);
	});

	it("acks a message a failing endpoint refused, and never NAKs on its behalf", async () => {
		// A NAK would redeliver to EVERY subscription, including the ones that already succeeded.
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW], enabledAfterUpdate: true });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch(500).fetchImpl);
		const subject = callSubject(ORG);
		const delivery = message(subject, envelope(subject));

		await dispatcher.dispatch(delivery, "call");

		expect(delivery.acked()).to.equal(1);
		expect(delivery.naked()).to.equal(0);
		expect(dispatcher.stats.failed).to.equal(1);
		// The failure was recorded, and the increment is SQL rather than a value this process read.
		expect(database.updates).to.have.length(1);
		expect(Object.keys(database.updates[0] ?? {})).to.include("consecutiveFailures");
		expect(Object.keys(database.updates[0] ?? {})).to.include("enabled");
	});

	it("counts a subscription as disabled, and drops the cache, when the update turns it off", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW], enabledAfterUpdate: false });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch(500).fetchImpl);
		const subject = callSubject(ORG);

		await dispatcher.dispatch(message(subject, envelope(subject)), "call");

		expect(dispatcher.stats.disabled).to.equal(1);
		// The cache was invalidated, so the next event re-reads rather than delivering to a
		// subscription the database has already switched off.
		const before = database.selects;
		await dispatcher.dispatch(message(subject, envelope(subject)), "call");
		expect(database.selects).to.be.greaterThan(before);
	});

	it("does not write the failure columns when auto-disabling is switched off", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const dispatcher = new WebhookDispatcher(
			env({ PBX_WEBHOOK_FAILURE_LIMIT: 0 }),
			database.client,
			recordingFetch(500).fetchImpl,
		);
		const subject = callSubject(ORG);

		await dispatcher.dispatch(message(subject, envelope(subject)), "call");

		expect(Object.keys(database.updates[0] ?? {})).to.not.include("enabled");
		expect(Object.keys(database.updates[0] ?? {})).to.include("consecutiveFailures");
	});

	it("caches a tenant's subscriptions for the configured window", async () => {
		const database = fakeDatabase({ rows: [SUBSCRIPTION_ROW] });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch().fetchImpl);
		const subject = callSubject(ORG);

		await dispatcher.dispatch(message(subject, envelope(subject)), "call");
		await dispatcher.dispatch(message(subject, envelope(subject)), "call");

		// One read for two events. The success bookkeeping still runs per delivery, which is why the
		// assertion is on the SELECT count rather than on the scope count.
		expect(database.selects).to.equal(1);

		dispatcher.invalidate(ORG);
		await dispatcher.dispatch(message(subject, envelope(subject)), "call");
		expect(database.selects).to.equal(2);
	});

	it("caches an EMPTY subscription list, so a tenant with no webhooks costs no round trips", async () => {
		const database = fakeDatabase({ rows: [] });
		const dispatcher = new WebhookDispatcher(env(), database.client, recordingFetch().fetchImpl);
		const subject = callSubject(ORG);

		await dispatcher.dispatch(message(subject, envelope(subject)), "call");
		await dispatcher.dispatch(message(subject, envelope(subject)), "call");

		expect(database.selects).to.equal(1);
	});
});
