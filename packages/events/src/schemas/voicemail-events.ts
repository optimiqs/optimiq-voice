import { z } from "zod";
import { subjectFor, type VoicemailEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";

/**
 * Voicemail events — `voicemail.evt.v1.<orgId>.<mailboxId>.<event>`.
 *
 * `mailboxId` (the `voicemail_box` row id) is subject-carried and therefore absent from the
 * payloads, on the same rule as `queueId` and `callId`: one copy, in the address.
 *
 * ## Two events, two authors
 *
 * `message.left` is a FACT the engine observed: a caller finished recording, here is the object and
 * how long it is. The engine publishes it and knows nothing else about the mailbox — not how many
 * messages it holds, not whether the box is over quota, not whether anyone should be emailed.
 *
 * `mwi.updated` is a COUNT, and only the process that owns the `voicemail_message` rows can produce
 * one. It is published by the control plane after it has filed the message (or after a user read or
 * deleted one), and it is what a future BLF/MWI fan-out turns into a `NOTIFY` with a
 * `Messages-Waiting` body.
 *
 * Splitting them is what keeps the engine out of the mailbox: an engine that had to report
 * "3 new, 12 old" would have to read the database on the call path to record one message.
 */

/**
 * `message.left` — a caller recorded a message into this box.
 *
 * `objectKey` is the store key the engine already published on `channel.record.stopped`; carrying
 * it here too is deliberate, because the consumer of THIS stream must be able to file the message
 * without joining against the call stream, which has a 72-hour retention and a different consumer.
 */
export const voicemailMessageLeftDataSchema = z.object({
	/** `voicemail_message.id` — UUID v7, minted by the engine. The insert's idempotency key. */
	messageId: z.uuidv7(),
	/** The dialable mailbox number, for logs and for a consumer that has no box row yet. */
	mailboxNumber: z.string().min(1).max(64),
	/** The call the message was left on, so a mailbox entry can be traced to its CDR. */
	callId: z.uuid(),
	/** The A-leg that recorded it. Becomes `voicemail_message.call_leg_ref`. */
	legId: z.uuid(),
	/** The media object's id, matching the `channel.record.*` pair for the same recording. */
	recordingId: z.uuid(),
	/** Store key of the audio. */
	objectKey: z.string().min(1).max(1024),
	durationMs: z.int().min(0),
	sizeBytes: z.int().min(0).optional(),
	callerIdNumber: z.string().max(128).optional(),
	callerIdName: z.string().max(128).optional(),
	receivedAt: z.iso.datetime(),
	/** Whether the box asks for transcription. The consumer decides what to do about it. */
	transcriptionRequested: z.boolean().optional(),
});

/**
 * `mwi.updated` — the box's unread/read counts changed.
 *
 * Both counts are absolute, never deltas: a lamp driven by deltas is one dropped message away from
 * being wrong until someone reboots a phone.
 */
export const voicemailMwiUpdatedDataSchema = z.object({
	mailboxNumber: z.string().min(1).max(64),
	/** The extension whose lamp this lights, when the box is bound to one. */
	extensionNumber: z.string().max(64).optional(),
	/** Messages in the `new` folder. */
	newCount: z.int().min(0),
	/** Messages in the `saved` folder. */
	savedCount: z.int().min(0),
	/** What moved the counts, for the log. */
	reason: z.enum(["message-left", "message-read", "message-deleted", "resync"]).optional(),
});

export const VOICEMAIL_EVENT_DEFINITIONS = {
	"message.left": defineEvent("voicemail", "message.left", voicemailMessageLeftDataSchema),
	"mwi.updated": defineEvent("voicemail", "mwi.updated", voicemailMwiUpdatedDataSchema),
} as const;

export type VoicemailEventDefinitions = typeof VOICEMAIL_EVENT_DEFINITIONS;

export type VoicemailEventOf<TType extends VoicemailEvent> = z.infer<
	VoicemailEventDefinitions[TType]["envelope"]
>;

export type VoicemailEventDataOf<TType extends VoicemailEvent> = z.infer<
	VoicemailEventDefinitions[TType]["data"]
>;

export type VoicemailMessageLeftData = z.infer<typeof voicemailMessageLeftDataSchema>;
export type VoicemailMwiUpdatedData = z.infer<typeof voicemailMwiUpdatedDataSchema>;

/** Every voicemail event as one discriminated union. */
export const voicemailEventSchema = z.discriminatedUnion("type", [
	VOICEMAIL_EVENT_DEFINITIONS["message.left"].envelope,
	VOICEMAIL_EVENT_DEFINITIONS["mwi.updated"].envelope,
]);

export type VoicemailEventEnvelope = z.infer<typeof voicemailEventSchema>;

export interface VoicemailEventInput<TType extends VoicemailEvent> extends Omit<
	EventInput<VoicemailEventDataOf<TType>>,
	"subject"
> {
	/** The `voicemail_box` row id. */
	readonly mailboxId: string;
}

/** Builds and validates a voicemail event, deriving `voicemail.evt.v1.<orgId>.<mailboxId>.<type>`. */
export function makeVoicemailEvent<TType extends VoicemailEvent>(
	type: TType,
	input: VoicemailEventInput<TType>,
): VoicemailEventOf<TType> {
	const definition = VOICEMAIL_EVENT_DEFINITIONS[type];
	const subject = subjectFor.voicemail(input.orgId, input.mailboxId, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as VoicemailEventOf<TType>;
}
