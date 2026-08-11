import { describe, expect, it } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { VERB_NAMES } from "@optimiq-voice/telephony";
import { CallControlRegistry } from "../calls/call-control-registry";
import { makeFakeMediaPort } from "../media/media-port.fake";
import {
	MediaCommandFailure,
	UnsupportedVerbFailure,
	VerbNotPermittedFailure,
} from "./verb-errors";
import { makeVerbExecutor } from "./verb-executor";
import type { CallControlPort, ControlledLeg } from "../calls/call-control";
import type { MediaPort } from "../media/media-port";
import type { VerbChannelContext } from "./verb-executor";
import type { DtmfCollection, Verb, VerbResult } from "@optimiq-voice/telephony";

interface Call {
	readonly method: string;
	readonly args: readonly unknown[];
}

/**
 * A complete media server, as far as the engine's logic is concerned.
 *
 * Built on the shared `*.fake.ts` port so that a method added to `MediaPort` does not have to be
 * re-stubbed in every spec file that touches it; `overrides` is what these specs actually use it
 * for — making one command fail.
 */
function fakeMedia(overrides: Partial<MediaPort> = {}): { port: MediaPort; calls: Call[] } {
	const fake = makeFakeMediaPort();
	return { port: { ...fake, ...overrides }, calls: fake.calls };
}

const ANSWERED: VerbChannelContext = {
	mediaChannelId: "1754400000.1",
	channelId: "0195c0f0-1c2f-7000-8000-0000000000e1",
	isTearingDown: false,
	hasMediaPath: true,
};

const UNANSWERED: VerbChannelContext = { ...ANSWERED, hasMediaPath: false };
const TEARING_DOWN: VerbChannelContext = { ...ANSWERED, isTearingDown: true };

const COLLECTION: DtmfCollection = { digits: ["1", "2"], endReason: "max-digits" };

function executor(
	media: MediaPort,
	collect: (context: VerbChannelContext) => Promise<DtmfCollection> = async () => COLLECTION,
) {
	let counter = 0;
	return makeVerbExecutor({
		media,
		collectDtmf: (context) => collect(context),
		now: () => 0,
		newPlaybackRef: () => `pb-${String(++counter)}`,
	});
}

async function run(
	media: MediaPort,
	context: VerbChannelContext,
	verb: Verb,
	collect?: (context: VerbChannelContext) => Promise<DtmfCollection>,
) {
	return await Effect.runPromiseExit(executor(media, collect).dispatch(context, verb));
}

function successValue(exit: Exit.Exit<VerbResult, unknown>): VerbResult {
	if (!Exit.isSuccess(exit)) {
		throw new Error(`expected success, got ${String(exit)}`);
	}
	return exit.value;
}

function failureValue(exit: Exit.Exit<VerbResult, unknown>): unknown {
	if (Exit.isSuccess(exit)) {
		throw new Error("expected a failure");
	}
	const found = Cause.findErrorOption(exit.cause);
	if (found._tag !== "Some") {
		throw new Error(`expected a typed failure, got a defect: ${Cause.pretty(exit.cause)}`);
	}
	return found.value;
}

