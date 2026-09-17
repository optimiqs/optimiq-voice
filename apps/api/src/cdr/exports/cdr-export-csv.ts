import type { CallLegListRow } from "../query/cdr.repository";

/**
 * The CSV rendering, as a pure function of a row.
 *
 * Separate from the worker so the format is testable without a database, an object store or a
 * timer — which matters more here than for most helpers, because a format is the part of an export
 * a customer's spreadsheet depends on and the part a refactor is most likely to change without
 * anybody noticing.
 *
 * ## The column set is `LEG_LIST_COLUMNS`, not the detail projection
 *
 * The export returns what the LIST returns. That is a decision and not a shortcut: the detail
 * projection adds `raw` — the passthrough jsonb the engine attached to the leg — and a blob of
 * nested JSON inside a CSV cell is not data anybody can use in the tool they opened the CSV in. It
 * also adds the media-quality block (MOS, jitter, packet loss), which is a diagnostic dimension
 * rather than a reporting one; when somebody asks for it, it arrives as a column set the request
 * chooses, and that is a change to this file and to the DTO together.
 *
 * ## Escaping, and why every value is quoted
 *
 * RFC 4180 lets a field go unquoted when it contains no comma, quote or newline. This quotes
 * everything anyway. The reason is the failure mode, not the spec: a caller number is `+12125550100`
 * and a spreadsheet reading that unquoted may or may not decide it is a formula, a number in
 * scientific notation, or a date, depending on the spreadsheet and its locale. Quoting uniformly
 * removes an entire class of "the numbers changed when I opened the file" report, costs two bytes a
 * field, and makes the writer's own correctness a one-line rule instead of a per-type judgement.
 *
 * A `"` inside a value is doubled, which is the whole of RFC 4180's escape.
 *
 * ## Formula injection
 *
 * A cell beginning `=`, `+`, `-` or `@` is executed as a formula by Excel and by Google Sheets
 * when the file is opened, quoted or not — quoting is a CSV concern and this is a spreadsheet
 * one. Caller NAME is attacker-controlled on an inbound call (it arrives in the SIP `From`
 * display name from a network we do not run), so this is not a theoretical vector: it is a
 * stranger being able to put a formula into a report an employee opens. Such values are prefixed
 * with a single quote, which every spreadsheet reads as "this is text" and which survives the
 * round trip visibly rather than silently.
 *
 * The rule has one carve-out, and it is the difference between a defence and a nuisance. **A `+`
 * or `-` followed by digits and nothing else is left alone**, because that is every E.164 number
 * in the file — `+12125550100` — and prefixing all of them would put an apostrophe in front of the
 * single most-read column in the report, breaking every downstream parser to defend against a
 * formula that cannot exist. A sign followed only by digits has no operator, no reference and no
 * function call in it; the worst a spreadsheet can do with it is read it as the number it plainly
 * is. `-2+3` has a non-digit after the sign and is defused; `=`, `@`, a leading tab and a leading
 * carriage return are defused unconditionally, the last two because they are the classic way to
 * smuggle a `=` past a naive first-character check.
 */

/** The header row, and the order every data row follows. */
export const CDR_EXPORT_COLUMNS = [
	"id",
	"callId",
	"leg",
	"direction",
	"fromNumber",
	"fromName",
	"toNumber",
	"destinationType",
	"destinationRef",
	"startedAt",
	"answeredAt",
	"endedAt",
	"durationSeconds",
	"billableSeconds",
	"disposition",
	"hangupCause",
	"hangupCauseCode",
	"hangupSide",
	"recorded",
	"transcriptionStatus",
] as const;

/**
 * The byte-order mark, and why the file starts with one.
 *
 * Excel on Windows decodes a CSV as the system code page unless the file announces UTF-8, and a
 * caller name in any non-Latin script is mojibake without it. Every other consumer — LibreOffice,
 * Google Sheets, `pandas`, `csv.reader` — either honours it or skips it. It is three bytes to
 * make the common case correct on the platform most of these files are opened on.
 */
export const CSV_BYTE_ORDER_MARK = "﻿";

/** CRLF, which is what RFC 4180 specifies and what Excel is least surprising about. */
const ROW_SEPARATOR = "\r\n";

/** Always defused: none of these can begin a value this platform legitimately produces. */
const FORMULA_LEAD = new Set(["=", "@", "\t", "\r"]);

/** Defused unless the rest is digits — see the header's carve-out for E.164. */
const SIGN_LEAD = new Set(["+", "-"]);

const DIGITS_ONLY = /^[0-9]+$/u;

function needsDefusing(raw: string): boolean {
	const first = raw[0];
	if (first === undefined) {
		return false;
	}
	if (FORMULA_LEAD.has(first)) {
		return true;
	}
	return SIGN_LEAD.has(first) && !DIGITS_ONLY.test(raw.slice(1));
}

/** One field, quoted, escaped and defused. */
export function csvField(value: unknown): string {
	if (value === null || value === undefined) {
		return '""';
	}
	const raw = value instanceof Date ? value.toISOString() : String(value);
	const defused = needsDefusing(raw) ? `'${raw}` : raw;
	return `"${defused.replaceAll('"', '""')}"`;
}

/** The header line, terminator included. */
export function csvHeader(): string {
	return `${CDR_EXPORT_COLUMNS.map((column) => csvField(column)).join(",")}${ROW_SEPARATOR}`;
}

/**
 * One leg as one line.
 *
 * Durations are rendered in SECONDS while the column holds milliseconds, because a report is read
 * by a person and "how long was the call" is a question answered in seconds. Rounded rather than
 * truncated, so a 1 999 ms call is not reported as one second. The millisecond precision is still
 * available through the API for anything that needs it.
 *
 * `recorded` is a boolean rather than the storage key: the key is an object path, it means nothing
 * outside this platform, and publishing it in a file that leaves the building tells a reader where
 * the audio lives without giving them any way to reach it.
 */
export function csvRow(leg: CallLegListRow): string {
	const cells = [
		leg.id,
		leg.callId,
		leg.leg,
		leg.direction,
		leg.fromNumber,
		leg.fromName,
		leg.toNumber,
		leg.destinationType,
		leg.destinationRef,
		leg.startedAt,
		leg.answeredAt,
		leg.endedAt,
		msToSeconds(leg.durationMs),
		msToSeconds(leg.billsecMs),
		leg.disposition,
		leg.hangupCause,
		leg.hangupCauseCode,
		leg.hangupSide,
		leg.recordingKey === null || leg.recordingKey === undefined ? "false" : "true",
		leg.transcriptionStatus,
	];
	return `${cells.map((cell) => csvField(cell)).join(",")}${ROW_SEPARATOR}`;
}

function msToSeconds(value: number | null | undefined): number | null {
	return value === null || value === undefined ? null : Math.round(value / 1_000);
}

/**
 * The human-readable name the download offers, which is not the object key.
 *
 * `cdr-<from>-<to>.csv`, dates only: an export is asked for by its window and that is what somebody
 * scanning a downloads folder needs to tell two of them apart. The job id is deliberately absent —
 * it is an internal handle, and a file name is the one place it would leak into a document that
 * gets emailed.
 */
export function csvFileName(range: { readonly from: Date; readonly to: Date }): string {
	return `cdr-${isoDate(range.from)}-${isoDate(range.to)}.csv`;
}

function isoDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}
