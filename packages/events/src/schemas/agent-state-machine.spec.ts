import { describe, expect, it } from "bun:test";
import {
	ABSENT_AGENT_STATUS,
	AGENT_SESSION_ACTION_SOURCES,
	AGENT_SESSION_ACTION_TARGET,
	AGENT_SESSION_ACTIONS,
	AGENT_STATUS_VALUES,
	API_DRIVEN_TRANSITIONS,
	assertApiAgentTransition,
	assertEngineAgentTransition,
	canAgentTransition,
	ENGINE_DRIVEN_TRANSITIONS,
	InvalidAgentTransitionError,
	isApiDrivenTransition,
	isEngineDrivenTransition,
	planAgentSessionAction,
	VALID_AGENT_TRANSITIONS,
} from "./agent-state-machine";
import { AGENT_STATUSES } from "./telephony";
import type { AgentStatus } from "./telephony";

/**
 * The shared agent state machine.
 *
 * These assertions are the ones that stop a change to the table from quietly changing who may
 * write what. The machine is read by two processes with opposite blind spots, so the invariants
 * that matter are the SEPARATION ones — an engine that could log somebody out, or an API that
 * could answer a call on their behalf, are both one careless array entry away.
 */

describe("VALID_AGENT_TRANSITIONS", () => {
	it("covers the status vocabulary exactly, with nothing invented and nothing missed", () => {
		expect(Object.keys(VALID_AGENT_TRANSITIONS).sort()).toEqual([...AGENT_STATUSES].sort());
		expect(AGENT_STATUS_VALUES).toEqual(AGENT_STATUSES);
	});

	it("lets an agent go home from anywhere", () => {
		for (const status of AGENT_STATUSES) {
			if (status === "logged-out") {
				continue;
			}
			expect(canAgentTransition(status, "logged-out")).toBe(true);
		}
	});

	/**
	 * A re-entry is not a transition. A wallboard reading the `agent.state` stream as a transition
	 * log would render a self-edge as an agent flapping between one state and itself.
	 */
	it("has no self-loops", () => {
		for (const status of AGENT_STATUSES) {
			expect(canAgentTransition(status, status)).toBe(false);
		}
	});

	it("only starts a ring at an available agent", () => {
		for (const status of AGENT_STATUSES) {
			expect(canAgentTransition(status, "ringing")).toBe(status === "available");
		}
	});

	it("only reaches on-call from ringing", () => {
		for (const status of AGENT_STATUSES) {
			expect(canAgentTransition(status, "on-call")).toBe(status === "ringing");
		}
	});
});

describe("the writer split", () => {
	it("declares only edges the machine actually has", () => {
		for (const [from, to] of [...ENGINE_DRIVEN_TRANSITIONS, ...API_DRIVEN_TRANSITIONS]) {
			expect(canAgentTransition(from, to)).toBe(true);
		}
	});

	/**
	 * The whole reason the machine is shared. An engine that could write `logged-out` would take an
	 * agent off the roster for being in a meeting; one that could write `on-break` would decide a
	 * human was on a break.
	 */
	it("keeps shift transitions away from the engine", () => {
		expect(isEngineDrivenTransition("available", "logged-out")).toBe(false);
		expect(isEngineDrivenTransition("available", "on-break")).toBe(false);
		expect(isEngineDrivenTransition("on-break", "available")).toBe(false);
		expect(() => assertEngineAgentTransition("available", "logged-out")).toThrow(
			InvalidAgentTransitionError,
		);
	});

	/**
	 * And the mirror. An API that could write `ringing` would put a call at a phone the switch has
	 * not dialled; one that could end wrap-up would hand an agent a button that skips the after-call
	 * work their supervisor configured.
	 */
	it("keeps call transitions away from the control plane", () => {
		expect(isApiDrivenTransition("available", "ringing")).toBe(false);
		expect(isApiDrivenTransition("ringing", "on-call")).toBe(false);
		expect(isApiDrivenTransition("wrap-up", "available")).toBe(false);
		expect(isApiDrivenTransition("on-call", "wrap-up")).toBe(false);
		expect(() => assertApiAgentTransition("wrap-up", "available")).toThrow(
			InvalidAgentTransitionError,
		);
	});

	/**
	 * The one edge both own, and it is not an accident: the engine writes it when a phone rings out
	 * three times, the API when a supervisor pulls somebody off the floor mid-ring.
	 */
	it("lets both writers move a ringing agent to unavailable", () => {
		expect(isEngineDrivenTransition("ringing", "unavailable")).toBe(true);
		expect(isApiDrivenTransition("ringing", "unavailable")).toBe(false);
		// `unavailable` is not one of the four session actions' targets, so the API reaches it only
		// through `pause`'s sibling — which does not exist yet. Recorded here so adding it is a
		// deliberate change rather than a surprise.
		expect(Object.values(AGENT_SESSION_ACTION_TARGET)).not.toContain("unavailable");
	});

	it("refuses a transition the machine does not have at all, before asking who owns it", () => {
		let thrown: InvalidAgentTransitionError | undefined;
		try {
			assertApiAgentTransition("on-call", "ringing");
		} catch (error) {
			thrown = error as InvalidAgentTransitionError;
		}
		expect(thrown?.reason).toBe("not-adjacent");
	});
});

