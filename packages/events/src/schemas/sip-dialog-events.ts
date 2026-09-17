import { z } from "zod";
import { subjectFor, type SipDialogEvent } from "../subjects";
import { defineEvent, makeEvent, type EventInput } from "./envelope";
import { dtmfDigitSchema, hangupCauseCodeSchema } from "./telephony";

/**
 * SIP dialog events — `sip.evt.v1.<orgId>.<legId>.<event>`.
 *
 * The signalling plane's half of a call, published by `apps/sipd` and consumed by the engine, which
 * maps each one onto a member of its media-server-agnostic `MediaEvent` union
 * (`apps/engine/src/media/media-event.ts`). The union is NOT extended for this plane; the mapping
 * table is `plans/sipd-invite-design.md` §3.3 and the vocabulary is `SIP_DIALOG_EVENTS`.
 *
 * ## Why the leg id is the subject token and the SIP identity is payload
 *
 * One string names the leg, the `mediad` session and the `sipd` dialog (§3.1). The SIP dialog
 * identifier — `Call-ID` plus the two tags — travels in every payload here as a LOOKUP KEY and
 * never as an authorisation, the same rule `sipTransferRequestSchema.sipCallId` already states. It
 * could not be the key even if we wanted it to: a `Call-ID` is phone-chosen and full of characters
 * no subject token accepts.
 *
 * ## Why `sipd` never parses the bodies it carries
 *
 * `sdpAnswer` and `sdpOffer` appear on two of these payloads as OPAQUE strings. The engine is the
 * courier for SDP and `mediad` is the only process that parses it — the rule
 * `plans/mediad-design.md` §5 states in one sentence, preserved here in the direction that design
 * had not needed yet. A `sipd` that read a body would be holding a second opinion about codecs it
 * cannot check.
 */

/** A SIP `Call-ID` as the far end wrote it. 256 matches `sipTransferRequestSchema.sipCallId`. */
export const sipCallIdSchema = z.string().min(1).max(256);

/** A dialog tag (RFC 3261 §19.3). */
export const sipTagSchema = z.string().min(1).max(128);

/**
 * The SIP dialog triple, carried on every event in this family.
 *
 * Present on all six rather than on the terminal one alone, because the consumer that needs it most
 * is a packet capture being lined up against a log at three in the morning, and an event that made
 * the reader join back to an earlier one to learn which dialog it was about would fail exactly then.
 * `remoteTag` is optional because a UAS leg has one from the start and a UAC leg does not learn it
 * until the far end answers (RFC 3261 §12.1.2).
 */
export const sipDialogIdentitySchema = z.object({
	sipCallId: sipCallIdSchema,
	localTag: sipTagSchema.optional(),
	remoteTag: sipTagSchema.optional(),
});

const dialogBase = {
	/**
	 * Always equals the subject's middle token; carried so a replayed file is self-describing —
	 * the same argument `registrationBase.aorHash` makes.
	 */
	legId: z.string().min(1).max(128),
	/** The engine's call id, as it came back on the admission reply. */
	callId: z.string().min(1).max(128),
	/** The `sipd` instance holding the dialog. Every command for this leg is addressed at it. */
	instanceId: z.string().min(1).max(128),
	/** `uas` when we answered the INVITE, `uac` when we placed it. */
	role: z.enum(["uas", "uac"]),
	identity: sipDialogIdentitySchema,
};

/**
 * `dialog.progressed` — a `18x` came back on a leg we placed, or we sent one on a leg we answered.
 *
 * Maps to `call-state-changed` → `ringing`, or → `early` when {@link hasEarlyMedia} is true, which
 * is the ONLY thing that distinguishes them: a `183 Session Progress` carrying an answer commits the
 * offer/answer exchange, and a consumer that treated it as plain ringback would start `billsec` at
 * the wrong moment and would let the subsequent `200 OK` repeat a different answer.
 */
export const sipDialogProgressedDataSchema = z.object({
	...dialogBase,
	/** The SIP status on the provisional response: 180, 183, 181, 182. */
	status: z.int().min(100).max(199),
	/** True when the `18x` carried an SDP body — an early-media session, not merely ringback. */
	hasEarlyMedia: z.boolean().default(false),
	/**
	 * The answer the far end put in its `18x`, verbatim and unparsed, when there was one.
	 *
	 * Present only on a UAC leg: on a UAS leg we WROTE the body and the engine already holds it. It
	 * is here so early media can be settled without a second round trip back to the edge for bytes
	 * the edge is already holding.
	 */
	sdpAnswer: z
		.string()
		.max(16 * 1024)
		.optional(),
});

