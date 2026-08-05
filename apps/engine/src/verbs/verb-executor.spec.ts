import { describe, expect, it } from "bun:test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { VERB_NAMES } from "@optimiq-voice/telephony";
import {
	MediaCommandFailure,
	UnsupportedVerbFailure,
	VerbNotPermittedFailure,
} from "./verb-errors";
import { makeVerbExecutor } from "./verb-executor";
import type { MediaPort, PlaybackHandle, PlayRequest } from "../ari/media-port";
import type { VerbChannelContext } from "./verb-executor";
import type { DtmfCollection, HangupCause, Verb, VerbResult } from "@optimiq-voice/telephony";

interface Call {
	readonly method: string;
	readonly args: readonly unknown[];
}

/** A complete media server, as far as the engine's logic is concerned. */
function fakeMedia(overrides: Partial<MediaPort> = {}): { port: MediaPort; calls: Call[] } {
	const calls: Call[] = [];
	const record = (method: string, ...args: unknown[]): void => {
		calls.push({ method, args });
	};

	const port: MediaPort = {
		answer: async (channelId) => {
			record("answer", channelId);
		},
		ring: async (channelId) => {
			record("ring", channelId);
		},
		play: async (channelId: string, request: PlayRequest): Promise<PlaybackHandle> => {
			record("play", channelId, request);
			return { playbackRef: request.playbackRef };
		},
		stopPlayback: async (playbackRef) => {
			record("stopPlayback", playbackRef);
		},
		hangup: async (channelId, cause: HangupCause) => {
			record("hangup", channelId, cause);
		},
		getVariable: async () => undefined,
		setVariable: async () => {
			// nothing to record for the specs below
		},
		channelExists: async () => true,
		...overrides,
	};

	return { port, calls };
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

describe("dispatch coverage", () => {
	const IMPLEMENTED = new Set(["answer", "ringing", "play", "gather", "hangup"]);

	it("handles every verb name in the protocol — implemented or explicitly unsupported", () => {
		// The executor's `switch` is exhaustive over the union at COMPILE time; this asserts the
		// runtime consequence, so that a verb added to `packages/telephony` without a case here
		// cannot slip through as an unhandled default.
		expect(VERB_NAMES.length).toBe(28);
		expect([...IMPLEMENTED].every((verb) => (VERB_NAMES as readonly string[]).includes(verb))).toBe(
			true,
		);
	});

	it("returns UnsupportedVerbFailure for each unimplemented verb", async () => {
		const samples: readonly Verb[] = [
			{ verb: "earlyMedia" },
			{ verb: "stopPlay" },
			{ verb: "playbackControl", action: "pause" },
			{ verb: "say", text: "hello" },
			{ verb: "stopSay" },
			{ verb: "record" },
			{ verb: "bridge", legId: "x" },
			{ verb: "unbridge" },
			{ verb: "transfer", kind: "blind", destination: { destination: "1001" } },
			{ verb: "hold" },
			{ verb: "unhold" },
			{ verb: "park" },
			{ verb: "unpark" },
			{ verb: "playDtmf", digits: ["1"] },
			{ verb: "mute", direction: "both" },
			{ verb: "unmute", direction: "both" },
			{ verb: "stream", direction: "both" },
			{ verb: "stopStream" },
			{ verb: "streamGather" },
			{ verb: "stopStreamGather" },
			{ verb: "setVariable", name: "X", value: "1" },
			{ verb: "sleep", durationMs: 100 },
		];

		for (const verb of samples) {
			const failure = failureValue(await run(fakeMedia().port, ANSWERED, verb));
			expect(failure).toBeInstanceOf(UnsupportedVerbFailure);
		}

		// Implemented + sampled unimplemented must account for the whole protocol.
		expect(samples.length + IMPLEMENTED.size).toBe(VERB_NAMES.length - 1);
	});
});
