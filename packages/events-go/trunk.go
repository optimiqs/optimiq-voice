package events

// Trunk event constructor — the Go mirror of makeTrunkEvent in
// packages/events/src/schemas/trunk-events.ts.
//
// Like registration.go and sip_dialog.go it derives the subject inside, so a caller cannot publish
// a payload whose subject names a different trunk. Unlike them the trunk id is a parameter rather
// than a payload field: TrunkStatusChangedData carries only the facts that changed, and the trunk's
// identity is the subject's job (`trunk.evt.v1.<orgId>.<trunkId>`).

// NewTrunkStatusChangedEnvelope builds a `status.changed` event, deriving
// trunk.evt.v1.<orgId>.<trunkId>.status.changed.
//
// The status vocabulary is closed and generated — see TrunkStatusChangedStatusValues. `unknown` is
// the right answer before the first REGISTER has been answered; `down` means a carrier that was
// asked and did not work, so publishing it for an untried trunk would false-alarm at boot.
func NewTrunkStatusChangedEnvelope(
	trunkID string,
	in EnvelopeInput[TrunkStatusChangedData],
) (Envelope[TrunkStatusChangedData], error) {
	subject, err := TrunkSubject(in.OrgID, trunkID, EventTypeTrunkStatusChanged)
	if err != nil {
		return Envelope[TrunkStatusChangedData]{}, err
	}
	in.Subject = subject
	return NewEnvelope(EventTypeTrunkStatusChanged, in), nil
}