/**
 * `dialog.answered` — the call is up.
 *
 * Published on the ACK for a UAS leg and on the `2xx` for a UAC leg, and the asymmetry is the
 * contract rather than an oversight: those are the two moments the call is genuinely established in
 * each direction, and `billsec` counts from exactly here. It is emphatically NOT published when the
 * `answer` command replies — that reply means "the 200 is on the socket" and the far end may still
 * never ACK (`plans/sipd-invite-design.md` §4.6).
 */
export const sipDialogAnsweredDataSchema = z.object({
	...dialogBase,
	/**
	 * The negotiated body from the far end, verbatim. Present on a UAC leg, where the `2xx` carried
	 * the answer to the offer `mediad` wrote; absent on a UAS leg, where the ACK carries nothing new.
	 */
	sdpAnswer: z
		.string()
		.max(16 * 1024)
		.optional(),
	/** Milliseconds from the INVITE to this moment. Post-dial delay, measured where it happens. */
	setupMs: z.int().min(0).optional(),
});

/**
 * `dialog.held` — a re-INVITE or UPDATE moved the far end to `sendonly` or `inactive`.
 *
 * Maps to `leg-held`. The direction is carried rather than derived because `sendonly` and
 * `inactive` are different holds — one still expects to hear us — and a consumer that flattened
 * them would play music at a party that muted itself.
 */
export const sipDialogHeldDataSchema = z.object({
	...dialogBase,
	/** The direction attribute the far end asserted. */
	direction: z.enum(["sendonly", "inactive"]),
});

/** `dialog.resumed` — the same transition back to `sendrecv` or `recvonly`. Maps to `leg-unheld`. */
export const sipDialogResumedDataSchema = z.object({
	...dialogBase,
	direction: z.enum(["sendrecv", "recvonly"]),
});

/**
 * Which way a dialog ended, alongside the Q.850 cause that says why.
 *
 * Two fields rather than one because they answer different questions and a CDR needs both: a
 * `cancelled` and a `rejected` can both carry cause 16, and a report that cannot tell them apart
 * cannot tell a caller who hung up from a callee who declined.
 */
export const SIP_TERMINATION_REASONS = [
	/** The ordinary end of a call: somebody sent a BYE. */
	"bye",
	/** A CANCEL that arrived before the `200 OK` was on the socket. */
	"cancelled",
	/** A final failure response — ours to a caller, or theirs to our INVITE. */
	"rejected",
	/** Any expired timer: Timer B, an unACKed 2xx, an RFC 4028 session expiry. */
	"timeout",
	/** An RFC 3891 `Replaces` completed and this dialog was the one taken out of the call. */
	"replaced",
	/**
	 * The reaping path (`plans/sipd-invite-design.md` §6.2): a SURVIVING instance found an expired
	 * `sip-dialogs` claim and published the termination its owner never got to.
	 *
	 * It is a distinct reason and not a `timeout` because the difference is operationally enormous:
	 * a timeout is one call that went wrong, and this is a pod that went away with N calls on it. The
	 * engine writes a CDR from a `leg-ended` it would otherwise never have received, and the row says
	 * honestly that nobody watched the call end.
	 */
	"instance-lost",
	/** A drain that ran out of patience. */
	"shutting-down",
] as const;
export const sipTerminationReasonSchema = z.enum(SIP_TERMINATION_REASONS);
export type SipTerminationReason = (typeof SIP_TERMINATION_REASONS)[number];

/**
 * `dialog.terminated` — the leg is over, with a cause this plane can actually defend.
 *
 * Maps to `leg-ended`, and it is the ONE event on this backbone whose Q.850 cause is derived from
 * evidence rather than inferred. `plans/mediad-design.md` §3.2 records that a media plane "has no
 * Q.850 opinion — it never saw a SIP response"; `sipd` did see it, so the status maps through
 * RFC 3398, and when the far end sent an RFC 3326 `Reason: Q.850;cause=NN` that value wins VERBATIM
 * — it is the far end's own switch telling us what it decided, and re-deriving it from the status
 * code would be discarding better evidence for worse.
 *
 * There is deliberately no companion `hangup-requested`: under `sipd` there is no "afterwards", a
 * BYE IS the termination, and emitting both from one wire event would tear the leg down twice.
 */
