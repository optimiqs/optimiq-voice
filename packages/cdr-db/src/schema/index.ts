export {
	CALL_DESTINATION_TYPES,
	CALL_DIRECTIONS,
	CALL_DISPOSITIONS,
	CALL_EVENT_TYPES,
	CALL_LEG_SIDES,
	HANGUP_SIDES,
	RECORDING_KINDS,
	TRANSCRIPTION_STATUSES,
	type CallDestinationType,
	type CallDirection,
	type CallDisposition,
	type CallEventType,
	type CallLegSide,
	type HangupSide,
	type RecordingKind,
	type TranscriptionStatus,
} from "./enums";
export { callLegs, type CallLegRow, type NewCallLegRow } from "./call-leg-schema";
export { callEvents, type CallEventRow, type NewCallEventRow } from "./call-event-schema";
export { recordings, type NewRecordingRow, type RecordingRow } from "./recording-schema";

import { callEvents } from "./call-event-schema";
import { callLegs } from "./call-leg-schema";
import { recordings } from "./recording-schema";

/** Every table in the CDR journal, for `drizzle({ schema })` and test fixtures. */
export const cdrSchema = {
	callEvents,
	callLegs,
	recordings,
} as const;

export type CdrSchema = typeof cdrSchema;
