import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SoftphoneEvent } from "./call-state";
import type { ResolvedSoftphoneCredentials } from "./contracts";

/**
 * The adapter's credential handling, driven by a fake jssip.
 *
 * Only the part with an operational consequence is pinned here: what happens when the credentials
 * fetched before a call differ from the ones the UA registered with. Everything else in the adapter
 * is a translation of jssip events into {@link SoftphoneEvent}s, which the reducer's own spec
 * covers.
 */

interface FakeSession {
	answered: number;
	terminated: { status_code?: number }[];
	ended: boolean;
}

class FakeUA {
	static last: FakeUA | undefined;
	readonly set_: { parameter: string; value: unknown }[] = [];
	registers = 0;
	private readonly handlers = new Map<string, ((event: unknown) => void)[]>();

	constructor(readonly config: Record<string, unknown>) {
		FakeUA.last = this;
	}

	on(event: string, handler: (event: unknown) => void): void {
		const held = this.handlers.get(event);
		if (held) {
			held.push(handler);
		} else {
			this.handlers.set(event, [handler]);
		}
	}

	emit(event: string, payload: unknown): void {
		for (const handler of this.handlers.get(event) ?? []) {
			handler(payload);
		}
	}

	set(parameter: string, value: unknown): boolean {
		this.set_.push({ parameter, value });
		return true;
	}

	register(): void {
		this.registers += 1;
	}

	start(): void {
		/* nothing to open without a socket */
	}

	stop(): void {
		/* nothing to close without a socket */
	}

	call(): unknown {
		return session();
	}
}

function session(): FakeSession & Record<string, unknown> {
	const fake = {
		answered: 0,
		terminated: [] as { status_code?: number }[],
		ended: false,
		direction: "incoming",
		remote_identity: { uri: { user: "1002" }, display_name: "Bob" },
		connection: null,
		on: () => undefined,
		answer: () => {
			fake.answered += 1;
		},
		terminate: (options: { status_code?: number } = {}) => {
			fake.terminated.push(options);
			fake.ended = true;
		},
		isEnded: () => fake.ended,
		isEstablished: () => false,
		isInProgress: () => true,
	};
	return fake as unknown as FakeSession & Record<string, unknown>;
}

await mock.module("jssip", () => ({
	UA: FakeUA,
	WebSocketInterface: class {
		constructor(readonly url: string) {}
	},
}));

const { createJsSipUserAgent } = await import("./jssip-adapter");

function credentials(
	overrides: Partial<ResolvedSoftphoneCredentials> = {},
): ResolvedSoftphoneCredentials {
	return {
		wssUrl: "wss://sip.example.com:8089",
		sipUri: "sip:1001@acme.example",
		authorizationUser: "1001",
		password: "secret",
		realm: "acme.example",
		displayName: "Alice",
		registerExpires: 600,
		extensionNumber: "1001",
		voicemailNumber: null,
		webrtcSupported: true,
		mediaNote: "",
		iceServers: [{ urls: ["stun:stun.example.com:3478"] }],
		...overrides,
	};
}

function agentWith(refreshed: ResolvedSoftphoneCredentials): {
	readonly events: SoftphoneEvent[];
	readonly ua: () => FakeUA;
	readonly incoming: () => FakeSession;
	readonly answer: () => Promise<void>;
} {
	const events: SoftphoneEvent[] = [];
	const agent = createJsSipUserAgent({
		credentials: credentials(),
		refreshCredentials: async () => refreshed,
		media: {},
		onEvent: (event) => events.push(event),
	});
	const ua = FakeUA.last as FakeUA;
	const ringing = session();
	ua.emit("newRTCSession", { session: ringing });
	return {
		events,
		ua: () => ua,
		incoming: () => ringing,
		answer: async () => {
			agent.answer();
			// `answer()` refreshes credentials on a promise; let it settle.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

describe("jssip adapter credentials", () => {
	beforeEach(() => {
		FakeUA.last = undefined;
	});

	/**
	 * The case that used to decline every call: an admin regenerates the extension's SIP secret and
	 * the refresh returns it. Re-registering with it is the point of the refresh; refusing the call
	 * left a softphone that showed "Registered" and silently answered 480.
	 */
	it("re-registers with a rotated password and answers the call", async () => {
		const harness = agentWith(credentials({ password: "rotated" }));
		await harness.answer();

		expect(harness.ua().set_).toContainEqual({ parameter: "password", value: "rotated" });
		expect(harness.ua().registers).toBe(1);
		expect(harness.incoming().answered).toBe(1);
		expect(harness.incoming().terminated).toHaveLength(0);
	});

	/** A different account is the one genuinely fatal change — an org switch, or a reassignment. */
	it("declines the call when the account itself changed, and says why", async () => {
		const harness = agentWith(credentials({ sipUri: "sip:1009@acme.example" }));
		await harness.answer();

		expect(harness.incoming().answered).toBe(0);
		expect(harness.incoming().terminated[0]?.status_code).toBe(480);
		expect(harness.events.some((event) => event.type === "CALL_ENDED")).toBe(true);
	});

	it("does not re-register when nothing rotated", async () => {
		const harness = agentWith(credentials());
		await harness.answer();

		expect(harness.ua().registers).toBe(0);
		expect(harness.incoming().answered).toBe(1);
	});
});
