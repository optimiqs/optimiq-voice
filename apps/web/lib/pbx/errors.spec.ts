import { describe, expect, it } from "bun:test";
import { ApiError } from "../api-client";
import {
	CONFERENCE_MODERATION_ERROR_CODES,
	conferenceModerationMessage,
	isCompileRollback,
	isConferenceActionNotServable,
	pbxDiagnostics,
	pbxErrorCode,
	pbxFieldErrors,
	pbxFormMessage,
	pbxReferences,
	pbxToastMessage,
} from "./errors";

/**
 * The error taxonomy is a CONTRACT, restated in `apps/api/src/pbx/shared/pbx.errors.ts`. These
 * fixtures are copied from the JSON examples in that file's doc comment, so a change to either
 * side that the other did not follow fails here rather than in a form that silently stops
 * showing messages.
 */

function apiError(status: number, body: unknown): ApiError {
	return new ApiError(status, "message from the server", body);
}

describe("pbxErrorBody", () => {
	it("ignores an error that is not one of ours", () => {
		expect(pbxErrorCode(new Error("boom"))).toBeUndefined();
		expect(pbxErrorCode(apiError(500, { message: "nope" }))).toBeUndefined();
		expect(pbxFieldErrors(new Error("boom"))).toEqual({});
	});
});

describe("PBX_INVALID_BODY", () => {
	const error = apiError(400, {
		statusCode: 400,
		code: "PBX_INVALID_BODY",
		message: "number: Too small; label: Required",
		issues: [
			{ field: "number", code: "too_small", message: "Too small" },
			{ field: "label", code: "invalid_type", message: "Required" },
		],
	});

	it("keys each issue by the control that produced it", () => {
		expect(pbxFieldErrors(error)).toEqual({ number: "Too small", label: "Required" });
	});

	/** A dotted path names a nested value; the control the user sees is the first segment. */
	it("attaches a nested path to its top-level control", () => {
		const nested = apiError(400, {
			code: "PBX_INVALID_BODY",
			issues: [
				{ field: "followMe.targets.0.destination", code: "invalid", message: "Not dialable" },
			],
		});
		expect(pbxFieldErrors(nested)).toEqual({ followMe: "Not dialable" });
	});

	it("shows the first message per field, so one control carries one requirement", () => {
		const twice = apiError(400, {
			code: "PBX_INVALID_BODY",
			issues: [
				{ field: "number", code: "too_small", message: "first" },
				{ field: "number", code: "invalid", message: "second" },
			],
		});
		expect(pbxFieldErrors(twice).number).toBe("first");
	});

	/** Repeating in a banner what is already on the input makes one problem look like two. */
	it("says nothing at form level once every issue found a field", () => {
		expect(pbxFormMessage(error)).toBeUndefined();
	});
});

describe("PBX_CONFLICT", () => {
	it("puts the conflict on the column the index named", () => {
		const error = apiError(409, {
			code: "PBX_CONFLICT",
			message: "Another extension already uses that value.",
			kind: "extension",
			field: "number",
		});
		expect(pbxFieldErrors(error)).toEqual({
			number: "Another extension already uses that value.",
		});
	});

	/** The server's index-name→column mapping is best effort; an empty field means "we cannot tell". */
	it("falls back to a form-level message when the column could not be determined", () => {
		const error = apiError(409, {
			code: "PBX_CONFLICT",
			message: "Another extension already uses that value.",
			field: "",
		});
		expect(pbxFieldErrors(error)).toEqual({});
		expect(pbxFormMessage(error)).toBe("Another extension already uses that value.");
	});
});

describe("PBX_REFERENCED", () => {
	const error = apiError(409, {
		code: "PBX_REFERENCED",
		message: "still referenced",
		kind: "extension",
		id: "0193f2aa-0000-7000-8000-000000000001",
		references: [
			{
				kind: "inbound-route",
				id: "0193f2aa-0000-7000-8000-000000000002",
				name: "Main line",
				field: "destination_ref",
			},
		],
	});

	it("hands the referring rows back so they can be rendered as links", () => {
		expect(pbxReferences(error)).toHaveLength(1);
		expect(pbxReferences(error)[0]?.name).toBe("Main line");
	});

	it("returns nothing for any other code", () => {
		expect(pbxReferences(apiError(404, { code: "PBX_NOT_FOUND" }))).toEqual([]);
	});
});

describe("PBX_INVALID_DESTINATION", () => {
	it("addresses the exact trio column the server named", () => {
		const error = apiError(422, {
			code: "PBX_INVALID_DESTINATION",
			issues: [
				{
					field: "timeoutDestinationRef",
					code: "dangling",
					message: "No ring-group with id … exists in this organization.",
				},
			],
		});
		expect(pbxFieldErrors(error)).toEqual({
			timeoutDestinationRef: "No ring-group with id … exists in this organization.",
		});
	});
});

