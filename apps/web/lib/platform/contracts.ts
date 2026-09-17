/**
 * The two cross-tenant surfaces, as types.
 *
 * Everything else in this app is answered inside the caller's active organization. These two are
 * not — `/api/v1/platform/*` reads and writes across tenants on `compliance.review` and
 * `compliance.traceback`, both of which are `OWNER_ONLY_PERMISSIONS` — so they get their own
 * directory rather than joining `lib/pbx`. A reader asking "what in this UI leaves the tenant?"
 * should be able to answer it by listing one folder, exactly as a reader of the API answers it by
 * grepping for one path segment.
 *
 * The shapes mirror `apps/api/src/compliance/**` and nothing here re-derives anything the server
 * decides: the decision, the KYC row and the traceback leg all arrive as the server computed them.
 */

import type { BadgeTone } from "../cdr/format";
import type { KycDecision, KycEntityType } from "../pbx/contracts";

/**
 * One organization's file as the review queue returns it.
 *
 * `taxId` is absent by construction rather than by redaction — see `kyc.repository.ts` — so there
 * is no field here for it and no screen that could accidentally render one. `taxIdLast4` is the
 * whole of what a reviewer sees, which is what a reviewer needs: enough to match a document
 * somebody sent them, and not enough to be worth stealing.
 */
