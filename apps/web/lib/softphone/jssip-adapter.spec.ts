import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { SoftphoneEvent } from "./call-state";
import type { ResolvedSoftphoneCredentials } from "./contracts";
import type { SipUserAgent } from "./sip-adapter";

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
	terminated: { status_code?: number; reason_phrase?: string }[];
	ended: boolean;
	referred: { target: string; replaces: unknown }[];
	holds: boolean[];
	held: boolean;
	fire: (event: string, payload?: unknown) => void;
	referHandlers: Record<string, (payload?: unknown) => void>;
	dtmf: { tone: string; transportType?: string }[];
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

	outgoing: (FakeSession & Record<string, unknown>) | undefined;

	call(): unknown {
		this.outgoing = session("outgoing");
		return this.outgoing;
	}
}

function session(direction = "incoming"): FakeSession & Record<string, unknown> {
	const handlers = new Map<string, ((payload?: unknown) => void)[]>();
	const fake = {
		answered: 0,
		terminated: [] as { status_code?: number; reason_phrase?: string }[],
		ended: false,
		established: false,
		direction,
		remote_identity: { uri: { user: "1002" }, display_name: "Bob" },
		connection: null,
		referred: [] as { target: string; replaces: unknown }[],
		holds: [] as boolean[],
		held: false,
		referHandlers: {} as Record<string, (payload?: unknown) => void>,
		dtmf: [] as { tone: string; transportType?: string }[],
		sendDTMF: (tone: string, options: { transportType?: string } = {}) => {
			fake.dtmf.push({ tone, transportType: options.transportType });
		},
		refer: (target: string, options: { replaces?: unknown; eventHandlers?: unknown } = {}) => {
			fake.referred.push({ target, replaces: options.replaces ?? null });
			fake.referHandlers = (options.eventHandlers ?? {}) as Record<string, () => void>;
		},
		hold: () => {
			fake.held = true;
			fake.holds.push(true);
		},
		unhold: () => {
			fake.held = false;
			fake.holds.push(false);
		},
		isOnHold: () => ({ local: fake.held, remote: false }),
		fire: (event: string, payload?: unknown) => {
			for (const handler of handlers.get(event) ?? []) {
				handler(payload);
			}
		},
		on: (event: string, handler: (payload?: unknown) => void) => {
			const held = handlers.get(event);
			if (held) {
				held.push(handler);
			} else {
				handlers.set(event, [handler]);
			}
		},
		answer: () => {
			fake.answered += 1;
		},
		terminate: (options: { status_code?: number } = {}) => {
			fake.terminated.push(options);
			fake.ended = true;
		},
		isEnded: () => fake.ended,
		isEstablished: () => fake.established,
		isInProgress: () => !fake.ended,
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

function agentWith(
	refreshed: ResolvedSoftphoneCredentials,
	direction: "incoming" | "outgoing" = "incoming",
): {
	readonly events: SoftphoneEvent[];
	readonly ua: () => FakeUA;
	readonly incoming: () => FakeSession;
	readonly establish: () => void;
	readonly hangup: () => void;
	readonly settle: () => Promise<void>;
	readonly answer: () => Promise<void>;
	readonly agent: SipUserAgent;
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
	if (direction === "outgoing") {
		// `call()` refreshes credentials on a promise before it reaches `UA.call`; `settle()` drains it.
		agent.call("1002");
	} else {
		ua.emit("newRTCSession", { session: ringing });
	}
	const current = () => (direction === "outgoing" ? (ua.outgoing as FakeSession) : ringing);
	return {
		events,
		agent,
		ua: () => ua,
		incoming: current,
		establish: () => {
			(current() as unknown as { established: boolean }).established = true;
		},
		hangup: () => agent.hangup(),
		settle: async () => {
			for (let tick = 0; tick < 5; tick++) {
				await Promise.resolve();
			}
		},
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

	/**
	 * Rejecting a ringing call is a final answer from a reachable endpoint. jssip's default for an
	 * unanswered incoming session is 480, which a dial plan reads as "keep hunting" and a caller's
	 * UI reads as "Unavailable" — neither is what the user who pressed Reject meant.
	 */
	it("rejects a ringing incoming call with 486 Busy Here, not 480", () => {
		const harness = agentWith(credentials());
		harness.hangup();

		expect(harness.incoming().terminated).toEqual([
			{ status_code: 486, reason_phrase: "Busy Here" },
		]);
	});

	/**
	 * Paging and intercom: the browser is a handset like any other, and the engine asks it to pick
	 * up with the same headers it sends every desk phone. Before this it rang instead, so a page to
	 * a group of browser softphones announced into a room of ringing tabs.
	 */
	it("auto-answers an INVITE that carries the paging Alert-Info", async () => {
		const events: SoftphoneEvent[] = [];
		createJsSipUserAgent({
			credentials: credentials(),
			refreshCredentials: async () => credentials(),
			media: {},
			onEvent: (event) => events.push(event),
		});
		const ua = FakeUA.last as FakeUA;
		const ringing = session();
		ua.emit("newRTCSession", {
			session: ringing,
			request: {
				getHeader: (name: string) => (name === "Alert-Info" ? "info=alert-autoanswer" : undefined),
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(events.some((event) => event.type === "INCOMING_CALL")).toBe(true);
		expect(ringing.answered).toBe(1);
	});

	it("leaves an ordinary INVITE ringing for the user to answer", async () => {
		const events: SoftphoneEvent[] = [];
		createJsSipUserAgent({
			credentials: credentials(),
			refreshCredentials: async () => credentials(),
			media: {},
			onEvent: (event) => events.push(event),
		});
		const ua = FakeUA.last as FakeUA;
		const ringing = session();
		ua.emit("newRTCSession", { session: ringing, request: { getHeader: () => undefined } });
		await Promise.resolve();
		await Promise.resolve();

		expect(events.some((event) => event.type === "INCOMING_CALL")).toBe(true);
		expect(ringing.answered).toBe(0);
	});

	/** An established call ends with a plain BYE — no status code belongs on one. */
	it("hangs an established call up with no status code", () => {
		const harness = agentWith(credentials());
		harness.establish();
		harness.hangup();

		expect(harness.incoming().terminated).toEqual([{}]);
	});

	/** Cancelling an outgoing call is a CANCEL, which carries no status code either. */
	it("cancels an outgoing call with no status code", async () => {
		const harness = agentWith(credentials(), "outgoing");
		await harness.settle();
		harness.hangup();

		expect(harness.incoming().terminated).toEqual([{}]);
	});

	it("does not re-register when nothing rotated", async () => {
		const harness = agentWith(credentials());
		await harness.answer();

		expect(harness.ua().registers).toBe(0);
		expect(harness.incoming().answered).toBe(1);
	});
});

/**
 * Transfer, which the platform could always do and the browser could not reach.
 *
 * sipd implements REFER end to end (`OnRefer`, digest-authenticated, `Replaces` honoured); these
 * pin the browser half — that the right dialog is REFERred, that an attended transfer holds the
 * first party before the consultation grabs the microphone, and that a refusal gives them back.
 */
describe("transfer", () => {
	beforeEach(() => {
		FakeUA.last = undefined;
	});

	it("REFERs the established call to the target on a blind transfer", () => {
		const harness = agentWith(credentials());
		harness.establish();
		harness.agent.transferBlind("2003");

		expect(harness.incoming().referred).toEqual([{ target: "2003", replaces: null }]);
		expect(harness.events).toContainEqual({
			type: "TRANSFER_REQUESTED",
			mode: "blind",
			target: "2003",
		});
	});

	it("refuses to transfer a call that is not established", () => {
		// REFER is an in-dialog request; there is no dialog until the call is confirmed.
		const harness = agentWith(credentials());
		harness.agent.transferBlind("2003");
		expect(harness.incoming().referred).toEqual([]);
	});

	it("reports a refused REFER and leaves the call where it was", () => {
		const harness = agentWith(credentials());
		harness.establish();
		harness.agent.transferBlind("2003");
		harness.incoming().referHandlers.requestFailed?.();

		expect(harness.events).toContainEqual({
			type: "TRANSFER_FAILED",
			reason: "The transfer to 2003 was refused.",
		});
		expect(harness.incoming().ended).toBe(false);
	});

	it("holds the first party BEFORE the consultation takes the microphone", async () => {
		const harness = agentWith(credentials());
		harness.establish();
		harness.agent.startConsult("2003");
		expect(harness.incoming().holds).toEqual([true]);

		await harness.settle();
		expect(harness.ua().outgoing).toBeDefined();
	});

	it("completes an attended transfer with Replaces naming the consultation", async () => {
		const harness = agentWith(credentials());
		harness.establish();
		harness.agent.startConsult("2003");
		await harness.settle();

		const consult = harness.ua().outgoing as FakeSession & Record<string, unknown>;
		(consult as unknown as { established: boolean }).established = true;
		consult.fire("confirmed");
		harness.agent.completeTransfer();

		expect(harness.events).toContainEqual({ type: "CONSULT_CONFIRMED" });
		expect(harness.incoming().referred).toEqual([{ target: "2003", replaces: consult }]);
	});

	it("gives the first party back when the consultation is cancelled", async () => {
		const harness = agentWith(credentials());
		harness.establish();
		harness.agent.startConsult("2003");
		await harness.settle();
		harness.agent.cancelTransfer();

		expect((harness.ua().outgoing as FakeSession).ended).toBe(true);
		expect(harness.incoming().holds).toEqual([true, false]);
		expect(harness.events).toContainEqual({ type: "TRANSFER_CANCELLED" });
	});
});

/**
 * Being held BY the other party is a different fact from holding them, and the panel said neither.
 *
 * jssip reports both through one `hold` event and distinguishes them only by `originator`; ignoring
 * that left the held party reading "Connected" through a silence nothing on screen explained.
 */
describe("remote hold", () => {
	beforeEach(() => {
		FakeUA.last = undefined;
	});

	it("separates the far end's hold from our own", () => {
		const harness = agentWith(credentials());
		harness.incoming().fire("hold", { originator: "remote" });
		harness.incoming().fire("hold", { originator: "local" });
		harness.incoming().fire("unhold", { originator: "remote" });

		expect(harness.events).toContainEqual({ type: "REMOTE_HOLD_CHANGED", onHold: true });
		expect(harness.events).toContainEqual({ type: "HOLD_CHANGED", onHold: true });
		expect(harness.events).toContainEqual({ type: "REMOTE_HOLD_CHANGED", onHold: false });
	});
});

/**
 * Which plane a keypress travels on.
 *
 * JsSIP defaults to SIP INFO, which reaches the switch and nothing else: the far end of a bridged
 * call never hears a digit sent that way. RFC 4733 rides the RTP `mediad` is already relaying, so
 * both the engine and the other party get it — but only where the leg negotiated a
 * `telephone-event` payload type, which is what `canInsertDTMF` reports.
 */
describe("dtmf transport", () => {
	beforeEach(() => {
		FakeUA.last = undefined;
	});

	const connectionWith = (canInsertDTMF: boolean | undefined): unknown => ({
		getSenders: () => [
			{ track: { kind: "video" }, dtmf: null },
			{
				track: { kind: "audio" },
				dtmf: canInsertDTMF === undefined ? null : { canInsertDTMF },
			},
		],
	});

	it("sends RFC 4733 when the leg negotiated a telephone-event payload type", () => {
		const harness = agentWith(credentials());
		(harness.incoming() as unknown as { connection: unknown }).connection = connectionWith(true);

		harness.agent.sendDtmf("5");

		expect(harness.incoming().dtmf).toEqual([{ tone: "5", transportType: "RFC2833" }]);
	});

	it("falls back to SIP INFO when the audio sender cannot insert a tone", () => {
		const harness = agentWith(credentials());
		(harness.incoming() as unknown as { connection: unknown }).connection = connectionWith(false);

		harness.agent.sendDtmf("5");

		expect(harness.incoming().dtmf).toEqual([{ tone: "5", transportType: "INFO" }]);
	});

	it("falls back to SIP INFO before the peer connection exists", () => {
		const harness = agentWith(credentials());

		harness.agent.sendDtmf("#");

		expect(harness.incoming().dtmf).toEqual([{ tone: "#", transportType: "INFO" }]);
	});
});
