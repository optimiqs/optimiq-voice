import { and, callLegs, eq, inArray, or } from "@optimiq-voice/cdr-db";
import type { CallLegListRow } from "./cdr.repository";
import type { SQL } from "@optimiq-voice/cdr-db";

/**
 * `cdr.read.own` — what "a call the acting user took part in" means on a ledger with no user ids.
 *
 * ## The two ways a leg names a person, and why both are needed
 *
 * `cdr-db` stores numbers and entity refs; identity lives in another bounded context. So the link
 * is the user's EXTENSIONS, resolved in the PBX area and handed here as {@link OwnedParties}:
 *
 * 1. **The numbers.** `from_number` on a call they placed, `to_number` on one they answered — the
 *    same "either end of the leg" rule `legFilters` already applies to the `extension` query
 *    parameter, and both columns are indexed with the organization.
 * 2. **The destination ref.** A B-leg the switch dialled TO an extension carries
 *    `destination_type = 'extension'` and that extension's row id. Matching it catches the legs
 *    whose `to_number` is not the extension number — a ring group's fan-out, a queue delivery, a
 *    follow-me hop — which is most of the inbound history of anybody who is dialled through
 *    anything other than their own number. Number matching alone would leave those out and the
 *    user's own call history would be missing exactly the calls they answered.
 *
 * ## Not a substitute for the tenant scope
 *
 * This narrows WITHIN a tenant-scoped transaction and nothing else: RLS is still the organization
 * filter, as everywhere else in this area. An unscoped `cdr.read` holder never reaches this file.
 */

/** The acting user's extensions, in both spellings the ledger records them in. */
export interface OwnedParties {
	/** `extension.id` values — matched against `destination_ref`. */
	readonly extensionIds: readonly string[];
	/** `extension.number` values — matched against `from_number` and `to_number`. */
	readonly numbers: readonly string[];
}

/** Whether the user holds any extension at all. `false` means there is nothing they can see. */
export function hasAnyParty(owned: OwnedParties): boolean {
	return owned.extensionIds.length > 0 || owned.numbers.length > 0;
}

/**
 * The `where` fragment that keeps only legs the user is a party to.
 *
 * Only ever called with a non-empty {@link OwnedParties} — an empty one has no rows to describe,
 * and the service answers it without a query rather than sending a predicate that is always false.
 */
export function ownPartyFilter(owned: OwnedParties): SQL {
	const clauses: SQL[] = [];
	if (owned.numbers.length > 0) {
		clauses.push(inArray(callLegs.fromNumber, [...owned.numbers]) as SQL);
		clauses.push(inArray(callLegs.toNumber, [...owned.numbers]) as SQL);
	}
	if (owned.extensionIds.length > 0) {
		clauses.push(
			and(
				eq(callLegs.destinationType, "extension"),
				inArray(callLegs.destinationRef, [...owned.extensionIds]),
			) as SQL,
		);
	}
	return or(...clauses) as SQL;
}

/**
 * The same question asked of a row already in hand.
 *
 * Used by the call-detail read, which returns a call's WHOLE tree once the caller is a party to any
 * leg of it. Narrowing that read leg by leg was the alternative and is wrong: the tree is drawn
 * from `originating_leg_id` and `bridge_leg_id`, so a user who answered a ring-group call would get
 * their own B-leg with its originating leg filtered out and a timeline that starts nowhere.
 */
export function ownPartyMatcher(owned: OwnedParties): (row: CallLegListRow) => boolean {
	// Indexed once and closed over, not rebuilt per row: a call's tree is up to 200 legs and this
	// runs on every self-scoped detail read.
	const numbers = new Set(owned.numbers);
	const extensionIds = new Set(owned.extensionIds);
	return (row) =>
		numbers.has(row.fromNumber) ||
		numbers.has(row.toNumber) ||
		(row.destinationType === "extension" &&
			row.destinationRef !== null &&
			extensionIds.has(row.destinationRef));
}
