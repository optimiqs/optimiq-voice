import { describe, expect, it } from "bun:test";
import { AriEventParseError } from "./errors";
import {
	ARI_EVENT_TYPES,
	callerIdOf,
	channelOfEvent,
	isAriEventType,
	parseAriEvent,
	parseAriEventFrame,
} from "./events";

const channel = {
	id: "1754400000.42",
	name: "PJSIP/trunk-00000001",
	state: "Ring",
	caller: { name: "Ada", number: "+15551234567" },
	dialplan: { context: "local-ctx", exten: "+15559876543", priority: 1 },
};

function frame(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type,
		application: "optimiq-engine",
		timestamp: "2026-08-05T10:00:00.000+0000",
		asterisk_id: "aa:bb:cc:dd:ee:ff",
		...extra,
	};
}

describe("event type vocabulary", () => {
	it("recognises every modelled type", () => {
		for (const type of ARI_EVENT_TYPES) {
			expect(isAriEventType(type)).toBe(true);
		}
	});

	it("rejects an unmodelled type", () => {
		expect(isAriEventType("ContactStatusChange")).toBe(false);
	});

	it("has no duplicates", () => {
		expect(new Set(ARI_EVENT_TYPES).size).toBe(ARI_EVENT_TYPES.length);
	});
});

