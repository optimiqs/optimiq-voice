package events

// SIP dialog event constructors — the Go mirror of makeSipDialogEvent in
// packages/events/src/schemas/sip-dialog-events.ts.
//
// The subject is derived from the payload's LegID here exactly as it is there, so a caller cannot
// publish a payload whose leg disagrees with its subject — the same invariant the registration
// constructors enforce between an AOR and its hash, and it matters more here: an event applied to
// the wrong leg tears down somebody else's call.
//
// Six explicit constructors rather than one generic, for the reason registration.go gives for its
// three: the payloads are distinct generated structs with no common interface, and a type-set
// constraint cannot reach their fields. Explicit beats clever, and the vocabulary is closed.
//
// apps/sipd is the only producer of these; the engine is the only consumer.

func sipDialogEnvelope[T any](eventType, legID string, in EnvelopeInput[T]) (Envelope[T], error) {
	subject, err := SIPDialogSubject(in.OrgID, legID, eventType)
	if err != nil {
		return Envelope[T]{}, err
	}
	in.Subject = subject
	return NewEnvelope(eventType, in), nil
}

// NewSIPDialogProgressedEnvelope builds a `dialog.progressed` event — a 18x, which the engine maps
// to `ringing` or, when the response carried SDP, to `early`.
func NewSIPDialogProgressedEnvelope(
	in EnvelopeInput[SIPDialogProgressedData],
) (Envelope[SIPDialogProgressedData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogProgressed, in.Data.LegID, in)
}

// NewSIPDialogAnsweredEnvelope builds a `dialog.answered` event.
//
// Published on the ACK for a UAS leg and on the 2xx for a UAC leg. The asymmetry is the contract,
// not an oversight: those are the two moments the call is genuinely established in each direction,
// and billsec counts from exactly here. It is NOT published when the `answer` command replies —
// that reply means "the 200 is on the socket" and the far end may still never ACK.
func NewSIPDialogAnsweredEnvelope(
	in EnvelopeInput[SIPDialogAnsweredData],
) (Envelope[SIPDialogAnsweredData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogAnswered, in.Data.LegID, in)
}

// NewSIPDialogHeldEnvelope builds a `dialog.held` event — a re-INVITE or UPDATE that moved the far
// end to sendonly or inactive.
func NewSIPDialogHeldEnvelope(
	in EnvelopeInput[SIPDialogHeldData],
) (Envelope[SIPDialogHeldData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogHeld, in.Data.LegID, in)
}

// NewSIPDialogResumedEnvelope builds a `dialog.resumed` event — the same transition back.
func NewSIPDialogResumedEnvelope(
	in EnvelopeInput[SIPDialogResumedData],
) (Envelope[SIPDialogResumedData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogResumed, in.Data.LegID, in)
}

// NewSIPDialogTerminatedEnvelope builds a `dialog.terminated` event — the leg is over, with a cause
// this plane can actually defend.
//
// The one event on this backbone whose Q.850 cause is derived from evidence rather than inferred: a
// media plane never saw a SIP response, and this one did. The status maps through RFC 3398, and when
// the far end sent an RFC 3326 `Reason: Q.850;cause=NN` that value wins VERBATIM — re-deriving it
// from the status code would be discarding better evidence for worse.
func NewSIPDialogTerminatedEnvelope(
	in EnvelopeInput[SIPDialogTerminatedData],
) (Envelope[SIPDialogTerminatedData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogTerminated, in.Data.LegID, in)
}

// NewSIPDialogDTMFEnvelope builds a `dialog.dtmf` event — one keypress that arrived as a SIP INFO
// body.
//
// SIP INFO ONLY, and the word "only" is the contract: RFC 4733 in-band digits are the media plane's,
// and a consumer handed both would have to decide which one a gather counts.
func NewSIPDialogDTMFEnvelope(
	in EnvelopeInput[SIPDialogDTMFData],
) (Envelope[SIPDialogDTMFData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogDTMF, in.Data.LegID, in)
}