describe("implemented verbs", () => {
	it("answers", async () => {
		const media = fakeMedia();
		const result = successValue(await run(media.port, UNANSWERED, { verb: "answer" }));
		expect(result).toEqual({ verb: "answer", endReason: "completed" });
		expect(media.calls).toEqual([{ method: "answer", args: ["1754400000.1"] }]);
	});

	it("rings", async () => {
		const media = fakeMedia();
		const result = successValue(await run(media.port, UNANSWERED, { verb: "ringing" }));
		expect(result).toEqual({ verb: "ringing", endReason: "completed" });
		expect(media.calls[0]?.method).toBe("ring");
	});

	it("plays and returns the handle it will be stopped with", async () => {
		const media = fakeMedia();
		const result = successValue(
			await run(media.port, ANSWERED, { verb: "play", media: "sound:hello" }),
		);
		expect(result).toMatchObject({ verb: "play", endReason: "completed", playbackRef: "pb-1" });
		expect(media.calls[0]).toEqual({
			method: "play",
			args: ["1754400000.1", { media: ["sound:hello"], playbackRef: "pb-1" }],
		});
	});

	it("honours a caller-supplied playback reference", async () => {
		const media = fakeMedia();
		await run(media.port, ANSWERED, { verb: "play", media: "sound:hello", playbackRef: "mine" });
		expect(media.calls[0]?.args[1]).toMatchObject({ playbackRef: "mine" });
	});

	it("hangs up with the requested cause", async () => {
		const media = fakeMedia();
		successValue(await run(media.port, ANSWERED, { verb: "hangup", cause: "USER_BUSY" }));
		expect(media.calls[0]).toEqual({ method: "hangup", args: ["1754400000.1", "USER_BUSY"] });
	});

	it("defaults a hangup with no cause to NORMAL_CLEARING", async () => {
		const media = fakeMedia();
		await run(media.port, ANSWERED, { verb: "hangup" });
		expect(media.calls[0]?.args[1]).toBe("NORMAL_CLEARING");
	});
});

describe("gather", () => {
	const GATHER: Verb = {
		verb: "gather",
		maxDigits: 4,
		terminators: ["#"],
		timeoutMs: 5_000,
		interDigitTimeoutMs: 2_000,
		media: "sound:enter-extension",
	};

	it("plays the prompt, collects, and stops the prompt on the way out", async () => {
		const media = fakeMedia();
		const result = successValue(await run(media.port, ANSWERED, GATHER));

		expect(result).toMatchObject({
			verb: "gather",
			endReason: "completed",
			collection: COLLECTION,
		});
		expect(media.calls.map((call) => call.method)).toEqual(["play", "stopPlayback"]);
	});

	it("stops the prompt even when collection timed out — barge-in must never leave audio on", async () => {
		const media = fakeMedia();
		await run(media.port, ANSWERED, GATHER, async () => ({ digits: [], endReason: "timeout" }));
		expect(media.calls.map((call) => call.method)).toEqual(["play", "stopPlayback"]);
	});

	it("collects with no prompt at all", async () => {
		const media = fakeMedia();
		const result = successValue(
			await run(media.port, ANSWERED, { ...GATHER, media: undefined } as Verb),
		);
		expect(result).toMatchObject({ verb: "gather" });
		expect(media.calls).toEqual([]);
	});

	it("maps every collection end reason onto a verb end reason", async () => {
		const cases: readonly [DtmfCollection["endReason"], string][] = [
			["max-digits", "completed"],
			["pattern", "completed"],
			["terminator", "terminator"],
			["timeout", "timeout"],
			["inter-digit-timeout", "timeout"],
			["cancelled", "cancelled"],
			["hangup", "hangup"],
		];

		for (const [collectionReason, expected] of cases) {
			const result = successValue(
				await run(fakeMedia().port, ANSWERED, GATHER, async () => ({
					digits: [],
					endReason: collectionReason,
				})),
			);
			expect(result.endReason).toBe(expected as VerbResult["endReason"]);
		}
	});

	it("does not fail the gather when stopping the prompt fails", async () => {
		const media = fakeMedia({
			stopPlayback: async () => {
				throw new Error("playback already gone");
			},
		});
		const result = successValue(await run(media.port, ANSWERED, GATHER));
		expect(result).toMatchObject({ verb: "gather" });
	});
});

