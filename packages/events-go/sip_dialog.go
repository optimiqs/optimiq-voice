package events

// SIP dialog event constructors — the Go mirror of makeSipDialogEvent in
// packages/events/src/schemas/sip-dialog-events.ts.
//
// Each derives the subject from the payload's LegID, exactly as TypeScript does, so a caller cannot
// publish a payload whose leg disagrees with its subject — an event applied to the wrong leg tears
// down somebody else's call. They are written out one per event type for the reason registration.go
// gives.

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
// Published on the ACK for a UAS leg and on the 2xx for a UAC leg: the asymmetry is deliberate,
// since those are the moments the call is genuinely established in each direction, and billsec
// counts from here. It is NOT published when the `answer` command replies — that reply only means
// the 200 is on the socket, and the far end may never ACK.
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

// NewSIPDialogTerminatedEnvelope builds a `dialog.terminated` event.
//
// Its Q.850 cause is derived from evidence rather than inferred: the status maps through RFC 3398,
// and an RFC 3326 `Reason: Q.850;cause=NN` from the far end wins verbatim over that mapping.
func NewSIPDialogTerminatedEnvelope(
	in EnvelopeInput[SIPDialogTerminatedData],
) (Envelope[SIPDialogTerminatedData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogTerminated, in.Data.LegID, in)
}

// NewSIPDialogDTMFEnvelope builds a `dialog.dtmf` event — one keypress from a SIP INFO body.
//
// SIP INFO only, by contract: RFC 4733 in-band digits belong to the media plane, and a consumer
// handed both would have to decide which one a gather counts.
func NewSIPDialogDTMFEnvelope(
	in EnvelopeInput[SIPDialogDTMFData],
) (Envelope[SIPDialogDTMFData], error) {
	return sipDialogEnvelope(EventTypeSIPDialogDTMF, in.Data.LegID, in)
}
