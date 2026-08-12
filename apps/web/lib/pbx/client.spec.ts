import { describe, expect, it } from "bun:test";
import {
	CONFERENCE_GAIN_PERCENT_MAX,
	CONFERENCE_GAIN_PERCENT_MIN,
	CONFERENCE_GAIN_SCOPES,
	CONFERENCE_PARTICIPANT_ACTIONS,
	conferenceModerationPath,
	conferenceVolumeBody,
	pbxListSearchParams,
} from "./client";

/**
 * What the PBX client puts on the wire, for the calls whose request is a DECISION rather than a
 * transcription of a form.
 *
 * The generic CRUD verbs are not here on purpose: `createPbx` and friends post the object they were
 * handed to the path their descriptor names, and a spec asserting that would be asserting that
 * `fetch` was called. What is worth pinning is the handful of builders where getting it wrong
 * produces a well-formed request that does the wrong thing — a moderation command addressed to a
 * room when it meant a person, or a level the server rejects for a reason no operator can see.
 */

describe("pbxListSearchParams", () => {
	/**
	 * Omission and emptiness are different requests. `search=` is a filter matching nothing on some
	 * endpoints and a parse failure on others; an absent key is "no filter" everywhere.
	 */
	it("omits an unset filter rather than sending it empty", () => {
		expect(pbxListSearchParams({ page: 1, limit: 20 })).not.toContain("search=");
		expect(pbxListSearchParams({ page: 1, limit: 20, search: "" })).not.toContain("search=");
	});

	it("escapes a search term so it cannot break out of the query string", () => {
		const params = new URLSearchParams(
			pbxListSearchParams({ page: 1, limit: 20, search: "a&b=c d" }),
		);

		expect(params.get("search")).toBe("a&b=c d");
	});
});

/**
 * The moderation surface, mirrored from `apps/api/src/pbx/conferences/conference-moderation.*`.
 *
 * The ACTION is in the path and the PARTICIPANT is in the path, which is what makes these two
 * builders worth a spec: every one of the seven verbs is a `POST` with an empty or near-empty body,
 * so the path is the ENTIRE request. A room verb that acquired a `:ref` would address a member who
 * does not exist, and a participant verb that lost one would 404 on a route that has no such shape.
 */
describe("conferenceModerationPath", () => {
	const conferenceId = "019fd400-2222-7000-8000-000000000001";
	const memberRef = "019fd400-3333-7000-8000-00000000aaaa";

	it("puts every participant verb under the member it acts on", () => {
		for (const action of CONFERENCE_PARTICIPANT_ACTIONS) {
			expect(conferenceModerationPath(conferenceId, action, memberRef)).toBe(
				`/conferences/${conferenceId}/participants/${memberRef}/${action}`,
			);
		}
	});

	it("addresses the ROOM for lock and unlock, with no member segment at all", () => {
		expect(conferenceModerationPath(conferenceId, "lock", memberRef)).toBe(
			`/conferences/${conferenceId}/lock`,
		);
		expect(conferenceModerationPath(conferenceId, "unlock")).toBe(
			`/conferences/${conferenceId}/unlock`,
		);
	});

	/** `volume` is a participant verb like the other five, even though it is refused with a 501. */
	it("routes volume through the participant path", () => {
		expect(conferenceModerationPath(conferenceId, "volume", memberRef)).toBe(
			`/conferences/${conferenceId}/participants/${memberRef}/volume`,
		);
	});

	/**
	 * The server documents `:ref` as an OPAQUE token whose shape it deliberately does not validate —
	 * it is a UUID on this platform today and the engine treats it as a handle. Encoding costs
	 * nothing and stops a leg id that ever contains a slash from inventing a path segment.
	 */
	it("percent-encodes the member reference", () => {
		expect(conferenceModerationPath(conferenceId, "mute", "a/b?c")).toBe(
			`/conferences/${conferenceId}/participants/a%2Fb%3Fc/mute`,
		);
	});
});

describe("conferenceVolumeBody", () => {
	/**
	 * The DTO is `z.number().int()`, and a slider bound to a numeric input produces fractions. An
	 * unrounded value would be a control that fails validation for a reason the operator cannot see
	 * — and on this surface the 400 would be indistinguishable from the 501 the action really gets.
	 */
	it("rounds to the integer the DTO requires", () => {
		expect(conferenceVolumeBody(99.5).gainPercent).toBe(100);
		expect(conferenceVolumeBody(0.4).gainPercent).toBe(0);
	});

	/**
	 * An absent scope means "both" to the server. Sending the value it would have defaulted anyway
	 * turns a single slider into a request that claims to have chosen a half.
	 */
	it("omits the scope unless one was chosen", () => {
		expect(conferenceVolumeBody(100)).toEqual({ gainPercent: 100 });
		expect(conferenceVolumeBody(100, "talk")).toEqual({ gainPercent: 100, scope: "talk" });
	});

	it("mirrors the server's vocabulary and bounds", () => {
		expect(CONFERENCE_GAIN_SCOPES).toEqual(["talk", "listen", "both"]);
		// 100 is unity, 0 is silent, and past four times unity a member is clipping rather than
		// louder — which is where `setConferenceVolumeDto` puts its ceiling.
		expect(CONFERENCE_GAIN_PERCENT_MIN).toBe(0);
		expect(CONFERENCE_GAIN_PERCENT_MAX).toBe(400);
	});

	/**
	 * The five verbs that take an empty body, and deliberately no `volume` among them: a level is a
	 * value rather than a verb, which is the whole reason it is the one action with a DTO.
	 */
	it("keeps volume out of the empty-bodied participant actions", () => {
		expect(CONFERENCE_PARTICIPANT_ACTIONS).toEqual(["mute", "unmute", "deaf", "undeaf", "kick"]);
	});
});