export interface PlatformKycEntry {
	readonly id: string;
	readonly organizationId: string;
	/** Resolved from the auth database per distinct tenant; `null` when that lookup failed. */
	readonly organizationName: string | null;
	readonly legalEntityName: string;
	readonly entityType: KycEntityType;
	readonly taxIdLast4: string | null;
	readonly addressLine1: string;
	readonly addressLine2: string | null;
	readonly addressCity: string;
	readonly addressRegion: string;
	readonly addressPostalCode: string;
	readonly addressCountry: string;
	readonly contactName: string;
	readonly contactEmail: string;
	readonly contactPhone: string;
	readonly websiteUrl: string | null;
	readonly expectedTrafficProfile: string | null;
	readonly expectedMonthlyMinutes: number | null;
	readonly decision: KycDecision;
	readonly reviewedBy: string | null;
	readonly reviewedAt: string | null;
	readonly reviewNotes: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface PlatformKycPage {
	readonly data: readonly PlatformKycEntry[];
	readonly total: number;
	readonly page: number;
	readonly limit: number;
}

export interface PlatformKycListQuery {
	readonly decision?: KycDecision | undefined;
	readonly page?: number | undefined;
	readonly limit?: number | undefined;
}

/** A reviewer's verdict. `reviewedBy` is the session's, never the body's. */
export interface KycDecisionInput {
	readonly decision: KycDecision;
	readonly reviewNotes?: string | null;
}

/**
 * The decisions a reviewer may record, in the order the queue offers them.
 *
 * `pending` is not among them. It is a STATE a file arrives in and the state an amendment returns
 * it to; a reviewer choosing it would be un-deciding something, which the ledger cannot express and
 * the tenant could not read.
 */
export const REVIEWER_DECISIONS = ["approved", "needs-info", "rejected"] as const;
export type ReviewerDecision = (typeof REVIEWER_DECISIONS)[number];

export const KYC_DECISION_LABELS: Readonly<Record<KycDecision, string>> = {
	pending: "Awaiting review",
	approved: "Approved",
	rejected: "Rejected",
	"needs-info": "More information needed",
};

/**
 * `needs-info` is a warning and not a danger, on the operator screen for the same reason it is on
 * the tenant's: it is the one decision somebody can act on, and red says the application is over.
 */
export const KYC_DECISION_TONES: Readonly<Record<KycDecision, BadgeTone>> = {
	pending: "neutral",
	approved: "success",
	rejected: "danger",
	"needs-info": "warning",
};

/**
 * Whether a verdict needs a note, and the sentence to show when it does.
 *
 * The server deliberately accepts a note-less rejection (`kycDecisionDto` says so, and says why: a
 * refusal at the schema would only teach reviewers to type "no"). The nudge belongs here, at the
 * one place a human is about to press the button — a rejection with no reason and a `needs-info`
 * with no question are both verdicts the tenant cannot act on.
 */
export function decisionNoteIssue(
	decision: ReviewerDecision,
	reviewNotes: string,
): string | undefined {
	if (decision === "approved" || reviewNotes.trim().length > 0) {
		return undefined;
	}
	return decision === "needs-info"
		? "Say what is missing. A “more information needed” with no note gives the tenant nothing to send."
		: "Say why. A rejection with no reason cannot be answered or appealed.";
}

// ---------------------------------------------------------------------------------------------
// Traceback
// ---------------------------------------------------------------------------------------------

/**
 * One leg of one call, as a traceback answers.
 *
 * The two attestation pairs are deliberately separate and are labelled apart on the screen:
 * `sipAttestation`/`sipVerstat`/`sipOrigId` are what the CARRIER claimed on the way in, and
 * `expectedAttestation`/`callerIdRightToUse` are what THIS platform decided on the way out. A
 * traceback form asks for both and they answer different questions.
 */
export interface TracebackEntry {
	readonly organizationId: string;
	readonly organizationName: string | null;
	readonly kycDecision: KycDecision | null;
	readonly callId: string;
	readonly startedAt: string;
	readonly direction: string;
	readonly fromNumber: string | null;
	readonly toNumber: string | null;
	readonly sipCallId: string | null;
	readonly trunkRef: string | null;
	readonly signalingAddress: string | null;
	readonly sipAttestation: string | null;
	readonly sipVerstat: string | null;
	readonly sipOrigId: string | null;
	readonly expectedAttestation: string | null;
	readonly callerIdRightToUse: string | null;
	readonly disposition: string | null;
	readonly durationMs: number | null;
}

export interface TracebackResult {
	readonly data: readonly TracebackEntry[];
	readonly range: { readonly from: string; readonly to: string };
	readonly limit: number;
	/** True when the row cap was reached. The answer is a prefix, not the whole of it. */
	readonly truncated: boolean;
}

export interface TracebackQuery {
	readonly from: string;
	readonly to: string;
	readonly calledNumber?: string | undefined;
	readonly callingNumber?: string | undefined;
	readonly trunkId?: string | undefined;
	readonly limit?: number | undefined;
}

/** Mirrors `TRACEBACK_MAX_RANGE_DAYS` in `apps/api/src/compliance/traceback/traceback.dto.ts`. */
export const TRACEBACK_MAX_RANGE_DAYS = 31;

/** Mirrors `TRACEBACK_MAX_ROWS`. Reached silently by the server, which sets `truncated`. */
export const TRACEBACK_MAX_ROWS = 500;

/**
 * The two queries the server refuses, checked before the request is sent.
 *
 * Mirrored rather than caught, on the reasoning `audit-log-screen.tsx` states for its own range: a
 * 400 empties the table, and an empty table reads as "there are no such calls" — which is the
 * opposite of what "you asked for something I will not run" means. Both refusals are the API's
 * (`ComplianceTracebackUnboundedException`, `ComplianceRangeTooWideException`) and stay the API's;
 * this only keeps the request from being made.
 */
export function tracebackQueryIssue(query: {
	readonly from: string;
	readonly to: string;
	readonly calledNumber: string;
	readonly callingNumber: string;
}): string | undefined {
	if (query.calledNumber.trim().length === 0 && query.callingNumber.trim().length === 0) {
		return "Give at least one number. A traceback asks about a call, and a window alone names every tenant's calls at once.";
	}
	const from = Date.parse(query.from);
	const to = Date.parse(query.to);
	if (Number.isNaN(from) || Number.isNaN(to)) {
		return "Give a start and an end. Neither is defaulted here: a traceback names an instant somebody else gave us.";
	}
	const days = Math.abs(to - from) / 86_400_000;
	if (days > TRACEBACK_MAX_RANGE_DAYS) {
		return `That window is ${Math.ceil(days)} days. A traceback may scan at most ${TRACEBACK_MAX_RANGE_DAYS}; a wider question is a subpoena, not an API call.`;
	}
	return undefined;
}
