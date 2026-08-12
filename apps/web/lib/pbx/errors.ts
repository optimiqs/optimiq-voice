/**
 * Reading the PBX area's failure taxonomy.
 *
 * Every PBX error body carries a `code` (a string the client switches on) alongside the status,
 * and four of the six codes carry per-field detail:
 *
 * ```jsonc
 * { "code": "PBX_INVALID_BODY",        "issues":      [{ "field": "number", … }] }   // 400
 * { "code": "PBX_NOT_FOUND",           "kind": "…", "id": "…" }                      // 404
 * { "code": "PBX_CONFLICT",            "field": "number" }                           // 409
 * { "code": "PBX_REFERENCED",          "references":  [{ "kind", "id", "name" }] }    // 409
 * { "code": "PBX_INVALID_DESTINATION", "issues":      [{ "field": "destinationRef" }] } // 422
 * { "code": "ROUTING_COMPILE_FAILED",  "diagnostics": [{ "field", "path", "subject" }] } // 422
 * { "code": "PBX_DATABASE_UNAVAILABLE" }                                             // 503
 * ```
 *
 * The whole point of the taxonomy is that a failure lands on the control that caused it, so this
 * module's job is one function — {@link pbxFieldErrors} — plus the narrow readers the delete
 * confirmation and the compile panel need. Anything that cannot be addressed to a field falls out
 * as {@link pbxFormMessage}, which the caller shows at the top of the form.
 *
 * `ROUTING_COMPILE_FAILED` deserves its own note: the write was **rolled back**. Rendering it as
 * "saved, but…" would be a lie, so the copy that accompanies it must say the change was not
 * applied.
 */

import { ApiError } from "../api-client";
import type {
	DestinationIssue,
	EntityReference,
	ValidationIssue,
	WireDiagnostic,
} from "./contracts";

export type PbxErrorCode =
	| "PBX_INVALID_BODY"
	| "PBX_NOT_FOUND"
	| "PBX_CONFLICT"
	| "PBX_REFERENCED"
	| "PBX_INVALID_DESTINATION"
	| "ROUTING_COMPILE_FAILED"
	| "PBX_VALIDATION_FAILED"
	| "PBX_DATABASE_UNAVAILABLE";

