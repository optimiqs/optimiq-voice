import { describe, expect, it } from "bun:test";
import { dtmfEventFrom, DtmfInbox } from "./dtmf-inbox";

const FAST = { maxDigits: 4, terminators: ["#"], timeoutMs: 40, interDigitTimeoutMs: 25 } as const;

function digit(value: string) {
	return dtmfEventFrom({ digit: value });
}

describe("dtmfEventFrom", () => {
	it("defaults to the transport essentially all SIP DTMF uses", () => {
		expect(dtmfEventFrom({ digit: "1" })).toEqual({
			digit: "1",
			durationMs: 100,
			source: "rfc2833",
		});
	});

	it("keeps a duration and source the media server reported", () => {
		expect(dtmfEventFrom({ digit: "2", durationMs: 240, source: "info" })).toEqual({
			digit: "2",
			durationMs: 240,
			source: "info",
		});
	});
});

describe("DtmfInbox", () => {
	it("resolves as digits arrive", async () => {
		const inbox = new DtmfInbox();
		const collecting = inbox.collect(FAST);
		expect(inbox.isCollecting).toBe(true);

		inbox.push(digit("1"));
		inbox.push(digit("2"));
		inbox.push(digit("#"));

		expect(await collecting).toEqual({
			digits: ["1", "2"],
			endReason: "terminator",
			terminator: "#",
		});
		expect(inbox.isCollecting).toBe(false);
	});

	it("buffers type-ahead and replays it, so a caller can dial over the greeting", async () => {
		const inbox = new DtmfInbox();
		inbox.push(digit("1"));
		inbox.push(digit("0"));
		inbox.push(digit("0"));
		inbox.push(digit("1"));
		expect(inbox.bufferedCount).toBe(4);

		// Resolves from the buffer alone — no timer ever fires.
		expect(await inbox.collect(FAST)).toEqual({
			digits: ["1", "0", "0", "1"],
			endReason: "max-digits",
		});
		expect(inbox.bufferedCount).toBe(0);
	});

	it("times out when the caller presses nothing", async () => {
		const inbox = new DtmfInbox();
		expect(await inbox.collect(FAST)).toEqual({ digits: [], endReason: "timeout" });
	});

	it("reports a gap after a first digit as an inter-digit timeout", async () => {
		const inbox = new DtmfInbox();
		const collecting = inbox.collect(FAST);
		inbox.push(digit("7"));
		expect(await collecting).toEqual({ digits: ["7"], endReason: "inter-digit-timeout" });
	});

	it("ends a running collection when the channel goes away", async () => {
		const inbox = new DtmfInbox();
		const collecting = inbox.collect({ ...FAST, timeoutMs: 10_000 });
		inbox.push(digit("5"));
		inbox.hangup();
		expect(await collecting).toEqual({ digits: ["5"], endReason: "hangup" });
	});

	it("ends a running collection when the engine abandons it", async () => {
		const inbox = new DtmfInbox();
		const collecting = inbox.collect({ ...FAST, timeoutMs: 10_000 });
		inbox.cancel();
		expect(await collecting).toEqual({ digits: [], endReason: "cancelled" });
	});

	it("refuses two concurrent collections on one leg", () => {
		const inbox = new DtmfInbox();
		void inbox.collect({ ...FAST, timeoutMs: 10_000 });
		expect(() => inbox.collect(FAST)).toThrow(/already running/u);
		inbox.cancel();
	});

	it("bounds the buffer so a stuck channel cannot grow it without limit", () => {
		const inbox = new DtmfInbox();
		for (let index = 0; index < 200; index += 1) {
			inbox.push(digit("1"));
		}
		expect(inbox.bufferedCount).toBeLessThanOrEqual(64);
	});

	it("clears the buffer on hangup", () => {
		const inbox = new DtmfInbox();
		inbox.push(digit("1"));
		inbox.hangup();
		expect(inbox.bufferedCount).toBe(0);
	});
});
