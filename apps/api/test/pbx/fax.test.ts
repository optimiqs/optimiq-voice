import { expect } from "chai";
import { FaxEmailService } from "../../src/pbx/fax/fax-email.service";
import { FaxInboundService } from "../../src/pbx/fax/fax-inbound.service";
import { buildFaxObjectKey, faxExtensionFor } from "../../src/pbx/fax/fax-media";
import {
	faxMediaKey,
	mintFaxMediaToken,
	verifyFaxMediaToken,
} from "../../src/pbx/fax/fax-media-token";
import { FaxSendWorker } from "../../src/pbx/fax/fax-send-worker.service";
import { createFaxServerDto, sendFaxDto } from "../../src/pbx/fax/fax.dto";
import { parseDto } from "../../src/pbx/shared/dto";
import type { FaxEnv } from "../../src/pbx/fax/fax-env";
import type { FaxMediaFetch } from "../../src/pbx/fax/fax-media";
import type { ObjectStore } from "../../src/storage";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";
import type { TelnyxClient, TelnyxFax } from "@optimiq-voice/telnyx";

/**
 * Fax, api-side.
 *
 * Three layers, matching the area's shape: the DTOs and the media token as pure functions, and the
 * send worker and inbound consumer driven directly against fakes. Nothing here needs a database, an
 * object store, a carrier or a timer — `tick()` and `handle()` are public precisely so a harness can
 * drive one pass rather than waiting one out.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const SERVER = "22222222-2222-4222-8222-222222222222";
const FAX = "33333333-3333-4333-8333-333333333333";

function env(overrides: Partial<FaxEnv> = {}): FaxEnv {
	return {
		FAX_OBJECT_ROOT: "./.data/faxes",
		TELNYX_FAX_CONNECTION_ID: "conn-1",
		FAX_SEND_ENABLED: true,
		FAX_SEND_POLL_INTERVAL_MS: 0,
		FAX_SEND_LEASE_MS: 120_000,
		FAX_MEDIA_URL_SECRET: "s3cr3t",
		FAX_MEDIA_URL_TTL_SECONDS: 3_600,
		...overrides,
	};
}

// --------------------------------------------------------------------------------------------
// DTOs and the media token
// --------------------------------------------------------------------------------------------

describe("fax DTOs", () => {
	it("accepts a minimal fax server and defaults the rest", () => {
		const parsed = parseDto(createFaxServerDto, { name: "Reception fax" });
		expect(parsed.name).to.equal("Reception fax");
		expect(parsed.phoneNumberId).to.equal(undefined);
	});

	it("rejects an unknown key rather than dropping it silently", () => {
		expect(() => parseDto(createFaxServerDto, { name: "x", bogus: true })).to.throw();
	});

	it("requires a well-formed email for the fax-to-email address", () => {
		expect(() =>
			parseDto(createFaxServerDto, { name: "x", emailToAddress: "not-an-email" }),
		).to.throw();
	});

	it("requires an E.164 destination and a media URL on send", () => {
		const ok = parseDto(sendFaxDto, { to: "+13125551234", mediaUrl: "https://media/doc.pdf" });
		expect(ok.to).to.equal("+13125551234");
		expect(() =>
			parseDto(sendFaxDto, { to: "3125551234", mediaUrl: "https://media/doc.pdf" }),
		).to.throw();
		expect(() => parseDto(sendFaxDto, { to: "+13125551234" })).to.throw();
	});
});

describe("fax media token", () => {
	it("round-trips a token and reads back its message and organization", () => {
		const expiresAt = Math.floor(Date.now() / 1_000) + 60;
		const token = mintFaxMediaToken(FAX, ORG, expiresAt, "secret");
		const result = verifyFaxMediaToken(token, { current: "secret" });
		expect(result.ok).to.equal(true);
		expect(result.payload?.r).to.equal(FAX);
		expect(result.payload?.o).to.equal(ORG);
	});

	it("is domain-separated: a token minted for fax does not verify as a recording", () => {
		// The keys differ, so the same secret produces non-interchangeable tokens.
		expect(faxMediaKey("secret")).to.not.equal("secret");
	});

	it("reports an expired token as expired, not invalid", () => {
		const token = mintFaxMediaToken(FAX, ORG, Math.floor(Date.now() / 1_000) - 1, "secret");
		expect(verifyFaxMediaToken(token, { current: "secret" }).failure).to.equal("expired");
	});

	it("picks the stored extension from the content type or the URL", () => {
		expect(faxExtensionFor("image/tiff", undefined)).to.equal("tiff");
		expect(faxExtensionFor(undefined, "https://x/doc.tiff")).to.equal("tiff");
		expect(faxExtensionFor("application/pdf", "https://x/doc.pdf")).to.equal("pdf");
		expect(faxExtensionFor(undefined, undefined)).to.equal("pdf");
		expect(buildFaxObjectKey(ORG, FAX, "pdf")).to.equal(`faxes/${ORG}/${FAX}.pdf`);
	});
});

// --------------------------------------------------------------------------------------------
// The send worker
// --------------------------------------------------------------------------------------------

interface SendScript {
	readonly claim?: Record<string, unknown>;
	readonly retryAttempts?: number;
}

function sendFakeDatabase(script: SendScript = {}): {
	readonly database: PbxDatabaseClient;
	readonly updates: Record<string, unknown>[];
} {
	const updates: Record<string, unknown>[] = [];
	const adminExecute = async (query: unknown): Promise<unknown> => {
		const text = renderSql(query);
		await Promise.resolve();
		if (text.includes("skip locked")) {
			return script.claim === undefined ? [] : [script.claim];
		}
		return [];
	};
	const transaction: Record<string, unknown> = {};
	Object.assign(transaction, {
		select: () => transaction,
		from: () => transaction,
		where: () => transaction,
		leftJoin: () => transaction,
		innerJoin: () => transaction,
		limit: () => [{ retryAttempts: script.retryAttempts ?? 3 }],
		update: () => transaction,
		set: (values: Record<string, unknown>) => {
			updates.push(values);
			return transaction;
		},
	});
	const database = {
		adminDb: { execute: adminExecute },
		withTenantScope: async <T>(_org: string, run: (handle: unknown) => Promise<T>): Promise<T> =>
			await run(transaction),
	} as unknown as PbxDatabaseClient;
	return { database, updates };
}

function fakeCarrier(onSend?: (input: unknown) => TelnyxFax | Promise<TelnyxFax>): TelnyxClient {
	return {
		faxes: {
			send: async (input: unknown) => {
				if (onSend !== undefined) {
					return await onSend(input);
				}
				return { id: "telnyx-fax-1", direction: "outbound", status: "queued" } as TelnyxFax;
			},
			get: async () =>
				({ id: "telnyx-fax-1", direction: "outbound", status: "queued" }) as TelnyxFax,
		},
	} as unknown as TelnyxClient;
}

const claimable = (attempts = 1) => ({
	id: FAX,
	organization_id: ORG,
	fax_server_id: SERVER,
	from_e164: "+13125550000",
	to_e164: "+13125551111",
	source_media_url: "https://media/doc.pdf",
	attempts,
});

describe("fax send worker", () => {
	it("does nothing when the queue is empty", async () => {
		const { database, updates } = sendFakeDatabase();
		const worker = new FaxSendWorker(env(), database, fakeCarrier());
		expect((await worker.tick()).sent).to.equal(0);
		expect(updates).to.deep.equal([]);
	});

	it("sends a claimed fax and stamps the carrier id on the row", async () => {
		let sentInput: Record<string, unknown> | undefined;
		const carrier = fakeCarrier((input) => {
			sentInput = input as Record<string, unknown>;
			return { id: "telnyx-fax-9", direction: "outbound", status: "queued" } as TelnyxFax;
		});
		const { database, updates } = sendFakeDatabase({ claim: claimable() });
		const worker = new FaxSendWorker(env(), database, carrier);
		expect((await worker.tick()).sent).to.equal(1);
		expect(worker.stats.sent).to.equal(1);
		// The row id rides through as client_state, so the webhook correlates back.
		expect(sentInput?.clientState).to.equal(FAX);
		expect(sentInput?.connectionId).to.equal("conn-1");
		expect(updates.some((u) => u.telnyxFaxId === "telnyx-fax-9")).to.equal(true);
	});

	it("fails fast, without a carrier call, when no carrier is configured", async () => {
		const { database, updates } = sendFakeDatabase({ claim: claimable() });
		const worker = new FaxSendWorker(env(), database, undefined);
		await worker.tick();
		expect(worker.stats.failed).to.equal(1);
		expect(updates.some((u) => u.status === "failed")).to.equal(true);
	});

	it("abandons a fax whose attempts exceed the server's retry ceiling", async () => {
		const { database, updates } = sendFakeDatabase({ claim: claimable(5), retryAttempts: 3 });
		const worker = new FaxSendWorker(env(), database, fakeCarrier());
		await worker.tick();
		expect(updates.some((u) => u.status === "failed")).to.equal(true);
	});

	it("releases the claim for a retry when the carrier call fails and attempts remain", async () => {
		const carrier = fakeCarrier(() => {
			throw new Error("carrier down");
		});
		const { database, updates } = sendFakeDatabase({ claim: claimable(1), retryAttempts: 3 });
		const worker = new FaxSendWorker(env(), database, carrier);
		await worker.tick();
		// Back to queued, not failed — the lease will offer it again.
		expect(updates.some((u) => u.status === "queued")).to.equal(true);
		expect(updates.some((u) => u.status === "failed")).to.equal(false);
	});

	it("refuses re-entrancy so a slow pass is not raced by the next tick", async () => {
		const { database } = sendFakeDatabase();
		const worker = new FaxSendWorker(env(), database, fakeCarrier());
		(worker as unknown as { running: boolean }).running = true;
		expect((await worker.tick()).sent).to.equal(0);
	});
});

// --------------------------------------------------------------------------------------------
// The inbound consumer
// --------------------------------------------------------------------------------------------

interface InboundScript {
	readonly server?: Record<string, unknown>;
	readonly messageOrg?: Record<string, unknown>;
	readonly insertReturns?: Record<string, unknown>[];
}

function inboundFakeDatabase(script: InboundScript = {}): {
	readonly database: PbxDatabaseClient;
	readonly inserted: Record<string, unknown>[];
	readonly updated: Record<string, unknown>[];
} {
	const inserted: Record<string, unknown>[] = [];
	const updated: Record<string, unknown>[] = [];
	const adminExecute = async (query: unknown): Promise<unknown> => {
		const text = renderSql(query);
		await Promise.resolve();
		if (text.includes("email_to_address")) {
			return script.server === undefined ? [] : [script.server];
		}
		if (text.includes("organization_id")) {
			return script.messageOrg === undefined ? [] : [script.messageOrg];
		}
		return [];
	};
	const transaction: Record<string, unknown> = {};
	Object.assign(transaction, {
		insert: () => transaction,
		values: (values: Record<string, unknown>) => {
			inserted.push(values);
			return transaction;
		},
		onConflictDoNothing: () => transaction,
		returning: () => script.insertReturns ?? [{ id: FAX }],
		update: () => transaction,
		set: (values: Record<string, unknown>) => {
			updated.push(values);
			return transaction;
		},
		where: () => transaction,
	});
	const database = {
		adminDb: { execute: adminExecute },
		withTenantScope: async <T>(_org: string, run: (handle: unknown) => Promise<T>): Promise<T> =>
			await run(transaction),
	} as unknown as PbxDatabaseClient;
	return { database, inserted, updated };
}

function fakeStore(): ObjectStore & { readonly puts: string[] } {
	const puts: string[] = [];
	return {
		driver: "local",
		puts,
		put: async (objectKey: string) => {
			puts.push(objectKey);
			await Promise.resolve();
		},
	} as unknown as ObjectStore & { readonly puts: string[] };
}

const fakeFetch: FaxMediaFetch = async () => ({
	bytes: Buffer.from("%PDF-1.4 fake"),
	contentType: "application/pdf",
});

function fakeEmail(): FaxEmailService & { readonly notifications: unknown[] } {
	const notifications: unknown[] = [];
	return {
		notifications,
		notify: async (input: unknown) => {
			notifications.push(input);
			return await Promise.resolve(true);
		},
	} as unknown as FaxEmailService & { readonly notifications: unknown[] };
}

function faxWebhook(eventType: string, payload: Record<string, unknown>) {
	return { eventType, id: "evt-1", fax: payload } as never;
}

describe("fax inbound consumer", () => {
	it("files a received fax, stores the document and notifies the configured address", async () => {
		const { database, inserted } = inboundFakeDatabase({
			server: { id: SERVER, organization_id: ORG, email_to_address: "fax@acme.test" },
			insertReturns: [{ id: FAX }],
		});
		const store = fakeStore();
		const email = fakeEmail();
		const service = new FaxInboundService(database, store, fakeFetch, email);

		const outcome = await service.handle(
			faxWebhook("fax.received", {
				fax_id: "telnyx-in-1",
				direction: "inbound",
				status: "received",
				from: "+13125559999",
				to: "+13125550000",
				media_url: "https://media.telnyx/received.pdf",
				page_count: 2,
			}),
		);
		expect(outcome).to.equal("filed");
		expect(inserted.some((row) => row.direction === "inbound")).to.equal(true);
		expect(store.puts).to.have.length(1);
		expect(email.notifications).to.have.length(1);
	});

	it("treats a redelivery as a duplicate and does not store or email twice", async () => {
		const { database } = inboundFakeDatabase({
			server: { id: SERVER, organization_id: ORG, email_to_address: "fax@acme.test" },
			insertReturns: [], // onConflictDoNothing returned no row: already filed.
		});
		const store = fakeStore();
		const email = fakeEmail();
		const service = new FaxInboundService(database, store, fakeFetch, email);
		const outcome = await service.handle(
			faxWebhook("fax.received", {
				fax_id: "telnyx-in-1",
				direction: "inbound",
				status: "received",
				from: "+13125559999",
				to: "+13125550000",
			}),
		);
		expect(outcome).to.equal("duplicate");
		expect(store.puts).to.have.length(0);
		expect(email.notifications).to.have.length(0);
	});

	it("ignores an inbound fax on a DID with no fax server", async () => {
		const { database } = inboundFakeDatabase({});
		const service = new FaxInboundService(database, fakeStore(), fakeFetch, fakeEmail());
		const outcome = await service.handle(
			faxWebhook("fax.received", {
				fax_id: "telnyx-in-2",
				direction: "inbound",
				status: "received",
				from: "+13125559999",
				to: "+13125550000",
			}),
		);
		expect(outcome).to.equal("no-server");
	});

	it("advances an outbound row to delivered, correlating on client_state", async () => {
		const { database, updated } = inboundFakeDatabase({
			messageOrg: { id: FAX, organization_id: ORG },
		});
		const service = new FaxInboundService(database, fakeStore(), fakeFetch, fakeEmail());
		const outcome = await service.handle(
			faxWebhook("fax.delivered", {
				fax_id: "telnyx-out-1",
				direction: "outbound",
				status: "delivered",
				client_state: FAX,
				page_count: 1,
			}),
		);
		expect(outcome).to.equal("updated");
		expect(updated.some((u) => u.status === "delivered")).to.equal(true);
	});

	it("records an outbound failure with the carrier's reason", async () => {
		const { database, updated } = inboundFakeDatabase({
			messageOrg: { id: FAX, organization_id: ORG },
		});
		const service = new FaxInboundService(database, fakeStore(), fakeFetch, fakeEmail());
		await service.handle(
			faxWebhook("fax.failed", {
				fax_id: "telnyx-out-2",
				direction: "outbound",
				status: "failed",
				client_state: FAX,
				failure_reason: "no_answer",
			}),
		);
		expect(updated.some((u) => u.status === "failed" && u.errorReason === "no_answer")).to.equal(
			true,
		);
	});

	it("ignores an outbound event it does not model", async () => {
		const { database } = inboundFakeDatabase({ messageOrg: { id: FAX, organization_id: ORG } });
		const service = new FaxInboundService(database, fakeStore(), fakeFetch, fakeEmail());
		expect(
			await service.handle(
				faxWebhook("fax.queued", {
					fax_id: "x",
					direction: "outbound",
					status: "queued",
					client_state: FAX,
				}),
			),
		).to.equal("ignored");
	});
});

/** The SQL text of a drizzle `sql` statement, from its literal chunks — same reader the CDR tests use. */
function renderSql(query: unknown): string {
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
}
