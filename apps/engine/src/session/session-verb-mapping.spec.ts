import { describe, expect, it } from "bun:test";
import { SESSION_VERBS } from "@optimiq-voice/events";
import { isMappingError, toRuntimeVerb, toWireResult } from "./session-verb-mapping";
import type { SessionVerbRequest } from "@optimiq-voice/events";

/**
 * The wire ↔ runtime seam.
 *
 * This is where the flat argument record the Go emitter forced on the contract is paid for, so it is
 * where the cost has to be shown to be bounded: **every verb the protocol declares maps**, and a
 * missing required argument is refused HERE, by name, rather than reaching the media server as
 * `undefined`. Both are asserted over the contract's own list, so a verb added to
 * `packages/events` and forgotten here fails this file rather than a live call.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

function request(overrides: Partial<SessionVerbRequest>): SessionVerbRequest {
	return {
		orgId: ORG,
		sessionId: "sess-1",
		callId: "call-1",
		legId: "leg-1",
		verb: "answer",
		...overrides,
	};
}

/** Arguments that satisfy every verb's requirements, so the coverage sweep can be exhaustive. */
const COMPLETE = {
	media: "sound:hello",
	maxDigits: 4,
	timeoutMs: 5_000,
	interDigitTimeoutMs: 2_000,
	targets: [{ destination: "1001" }] as { destination: string }[],
	peerLegId: "leg-2",
	destination: "1002",
	digits: ["1"] as string[],
	name: "FOO",
	value: "bar",
	durationMs: 100,
};

describe("toRuntimeVerb", () => {
	it("maps every verb the protocol declares", () => {
		for (const verb of SESSION_VERBS) {
			const mapped = toRuntimeVerb(request({ verb, arguments: { ...COMPLETE } }));
			expect(isMappingError(mapped) ? `${verb}: ${mapped.error}` : mapped.verb.verb).toBe(verb);
		}
	});

	it.each([
		["play", "media"],
		["gather", "maxDigits"],
		["dial", "target"],
		["bridge", "peerLegId"],
		["transfer", "destination"],
		["setVariable", "name and value"],
		["sleep", "durationMs"],
	])("refuses a %s with no arguments, naming what it needed", (verb, expected) => {
		const mapped = toRuntimeVerb(request({ verb: verb as (typeof SESSION_VERBS)[number] }));
		expect(isMappingError(mapped)).toBe(true);
		expect((mapped as { error: string }).error).toContain(expected);
	});

	/**
	 * Neither timeout is defaulted, and the refusal names both. `GatherVerb` says why: defaulting
	 * either is how an IVR ends up hanging on a silent caller, and nothing here can know which of the
	 * two a forgetful integrator meant.
	 */
	it("refuses a gather that states only one of its two timeouts", () => {
		const mapped = toRuntimeVerb(
			request({ verb: "gather", arguments: { maxDigits: 4, timeoutMs: 5_000 } }),
		);
		expect((mapped as { error: string }).error).toContain("interDigitTimeoutMs");
	});

	/**
	 * The toll boundary, expressed as a type. `outbound` is the only context that reaches a trunk, so
	 * it is the only one that becomes an `external` target; everything else resolves internally first.
	 */
	it("maps only an outbound target to the external kind", () => {
		const mapped = toRuntimeVerb(
			request({
				verb: "dial",
				arguments: {
					targets: [
						{ destination: "1001" },
						{ destination: "1002", context: "internal" },
						{ destination: "+15551230000", context: "outbound" },
					],
				},
			}),
		);
		expect(isMappingError(mapped)).toBe(false);
		expect((mapped as { verb: { targets: readonly { kind: string }[] } }).verb.targets).toEqual([
			{ kind: "extension", destination: "1001" },
			{ kind: "extension", destination: "1002" },
			{ kind: "external", destination: "+15551230000" },
		] as never);
	});

	it("defaults a dial's ring time rather than ringing until the caller gives up", () => {
		const mapped = toRuntimeVerb(
			request({ verb: "dial", arguments: { targets: [{ destination: "1001" }] } }),
		);
		expect((mapped as { verb: { timeoutMs: number; strategy: string } }).verb).toMatchObject({
			timeoutMs: 30_000,
			strategy: "sequential",
		});
	});

	/**
	 * `stopPlay` with no reference is NOT refused here. The executor refuses it, with its own
	 * explanation about the engine holding no per-leg playback list, and duplicating that would mean
	 * two places to change when the runtime learns to track playbacks.
	 */
	it("passes a reference-less stopPlay down to the executor's own refusal", () => {
		const mapped = toRuntimeVerb(request({ verb: "stopPlay" }));
		expect(isMappingError(mapped)).toBe(false);
	});
});

describe("toWireResult", () => {
	it("flattens a gather's collection", () => {
		expect(
			toWireResult("gather", {
				verb: "gather",
				endReason: "terminator",
				collection: { digits: ["1", "2"], endReason: "terminator" },
				elapsedMs: 900,
			}),
		).toEqual({ verb: "gather", endReason: "terminator", digits: ["1", "2"], elapsedMs: 900 });
	});

	it("carries a recording's handle and the object it was written to", () => {
		expect(
			toWireResult("record", {
				verb: "record",
				endReason: "completed",
				recordingId: "rec-1",
				mediaRef: "object://org/call/rec-1.wav",
				durationMs: 0,
				format: "wav",
			}),
		).toMatchObject({ recordingId: "rec-1", mediaRef: "object://org/call/rec-1.wav" });
	});

	/**
	 * A dial nobody answered carries its CAUSE, which is the field an application decides the next
	 * step from — try the mobile, or send them to voicemail.
	 */
	it("carries a failed dial's cause", () => {
		expect(
			toWireResult("dial", {
				verb: "dial",
				endReason: "failed",
				cause: "USER_BUSY",
				elapsedMs: 1_200,
			}),
		).toMatchObject({ endReason: "failed", cause: "USER_BUSY" });
	});

	it("reduces an acknowledged verb to its name and how it ended", () => {
		expect(toWireResult("answer", { verb: "answer", endReason: "completed" })).toEqual({
			verb: "answer",
			endReason: "completed",
		});
	});
});