describe("parseAriEvent", () => {
	it("carries application, timestamp and asterisk id onto every event", () => {
		const event = parseAriEvent(frame("StasisEnd", { channel }));
		expect(event.application).toBe("optimiq-engine");
		expect(event.timestamp).toBe("2026-08-05T10:00:00.000+0000");
		expect(event.asteriskId).toBe("aa:bb:cc:dd:ee:ff");
	});

	it("parses StasisStart with dialplan args", () => {
		const event = parseAriEvent(frame("StasisStart", { channel, args: ["inbound", "did"] }));
		expect(event.type).toBe("StasisStart");
		if (event.type !== "StasisStart") {
			throw new Error("narrowing failed");
		}
		expect(event.channel.id).toBe("1754400000.42");
		expect(event.args).toEqual(["inbound", "did"]);
		expect(event.replaceChannel).toBeUndefined();
	});

	it("keeps replaceChannel, which is how a completing transfer keeps its call id", () => {
		const event = parseAriEvent(
			frame("StasisStart", {
				channel,
				args: [],
				replace_channel: { ...channel, id: "1754400000.7" },
			}),
		);
		if (event.type !== "StasisStart") {
			throw new Error("narrowing failed");
		}
		expect(event.replaceChannel?.id).toBe("1754400000.7");
	});

	it("defaults missing args to an empty list", () => {
		const event = parseAriEvent(frame("StasisStart", { channel }));
		if (event.type !== "StasisStart") {
			throw new Error("narrowing failed");
		}
		expect(event.args).toEqual([]);
	});

	it("renames duration_ms to durationMs on DTMF", () => {
		const event = parseAriEvent(
			frame("ChannelDtmfReceived", { channel, digit: "5", duration_ms: 120 }),
		);
		if (event.type !== "ChannelDtmfReceived") {
			throw new Error("narrowing failed");
		}
		expect(event.digit).toBe("5");
		expect(event.durationMs).toBe(120);
	});

	it("keeps the numeric hangup cause and its text on ChannelDestroyed", () => {
		const event = parseAriEvent(
			frame("ChannelDestroyed", { channel, cause: 17, cause_txt: "User busy" }),
		);
		if (event.type !== "ChannelDestroyed") {
			throw new Error("narrowing failed");
		}
		expect(event.cause).toBe(17);
		expect(event.causeText).toBe("User busy");
	});

	it("defaults a missing cause to 0 rather than dropping the event", () => {
		const event = parseAriEvent(frame("ChannelDestroyed", { channel }));
		if (event.type !== "ChannelDestroyed") {
			throw new Error("narrowing failed");
		}
		expect(event.cause).toBe(0);
		expect(event.causeText).toBe("");
	});

	it("parses ChannelHangupRequest with an optional cause and soft flag", () => {
		const event = parseAriEvent(frame("ChannelHangupRequest", { channel, cause: 16, soft: true }));
		if (event.type !== "ChannelHangupRequest") {
			throw new Error("narrowing failed");
		}
		expect(event.cause).toBe(16);
		expect(event.soft).toBe(true);
	});

	it("parses a channel-scoped ChannelVarset", () => {
		const event = parseAriEvent(
			frame("ChannelVarset", { channel, variable: "OPTIMIQ_ORG_ID", value: "org-1" }),
		);
		if (event.type !== "ChannelVarset") {
			throw new Error("narrowing failed");
		}
		expect(event.variable).toBe("OPTIMIQ_ORG_ID");
		expect(event.value).toBe("org-1");
		expect(event.channel?.id).toBe("1754400000.42");
	});

	it("parses a global ChannelVarset, which has no channel", () => {
		const event = parseAriEvent(frame("ChannelVarset", { variable: "GLOBAL_X", value: "1" }));
		if (event.type !== "ChannelVarset") {
			throw new Error("narrowing failed");
		}
		expect(event.channel).toBeUndefined();
	});

	it("parses playback events", () => {
		const playback = {
			id: "pb-1",
			media_uri: "sound:hello",
			target_uri: "channel:x",
			state: "playing",
		};
		const started = parseAriEvent(frame("PlaybackStarted", { playback }));
		const finished = parseAriEvent(
			frame("PlaybackFinished", { playback: { ...playback, state: "done" } }),
		);
		if (started.type !== "PlaybackStarted" || finished.type !== "PlaybackFinished") {
			throw new Error("narrowing failed");
		}
		expect(started.playback.id).toBe("pb-1");
		expect(finished.playback.state).toBe("done");
	});

	it("parses recording events including the failure cause", () => {
		const recording = {
			name: "rec-1",
			format: "wav",
			target_uri: "channel:x",
			state: "failed",
			cause: "disk full",
		};
		const event = parseAriEvent(frame("RecordingFailed", { recording }));
		if (event.type !== "RecordingFailed") {
			throw new Error("narrowing failed");
		}
		expect(event.recording.cause).toBe("disk full");
	});

	it("parses bridge membership events", () => {
		const bridge = {
			id: "br-1",
			technology: "simple_bridge",
			bridge_type: "mixing",
			channels: ["a", "b"],
		};
		const entered = parseAriEvent(frame("ChannelEnteredBridge", { bridge, channel }));
		if (entered.type !== "ChannelEnteredBridge") {
			throw new Error("narrowing failed");
		}
		expect(entered.bridge.id).toBe("br-1");
		expect(entered.bridge.channels).toEqual(["a", "b"]);
		expect(entered.channel.id).toBe("1754400000.42");
	});

	it("parses Dial with its dialstatus, the outbound-failover signal", () => {
		const event = parseAriEvent(
			frame("Dial", { peer: channel, dialstatus: "BUSY", dialstring: "PJSIP/1001" }),
		);
		if (event.type !== "Dial") {
			throw new Error("narrowing failed");
		}
		expect(event.dialstatus).toBe("BUSY");
		expect(event.peer.id).toBe("1754400000.42");
		expect(event.caller).toBeUndefined();
	});

	it("parses PeerStatusChange with its endpoint and qualify verdict", () => {
		const event = parseAriEvent(
			frame("PeerStatusChange", {
				endpoint: { technology: "PJSIP", resource: "carrier-a", state: "online" },
				peer: { peer_status: "Reachable", time: "24" },
			}),
		);
		if (event.type !== "PeerStatusChange") {
			throw new Error("narrowing failed");
		}
		expect(event.endpoint?.resource).toBe("carrier-a");
		expect(event.peer.peer_status).toBe("Reachable");
		expect(event.peer.time).toBe("24");
	});

	it("tolerates a PeerStatusChange whose peer said nothing, and one with no endpoint", () => {
		// Channel drivers disagree on which rider fields accompany which transition; a strict
		// parse would turn a driver quirk into a dropped event. The consumer reads "" as unknown.
		const bare = parseAriEvent(frame("PeerStatusChange", { peer: {} }));
		if (bare.type !== "PeerStatusChange") {
			throw new Error("narrowing failed");
		}
		expect(bare.peer.peer_status).toBe("");
		expect(bare.endpoint).toBeUndefined();
	});

	it("keeps an unmodelled event as Unknown with its raw payload", () => {
		const event = parseAriEvent(
			frame("ContactStatusChange", { contact_info: { uri: "sip:1001@10.0.0.5" } }),
		);
		if (event.type !== "Unknown") {
			throw new Error("narrowing failed");
		}
		expect(event.ariType).toBe("ContactStatusChange");
		expect(event.raw.contact_info).toEqual({ uri: "sip:1001@10.0.0.5" });
	});

	it("rejects a frame that is not an object", () => {
		expect(() => parseAriEvent("StasisStart")).toThrow(AriEventParseError);
		expect(() => parseAriEvent(null)).toThrow(AriEventParseError);
		expect(() => parseAriEvent([1, 2])).toThrow(AriEventParseError);
	});

	it("rejects a frame with no type", () => {
		expect(() => parseAriEvent({ application: "optimiq-engine" })).toThrow(AriEventParseError);
	});

	it("rejects an event whose defining resource is missing", () => {
		expect(() => parseAriEvent(frame("StasisStart", {}))).toThrow(AriEventParseError);
	});

	it("rejects a channel with no id, because that is not a channel", () => {
		expect(() =>
			parseAriEvent(frame("StasisEnd", { channel: { name: "x", state: "Up" } })),
		).toThrow(AriEventParseError);
	});

	it("truncates the retained sample so caller data cannot flood a log", () => {
		try {
			parseAriEvent("x".repeat(5000));
			throw new Error("expected a parse error");
		} catch (error) {
			expect(error).toBeInstanceOf(AriEventParseError);
			expect((error as AriEventParseError).sample.length).toBeLessThanOrEqual(200);
		}
	});
});

