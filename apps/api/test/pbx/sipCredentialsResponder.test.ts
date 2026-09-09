import { expect } from "chai";
import { RPC_SUBJECTS } from "@optimiq-voice/events/subjects";
import { SipCredentialsResponder } from "../../src/pbx/sip-credentials/sip-credentials.responder";
import type { PbxEnv } from "../../src/pbx/shared/pbx-env";
import type { SipCredentialsService } from "../../src/pbx/sip-credentials/sip-credentials.service";
import type { TrunkCredentialsService } from "../../src/pbx/sip-credentials/trunk-credentials.service";
import type { Msg, Subscription } from "nats";

/**
 * The responder answers REGISTER credential requests concurrently, bounded, and finishes every
 * accepted request when the subscription drains. These tests drive the private `consume` loop with
 * a fake subscription so no broker is needed.
 */

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fakeMessage(index: number, replies: string[]): Msg {
	return {
		subject: RPC_SUBJECTS.sipCredential,
		data: new TextEncoder().encode(JSON.stringify({ index })),
		respond(payload?: Uint8Array): boolean {
			replies.push(new TextDecoder().decode(payload));
			return true;
		},
	} as unknown as Msg;
}

function fakeSubscription(messages: Msg[]): Subscription {
	return {
		async *[Symbol.asyncIterator]() {
			for (const message of messages) {
				yield message;
			}
		},
	} as unknown as Subscription;
}

function responderWithAnswer(answer: (raw: string) => Promise<unknown>): {
	responder: SipCredentialsResponder;
	consume(subscription: Subscription): Promise<void>;
} {
	const responder = new SipCredentialsResponder(
		{} as PbxEnv,
		{} as SipCredentialsService,
		{} as TrunkCredentialsService,
	);
	const internals = responder as unknown as {
		answer(raw: string): Promise<unknown>;
		consume(subscription: Subscription): Promise<void>;
	};
	internals.answer = answer;
	return { responder, consume: (subscription) => internals.consume(subscription) };
}

describe("SipCredentialsResponder consume loop", () => {
	it("answers requests concurrently instead of one at a time", async () => {
		const gates: Deferred[] = [];
		let peak = 0;
		let running = 0;
		const { consume } = responderWithAnswer(async (raw) => {
			running += 1;
			peak = Math.max(peak, running);
			const gate = deferred();
			gates.push(gate);
			await gate.promise;
			running -= 1;
			return { ok: true, echo: JSON.parse(raw).index };
		});

		const replies: string[] = [];
		const messages = Array.from({ length: 8 }, (_, index) => fakeMessage(index, replies));
		const finished = consume(fakeSubscription(messages));

		// Every message is taken off the subscription before any answer completes.
		await new Promise((tick) => setImmediate(tick));
		expect(gates).to.have.length(8);
		expect(peak).to.equal(8);

		for (const gate of gates) gate.resolve();
		await finished;
		expect(replies).to.have.length(8);
		expect(replies.map((reply) => JSON.parse(reply).echo).sort()).to.deep.equal([
			0, 1, 2, 3, 4, 5, 6, 7,
		]);
	});

	it("caps the number of answers in flight and resumes as they settle", async () => {
		const gates: Deferred[] = [];
		let peak = 0;
		let running = 0;
		const { consume } = responderWithAnswer(async () => {
			running += 1;
			peak = Math.max(peak, running);
			const gate = deferred();
			gates.push(gate);
			await gate.promise;
			running -= 1;
			return { ok: true };
		});

		const replies: string[] = [];
		const messages = Array.from({ length: 40 }, (_, index) => fakeMessage(index, replies));
		const finished = consume(fakeSubscription(messages));

		await new Promise((tick) => setImmediate(tick));
		expect(gates).to.have.length(32);
		expect(peak).to.equal(32);

		gates[0].resolve();
		await new Promise((tick) => setImmediate(tick));
		expect(gates).to.have.length(33);

		for (const gate of gates) gate.resolve();
		// Later-added gates resolve too once the loop admits them.
		while (replies.length < 40) {
			for (const gate of gates) gate.resolve();
			await new Promise((tick) => setImmediate(tick));
		}
		await finished;
		expect(replies).to.have.length(40);
		expect(peak).to.equal(32);
	});

	it("waits for in-flight answers when the subscription ends", async () => {
		const gate = deferred();
		const { consume } = responderWithAnswer(async () => {
			await gate.promise;
			return { ok: true };
		});
		const replies: string[] = [];
		const finished = consume(fakeSubscription([fakeMessage(0, replies)]));

		let settled = false;
		void finished.then(() => {
			settled = true;
		});
		await new Promise((tick) => setImmediate(tick));
		expect(settled).to.equal(false);
		expect(replies).to.have.length(0);

		gate.resolve();
		await finished;
		expect(replies).to.have.length(1);
	});
});