describe("guards", () => {
	it("refuses every verb on a leg that is tearing down", async () => {
		const failure = failureValue(await run(fakeMedia().port, TEARING_DOWN, { verb: "answer" }));
		expect(failure).toBeInstanceOf(VerbNotPermittedFailure);
		expect((failure as VerbNotPermittedFailure).reason).toContain("tearing down");
	});

	it("refuses a media verb on a leg with no media path — never implicitly answers", async () => {
		const media = fakeMedia();
		const failure = failureValue(
			await run(media.port, UNANSWERED, { verb: "play", media: "sound:hello" }),
		);
		expect(failure).toBeInstanceOf(VerbNotPermittedFailure);
		// The guard ran BEFORE any media command was issued.
		expect(media.calls).toEqual([]);
	});

	it("allows the non-media verbs on an unanswered leg", async () => {
		const media = fakeMedia();
		expect(Exit.isSuccess(await run(media.port, UNANSWERED, { verb: "answer" }))).toBe(true);
		expect(Exit.isSuccess(await run(media.port, UNANSWERED, { verb: "ringing" }))).toBe(true);
		expect(Exit.isSuccess(await run(media.port, UNANSWERED, { verb: "hangup" }))).toBe(true);
	});
});

describe("failures", () => {
	it("maps a media-server rejection to a typed failure, never a defect", async () => {
		const media = fakeMedia({
			answer: async () => {
				throw new Error("channel not in Stasis");
			},
		});
		const failure = failureValue(await run(media.port, UNANSWERED, { verb: "answer" }));
		expect(failure).toBeInstanceOf(MediaCommandFailure);
		expect((failure as MediaCommandFailure).detail).toContain("channel not in Stasis");
		expect((failure as MediaCommandFailure).verb).toBe("answer");
	});

	it("reports an unimplemented verb honestly rather than silently doing nothing", async () => {
		const failure = failureValue(
			await run(fakeMedia().port, ANSWERED, {
				verb: "dial",
				targets: [{ kind: "extension", destination: "1001" }],
				strategy: "simultaneous",
				timeoutMs: 30_000,
			}),
		);
		expect(failure).toBeInstanceOf(UnsupportedVerbFailure);
		expect((failure as UnsupportedVerbFailure).verb).toBe("dial");
	});
});

describe("media verbs", () => {
	it("generates DTMF towards the far end as one string", async () => {
		const media = fakeMedia();
		successValue(
			await run(media.port, ANSWERED, {
				verb: "playDtmf",
				digits: ["1", "2", "#"],
				toneDurationMs: 120,
			}),
		);
		expect(media.calls[0]).toEqual({
			method: "sendDtmf",
			args: ["1754400000.1", { digits: "12#", toneDurationMs: 120 }],
		});
	});

	it("mutes and unmutes in the direction it was asked for", async () => {
		const media = fakeMedia();
		successValue(await run(media.port, ANSWERED, { verb: "mute", direction: "in" }));
		successValue(await run(media.port, ANSWERED, { verb: "unmute", direction: "both" }));
		expect(media.calls).toEqual([
			{ method: "mute", args: ["1754400000.1", "in"] },
			{ method: "unmute", args: ["1754400000.1", "both"] },
		]);
	});

	it("stops one playback by reference, and refuses a stop with no reference", async () => {
		const media = fakeMedia();
		successValue(await run(media.port, ANSWERED, { verb: "stopPlay", playbackRef: "pb-9" }));
		expect(media.calls[0]).toEqual({ method: "stopPlayback", args: ["pb-9"] });

		const failure = failureValue(await run(fakeMedia().port, ANSWERED, { verb: "stopPlay" }));
		expect(failure).toBeInstanceOf(VerbNotPermittedFailure);
		expect((failure as VerbNotPermittedFailure).reason).toContain("playback reference");
	});

	it("writes a channel-scoped variable and refuses the scopes that are policy, not writes", async () => {
		const media = fakeMedia();
		successValue(await run(media.port, ANSWERED, { verb: "setVariable", name: "X", value: "1" }));
		expect((media.port as unknown as { variables: Record<string, string> }).variables.X).toBe("1");

		const failure = failureValue(
			await run(fakeMedia().port, ANSWERED, {
				verb: "setVariable",
				name: "X",
				value: "1",
				scope: "export",
			}),
		);
		expect(failure).toBeInstanceOf(VerbNotPermittedFailure);
	});

	it("sleeps for the requested time without holding a real timer in a spec", async () => {
		const slept: number[] = [];
		const executorWithDelay = makeVerbExecutor({
			media: fakeMedia().port,
			collectDtmf: async () => COLLECTION,
			delay: async (ms) => {
				slept.push(ms);
			},
		});
		const exit = await Effect.runPromiseExit(
			executorWithDelay.dispatch(ANSWERED, { verb: "sleep", durationMs: 250 }),
		);
		expect(Exit.isSuccess(exit)).toBe(true);
		expect(slept).toEqual([250]);
	});
});