describe("parseAriEventFrame", () => {
	it("decodes a JSON text frame", () => {
		const event = parseAriEventFrame(JSON.stringify(frame("StasisEnd", { channel })));
		expect(event.type).toBe("StasisEnd");
	});

	it("rejects a non-JSON frame", () => {
		expect(() => parseAriEventFrame("<html>502</html>")).toThrow(AriEventParseError);
	});
});

describe("channelOfEvent", () => {
	it("returns the channel for channel-scoped events", () => {
		expect(channelOfEvent(parseAriEvent(frame("StasisEnd", { channel })))?.id).toBe(channel.id);
	});

	it("returns the peer for a Dial", () => {
		expect(
			channelOfEvent(parseAriEvent(frame("Dial", { peer: channel, dialstatus: "" })))?.id,
		).toBe(channel.id);
	});

	it("returns undefined for events that are not about a channel", () => {
		const bridge = { id: "br-1" };
		expect(channelOfEvent(parseAriEvent(frame("BridgeCreated", { bridge })))).toBeUndefined();
		expect(channelOfEvent(parseAriEvent(frame("PeerStatusChange", { peer: {} })))).toBeUndefined();
	});
});

describe("callerIdOf", () => {
	it("returns the caller id when present", () => {
		expect(
			callerIdOf({ id: "x", name: "", state: "Up", caller: { name: "Ada", number: "1" } }),
		).toEqual({ name: "Ada", number: "1" });
	});

	it("returns empty strings when ARI omitted the object", () => {
		expect(callerIdOf({ id: "x", name: "", state: "Up" })).toEqual({ name: "", number: "" });
	});
});
