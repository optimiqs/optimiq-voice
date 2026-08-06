import { describe, expect, it } from "bun:test";
import {
	ABSENT_AGENT_STATUS,
	AGENT_STATUS_VALUES,
	absentAgentState,
	assertAgentTransition,
	canTransition,
	ENGINE_DRIVEN_TRANSITIONS,
	idleMsOf,
	InvalidAgentTransitionError,
	isEligibleForDistribution,
	isEngineDriven,
	isPastDeadline,
	isStaffing,
	VALID_AGENT_TRANSITIONS,
} from "./agent-state";
import type { AgentStateEntry, AgentStatus } from "@optimiq-voice/events";

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";
const AGENT = "0195c0f0-1c2f-7000-8000-0000000000b1";
const NOW = Date.parse("2026-08-05T12:00:00.000Z");

function entry(overrides: Partial<AgentStateEntry> = {}): AgentStateEntry {
	return {
		orgId: ORG,
		agentId: AGENT,
		status: "available",
		since: new Date(NOW).toISOString(),
		...overrides,
	};
}

describe("the agent state machine", () => {
	it("covers every status in the telephony vocabulary and nothing else", () => {
		expect(Object.keys(VALID_AGENT_TRANSITIONS).sort()).toEqual([...AGENT_STATUS_VALUES].sort());
	});

	it("lets an agent go home from any state", () => {
		for (const status of AGENT_STATUS_VALUES) {
			if (status === "logged-out") {
				continue;
			}
			expect(canTransition(status, "logged-out")).toBe(true);
		}
	});

	it("never lists a state as its own successor", () => {
		for (const [status, next] of Object.entries(VALID_AGENT_TRANSITIONS)) {
			expect(next).not.toContain(status);
		}
	});

	it("reaches `ringing` only from `available`", () => {
		for (const status of AGENT_STATUS_VALUES) {
			expect(canTransition(status, "ringing")).toBe(status === "available");
		}
	});

	it("reaches `on-call` only from `ringing`", () => {
		for (const status of AGENT_STATUS_VALUES) {
			expect(canTransition(status, "on-call")).toBe(status === "ringing");
		}
	});

	it("walks a whole queue call: available -> ringing -> on-call -> wrap-up -> available", () => {
		const lifecycle: AgentStatus[] = ["available", "ringing", "on-call", "wrap-up", "available"];
		for (let index = 0; index < lifecycle.length - 1; index += 1) {
			expect(() =>
				assertAgentTransition(lifecycle[index] as AgentStatus, lifecycle[index + 1] as AgentStatus),
			).not.toThrow();
		}
	});
});

describe("what the engine may write", () => {
	it("accepts every engine-driven edge", () => {
		for (const [from, to] of ENGINE_DRIVEN_TRANSITIONS) {
			expect(canTransition(from, to)).toBe(true);
			expect(() => {
				assertAgentTransition(from, to);
			}).not.toThrow();
		}
	});

	it("refuses to log an agent out: a shift is the control plane's to end", () => {
		expect(isEngineDriven("available", "logged-out")).toBe(false);
		try {
			assertAgentTransition("available", "logged-out");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(InvalidAgentTransitionError);
			expect((error as InvalidAgentTransitionError).reason).toBe("not-engine-driven");
		}
	});

	it("refuses to put an agent on a break", () => {
		expect(() => {
			assertAgentTransition("available", "on-break");
		}).toThrow(InvalidAgentTransitionError);
	});

	it("refuses to bring somebody back from a break: that is a person pressing a button", () => {
		expect(() => {
			assertAgentTransition("on-break", "available");
		}).toThrow(InvalidAgentTransitionError);
	});

	it("distinguishes an impossible edge from one it merely may not write", () => {
		try {
			assertAgentTransition("logged-out", "on-call");
			throw new Error("expected a refusal");
		} catch (error) {
			expect((error as InvalidAgentTransitionError).reason).toBe("not-adjacent");
		}
	});

	it("may take an agent out of distribution after repeated no-answers", () => {
		expect(isEngineDriven("ringing", "unavailable")).toBe(true);
	});

	it("may not bring that agent back: returning is a login", () => {
		expect(isEngineDriven("unavailable", "available")).toBe(false);
	});
});

describe("eligibility", () => {
	it("treats an agent nobody has logged in as logged out, not as available", () => {
		expect(ABSENT_AGENT_STATUS).toBe("logged-out");
		expect(isEligibleForDistribution(undefined, NOW)).toBe(false);
		expect(absentAgentState(ORG, AGENT, NOW).status).toBe("logged-out");
	});

	it("rings an available agent with no deadline", () => {
		expect(isEligibleForDistribution(entry(), NOW)).toBe(true);
	});

	it("does NOT ring an available agent who is serving a penalty", () => {
		const serving = entry({ availableAt: new Date(NOW + 30_000).toISOString() });
		expect(isEligibleForDistribution(serving, NOW)).toBe(false);
		expect(isEligibleForDistribution(serving, NOW + 30_000)).toBe(true);
	});

	it("DOES ring an agent still marked wrap-up whose deadline has passed", () => {
		// The cross-instance case: the engine that took their call is not the one distributing now,
		// so nobody was left to write the transition back to available.
		const stale = entry({ status: "wrap-up", availableAt: new Date(NOW - 1).toISOString() });
		expect(isEligibleForDistribution(stale, NOW)).toBe(true);
	});

	it("does not ring an agent in wrap-up whose deadline has not passed", () => {
		const fresh = entry({ status: "wrap-up", availableAt: new Date(NOW + 5_000).toISOString() });
		expect(isEligibleForDistribution(fresh, NOW)).toBe(false);
	});

	it("never rings somebody on a break, on a call, ringing, unavailable or logged out", () => {
		for (const status of ["on-break", "on-call", "ringing", "unavailable", "logged-out"] as const) {
			expect(isEligibleForDistribution(entry({ status }), NOW)).toBe(false);
		}
	});

	it("treats an unreadable deadline as passed rather than as forever", () => {
		expect(isPastDeadline(entry({ availableAt: "not a date" }), NOW)).toBe(true);
	});
});

describe("staffing", () => {
	it("counts an agent on a call, in wrap-up or on a break as working the queue", () => {
		for (const status of [
			"available",
			"ringing",
			"on-call",
			"wrap-up",
			"on-break",
			"unavailable",
		] as const) {
			expect(isStaffing(entry({ status }))).toBe(true);
		}
	});

	it("counts a logged-out or unseen agent as nobody", () => {
		expect(isStaffing(entry({ status: "logged-out" }))).toBe(false);
		expect(isStaffing(undefined)).toBe(false);
	});
});

describe("idle time", () => {
	it("measures from the transition instant, so a stale read is still correct", () => {
		expect(idleMsOf(entry({ since: new Date(NOW - 90_000).toISOString() }), NOW)).toBe(90_000);
	});

	it("clamps clock skew to zero rather than reporting a negative idle", () => {
		expect(idleMsOf(entry({ since: new Date(NOW + 5_000).toISOString() }), NOW)).toBe(0);
	});

	it("treats an unparseable timestamp as just-changed, so it loses the tie-break", () => {
		expect(idleMsOf(entry({ since: "whenever" }), NOW)).toBe(0);
	});
});
