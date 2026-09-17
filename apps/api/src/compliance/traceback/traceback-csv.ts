import { csvField, CSV_BYTE_ORDER_MARK } from "../../cdr/exports/cdr-export-csv";
import type { TracebackEntry } from "./traceback.service";

/**
 * The traceback answer as a CSV, rendered synchronously.
 *
 * ## Why this is NOT the asynchronous export the CDR area uses, and that is not an inconsistency
 *
 * `cdr-exports` is a job: a request is queued, a worker walks the whole result set with a cursor,
 * the CSV is assembled in memory and stored as an object, and the client polls and then downloads a
 * signed link. `cdr-exports.dto.ts` explains what forces that shape — a window of up to 366 days and
 * a cap of 100 000 rows, which is a file of roughly 25 MB that no request should be holding open.
 *
 * A traceback is the opposite of that in every dimension the export design turns on. The window is
 * capped at a month, the result is capped at {@link TRACEBACK_MAX_ROWS} legs, and it is answered by
 * an index seek per partition. The whole file is a few tens of kilobytes. Making an operator queue a
 * job, poll it and mint a signed URL to obtain that would add three failure modes and a worker
 * dependency to a request that completes in milliseconds — and it would do so on the one surface
 * with a 24-hour regulatory clock on it, where "the export worker is backed up" is not an answer.
 *
 * So this renders in the request. If a future traceback ever needs an unbounded window, the honest
 * change is to add a job, not to raise the cap here.
 *
 * ## The escaping is the CDR export's, imported rather than reimplemented
 *
 * `csvField` quotes every field, doubles embedded quotes, and defuses a leading `=`, `@`, tab or
 * carriage return — with the carve-out that leaves `+12125550100` alone so the most-read column in
 * the file is not prefixed with an apostrophe. That reasoning is argued at length in
 * `cdr-export-csv.ts` and is exactly as applicable here, where `from_number` and `sip_call_id` come
 * off a network we do not run. A second implementation would be a second place for the carve-out to
 * be got wrong.
 */

/** The header row, and the order every data row follows. */
export const TRACEBACK_CSV_COLUMNS = [
	"organizationId",
	"organizationName",
	"kycDecision",
	"callId",
	"startedAt",
	"direction",
	"fromNumber",
	"toNumber",
	"sipCallId",
	"trunkRef",
	"signalingAddress",
	"sipAttestation",
	"sipVerstat",
	"sipOrigId",
	"expectedAttestation",
	"callerIdRightToUse",
	"disposition",
	"durationMs",
] as const;

const ROW_SEPARATOR = "\r\n";

function line(cells: readonly unknown[]): string {
	return `${cells.map((cell) => csvField(cell)).join(",")}${ROW_SEPARATOR}`;
}

/**
 * The whole file, byte-order mark included.
 *
 * The BOM is here for the same reason the CDR export carries one: Excel on Windows decodes a CSV as
 * the system code page unless the file announces UTF-8, and an organization name in any non-Latin
 * script is mojibake without it.
 */
export function tracebackCsv(rows: readonly TracebackEntry[]): string {
	const body = rows.map((row) =>
		line([
			row.organizationId,
			row.organizationName,
			row.kycDecision,
			row.callId,
			row.startedAt,
			row.direction,
			row.fromNumber,
			row.toNumber,
			row.sipCallId,
			row.trunkRef,
			row.signalingAddress,
			row.sipAttestation,
			row.sipVerstat,
			row.sipOrigId,
			row.expectedAttestation,
			row.callerIdRightToUse,
			row.disposition,
			row.durationMs,
		]),
	);
	return `${CSV_BYTE_ORDER_MARK}${line(TRACEBACK_CSV_COLUMNS)}${body.join("")}`;
}

/**
 * The download name: `traceback-<from>-<to>.csv`, dates only.
 *
 * The numbers queried are deliberately NOT in the file name. A traceback names a real person's
 * telephone number, and a file name is the one part of a download that ends up in an email subject,
 * a shared folder listing and a screenshot.
 */
export function tracebackFileName(range: { readonly from: Date; readonly to: Date }): string {
	return `traceback-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.csv`;
}
