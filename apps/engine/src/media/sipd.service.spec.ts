import { describe, expect, it } from "bun:test";
import { makeSipDialogEvent, subjectFilterFor, subjectFor } from "@optimiq-voice/events";
import { loadEngineEnv } from "../config/engine-env";
import { SipdService } from "./sipd.service";
import type { JetStreamService } from "../nats/jetstream.service";
import type { MediaEvent } from "./media-event";
import type { SipDialogEventInput } from "@optimiq-voice/events";

/**
 * The signalling plane's event feed.
 *
 * Three properties are load-bearing and none of them is visible from the mapping's own spec:
 *
 * - **CORE, and never a durable consumer.** The engine wants a leg torn down NOW; an ack round trip
 *   on the call path is what it is buying its way out of.
 * - **No queue group.** Admission is made exclusive by a `channels` KV compare-and-set, so every
 *   replica may see the wire event and only the owner can act on it. Queueing the feed would hand a
 *   `dialog.terminated` to a non-owner and strand the owner holding a leg for a call that ended.
 * - **The subscription survives one bad message.** The next message on the feed is somebody else's
 *   call ending.
 */

const ORG = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293";
const CALL = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c";
const LEG = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53";

function terminated() {
	return makeSipDialogEvent("dialog.terminated", {
		orgId: ORG,
		source: "sipd",
		data: {
			legId: LEG,
			callId: CALL,
			instanceId: "sipd-7c9f",
			role: "uas" as const,
			identity: { sipCallId: "a84b4c76e66710@pc33", localTag: "8a9f2b", remoteTag: "19283017" },
			reason: "bye" as const,
			cause: 16,
			initiator: "remote" as const,
			causeFromReasonHeader: false,
		},
	} as SipDialogEventInput<"dialog.terminated">);
}

function fakeConnection() {
	const encoder = new TextEncoder();
	const subscriptions: { readonly subject: string; readonly queue?: string }[] = [];
	const pending: { subject: string; data: Uint8Array }[] = [];
	let closed = false;
	let wake: (() => void) | undefined;
	let flushes = 0;
	let flushError: Error | undefined;
	let drained = false;

	async function* messages(): AsyncGenerator<{ subject: string; data: Uint8Array }> {
		while (!closed) {
			const next = pending.shift();
			if (next === undefined) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				continue;
			}
			yield next;
		}
	}

	const iterator = messages();
	const subscription = {
		[Symbol.asyncIterator]: () => iterator,
		unsubscribe: () => {
			closed = true;
			wake?.();
		},
		drain: async () => {
			drained = true;
			closed = true;
			wake?.();
			await Promise.resolve();
		},
	};

	const connection = {
		subscribe: (subject: string, options?: { queue?: string }) => {
			subscriptions.push({
				subject,
				...(options?.queue === undefined ? {} : { queue: options.queue }),
			});
			return subscription;
		},
		flush: async () => {
			flushes += 1;
			if (flushError !== undefined) {
				throw flushError;
			}
			await Promise.resolve();
		},
		isClosed: () => false,
	};

	return {
		connection,
		subscriptions,
		flushCount: () => flushes,
		wasDrained: () => drained,
		failFlush: (error: Error) => {
			flushError = error;
		},
		deliver: async (subject: string, payload: unknown): Promise<void> => {
			pending.push({
				subject,
				data: encoder.encode(typeof payload === "string" ? payload : JSON.stringify(payload)),
			});
			wake?.();
			wake = undefined;
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
		},
	};
}

function service(fake: ReturnType<typeof fakeConnection>, driver: "ari" | "mediad" = "mediad") {
	const jetstream = { rawConnection: fake.connection } as unknown as JetStreamService;
	const received: MediaEvent[] = [];
	const built = new SipdService(
		// The ARI driver requires a credential, and this spec never opens a connection to Asterisk —
		// it only needs an env whose driver says "do not signal on the edge".
		loadEngineEnv({ ENGINE_MEDIA_DRIVER: driver, ARI_PASSWORD: "unused-by-this-spec" }),
		jetstream,
	);
	built.setEventHandler((event) => {
		received.push(event);
	});
	return { built, received };
}