export const sipDialogTerminatedDataSchema = z.object({
	...dialogBase,
	reason: sipTerminationReasonSchema,
	/** The Q.850 cause. See the note above for where it comes from. */
	cause: hangupCauseCodeSchema,
	/** The SIP status that produced the cause, when a response rather than a BYE ended the dialog. */
	status: z.int().min(300).max(699).optional(),
	/** True when the RFC 3326 `Reason` header supplied {@link cause} rather than the status table. */
	causeFromReasonHeader: z.boolean().default(false),
	/** Which end initiated. `local` is us, `remote` is the far end, `timer` is neither. */
	initiator: z.enum(["local", "remote", "timer"]),
	/** Seconds the dialog was CONFIRMED, so a CDR's `billsec` has a second witness. */
	answeredForSeconds: z.int().min(0).optional(),
});

/**
 * `dialog.dtmf` — one keypress that arrived as a SIP INFO body.
 *
 * SIP INFO ONLY, and the word "only" is the contract: RFC 4733 in-band digits are `mediad`'s
 * (`media.evt.v1.…dtmf.received`), and a consumer handed both would have to decide which one a
 * `gather` counts. Maps to `dtmf-received`, the same member the RFC 4733 path maps to — the engine
 * branches on the digit, not on how it travelled.
 */
export const sipDialogDtmfDataSchema = z.object({
	...dialogBase,
	digit: dtmfDigitSchema,
	/** Duration the far end claimed, in milliseconds. Advisory: INFO bodies routinely omit it. */
	durationMs: z.int().min(0).max(10_000).optional(),
});

export const SIP_DIALOG_EVENT_DEFINITIONS = {
	"dialog.progressed": defineEvent("sipDialog", "dialog.progressed", sipDialogProgressedDataSchema),
	"dialog.answered": defineEvent("sipDialog", "dialog.answered", sipDialogAnsweredDataSchema),
	"dialog.held": defineEvent("sipDialog", "dialog.held", sipDialogHeldDataSchema),
	"dialog.resumed": defineEvent("sipDialog", "dialog.resumed", sipDialogResumedDataSchema),
	"dialog.terminated": defineEvent("sipDialog", "dialog.terminated", sipDialogTerminatedDataSchema),
	"dialog.dtmf": defineEvent("sipDialog", "dialog.dtmf", sipDialogDtmfDataSchema),
} as const;

export type SipDialogEventDefinitions = typeof SIP_DIALOG_EVENT_DEFINITIONS;

export type SipDialogEventOf<TType extends SipDialogEvent> = z.infer<
	SipDialogEventDefinitions[TType]["envelope"]
>;

export type SipDialogEventDataOf<TType extends SipDialogEvent> = z.infer<
	SipDialogEventDefinitions[TType]["data"]
>;

/** Every SIP dialog event as one discriminated union. */
export const sipDialogEventSchema = z.discriminatedUnion("type", [
	SIP_DIALOG_EVENT_DEFINITIONS["dialog.progressed"].envelope,
	SIP_DIALOG_EVENT_DEFINITIONS["dialog.answered"].envelope,
	SIP_DIALOG_EVENT_DEFINITIONS["dialog.held"].envelope,
	SIP_DIALOG_EVENT_DEFINITIONS["dialog.resumed"].envelope,
	SIP_DIALOG_EVENT_DEFINITIONS["dialog.terminated"].envelope,
	SIP_DIALOG_EVENT_DEFINITIONS["dialog.dtmf"].envelope,
]);

export type SipDialogEventEnvelope = z.infer<typeof sipDialogEventSchema>;

/**
 * Input for {@link makeSipDialogEvent}. The subject is derived from `orgId` and `data.legId`, so a
 * caller cannot publish a payload whose leg disagrees with its subject — the same invariant
 * `makeRegistrationEvent` enforces between an AOR and its hash.
 */
export type SipDialogEventInput<TType extends SipDialogEvent> = Omit<
	EventInput<SipDialogEventDataOf<TType>>,
	"subject"
>;

/** Builds and validates a SIP dialog event, deriving the subject from the payload's leg id. */
export function makeSipDialogEvent<TType extends SipDialogEvent>(
	type: TType,
	input: SipDialogEventInput<TType>,
): SipDialogEventOf<TType> {
	const definition = SIP_DIALOG_EVENT_DEFINITIONS[type];
	const subject = subjectFor.sipDialog(input.orgId, input.data.legId, type);
	// See the note in `makeCallEvent`: the record index and the payload are correlated by `type`.
	return makeEvent(definition, { ...input, subject } as never) as SipDialogEventOf<TType>;
}
