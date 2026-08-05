import { describe, expect, it } from "bun:test";
import { CALL_STATES } from "./call-state";
import { CHANNEL_STATES } from "./channel-state";
import {
	CALL_EVENT_NAMES,
	CALL_STATE_MILESTONE_EVENTS,
	CHANNEL_STATE_MILESTONE_EVENTS,
	isCallEventName,
	type CallEvent,
	type CallEventOf,
} from "./events";

/**
 * The event vocabulary is shared by the routing executor, the session protocol and the CDR writer.
 * If they disagree on what "bridged" means, a replayed stream rebuilds the wrong CDR. Pinned
 * against `plans/reference/freeswitch-capabilities.md` §8.
 */
describe("call event vocabulary", () => {
	it("names every event exactly once", () => {
		expect(new Set(CALL_EVENT_NAMES).size).toBe(CALL_EVENT_NAMES.length);
	});

	it("uses dot-namespaced past-tense names", () => {
		for (const name of CALL_EVENT_NAMES) {
			expect(name).toMatch(/^[a-z]+\.[a-z][a-z-]*$/);
		}
	});

	it("covers the FreeSWITCH-semantic core set", () => {
		for (const name of [
			"channel.created",
			"channel.answered",
			"channel.hangup",
			"channel.destroyed",
			"channel.dtmf",
			"bridge.bridged",
			"bridge.unbridged",
			"call.held",
			"call.unheld",
			"call.parked",
			"record.started",
			"record.stopped",
			"playback.started",
			"playback.stopped",
			"device.state-changed",
		] as const) {
			expect(CALL_EVENT_NAMES).toContain(name);
		}
	});

	it("guards names arriving from NATS or a webhook", () => {
		expect(isCallEventName("channel.answered")).toBe(true);
		expect(isCallEventName("CHANNEL_ANSWER")).toBe(false);
		expect(isCallEventName("channel.answer")).toBe(false);
	});

	it("maps milestones only to states and events that exist", () => {
		for (const [state, event] of Object.entries(CHANNEL_STATE_MILESTONE_EVENTS)) {
			expect(CHANNEL_STATES).toContain(state as (typeof CHANNEL_STATES)[number]);
			expect(isCallEventName(event)).toBe(true);
		}
		for (const [state, event] of Object.entries(CALL_STATE_MILESTONE_EVENTS)) {
			expect(CALL_STATES).toContain(state as (typeof CALL_STATES)[number]);
			expect(isCallEventName(event)).toBe(true);
		}
	});

	// Answer is the billing boundary, so it gets its own event rather than riding a state change.
	it("gives answer, early media and hold dedicated events", () => {
		expect(CALL_STATE_MILESTONE_EVENTS.active).toBe("channel.answered");
		expect(CALL_STATE_MILESTONE_EVENTS.early).toBe("channel.early-media");
		expect(CALL_STATE_MILESTONE_EVENTS.held).toBe("call.held");
	});

	it("discriminates the union on the event field", () => {
		const summarise = (event: CallEvent): string => {
			switch (event.event) {
				case "channel.hangup":
					return `hangup:${event.cause}`;
				case "bridge.bridged":
					return `bridged:${event.mode}`;
				case "device.state-changed":
					return `device:${event.from}->${event.to}`;
				default:
					return event.event;
			}
		};

		const hangup: CallEventOf<"channel.hangup"> = {
			event: "channel.hangup",
			organizationId: "org",
			callId: "call",
			channelId: "chan",
			cause: "NORMAL_CLEARING",
			initiator: "caller",
		};

		expect(summarise(hangup)).toBe("hangup:NORMAL_CLEARING");
		expect(
			summarise({
				event: "device.state-changed",
				organizationId: "org",
				deviceRef: "1001",
				from: "ringing",
				to: "active",
			}),
		).toBe("device:ringing->active");
	});
});