export interface PbxErrorBody {
	readonly code?: PbxErrorCode | string;
	readonly message?: string;
	readonly kind?: string;
	readonly id?: string;
	readonly field?: string;
	readonly issues?: readonly (ValidationIssue | DestinationIssue)[];
	readonly references?: readonly EntityReference[];
	readonly diagnostics?: readonly WireDiagnostic[];
	/** `CONFERENCE_ACTION_NOT_SERVABLE` names the verb no media plane can serve. */
	readonly action?: string;
	readonly conferenceId?: string;
	readonly memberRef?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** The parsed body of a PBX failure, or `undefined` when this is not one. */
export function pbxErrorBody(error: unknown): PbxErrorBody | undefined {
	if (!(error instanceof ApiError) || !isRecord(error.body)) {
		return undefined;
	}
	const { code } = error.body;
	return typeof code === "string" ? (error.body as PbxErrorBody) : undefined;
}

export function pbxErrorCode(error: unknown): string | undefined {
	return pbxErrorBody(error)?.code;
}

/**
 * Per-field messages, keyed by the form field name the server named.
 *
 * `PBX_INVALID_BODY` issues use a dotted path (`followMe.targets.0.destination`); the first
 * segment is the control a form actually rendered, so that is the key — the same rule
 * `lib/forms/field-errors.ts` applies to a Zod result, for the same reason. Destination issues
 * and compile diagnostics already name a flat column (`timeoutDestinationRef`), so they are used
 * as-is.
 *
 * The FIRST message per field wins. A control shows one requirement at a time.
 */
export function pbxFieldErrors(error: unknown): Readonly<Record<string, string>> {
	const body = pbxErrorBody(error);
	return body ? fieldErrorsFromBody(body) : {};
}

function fieldErrorsFromBody(body: PbxErrorBody): Readonly<Record<string, string>> {
	const errors: Record<string, string> = {};

	const put = (field: string | undefined, message: string): void => {
		if (!field || errors[field]) {
			return;
		}
		errors[field] = message;
	};

	for (const issue of body.issues ?? []) {
		put(issue.field.split(".")[0], issue.message);
	}
	for (const diagnostic of body.diagnostics ?? []) {
		if (diagnostic.severity === "error") {
			put(diagnostic.field, diagnostic.message);
		}
	}
	// A unique violation names the column it refused; the mapping is best effort server-side, so an
	// empty `field` means "we could not tell which control" and belongs in the form message.
	if (body.code === "PBX_CONFLICT" || body.code === "PBX_VALIDATION_FAILED") {
		put(body.field, body.message ?? "That value is already in use.");
	}

	return errors;
}

/**
 * The message to show above the form, once the field-addressable parts have been attached.
 *
 * Returns `undefined` when every problem found a field — repeating them in a banner would make a
 * form with one bad input look like it has two problems.
 */
export function pbxFormMessage(error: unknown): string | undefined {
	const body = pbxErrorBody(error);
	if (!body) {
		return error instanceof Error ? error.message : "Something went wrong.";
	}

	if (body.code === "ROUTING_COMPILE_FAILED") {
		// Always shown: the user must know the change was NOT saved, which no field message says.
		return (
			"This change was rolled back — it would have produced a routing error. " +
			"Nothing was saved. Fix the problems below and try again."
		);
	}
	if (body.code === "PBX_DATABASE_UNAVAILABLE") {
		return "The telephony database is unavailable. Nothing was changed; try again in a moment.";
	}

	const addressed = Object.keys(fieldErrorsFromBody(body)).length;
	const total =
		(body.issues?.length ?? 0) +
		(body.diagnostics?.filter((entry) => entry.severity === "error").length ?? 0);

	if (total > 0 && addressed === 0) {
		return body.message ?? "The server rejected this change.";
	}
	return total > 0 ? undefined : (body.message ?? "The server rejected this change.");
}

/** Rows that refused a delete. Empty unless this is a `PBX_REFERENCED` 409. */
export function pbxReferences(error: unknown): readonly EntityReference[] {
	const body = pbxErrorBody(error);
	return body?.code === "PBX_REFERENCED" ? (body.references ?? []) : [];
}

/** Error-severity diagnostics from a rolled-back compile-on-write. */
export function pbxDiagnostics(error: unknown): readonly WireDiagnostic[] {
	const body = pbxErrorBody(error);
	if (body?.code !== "ROUTING_COMPILE_FAILED") {
		return [];
	}
	return (body.diagnostics ?? []).filter((entry) => entry.severity === "error");
}

/** True when the write was refused AND rolled back by the routing compiler. */
export function isCompileRollback(error: unknown): boolean {
	return pbxErrorCode(error) === "ROUTING_COMPILE_FAILED";
}

// ---------------------------------------------------------------------------------------------
// Conference moderation — a taxonomy of its own
// ---------------------------------------------------------------------------------------------

/**
 * The live-conference surface's failures, restated from
 * `apps/api/src/pbx/conferences/conference-moderation.errors.ts`.
 *
 * ```jsonc
 * { "statusCode": 403, "code": "CONFERENCE_MODERATE_FORBIDDEN" }
 * { "statusCode": 404, "code": "CONFERENCE_NOT_RUNNING",           "conferenceId": "…" }
 * { "statusCode": 404, "code": "CONFERENCE_MEMBER_NOT_FOUND",      "memberRef": "…" }
 * { "statusCode": 501, "code": "CONFERENCE_ACTION_NOT_SERVABLE",   "action": "volume" }
 * { "statusCode": 503, "code": "CONFERENCE_CONTROL_UNAVAILABLE" }
 * ```
 *
 * They are Nest exceptions server-side rather than the PBX area's tagged failures, because the
 * moderation service's store is a KV read and a request-reply and not a repository. The body
 * contract is identical on purpose — this module switches on `code` and must not care which layer
 * produced it — which is exactly why these readers live here beside the CRUD taxonomy rather than in
 * the panel that renders them.
 *
 * They deliberately do NOT go through {@link pbxFieldErrors}: not one of the five addresses a form
 * control, because this surface has no form. Every one of them is an outcome, and an outcome is a
 * toast.
 */
export const CONFERENCE_MODERATION_ERROR_CODES = [
	"CONFERENCE_MODERATE_FORBIDDEN",
	"CONFERENCE_NOT_RUNNING",
	"CONFERENCE_MEMBER_NOT_FOUND",
	"CONFERENCE_ACTION_NOT_SERVABLE",
	"CONFERENCE_CONTROL_UNAVAILABLE",
] as const;
export type ConferenceModerationErrorCode = (typeof CONFERENCE_MODERATION_ERROR_CODES)[number];

/**
 * Whether the platform refused the ACTION rather than the request.
 *
 * The one status a client may use to disable a control instead of retrying it — 501 means the
 * request was well formed and no media plane can serve it, which no amount of trying again will
 * change. `volume` is the only action that produces it today.
 */
export function isConferenceActionNotServable(error: unknown): boolean {
	return pbxErrorCode(error) === "CONFERENCE_ACTION_NOT_SERVABLE";
}

/**
 * A moderation failure, in words whose next step differs.
 *
 * That is the whole reason this is not one sentence: each of the five sends the operator somewhere
 * else — ask an administrator, re-read the room, re-read the member, stop pressing this control, or
 * wait — and a shared "Something went wrong" would send all five to the same place.
 *
 * The 503 line is the one to keep exact. `CONFERENCE_CONTROL_UNAVAILABLE` promises that NOTHING was
 * applied, and saying so is what stops a moderator from muting somebody twice and unmuting them by
 * accident.
 */
export function conferenceModerationMessage(error: unknown): string {
	const body = pbxErrorBody(error);
	switch (body?.code) {
		case "CONFERENCE_MODERATE_FORBIDDEN": {
			return (
				body.message ??
				"Moderating a live conference needs the conferences.moderate permission, which your role does not include."
			);
		}
		case "CONFERENCE_NOT_RUNNING": {
			return "Nobody is in this room any more, so there was nothing to change.";
		}
		case "CONFERENCE_MEMBER_NOT_FOUND": {
			return "That participant has already left the meeting.";
		}
		case "CONFERENCE_ACTION_NOT_SERVABLE": {
			return body.message ?? `No media plane on this platform can ${body.action ?? "do that"}.`;
		}
		case "CONFERENCE_CONTROL_UNAVAILABLE": {
			return "The call engine could not be reached, so nothing was changed. The meeting is unaffected.";
		}
		default: {
			return body?.message ?? "That could not be applied to the meeting. Try again in a moment.";
		}
	}
}

/**
 * A short line for a toast. Toasts report OUTCOMES; the detail stays on the form, which is why
 * this deliberately does not enumerate issues.
 */
export function pbxToastMessage(error: unknown, fallback: string): string {
	const code = pbxErrorCode(error);
	switch (code) {
		case "ROUTING_COMPILE_FAILED": {
			return "Rolled back — the change would break call routing";
		}
		case "PBX_REFERENCED": {
			return "Still in use — see the details on screen";
		}
		case "PBX_CONFLICT": {
			return "That value is already taken";
		}
		case "PBX_DATABASE_UNAVAILABLE": {
			return "The telephony database is unavailable";
		}
		default: {
			return error instanceof ApiError && error.message ? error.message : fallback;
		}
	}
}
