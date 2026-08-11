import { describe, expect, it } from "bun:test";
import { DEFAULT_MID_CALL_FEATURE_SETTINGS } from "@optimiq-voice/telephony";
import { MID_CALL_ACTION_BY_COMPILED_ACTION, MidCallFeatureRuntime } from "./mid-call-features";
import type {
	CallControlResult,
	ControlledLeg,
	ParkOutcome,
	RecordingOutcome,
	TransferRequest,
} from "./call-control";
import type { MidCallFeatureControl } from "./mid-call-features";
import type { RoutingArtifact } from "@optimiq-voice/routing";

/**
 * Mid-call feature codes, driven end to end with a fake call-control surface and a fake clock.
 *
 * The interesting assertions are about the digits the runtime does NOT take. A `*` swallowed from a
 * party who was navigating the far end's IVR is worse than the feature not existing, and the two
 * guards that stop it — "only on a bridged leg" and "only when nothing is collecting" — are why
 * most of this file is about pass-through.
 */

const ORG = "0195c0f0-1c2f-7000-8000-000000000001";

interface Recorded {
	readonly method: string;
	readonly args?: unknown;
}

interface Harness {
	readonly runtime: MidCallFeatureRuntime;
	readonly calls: Recorded[];
	readonly leg: ControlledLeg;
	/** Fires every armed timer whose delay has elapsed, advancing the clock to `atMs`. */
	advanceTo(atMs: number): void;
	now(): number;
}

interface HarnessOptions {
	/** Compiled codes, as `internal.featureCodes` holds them. */
	readonly codes?: readonly { readonly code: string; readonly action: string }[];
	/** No artifact at all, as an organization the engine cannot resolve produces. */
	readonly noArtifact?: boolean;
	readonly bridged?: boolean;
	readonly answered?: boolean;
	readonly recording?: boolean;
	readonly pendingTransfer?: boolean;
	readonly transferResult?: CallControlResult;
	/** The transfer never resolves: a routing walk that is still ringing somebody's phone. */
	readonly slowTransfer?: boolean;
	readonly parkResult?: ParkOutcome;
}

const DEFAULT_CODES = [
	{ code: "*1", action: "transfer" },
	{ code: "*3", action: "record-toggle" },
	{ code: "*5", action: "call-park" },
	// Present in every real catalogue and deliberately WITHOUT a mid-call runtime.
	{ code: "*72", action: "call-forward-all" },
	{ code: "*97", action: "voicemail-check" },
] as const;

function harness(options: HarnessOptions = {}): Harness {
	const calls: Recorded[] = [];
	let clock = 0;
	let recording = options.recording === true;
	const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];

	const leg: ControlledLeg = {
		mediaChannelId: "a",
		legId: "leg-a",
		callId: "call-a",
		organizationId: ORG,
		isTearingDown: false,
		isAnswered: options.answered !== false,
		bridgeId: options.bridged === false ? undefined : "bridge-1",
		peerMediaChannelId: "b",
		moveTo: () => true,
		moveCallStateTo: () => true,
		setBridge: () => undefined,
		setBridgePeer: () => undefined,
		addFlag: () => undefined,
		removeFlag: () => undefined,
		markHangup: () => undefined,
		detach: () => undefined,
	};

	const control: MidCallFeatureControl = {
		transfer: async (_leg: ControlledLeg, request: TransferRequest) => {
			calls.push({ method: "transfer", args: request });
			if (options.slowTransfer === true) {
				await new Promise<void>(() => undefined);
			}
			return options.transferResult ?? { ok: true };
		},
		cancelTransfer: async () => {
			calls.push({ method: "cancelTransfer" });
			return { ok: true };
		},
		hasPendingTransfer: () => options.pendingTransfer === true,
		park: async (_leg, request) => {
			calls.push({ method: "park", args: request });
			return options.parkResult ?? { result: { ok: true }, slot: 401 };
		},
		startRecording: async (): Promise<RecordingOutcome> => {
			calls.push({ method: "startRecording" });
			recording = true;
			return { result: { ok: true }, recordingId: "rec-1" };
		},
		stopRecording: async () => {
			calls.push({ method: "stopRecording" });
			recording = false;
			return { ok: true };
		},
		recordingFor: () => (recording ? { recordingId: "rec-1" } : undefined),
	};

	const artifact = {
		internal: { featureCodes: options.codes ?? DEFAULT_CODES },
	} as unknown as RoutingArtifact;

	const runtime = new MidCallFeatureRuntime({
		control,
		artifactFor: async () => (options.noArtifact === true ? undefined : artifact),
		now: () => clock,
		setTimer: (fn, ms) => {
			const timer = { at: clock + ms, fn, cancelled: false };
			timers.push(timer);
			return {
				cancel: () => {
					timer.cancelled = true;
				},
			};
		},
	});

	return {
		runtime,
		calls,
		leg,
		now: () => clock,
		advanceTo: (atMs) => {
			clock = atMs;
			for (const timer of Array.from(timers)) {
				if (!timer.cancelled && timer.at <= atMs) {
					timer.cancelled = true;
					timer.fn();
				}
			}
		},
	};
}

