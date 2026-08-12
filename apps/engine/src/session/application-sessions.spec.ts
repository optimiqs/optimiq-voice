import { describe, expect, it } from "bun:test";
import { ApplicationSessions } from "./application-sessions";
import type {
	ApplicationRunRequest,
	ApplicationSessionDependencies,
	VerbDispatchOutcome,
} from "./application-sessions";
import type { SessionAnnounceResponse, SessionVerbRequest } from "@optimiq-voice/events";
import type { Verb } from "@optimiq-voice/telephony";

/**
 * The session runtime: who has control of which leg, and what a verb is allowed to do to it.
 *
 * Two properties carry this file. The first is that **the walk blocks and then resumes with the
 * right answer** — a destination that returned early would run the plan's failover path underneath
 * a live conversation. The second is the AUTHORIZATION: a session id names exactly one leg in
 * exactly one organization, and anything else is refused without telling the caller which half was
 * wrong. Everything else here is bookkeeping.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const OTHER_ORG = "0195c0f0-1c2f-7000-8000-0000000000ff";

function runRequest(overrides: Partial<ApplicationRunRequest> = {}): ApplicationRunRequest {
	return {
		application: "autopilot",
		direction: "inbound",
		leg: {
			legId: "leg-1",
			callId: "call-1",
			organizationId: ORG,
			isAnswered: false,
			callerIdNumber: "+15551230000",
		},
		dialedNumber: "2000",
		...overrides,
	};
}

function verb(overrides: Partial<SessionVerbRequest> = {}): SessionVerbRequest {
	return {
		orgId: ORG,
		sessionId: "sess-1",
		callId: "call-1",
		legId: "leg-1",
		verb: "answer",
		...overrides,
	};
}

interface HarnessOptions {
	readonly announce?: SessionAnnounceResponse;
	readonly dispatch?: VerbDispatchOutcome;
	readonly maxSessionMs?: number;
}

function harness(options: HarnessOptions = {}) {
	const announced: unknown[] = [];
	const executed: { legId: string; verb: Verb }[] = [];
	const timers: { fn: () => void; ms: number }[] = [];
	const logs: string[] = [];

	const deps: ApplicationSessionDependencies = {
		announce: async (request) => {
			announced.push(request);
			return options.announce ?? { accepted: true, sessionId: "sess-1" };
		},
		execute: async (legId, runtimeVerb) => {
			executed.push({ legId, verb: runtimeVerb });
			return options.dispatch ?? { ok: true, result: { verb: "answer", endReason: "completed" } };
		},
		instanceId: "engine-1",
		now: () => 1_700_000_000_000,
		...(options.maxSessionMs === undefined
			? {}
			: { settings: { maxSessionMs: options.maxSessionMs } }),
		setTimer: (fn, ms) => {
			const entry = { fn, ms };
			timers.push(entry);
			return {
				cancel: () => {
					const at = timers.indexOf(entry);
					if (at >= 0) {
						timers.splice(at, 1);
					}
				},
			};
		},
		log: (message) => {
			logs.push(message);
		},
	};

	return { sessions: new ApplicationSessions(deps), announced, executed, timers, logs };
}

describe("announcing a call", () => {
	it("offers the leg exactly as it found it, with this engine as the return address", async () => {
		const h = harness();
		void h.sessions.run(runRequest({ arguments: { queue: "sales" } }));
		await Promise.resolve();

		expect(h.announced[0]).toMatchObject({
			orgId: ORG,
			application: "autopilot",
			callId: "call-1",
			legId: "leg-1",
			// The address every verb comes back to. Learned here and nowhere else — a control plane
			// holds no channel registry.
			instanceId: "engine-1",
			direction: "inbound",
			answered: false,
			callerIdNumber: "+15551230000",
			dialedNumber: "2000",
			arguments: { queue: "sales" },
		});
	});

	/**
	 * Every way the handover can fail produces `unavailable`, because the walker's only sane answer
	 * to all of them is the same announcement. Dead air is not an outcome.
	 */
	it("reports a refusal as unavailable rather than throwing", async () => {
		const h = harness({ announce: { accepted: false, reason: "no-application" } });
		expect(await h.sessions.run(runRequest())).toEqual({
			kind: "unavailable",
			reason: "no-application",
		});
		expect(h.sessions.activeSessionCount).toBe(0);
	});

	it("refuses a second application on a leg one is already driving", async () => {
		const h = harness();
		void h.sessions.run(runRequest());
		await Promise.resolve();
		const second = await h.sessions.run(runRequest());

		expect(second).toMatchObject({ kind: "unavailable" });
		expect(h.sessions.activeSessionCount).toBe(1);
	});
});