describe("call-control verbs", () => {
	function boundExecutor(port: Partial<CallControlPort> = {}) {
		const calls: { verb: string; args: unknown }[] = [];
		const leg = { mediaChannelId: "1754400000.1", legId: ANSWERED.channelId } as ControlledLeg;
		const registry = new CallControlRegistry();
		registry.register({
			legFor: (mediaChannelId) => (mediaChannelId === leg.mediaChannelId ? leg : undefined),
			port: {
				hold: async (_leg, request) => {
					calls.push({ verb: "hold", args: request });
					return { ok: true };
				},
				unhold: async () => {
					calls.push({ verb: "unhold", args: undefined });
					return { ok: true };
				},
				park: async (_leg, request) => {
					calls.push({ verb: "park", args: request });
					return { result: { ok: true }, slot: 401 };
				},
				unpark: async (_leg, request) => {
					calls.push({ verb: "unpark", args: request });
					return { ok: true };
				},
				transfer: async (_leg, request) => {
					calls.push({ verb: "transfer", args: request });
					return { ok: true };
				},
				completeTransfer: async () => ({ ok: true }),
				cancelTransfer: async () => ({ ok: true }),
				pickup: async () => ({ ok: true }),
				startRecording: async (_leg, request) => {
					calls.push({ verb: "record", args: request });
					return { result: { ok: true }, recordingId: "rec-1", objectKey: "org/call/rec-1.wav" };
				},
				stopRecording: async () => ({ ok: true }),
				hasPendingTransfer: () => false,
				onLegEnded: async () => undefined,
				...port,
			} as CallControlPort,
		});
		return {
			calls,
			dispatch: (verb: Verb) =>
				Effect.runPromiseExit(
					makeVerbExecutor({
						media: fakeMedia().port,
						collectDtmf: async () => COLLECTION,
						callControl: registry,
					}).dispatch(ANSWERED, verb),
				),
		};
	}

	it("passes hold, park, unpark and transfer straight through to the call-control seam", async () => {
		const bound = boundExecutor();
		successValue(await bound.dispatch({ verb: "hold", musicOnHold: "stream:moh", soft: true }));
		successValue(await bound.dispatch({ verb: "unhold" }));
		successValue(await bound.dispatch({ verb: "park", lot: "main", orbit: "401" }));
		successValue(await bound.dispatch({ verb: "unpark", orbit: "401" }));
		successValue(
			await bound.dispatch({
				verb: "transfer",
				kind: "attended",
				destination: { destination: "1002", context: "internal" },
				fallbackDestination: { destination: "1003" },
			}),
		);

		expect(bound.calls).toEqual([
			{ verb: "hold", args: { musicOnHold: "stream:moh", soft: true } },
			{ verb: "unhold", args: undefined },
			{ verb: "park", args: { lot: "main", orbit: "401" } },
			{ verb: "unpark", args: { orbit: "401" } },
			{
				verb: "transfer",
				args: {
					kind: "attended",
					destination: "1002",
					context: "internal",
					fallbackDestination: "1003",
				},
			},
		]);
	});

	it("returns the recording handle as an object ref, and returns as soon as it is running", async () => {
		const bound = boundExecutor();
		const result = successValue(await bound.dispatch({ verb: "record", maxDurationMs: 60_000 }));
		expect(result).toMatchObject({
			verb: "record",
			endReason: "completed",
			recordingId: "rec-1",
			mediaRef: "object://org/call/rec-1.wav",
			// The real figure rides `channel.record.stopped`; see the executor's note.
			durationMs: 0,
		});
		expect(bound.calls[0]?.args).toEqual({ maxDurationMs: 60_000 });
	});

	it("turns a refusal into a typed failure carrying the reason", async () => {
		const bound = boundExecutor({
			hold: async () => ({ ok: false, reason: "the leg is already on hold" }),
		});
		const failure = failureValue(await bound.dispatch({ verb: "hold" }));
		expect(failure).toBeInstanceOf(VerbNotPermittedFailure);
		expect((failure as VerbNotPermittedFailure).reason).toBe("the leg is already on hold");
	});

	it("reports a call-control verb as unsupported when nothing has bound the seam", async () => {
		const failure = failureValue(await run(fakeMedia().port, ANSWERED, { verb: "hold" }));
		expect(failure).toBeInstanceOf(UnsupportedVerbFailure);
		expect((failure as UnsupportedVerbFailure).verb).toBe("hold");
	});

	it("refuses a leg this engine is not handling, rather than acting on the wrong one", async () => {
		const registry = new CallControlRegistry();
		registry.register({ legFor: () => undefined, port: {} as CallControlPort });
		const exit = await Effect.runPromiseExit(
			makeVerbExecutor({
				media: fakeMedia().port,
				collectDtmf: async () => COLLECTION,
				callControl: registry,
			}).dispatch(ANSWERED, { verb: "unhold" }),
		);
		const failure = failureValue(exit);
		expect(failure).toBeInstanceOf(VerbNotPermittedFailure);
		expect((failure as VerbNotPermittedFailure).reason).toContain("not handling the leg");
	});

	it("refuses park on a leg with no media path — an orbit nobody can hear is not a park", async () => {
		const bound = boundExecutor();
		const registry = new CallControlRegistry();
		registry.register({ legFor: () => ({}) as ControlledLeg, port: {} as CallControlPort });
		const exit = await Effect.runPromiseExit(
			makeVerbExecutor({
				media: fakeMedia().port,
				collectDtmf: async () => COLLECTION,
				callControl: registry,
			}).dispatch(UNANSWERED, { verb: "park" }),
		);
		expect(failureValue(exit)).toBeInstanceOf(VerbNotPermittedFailure);
		expect(bound.calls).toEqual([]);
	});
});

