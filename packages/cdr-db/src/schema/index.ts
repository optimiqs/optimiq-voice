export {
	CALL_DESTINATION_TYPES,
	CALL_DIRECTIONS,
	CALL_DISPOSITIONS,
	QUEUE_OUTCOMES,
	CALL_EVENT_TYPES,
	CALL_LEG_SIDES,
	HANGUP_SIDES,
	RECORDING_KINDS,
	TRANSCRIPTION_STATUSES,
	type CallDestinationType,
	type CallDirection,
	type CallDisposition,
	type QueueOutcome,
	type CallEventType,
	type CallLegSide,
	type HangupSide,
	type RecordingKind,
	type TranscriptionStatus,
} from "./enums";
export { callLegs, type CallLegRow, type NewCallLegRow } from "./call-leg-schema";
export { callEvents, type CallEventRow, type NewCallEventRow } from "./call-event-schema";
export { recordings, type NewRecordingRow, type RecordingRow } from "./recording-schema";
export {
	CDR_EXPORT_FAILURES,
	CDR_EXPORT_STATUSES,
	cdrExportJob,
	type CdrExportFailure,
	type CdrExportJobRow,
	type CdrExportStatus,
	type NewCdrExportJobRow,
} from "./export-schema";
export {
	CDR_QUARANTINE_REASONS,
	cdrWriteQuarantine,
	type CdrQuarantineReason,
	type CdrWriteQuarantineRow,
	type NewCdrWriteQuarantineRow,
} from "./quarantine-schema";

import { callEvents } from "./call-event-schema";
import { callLegs } from "./call-leg-schema";
import { cdrExportJob } from "./export-schema";
import { cdrWriteQuarantine } from "./quarantine-schema";
import { recordings } from "./recording-schema";

/** Every table in the CDR journal, for `drizzle({ schema })` and test fixtures. */
export const cdrSchema = {
	callEvents,
	callLegs,
	cdrExportJob,
	cdrWriteQuarantine,
	recordings,
} as const;

export type CdrSchema = typeof cdrSchema;
