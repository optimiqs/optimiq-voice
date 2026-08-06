import { describe, expect, it } from "bun:test";
import { actionForStatus, AGENT_SESSION_ACTIONS } from "./agent-session";

/**
 * Which button the console offers for which status.
 *
 * This is a mirror of the server's state machine, and the assertions that matter are the ones that
 * stop the UI offering a control the machine would refuse — a 409 the user cannot act on, produced
 * by a button they were invited to press.
 */

describe("the mirror", () => {
	it("names the same four actions the shared machine does", async () => {
		const shared = await import("../../../../packages/events/src/schemas/agent-state-machine");
		expect([...AGENT_SESSION_ACTIONS].sort()).toEqual([...shared.AGENT_SESSION_ACTIONS].sort());
	});

	/**
	 * Every action this control can produce has to be one the control plane is allowed to write.
	 * `login` from `logged-out`, `logout` from anywhere, `pause` and `resume` — and never `ringing`,
	 * which is the engine's.
	 */
	it("only ever produces a transition the control plane owns", async () => {
		const shared = await import("../../../../packages/events/src/schemas/agent-state-machine");
		for (const status of shared.AGENT_STATUS_VALUES) {
			for (const intent of ["toggle-shift", "toggle-break"] as const) {
				const action = actionForStatus(status, intent);
				if (action === undefined) {
					continue;
				}
				const plan = shared.planAgentSessionAction(action, status);
				expect(plan.outcome, `${status} + ${intent} -> ${action}`).not.toBe("refused");
			}
		}
	});
});

describe("actionForStatus", () => {
	it("offers log in to somebody who is out, and log out to everybody else", () => {
		expect(actionForStatus("logged-out", "toggle-shift")).toBe("login");
		expect(actionForStatus("available", "toggle-shift")).toBe("logout");
		expect(actionForStatus("on-call", "toggle-shift")).toBe("logout");
		expect(actionForStatus("on-break", "toggle-shift")).toBe("logout");
	});

	it("offers end break to somebody who is paused or unavailable", () => {
		expect(actionForStatus("on-break", "toggle-break")).toBe("resume");
		expect(actionForStatus("unavailable", "toggle-break")).toBe("resume");
	});

	/**
	 * The machine has no `on-call → on-break` edge, because a break that interrupted a live call is
	 * a state the switch could not honour. Rendering the button would be offering a 409.
	 */
	it("offers no break to somebody on a call or ringing", () => {
		expect(actionForStatus("on-call", "toggle-break")).toBe(undefined);
		expect(actionForStatus("ringing", "toggle-break")).toBe(undefined);
	});

	it("offers a break to somebody available or wrapping up", () => {
		expect(actionForStatus("available", "toggle-break")).toBe("pause");
		expect(actionForStatus("wrap-up", "toggle-break")).toBe("pause");
	});
});