/** Presses a string of digits, returning the outcome of each. */
async function press(h: Harness, digits: string): Promise<string[]> {
	const outcomes: string[] = [];
	for (const digit of digits) {
		outcomes.push(await h.runtime.offer(h.leg, digit));
	}
	return outcomes;
}

/** Settles the microtask queue, so an action started but not awaited has run. */
async function flush(ticks = 8): Promise<void> {
	for (let index = 0; index < ticks; index += 1) {
		await Promise.resolve();
	}
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

describe("the code table", () => {
	it("comes from the tenant's own catalogue, so a renumbered code works mid-call", async () => {
		const h = harness({ codes: [{ code: "*7", action: "transfer" }] });
		const table = await h.runtime.tableFor(ORG);
		expect(table).toEqual([{ code: "*7", action: "blind-transfer" }]);
	});

	it("offers only the three actions that have a mid-call runtime", async () => {
		const table = await harness().runtime.tableFor(ORG);
		expect(table.map((entry) => entry.action).sort()).toEqual([
			"blind-transfer",
			"park",
			"record-toggle",
		]);
	});

	it("names the compiled actions it maps, so the set is enumerable rather than a switch", () => {
		expect(Object.keys(MID_CALL_ACTION_BY_COMPILED_ACTION).sort()).toEqual([
			"call-park",
			"record-toggle",
			"transfer",
		]);
	});

	it("adds the cancel key as a one-character code when one is armed", async () => {
		const table = await harness().runtime.tableFor(ORG, "#");
		expect(table).toContainEqual({ code: "#", action: "cancel" });
	});

	it("is empty for an organization whose artifact cannot be read", async () => {
		expect(await harness({ noArtifact: true }).runtime.tableFor(ORG)).toEqual([]);
	});
});

// ---------------------------------------------------------------------------------------------
// The guards
// ---------------------------------------------------------------------------------------------

describe("digits the runtime must not touch", () => {
	it("passes everything through on a leg that is not bridged", async () => {
		// An IVR, a greeting, a voicemail menu: the digits belong to the application, and a `*`
		// swallowed here breaks every menu that uses one.
		const h = harness({ bridged: false });
		expect(await press(h, "*1200#")).toEqual(Array(6).fill("pass-through"));
	});

	it("passes everything through on a leg that has not answered", async () => {
		const h = harness({ answered: false });
		expect(await press(h, "*3")).toEqual(["pass-through", "pass-through"]);
	});

	it("passes everything through when the organization has no codes at all", async () => {
		const h = harness({ codes: [] });
		expect(await press(h, "*3")).toEqual(["pass-through", "pass-through"]);
	});

	it("passes a plain digit through, which is almost every digit on a live call", async () => {
		const h = harness();
		expect(await press(h, "12345")).toEqual(Array(5).fill("pass-through"));
	});

	it("gives a stray star back rather than swallowing the rest of an IVR interaction", async () => {
		const h = harness();
		// `*9` matches nothing: the capture is abandoned and the party carries on.
		expect(await press(h, "*9")).toEqual(["consumed", "consumed"]);
		expect(await press(h, "1")).toEqual(["pass-through"]);
	});
});

// ---------------------------------------------------------------------------------------------
// The three operations
// ---------------------------------------------------------------------------------------------

describe("*1 — blind transfer", () => {
	it("collects the destination and runs the ordinary transfer path", async () => {
		const h = harness();
		await press(h, "*1200#");
		await flush();

		expect(h.calls).toEqual([{ method: "transfer", args: { kind: "blind", destination: "200" } }]);
	});

	it("fires on the inter-digit timeout when nobody presses hash", async () => {
		const h = harness();
		await press(h, "*1200");
		h.advanceTo(DEFAULT_MID_CALL_FEATURE_SETTINGS.interDigitTimeoutMs + 1);
		await flush();

		expect(h.calls[0]).toMatchObject({ method: "transfer" });
	});

	it("does not transfer to nowhere when the destination is empty", async () => {
		const h = harness();
		await press(h, "*1#");
		await flush();
		expect(h.calls).toEqual([]);
	});

	it("swallows the destination digits, so the far end never sees them", async () => {
		const h = harness();
		expect(await press(h, "*1200#")).toEqual(Array(6).fill("consumed"));
	});

	it("keeps swallowing while the transfer runs, so an impatient party does not queue two", async () => {
		// A real blind transfer walks a routing plan and rings a phone; it does not settle inside a
		// microtask, and the whole point of `executing` is the window while it has not.
		const h = harness({ slowTransfer: true });
		await press(h, "*1200#");
		await flush();
		// Still executing.
		expect(await press(h, "*1201#")).toEqual(Array(6).fill("consumed"));
		await flush();
		expect(h.calls.filter((call) => call.method === "transfer")).toHaveLength(1);
	});

	it("is usable again once the transfer has settled", async () => {
		const h = harness({ transferResult: { ok: false, reason: "no such extension" } });
		await press(h, "*1200#");
		await flush();

		await press(h, "*3");
		await flush();
		expect(h.calls.at(-1)).toMatchObject({ method: "startRecording" });
	});
});

describe("*3 — record toggle", () => {
	it("starts a recording when there is none", async () => {
		const h = harness();
		await press(h, "*3");
		await flush();
		expect(h.calls).toEqual([{ method: "startRecording" }]);
	});

	it("stops the one that is running, whoever started it", async () => {
		// A recording begun by a policy or by a verb must be stoppable by this key, or a compliance
		// recording outlives the call it was on.
		const h = harness({ recording: true });
		await press(h, "*3");
		await flush();
		expect(h.calls).toEqual([{ method: "stopRecording" }]);
	});

	it("toggles back and forth across presses", async () => {
		const h = harness();
		await press(h, "*3");
		await flush();
		await press(h, "*3");
		await flush();
		expect(h.calls.map((call) => call.method)).toEqual(["startRecording", "stopRecording"]);
	});
});

describe("*5 — park", () => {
	it("parks with no orbit when the code is pressed alone", async () => {
		const h = harness();
		await press(h, "*5");
		h.advanceTo(DEFAULT_MID_CALL_FEATURE_SETTINGS.interDigitTimeoutMs + 1);
		await flush();
		expect(h.calls).toEqual([{ method: "park", args: {} }]);
	});

	it("takes the orbit the parker asked for", async () => {
		const h = harness();
		await press(h, "*5401#");
		await flush();
		expect(h.calls).toEqual([{ method: "park", args: { orbit: "401" } }]);
	});

	it("settles the machine when the park is refused, rather than swallowing forever", async () => {
		const h = harness({ parkResult: { result: { ok: false, reason: "every orbit is taken" } } });
		await press(h, "*5401#");
		await flush();
		// And the leg can still type at the far end.
		expect(await press(h, "7")).toEqual(["pass-through"]);
	});
});

// ---------------------------------------------------------------------------------------------
// The cancel key
// ---------------------------------------------------------------------------------------------

describe("the attended-transfer cancel key", () => {
	it("is inert until it is armed", async () => {
		const h = harness({ pendingTransfer: true });
		expect(await press(h, "#")).toEqual(["pass-through"]);
	});

	it("cancels a consultation that is in progress", async () => {
		const h = harness({ pendingTransfer: true });
		h.runtime.armCancelKey("a", "#");
		expect(await press(h, "#")).toEqual(["consumed"]);
		await flush();
		expect(h.calls).toEqual([{ method: "cancelTransfer" }]);
	});

	it("does nothing when the consultation has already ended", async () => {
		const h = harness({ pendingTransfer: false });
		h.runtime.armCancelKey("a", "#");
		await press(h, "#");
		await flush();
		expect(h.calls).toEqual([]);
	});

	it("stops swallowing the digit once it is disarmed", async () => {
		const h = harness({ pendingTransfer: true });
		h.runtime.armCancelKey("a", "#");
		h.runtime.disarmCancelKey("a");
		expect(await press(h, "#")).toEqual(["pass-through"]);
	});

	it("coexists with a longer code that starts with the same digit", async () => {
		const h = harness({ pendingTransfer: true });
		h.runtime.armCancelKey("a", "*");
		// `*1` still wins while the party keeps typing.
		await press(h, "*1200#");
		await flush();
		expect(h.calls).toEqual([{ method: "transfer", args: { kind: "blind", destination: "200" } }]);
	});

	it("cancels on the code timeout when the party presses the key alone", async () => {
		const h = harness({ pendingTransfer: true });
		h.runtime.armCancelKey("a", "*");
		await press(h, "*");
		h.advanceTo(DEFAULT_MID_CALL_FEATURE_SETTINGS.codeTimeoutMs + 1);
		await flush();
		expect(h.calls).toEqual([{ method: "cancelTransfer" }]);
	});
});

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

/**
 * Digit ORDER. `offer` has to await, and ARI events are dispatched concurrently — one
 * `void handleEvent` per event — so without the per-leg chain two digits pressed a few milliseconds
 * apart could be decided out of order, and a `*1` followed by a `2` would resolve as a stray `2`
 * passed to the far end and a `*1` that collects nothing.
 */
describe("digits pressed faster than the runtime settles", () => {
	it("decides them in the order they were pressed, not the order they resolve", async () => {
		const h = harness();
		const outcomes = await Promise.all(
			[..."*1200#"].map(async (digit) => await h.runtime.offer(h.leg, digit)),
		);
		expect(outcomes).toEqual(Array(6).fill("consumed"));
		await flush();
		expect(h.calls).toEqual([{ method: "transfer", args: { kind: "blind", destination: "200" } }]);
	});

	it("does not stall a leg's later digits behind one that failed", async () => {
		const h = harness();
		await Promise.all([h.runtime.offer(h.leg, "*"), h.runtime.offer(h.leg, "3")]);
		await flush();
		expect(h.calls).toEqual([{ method: "startRecording" }]);
	});
});

describe("lifecycle", () => {
	it("reports a capture in progress, which is what /healthz reads", async () => {
		const h = harness();
		expect(h.runtime.activeCaptureCount).toBe(0);
		await press(h, "*1");
		expect(h.runtime.activeCaptureCount).toBe(1);
	});

	it("forgets a leg that has gone away, and cancels its timer with it", async () => {
		const h = harness();
		await press(h, "*1");
		h.runtime.release("a");
		expect(h.runtime.activeCaptureCount).toBe(0);

		// The armed timer must not fire an action for a leg that is gone.
		h.advanceTo(DEFAULT_MID_CALL_FEATURE_SETTINGS.interDigitTimeoutMs + 1);
		await flush();
		expect(h.calls).toEqual([]);
	});

	it("drops everything on clear", async () => {
		const h = harness();
		await press(h, "*1");
		h.runtime.clear();
		expect(h.runtime.activeCaptureCount).toBe(0);
	});
});
