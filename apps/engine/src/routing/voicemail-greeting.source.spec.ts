import { describe, expect, it } from "bun:test";
import { of, throwError } from "rxjs";
import { createEntityId } from "@optimiq-voice/identifiers";
import { VoicemailGreetingRpcPort } from "./voicemail-greeting.source";
import type { RecordedGreeting } from "./plan-walker";
import type { ClientProxy } from "@nestjs/microservices";

/**
 * The client side of `rpc.pbx.v1.file-greeting`.
 *
 * One invariant underneath every case here, and it is the whole reason `*99` checks its port before
 * it plays a beep: **the confirmation is only ever played for a greeting that was actually filed.**
 * A refusal, a reply this release cannot read and a broker with no responder are three different
 * things to an operator and one thing to the person holding the handset, so they collapse to a
 * throw at this seam — which the walk turns into the "not available" announcement.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const BOX = "0195c0f0-1c2f-7000-8000-0000000000b1";
const CALL = "0195c0f0-1c2f-7000-8000-0000000000c1";

function greeting(overrides: Partial<RecordedGreeting> = {}): RecordedGreeting {
	const recordingId = createEntityId();
	return {
		organizationId: ORG,
		voicemailBoxId: BOX,
		mailboxNumber: "1001",
		greetingId: createEntityId(),
		recordingId,
		objectKey: `${ORG}/${CALL}/${recordingId}.wav`,
		durationMs: 4_200,
		kind: "unavailable",
		callId: CALL,
		...overrides,
	};
}

function clientReturning(value: unknown): {
	proxy: ClientProxy;
	sent: { subject: string; payload: unknown }[];
} {
	const sent: { subject: string; payload: unknown }[] = [];
	const proxy = {
		send: (subject: string, payload: unknown) => {
			sent.push({ subject, payload });
			return of(value);
		},
	} as unknown as ClientProxy;
	return { proxy, sent };
}

function clientFailing(): ClientProxy {
	return {
		send: () => throwError(() => new Error("no responders available for request")),
	} as unknown as ClientProxy;
}

describe("VoicemailGreetingRpcPort", () => {
	it("asks on the versioned subject with the audio's key, not its bytes", async () => {
		const { proxy, sent } = clientReturning({ applied: true, kind: "unavailable", active: true });
		const recorded = greeting();
		await new VoicemailGreetingRpcPort(proxy).greetingRecorded(recorded);

		expect(sent[0]?.subject).toBe("rpc.pbx.v1.file-greeting");
		// The engine never holds the recording — the media server wrote it onto the shared mount — so
		// what crosses the broker is the name of the object and never a megabyte of PCM.
		expect(sent[0]?.payload).toMatchObject({
			orgId: ORG,
			voicemailBoxId: BOX,
			mailboxNumber: "1001",
			greetingId: recorded.greetingId,
			kind: "unavailable",
			objectKey: recorded.objectKey,
			durationMs: 4_200,
			callId: CALL,
		});
	});

	it("returns quietly when the greeting was filed", async () => {
		const { proxy } = clientReturning({ applied: true, kind: "unavailable", active: true });
		const port = new VoicemailGreetingRpcPort(proxy);

		await port.greetingRecorded(greeting());

		expect(port.stats).toEqual({ calls: 1, failures: 0 });
	});

	it("throws the responder's own reason when the greeting was refused", async () => {
		// The reason is carried rather than replaced: it is the only description of WHY that will ever
		// exist, and the walk writes it into the notes beside the object key so the audio is
		// recoverable by hand.
		const { proxy } = clientReturning({
			applied: false,
			kind: "unavailable",
			active: false,
			reason: "no enabled mailbox 1001 in this organization",
		});
		const port = new VoicemailGreetingRpcPort(proxy);

		await expect(port.greetingRecorded(greeting())).rejects.toThrow("no enabled mailbox 1001");
		expect(port.stats.failures).toBe(1);
	});

	it("throws when nobody answers, because a filed greeting is the only thing worth confirming", async () => {
		const port = new VoicemailGreetingRpcPort(clientFailing());

		await expect(port.greetingRecorded(greeting())).rejects.toThrow("did not answer");
	});

	it("treats a reply it cannot read as a greeting that was NOT filed", async () => {
		// Parsed, not trusted: the responder is another deployable on another release train, and a
		// malformed reply must produce the announcement rather than a confirmation for a field that
		// was not there.
		const { proxy } = clientReturning({ applied: "yes please" });
		const port = new VoicemailGreetingRpcPort(proxy);

		await expect(port.greetingRecorded(greeting())).rejects.toThrow("did not answer");
	});
});
