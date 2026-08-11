import { describe, expect, it } from "bun:test";
import { makeMediaEvent, MEDIA_PLAYBACK_END_REASONS } from "./media-events";
import {
	mediaStartPlaybackRequestSchema,
	mediaStartPlaybackResponseSchema,
	mediaStopPlaybackRequestSchema,
	mediaStopPlaybackResponseSchema,
} from "./rpc";

/**
 * Rung 1's playback contract — `plans/mediad-design.md` §2.
 *
 * The assertions here are the ones a Go responder would otherwise discover at runtime: which fields
 * are required, which defaults the engine may rely on without sending them, and that
 * `playback.finished` derives its subject from the session rather than the call.
 */

const ORG = "018f2b7c-0000-7000-8000-0000000000aa";
const SESSION = "018f2b7c-0000-7000-8000-0000000000dd";

describe("rpc.media.v1.start-playback", () => {
	it("requires a session, a reference and at least one media ref", () => {
		const parsed = mediaStartPlaybackRequestSchema.parse({
			sessionId: SESSION,
			playbackRef: "pb-1",
			media: ["sound:welcome"],
		});
		expect(parsed).toEqual({
			sessionId: SESSION,
			playbackRef: "pb-1",
			media: ["sound:welcome"],
		});
	});

	it("refuses a play of nothing", () => {
		// An empty list is a caller bug, and answering `ok` to it would report a prompt that never
		// happened — the exact silent failure the whole refusal vocabulary exists to prevent.
		const result = mediaStartPlaybackRequestSchema.safeParse({
			sessionId: SESSION,
			playbackRef: "pb-1",
			media: [],
		});
		expect(result.success).toBe(false);
	});

	it("carries a machine-readable reason on a refusal", () => {
		const parsed = mediaStartPlaybackResponseSchema.parse({
			ok: false,
			sessionId: SESSION,
			playbackRef: "pb-1",
			instanceId: "mediad-7c9f",
			reason: "not_supported",
			error: "tone: is a generator scheme mediad has no synthesiser for",
		});
		expect(parsed.reason).toBe("not_supported");
	});
});

describe("rpc.media.v1.stop-playback", () => {
	it("is keyed by the playback reference alone", () => {
		// MediaPort.stopPlayback(playbackRef) has no channel id to give, so neither does this.
		expect(mediaStopPlaybackRequestSchema.parse({ playbackRef: "pb-1" })).toEqual({
			playbackRef: "pb-1",
		});
	});

	it("defaults `stopped` to false, so a stop of a finished playback is a success", () => {
		const parsed = mediaStopPlaybackResponseSchema.parse({ ok: true, playbackRef: "pb-1" });
		expect(parsed).toEqual({ ok: true, playbackRef: "pb-1", stopped: false });
	});
});

describe("media.evt.v1 playback.finished", () => {
	it("derives its subject from the SESSION, not the call", () => {
		const event = makeMediaEvent("playback.finished", {
			orgId: ORG,
			source: "mediad",
			data: {
				sessionId: SESSION,
				instanceId: "mediad-7c9f",
				playbackRef: "pb-1",
				reason: "stopped",
				playedMs: 1_240,
			},
		});
		expect(event.subject).toBe(`media.evt.v1.${ORG}.${SESSION}.playback.finished`);
		expect(event.type).toBe("playback.finished");
	});

	it("closes the reason vocabulary at three outcomes", () => {
		expect(MEDIA_PLAYBACK_END_REASONS).toEqual(["completed", "stopped", "error"]);
	});
});