describe("subscribing to the dialog feed", () => {
	it("takes a CORE subscription on the whole family, with no queue group", async () => {
		const fake = fakeConnection();
		const { built } = service(fake);

		await built.start();

		expect(fake.subscriptions).toEqual([{ subject: subjectFilterFor.allSipDialogs() }]);
		expect(fake.subscriptions[0]?.subject).toBe("sip.evt.v1.>");
		expect(built.subscriptionState).toBe("subscribed");
	});

	it("flushes before reporting subscribed, so no event can outrun the subscriber", async () => {
		const fake = fakeConnection();
		const { built } = service(fake);

		await built.start();

		expect(fake.flushCount()).toBe(1);
	});

	it("does not report subscribed when the flush barrier fails", async () => {
		const fake = fakeConnection();
		fake.failFlush(new Error("the broker went away"));
		const { built } = service(fake);

		await expect(built.start()).rejects.toThrow("the broker went away");
		expect(built.subscriptionState).toBe("closed");
	});

	it("does nothing at all on a deployment that does not signal on the sip edge", async () => {
		const fake = fakeConnection();
		const { built } = service(fake, "ari");

		await built.start();

		expect(fake.subscriptions).toHaveLength(0);
		expect(built.subscriptionState).toBe("idle");
	});

	it("subscribes once, however many times start is called", async () => {
		const fake = fakeConnection();
		const { built } = service(fake);

		await built.start();
		await built.start();

		expect(fake.subscriptions).toHaveLength(1);
	});

	it("refuses to start before a handler is registered, rather than dropping the feed on the floor", async () => {
		const fake = fakeConnection();
		const jetstream = { rawConnection: fake.connection } as unknown as JetStreamService;
		const built = new SipdService(loadEngineEnv({ ENGINE_MEDIA_DRIVER: "mediad" }), jetstream);

		await expect(built.start()).rejects.toThrow("event handler");
	});
});

describe("handling what arrives", () => {
	it("maps a dialog event into the engine's own union and hands it to the handler", async () => {
		const fake = fakeConnection();
		const { built, received } = service(fake);
		await built.start();

		await fake.deliver(subjectFor.sipDialog(ORG, LEG, "dialog.terminated"), terminated());

		expect(received).toEqual([
			{ type: "leg-ended", channelId: LEG, cause: "NORMAL_CLEARING", causeCode: 16 },
		]);
		expect(built.eventCount).toBe(1);
	});

	it("counts and drops a message it cannot read, and keeps serving the next call's teardown", async () => {
		const fake = fakeConnection();
		const { built, received } = service(fake);
		await built.start();

		// Poison, then an event from a newer edge this contract version has never heard of, then a
		// real one. Additive evolution is the rule on this backbone: an unknown event is a normal
		// outcome and must not end the feed.
		await fake.deliver(subjectFor.sipDialog(ORG, LEG, "dialog.terminated"), "{not json");
		await fake.deliver(subjectFor.sipDialog(ORG, LEG, "dialog.invented"), {
			type: "dialog.invented",
		});
		await fake.deliver(subjectFor.sipDialog(ORG, LEG, "dialog.terminated"), terminated());

		expect(received).toHaveLength(1);
		expect(built.eventCount).toBe(3);
		expect(built.subscriptionState).toBe("subscribed");
	});
});

describe("shutting down", () => {
	it("DRAINS rather than unsubscribing, because the messages in flight are the calls ending", async () => {
		const fake = fakeConnection();
		const { built } = service(fake);
		await built.start();

		await built.onApplicationShutdown();

		expect(fake.wasDrained()).toBe(true);
		expect(built.subscriptionState).toBe("closed");
	});

	it("is a no-op when nothing was ever subscribed", async () => {
		const fake = fakeConnection();
		const { built } = service(fake, "ari");

		await built.onApplicationShutdown();

		expect(built.subscriptionState).toBe("closed");
	});
});
