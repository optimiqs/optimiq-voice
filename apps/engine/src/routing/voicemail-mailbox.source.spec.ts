import { describe, expect, it } from "bun:test";
import { of, throwError } from "rxjs";
import { createEntityId } from "@optimiq-voice/identifiers";
import { VoicemailMailboxRpcSource } from "./voicemail-mailbox.source";
import type { EngineEnv } from "../config/engine-env";
import type { ClientProxy } from "@nestjs/microservices";

/**
 * The client side of `rpc.voicemail.v1.list`.
 *
 * Nobody answers this subject yet, so the failure paths are not edge cases here — they are the
 * production path until the API responder lands, and they are what these specs mostly assert.
 * The single invariant underneath all of them: **a mailbox that could not be read is never
 * reported as an empty one.**
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const BOX = "0195c0f0-1c2f-7000-8000-0000000000b1";

const ENV = { ENGINE_VOICEMAIL_RPC_TIMEOUT_MS: 500 } as EngineEnv;

function clientReturning(value: unknown): { proxy: ClientProxy; sent: unknown[] } {
	const sent: unknown[] = [];
	const proxy = {
		send: (_subject: string, payload: unknown) => {
			sent.push(payload);
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

const REQUEST = { organizationId: ORG, voicemailBoxId: BOX, mailboxNumber: "1001" };

describe("VoicemailMailboxRpcSource", () => {
	it("asks on the versioned subject with the box the walk authenticated", async () => {
		const { proxy, sent } = clientReturning({ found: true, messages: [], total: 0 });
		await new VoicemailMailboxRpcSource(ENV, proxy).list({ ...REQUEST, callId: createEntityId() });

		expect(sent[0]).toMatchObject({
			orgId: ORG,
			voicemailBoxId: BOX,
			mailboxNumber: "1001",
			folder: "new",
		});
	});

	it("renders each message's object key as a domain media ref", async () => {
		// The contract describes ROWS; the media vocabulary is the engine's, so the translation
		// happens here rather than leaking `object://` into a schema the API also implements.
		const { proxy } = clientReturning({
			found: true,
			total: 1,
			messages: [
				{
					messageId: createEntityId(),
					folder: "new",
					objectKey: "/org-1/vm/msg.wav",
					durationMs: 3_000,
					receivedAt: "2026-08-05T12:00:00.000Z",
					callerIdNumber: "+15551230000",
				},
			],
		});
		const listing = await new VoicemailMailboxRpcSource(ENV, proxy).list(REQUEST);

		expect(listing.found).toBe(true);
		expect(listing.messages[0]?.media).toBe("object://org-1/vm/msg.wav");
		expect(listing.messages[0]?.callerIdNumber).toBe("+15551230000");
	});

	it("reports an empty mailbox as found and empty", async () => {
		const { proxy } = clientReturning({ found: true, messages: [], total: 0 });
		expect(await new VoicemailMailboxRpcSource(ENV, proxy).list(REQUEST)).toEqual({
			found: true,
			messages: [],
		});
	});

	it("reports a responder that says no as NOT found, with its reason", async () => {
		const { proxy } = clientReturning({ found: false, reason: "mailbox belongs to another org" });
		const listing = await new VoicemailMailboxRpcSource(ENV, proxy).list(REQUEST);

		expect(listing.found).toBe(false);
		expect(listing.reason).toBe("mailbox belongs to another org");
	});

	it("reports no responder at all as NOT found, never as empty", async () => {
		// The production path today. Returning `{ found: true, messages: [] }` here would make the
		// menu tell somebody with nine messages that they have none.
		const source = new VoicemailMailboxRpcSource(ENV, clientFailing());
		const listing = await source.list(REQUEST);

		expect(listing).toEqual({
			found: false,
			messages: [],
			reason: "the mailbox service did not answer",
		});
		expect(source.stats).toEqual({ calls: 1, failures: 1 });
	});

	it("treats a malformed reply as an unreadable mailbox rather than trusting it", async () => {
		// A responder on a shared broker is another process on another release. A reply that does not
		// match the contract must fail as "unreadable", not as a walk that dereferences `undefined`
		// halfway through somebody's messages.
		const { proxy } = clientReturning({ found: true, messages: [{ nonsense: true }] });
		expect((await new VoicemailMailboxRpcSource(ENV, proxy).list(REQUEST)).found).toBe(false);
	});

	it("counts every call, so /healthz can show the responder is missing", async () => {
		const { proxy } = clientReturning({ found: true, messages: [] });
		const source = new VoicemailMailboxRpcSource(ENV, proxy);
		await source.list(REQUEST);
		await source.list(REQUEST);

		expect(source.stats).toEqual({ calls: 2, failures: 0 });
	});
});
