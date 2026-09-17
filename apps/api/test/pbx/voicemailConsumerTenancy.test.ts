import { expect } from "chai";
import { makeVoicemailEvent } from "@optimiq-voice/events/schemas";
import { VoicemailConsumer } from "../../src/pbx/voicemail-boxes/voicemail-consumer.service";
import type { PbxDatabaseClient } from "@optimiq-voice/pbx-db";

/**
 * The voicemail consumer's tenancy cross-check.
 *
 * `voicemail.evt.v1.<orgId>.<mailboxId>.<event>` puts the tenant in the ADDRESS, and JetStream is
 * what proves an envelope arrived on the subject its filter matched. The body carries an `orgId`
 * too, and the only safe thing to do with two copies of one fact is to compare them and scope the
 * write by the one the transport vouched for. A check that compared the envelope's subject to
 * itself would pass on every message including a forged one, which is what this covers:
 *
 *  1. A matching envelope files under the SUBJECT's org token.
 *  2. An envelope whose `orgId` disagrees with the subject is terminated, not NAKed — a redelivery
 *     will carry the same disagreement forever.
 *  3. An envelope whose own `subject` field disagrees with the delivery subject is terminated too.
 */

const ORG = "019fd3c2-1111-76be-a6b3-b0f1914e39b6";
const OTHER_ORG = "019fd3c2-2222-76be-a6b3-b0f1914e39b6";
const BOX = "019fd3c2-3333-76be-a6b3-b0f1914e39b6";

interface Delivery {
	readonly subject: string;
	readonly data: Uint8Array;
	ack(): void;
	nak(millis?: number): void;
	term(): void;
}

interface Outcome {
	readonly message: Delivery;
	readonly acked: () => number;
	readonly termed: () => number;
	readonly naked: () => number;
}

function deliveryOf(subject: string, envelope: unknown): Outcome {
	let acked = 0;
	let termed = 0;
	let naked = 0;
	const message: Delivery = {
		subject,
		data: new TextEncoder().encode(JSON.stringify(envelope)),
		ack: () => {
			acked += 1;
		},
		nak: () => {
			naked += 1;
		},
		term: () => {
			termed += 1;
		},
	};
	return { message, acked: () => acked, termed: () => termed, naked: () => naked };
}

function messageLeft(orgId: string, mailboxId: string): Record<string, unknown> {
	return makeVoicemailEvent("message.left", {
		orgId,
		source: "test",
		mailboxId,
		data: {
			messageId: "019fd3c2-4444-76be-a6b3-b0f1914e39b6",
			mailboxNumber: "2001",
			callId: "019fd3c2-5555-76be-a6b3-b0f1914e39b6",
			legId: "019fd3c2-6666-76be-a6b3-b0f1914e39b6",
			recordingId: "019fd3c2-7777-76be-a6b3-b0f1914e39b6",
			objectKey: "voicemail/box/message.wav",
			durationMs: 4200,
			receivedAt: new Date().toISOString(),
		},
	}) as unknown as Record<string, unknown>;
}

interface Scoped {
	readonly database: PbxDatabaseClient;
	readonly scopes: string[];
}

/** A database that records the tenant every `withTenantScope` was opened for, and finds no box. */
function recordingDatabase(): Scoped {
	const scopes: string[] = [];
	const chain = (): Record<string, unknown> => {
		const self: Record<string, unknown> = {};
		self.from = () => self;
		self.leftJoin = () => self;
		self.where = () => self;
		self.limit = async () => [] as unknown[];
		return self;
	};
	const database = {
		withTenantScope: async <T>(organizationId: string, work: (t: never) => Promise<T>) => {
			scopes.push(organizationId);
			return await work({ select: () => chain() } as never);
		},
	} as unknown as PbxDatabaseClient;
	return { database, scopes };
}

function consumerOn(database: PbxDatabaseClient): VoicemailConsumer {
	return new VoicemailConsumer(
		{} as never,
		database,
		{} as never,
		{} as never,
		{} as never,
		{ enabled: false } as never,
	);
}

/** `handle` is private; the test drives it directly because it IS the tenancy boundary. */
async function handle(consumer: VoicemailConsumer, message: Delivery): Promise<void> {
	await (consumer as unknown as { handle: (m: Delivery) => Promise<void> }).handle(message);
}

describe("the voicemail consumer's tenancy check", () => {
	it("scopes the write by the SUBJECT's org token, not the body's", async () => {
		const { database, scopes } = recordingDatabase();
		const subject = `voicemail.evt.v1.${ORG}.${BOX}.message.left`;
		const delivery = deliveryOf(subject, messageLeft(ORG, BOX));

		await handle(consumerOn(database), delivery.message);

		expect(scopes).to.deep.equal([ORG]);
		// The box does not exist in the fake, which is the documented terminate rather than a NAK.
		expect(delivery.termed()).to.equal(1);
		expect(delivery.naked()).to.equal(0);
	});

	it("terminates an envelope whose orgId disagrees with the subject, without opening a scope", async () => {
		const { database, scopes } = recordingDatabase();
		// The subject a foreign publisher could not have got past the stream's filter, carrying a body
		// that claims another tenant. The envelope's own `subject` is rewritten to match the delivery
		// so this test fails for the orgId reason and not the subject one.
		const envelope = messageLeft(OTHER_ORG, BOX);
		const subject = `voicemail.evt.v1.${ORG}.${BOX}.message.left`;
		const delivery = deliveryOf(subject, { ...envelope, subject });

		await handle(consumerOn(database), delivery.message);

		expect(delivery.termed()).to.equal(1);
		expect(delivery.acked()).to.equal(0);
		expect(scopes).to.deep.equal([]);
	});

	it("terminates an envelope delivered on a subject other than its own", async () => {
		const { database, scopes } = recordingDatabase();
		const delivery = deliveryOf(
			`voicemail.evt.v1.${OTHER_ORG}.${BOX}.message.left`,
			messageLeft(ORG, BOX),
		);

		await handle(consumerOn(database), delivery.message);

		expect(delivery.termed()).to.equal(1);
		expect(scopes).to.deep.equal([]);
	});
});