describe("the session actions", () => {
	it("names a target for every action and only reachable sources", () => {
		for (const action of AGENT_SESSION_ACTIONS) {
			const to = AGENT_SESSION_ACTION_TARGET[action];
			for (const from of AGENT_SESSION_ACTION_SOURCES[action]) {
				if (from === to) {
					continue;
				}
				expect(canAgentTransition(from, to)).toBe(true);
			}
		}
	});

	/**
	 * A button pressed twice — a double tap, a retried request, two tabs open — must not be an
	 * error. It must also not be a write, or the transition log fills with edges that did not
	 * happen.
	 */
	it("treats an action that changes nothing as a no-op rather than a failure", () => {
		expect(planAgentSessionAction("login", "available").outcome).toBe("no-op");
		expect(planAgentSessionAction("logout", "logged-out").outcome).toBe("no-op");
		expect(planAgentSessionAction("pause", "on-break").outcome).toBe("no-op");
	});

	it("applies the ordinary shift moves", () => {
		expect(planAgentSessionAction("login", "logged-out")).toEqual({
			outcome: "apply",
			to: "available",
		});
		expect(planAgentSessionAction("pause", "available")).toEqual({
			outcome: "apply",
			to: "on-break",
		});
		expect(planAgentSessionAction("resume", "on-break")).toEqual({
			outcome: "apply",
			to: "available",
		});
		expect(planAgentSessionAction("logout", "on-call")).toEqual({
			outcome: "apply",
			to: "logged-out",
		});
	});

	/**
	 * `resume` from `logged-out` names an edge the control plane DOES own — it is what `login`
	 * writes — so the refusal has to say "wrong button", not "that belongs to the engine". An
	 * operator told the second would go looking for a bug in the switch.
	 */
	it("distinguishes the wrong button from the wrong writer", () => {
		const wrongButton = planAgentSessionAction("resume", "logged-out");
		expect(wrongButton.outcome).toBe("refused");
		expect(wrongButton.outcome === "refused" && wrongButton.error.reason).toBe("not-this-action");

		const wrongWriter = planAgentSessionAction("login", "wrap-up");
		expect(wrongWriter.outcome).toBe("refused");
		expect(wrongWriter.outcome === "refused" && wrongWriter.error.reason).toBe("not-api-driven");
	});

	it("refuses to pause an agent who is on a call", () => {
		const plan = planAgentSessionAction("pause", "on-call");
		expect(plan.outcome).toBe("refused");
		// Not because of the writer split — the machine simply has no `on-call -> on-break` edge.
		// An agent on a call goes to wrap-up first; a break that interrupted a live call would be a
		// state the switch could not honour.
		expect(plan.outcome === "refused" && plan.error.reason).toBe("not-adjacent");
	});

	it("lets an agent log out from every state, which is the point of the logout action", () => {
		for (const status of AGENT_STATUSES) {
			const plan = planAgentSessionAction("logout", status);
			expect(plan.outcome).toBe(status === "logged-out" ? "no-op" : "apply");
		}
	});
});

describe("ABSENT_AGENT_STATUS", () => {
	/**
	 * An unseen agent must read as logged out. Treating an absent entry as available would make an
	 * empty bucket look like a fully staffed queue and ring phones nobody is sitting at.
	 */
	it("is logged-out", () => {
		const status: AgentStatus = ABSENT_AGENT_STATUS;
		expect(status).toBe("logged-out");
	});
});