describe("ROUTING_COMPILE_FAILED", () => {
	const error = apiError(422, {
		code: "ROUTING_COMPILE_FAILED",
		message: "The change was rolled back: it would produce 1 routing error(s).",
		diagnostics: [
			{
				severity: "error",
				code: "dangling-destination",
				message: "Inbound route “Main line” points at a ring group that does not exist.",
				subject: {
					kind: "inbound-route",
					id: "0193f2aa-0000-7000-8000-000000000002",
					name: "Main line",
				},
				path: "inboundRoutes[0].destinationRef",
				field: "destinationRef",
			},
			{
				severity: "warning",
				code: "empty-ring-group",
				message: "Ring group has no members.",
			},
		],
	});

	it("attaches error diagnostics to the field their path names", () => {
		expect(pbxFieldErrors(error)).toEqual({
			destinationRef: "Inbound route “Main line” points at a ring group that does not exist.",
		});
	});

	it("ignores warning-severity diagnostics — those are not why the save failed", () => {
		expect(pbxDiagnostics(error)).toHaveLength(1);
		expect(pbxDiagnostics(error)[0]?.severity).toBe("error");
	});

	/**
	 * The single most important sentence in this area. The write was ROLLED BACK, and no field
	 * message says so — a user reading only "points at a ring group that does not exist" would
	 * reasonably assume the rest of their change was saved.
	 */
	it("always says the change was not saved, even though every issue found a field", () => {
		const message = pbxFormMessage(error);
		expect(message).toContain("rolled back");
		expect(message).toContain("Nothing was saved");
	});

	it("is recognisable as a rollback without inspecting the body", () => {
		expect(isCompileRollback(error)).toBe(true);
		expect(isCompileRollback(apiError(422, { code: "PBX_INVALID_DESTINATION", issues: [] }))).toBe(
			false,
		);
	});
});

describe("PBX_DATABASE_UNAVAILABLE", () => {
	it("says nothing changed, because a 503 on a write is ambiguous otherwise", () => {
		const error = apiError(503, {
			code: "PBX_DATABASE_UNAVAILABLE",
			message: 'The telephony database refused "extension.create": …',
		});
		expect(pbxFormMessage(error)).toContain("Nothing was changed");
	});
});

describe("pbxToastMessage", () => {
	it("summarises each outcome without repeating the detail that is on screen", () => {
		expect(pbxToastMessage(apiError(422, { code: "ROUTING_COMPILE_FAILED" }), "fallback")).toBe(
			"Rolled back — the change would break call routing",
		);
		expect(pbxToastMessage(apiError(409, { code: "PBX_REFERENCED" }), "fallback")).toBe(
			"Still in use — see the details on screen",
		);
		expect(pbxToastMessage(apiError(409, { code: "PBX_CONFLICT" }), "fallback")).toBe(
			"That value is already taken",
		);
	});

	it("falls back to the server's own message for anything unrecognised", () => {
		expect(pbxToastMessage(apiError(500, null), "Could not save")).toBe("message from the server");
		expect(pbxToastMessage(null, "Could not save")).toBe("Could not save");
	});
});

/**
 * The conference-moderation taxonomy, mirrored from
 * `apps/api/src/pbx/conferences/conference-moderation.errors.ts`.
 *
 * What is asserted is that each of the five leads somewhere DIFFERENT, because that is the whole
 * reason there are five: ask an administrator, re-read the room, re-read the member, stop pressing
 * the control, or wait. A shared message would send all five to the same place.
 */
describe("conference moderation failures", () => {
	it("distinguishes a missing grant from a room nobody is in", () => {
		expect(
			conferenceModerationMessage(
				apiError(403, { code: "CONFERENCE_MODERATE_FORBIDDEN", message: undefined }),
			),
		).toContain("conferences.moderate");
		expect(
			conferenceModerationMessage(apiError(404, { code: "CONFERENCE_NOT_RUNNING" })),
		).toContain("Nobody is in this room");
	});

	it("says a participant has left rather than that the room does not exist", () => {
		expect(
			conferenceModerationMessage(
				apiError(404, { code: "CONFERENCE_MEMBER_NOT_FOUND", memberRef: "leg-1" }),
			),
		).toContain("already left");
	});

	/**
	 * The 503 line is the one to keep exact. `CONFERENCE_CONTROL_UNAVAILABLE` promises that NOTHING
	 * was applied, and saying so is what stops a moderator muting somebody twice and unmuting them
	 * by accident.
	 */
	it("promises that a 503 changed nothing", () => {
		const message = conferenceModerationMessage(
			apiError(503, { code: "CONFERENCE_CONTROL_UNAVAILABLE" }),
		);

		expect(message).toContain("nothing was changed");
	});

	/**
	 * 501 is the one status a client may use to DISABLE a control rather than retry it: the request
	 * is well formed and no media plane can serve it, which trying again will not change.
	 */
	it("is recognisable as a not-servable action without reading the body", () => {
		const notServable = apiError(501, {
			code: "CONFERENCE_ACTION_NOT_SERVABLE",
			action: "volume",
			message: "no media plane on this platform can set a per-member level",
		});

		expect(isConferenceActionNotServable(notServable)).toBe(true);
		expect(conferenceModerationMessage(notServable)).toContain("per-member level");
		expect(
			isConferenceActionNotServable(apiError(503, { code: "CONFERENCE_CONTROL_UNAVAILABLE" })),
		).toBe(false);
	});

	it("falls back without pretending to know what happened", () => {
		expect(conferenceModerationMessage(new Error("boom"))).toContain("Try again");
		expect(CONFERENCE_MODERATION_ERROR_CODES).toHaveLength(5);
	});
});