describe("running verbs", () => {
	async function started(options: HarnessOptions = {}) {
		const h = harness(options);
		let outcome: Awaited<ReturnType<ApplicationSessions["run"]>> | undefined;
		void h.sessions.run(runRequest()).then((settled) => {
			outcome = settled;
		});
		await Promise.resolve();
		await Promise.resolve();
		return { ...h, settled: () => outcome };
	}

	it("translates the wire verb and runs it on the session's leg", async () => {
		const h = await started();
		const answer = await h.sessions.execute(
			verb({ verb: "play", arguments: { media: "sound:hello" } }),
		);

		expect(answer).toMatchObject({ ok: true, verb: "play" });
		expect(h.executed).toEqual([{ legId: "leg-1", verb: { verb: "play", media: "sound:hello" } }]);
	});

	it("refuses a session id it has never minted", async () => {
		const h = await started();
		expect(await h.sessions.execute(verb({ sessionId: "somebody-elses" }))).toMatchObject({
			ok: false,
			reason: "unknown-leg",
		});
		expect(h.executed).toEqual([]);
	});

	/**
	 * The authorization that matters. A valid session id must not become a way to send verbs at
	 * another leg — or another TENANT's leg — by naming it, and the two refusals are deliberately
	 * identical so an application cannot enumerate live legs one guess at a time.
	 */
	it("refuses a verb whose leg or organization the session does not name", async () => {
		const h = await started();
		const wrongLeg = await h.sessions.execute(verb({ legId: "somebody-elses-leg" }));
		const wrongOrg = await h.sessions.execute(verb({ orgId: OTHER_ORG }));

		expect(wrongLeg).toMatchObject({ ok: false, reason: "session-mismatch" });
		expect(wrongOrg).toMatchObject({ ok: false, reason: "session-mismatch" });
		expect(wrongLeg.error).toBe(wrongOrg.error);
		expect(h.executed).toEqual([]);
	});

	it("refuses a verb missing a required argument, by name, before touching the leg", async () => {
		const h = await started();
		const answer = await h.sessions.execute(verb({ verb: "play" }));

		expect(answer).toMatchObject({ ok: false, reason: "bad_request" });
		expect(answer.error).toContain("media");
		expect(h.executed).toEqual([]);
	});

	it("passes the executor's refusal through with its tag and its reason", async () => {
		const h = await started({
			dispatch: { ok: false, reason: "unsupported", error: "the engine does not implement say" },
		});
		expect(await h.sessions.execute(verb())).toMatchObject({
			ok: false,
			reason: "unsupported",
			error: "the engine does not implement say",
		});
	});

	it("flattens a gather's collection onto the wire response", async () => {
		const h = await started({
			dispatch: {
				ok: true,
				result: {
					verb: "gather",
					endReason: "completed",
					collection: { digits: ["1", "2"], endReason: "max-digits" },
					elapsedMs: 40,
				},
			},
		});
		const answer = await h.sessions.execute(
			verb({
				verb: "gather",
				arguments: { maxDigits: 2, timeoutMs: 5_000, interDigitTimeoutMs: 2_000 },
			}),
		);
		expect(answer).toMatchObject({ ok: true, verb: "gather", digits: ["1", "2"], elapsedMs: 40 });
	});
});

describe("ending a session", () => {
	async function started(options: HarnessOptions = {}) {
		const h = harness(options);
		let outcome: Awaited<ReturnType<ApplicationSessions["run"]>> | undefined;
		const walk = h.sessions.run(runRequest()).then((settled) => {
			outcome = settled;
			return settled;
		});
		await Promise.resolve();
		await Promise.resolve();
		return { ...h, walk, settled: () => outcome };
	}

	it("resumes the walk with the cause the application chose", async () => {
		const h = await started();
		await h.sessions.execute(verb({ verb: "hangup", arguments: { cause: "CALL_REJECTED" } }));

		expect(await h.walk).toEqual({
			kind: "hangup",
			cause: "CALL_REJECTED",
			sessionId: "sess-1",
		});
		expect(h.sessions.activeSessionCount).toBe(0);
	});

	it("defaults a hangup with no cause rather than leaving the CDR blank", async () => {
		const h = await started();
		await h.sessions.execute(verb({ verb: "hangup" }));
		expect(await h.walk).toMatchObject({ cause: "NORMAL_CLEARING" });
	});

	it("aborts the walk when the leg goes away, and is a no-op for a leg with no session", async () => {
		const h = await started();
		h.sessions.legEnded("some-other-leg");
		expect(h.sessions.activeSessionCount).toBe(1);

		h.sessions.legEnded("leg-1");
		expect(await h.walk).toEqual({ kind: "aborted", sessionId: "sess-1" });
	});

	/**
	 * The backstop, and the seam a session heartbeat would replace. Without it, a control plane that
	 * crashed before it could send its `hangup` would leave a caller holding a live line to a process
	 * that had forgotten them.
	 */
	it("ends a session that outlives its deadline, so a crashed control plane cannot strand a call", async () => {
		const h = await started({ maxSessionMs: 60_000 });
		expect(h.timers[0]?.ms).toBe(60_000);

		h.timers[0]?.fn();
		expect(await h.walk).toMatchObject({ kind: "hangup", cause: "ALLOTTED_TIMEOUT" });
	});

	it("cancels the deadline when the session ends normally", async () => {
		const h = await started();
		await h.sessions.execute(verb({ verb: "hangup" }));
		await h.walk;
		expect(h.timers).toEqual([]);
	});

	it("releases every session on shutdown", async () => {
		const h = await started();
		h.sessions.clear();
		expect(await h.walk).toMatchObject({ kind: "aborted" });
		expect(h.sessions.activeSessionCount).toBe(0);
	});
});
