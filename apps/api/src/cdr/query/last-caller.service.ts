import { Inject, Injectable } from "@nestjs/common";
import { and, callLegs, desc, eq, gte, inArray } from "@optimiq-voice/cdr-db";
import { getLogger } from "@optimiq-voice/logging";
import { CDR_DATABASE } from "../shared/cdr.tokens";
import type { CdrDatabaseClient } from "@optimiq-voice/cdr-db";
import type { LastCallerResponse } from "@optimiq-voice/events/schemas";

const logger = getLogger("api.cdr");

const MILLIS_PER_HOUR = 3_600_000;

/**
 * `*69` — who rang this extension last, answered from the ledger.
 *
 * ## Why this lives in the CDR area and not beside the feature WRITE
 *
 * `rpc.pbx.v1.extension-feature` writes `pbx-db`; this reads `cdr-db`. They are two databases with
 * two pools, two RLS contexts and two retention stories, which is exactly why `packages/events`
 * gave them separate subjects. Answering the read from `PbxModule` would mean a second connection
 * budget against a database that area does not otherwise touch — the same argument
 * `pbx.module.ts` makes about `AuditLogController`, pointing the other way.
 *
 * The subscription still costs nothing to add: `registerPbxTransport` calls
 * `app.connectMicroservice` once for the whole APPLICATION, so a `@MessagePattern` declared here is
 * subscribed at boot exactly like the ones in `PbxModule`. It follows that a deployment with a CDR
 * database and no PBX database has no transport and therefore no responder — which is correct
 * rather than unfortunate, because such a deployment has no extensions for `*69` to be dialled from.
 *
 * ## The window is not a tuning knob
 *
 * `call_legs` is partitioned by `started_at`, so a query with no lower bound is a scan of every
 * partition that exists. `withinHours` is that bound, it is capped by the contract at 30 days, and
 * a lookup that finds nothing inside it answers `found: false` rather than reaching further back:
 * a `*69` that dials somebody from three months ago is a wrong number, not a feature.
 *
 * The predicate is `(organization_id, to_number)` — an index (`call_legs_organization_to_idx`) —
 * plus the partition bound, so the newest leg towards an extension is one bounded seek. The
 * organization is NOT in the `where` clause: `withTenantScope` publishes it and RLS is the filter,
 * on the rule `cdr.repository.ts` states for every query in this area.
 */
@Injectable()
export class LastCallerService {
	constructor(@Inject(CDR_DATABASE) private readonly database: CdrDatabaseClient) {}

	/**
	 * The most recent call towards `extensionNumber` inside the window.
	 *
	 * @throws never. The caller is connected and listening; a failure is `found: false` with a
	 * reason, which the engine turns into an announcement rather than into dead air.
	 */
	async lookupForBroker(request: {
		readonly orgId: string;
		readonly extensionNumber: string;
		readonly withinHours: number;
		readonly callId?: string;
	}): Promise<LastCallerResponse> {
		const since = new Date(Date.now() - request.withinHours * MILLIS_PER_HOUR);

		try {
			const rows = await this.database.withTenantScope(request.orgId, async (transaction) =>
				transaction
					.select({
						fromNumber: callLegs.fromNumber,
						fromName: callLegs.fromName,
						startedAt: callLegs.startedAt,
					})
					.from(callLegs)
					.where(
						and(
							eq(callLegs.toNumber, request.extensionNumber),
							gte(callLegs.startedAt, since),
							// `outbound` is excluded rather than `inbound` required: a colleague on another
							// extension who rang this desk is exactly the person `*69` is for, and their leg
							// is `internal`. What is never wanted is a leg this extension DIALLED, and that
							// is the only thing `outbound` can be.
							inArray(callLegs.direction, ["inbound", "internal"]),
						),
					)
					// `(started_at, id)` descending, matching the keyset order the reporting list uses, so
					// two legs that started in the same millisecond still have one deterministic winner.
					.orderBy(desc(callLegs.startedAt), desc(callLegs.id))
					.limit(1),
			);

			const row = rows[0];
			if (row === undefined) {
				return { found: false, reason: "nobody called this extension inside the window" };
			}

			const callerNumber = dialableBack(row.fromNumber);
			const callerName = row.fromName?.trim();
			return {
				// `found: true` with no `callerNumber` is the WITHHELD case and it is deliberately not a
				// miss: the caller exists, the switch simply has nothing to dial. The engine announces
				// that differently from "nobody rang you", which is the distinction a user needs.
				found: true,
				...(callerNumber === undefined ? {} : { callerNumber }),
				...(callerName === undefined || callerName === "" ? {} : { callerName }),
				at: row.startedAt.toISOString(),
			};
		} catch (error) {
			logger.error(
				{
					orgId: request.orgId,
					extensionNumber: request.extensionNumber,
					callId: request.callId,
					error,
				},
				"rpc.pbx.v1.last-caller could not read the ledger",
			);
			return {
				found: false,
				reason: `the call ledger could not be read: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}
}

/**
 * The stored `from_number`, or `undefined` when there is nothing to dial back.
 *
 * A withheld caller does not arrive as an empty column. Carriers and SIP stacks write a WORD there
 * — `anonymous` is the SIP convention (RFC 3323), and `unknown`, `restricted`, `private` and
 * `unavailable` all appear in the wild — and every one of them would be handed to the dialler as a
 * SIP user part if it were passed through. `*69` would then place a call to `sip:anonymous@…`,
 * which fails somewhere the user cannot see, several seconds later.
 */
function dialableBack(fromNumber: string): string | undefined {
	const trimmed = fromNumber.trim();
	if (trimmed === "" || WITHHELD.has(trimmed.toLowerCase())) {
		return undefined;
	}
	return trimmed;
}

const WITHHELD = new Set([
	"anonymous",
	"unknown",
	"restricted",
	"private",
	"unavailable",
	"withheld",
]);