describe("dispatch coverage", () => {
	const IMPLEMENTED = new Set([
		"answer",
		"ringing",
		"play",
		"gather",
		"hangup",
		"stopPlay",
		"setVariable",
		"record",
		"hold",
		"unhold",
		"park",
		"unpark",
		"transfer",
		"playDtmf",
		"mute",
		"unmute",
		"sleep",
	]);

	it("handles every verb name in the protocol — implemented or explicitly unsupported", () => {
		// The executor's `switch` is exhaustive over the union at COMPILE time; this asserts the
		// runtime consequence, so that a verb added to `packages/telephony` without a case here
		// cannot slip through as an unhandled default.
		expect(VERB_NAMES.length).toBe(28);
		expect([...IMPLEMENTED].every((verb) => (VERB_NAMES as readonly string[]).includes(verb))).toBe(
			true,
		);
	});

	it("returns UnsupportedVerbFailure for each verb that is still unimplemented", async () => {
		const samples: readonly Verb[] = [
			{ verb: "earlyMedia" },
			{ verb: "playbackControl", action: "pause" },
			{ verb: "say", text: "hello" },
			{ verb: "stopSay" },
			{ verb: "dial", targets: [], strategy: "simultaneous", timeoutMs: 1_000 },
			{ verb: "bridge", legId: "x" },
			{ verb: "unbridge" },
			{ verb: "stream", direction: "both" },
			{ verb: "stopStream" },
			{ verb: "streamGather" },
			{ verb: "stopStreamGather" },
		];

		for (const verb of samples) {
			const failure = failureValue(await run(fakeMedia().port, ANSWERED, verb));
			expect(failure).toBeInstanceOf(UnsupportedVerbFailure);
		}

		// Implemented + sampled unimplemented must account for the whole protocol.
		expect(samples.length + IMPLEMENTED.size).toBe(VERB_NAMES.length);
	});
});
