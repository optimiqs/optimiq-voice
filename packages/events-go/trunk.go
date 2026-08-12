package events

// Trunk event constructors — the Go mirror of makeTrunkEvent in
// packages/events/src/schemas/trunk-events.ts.
//
// # Why this file exists now and did not before
//
// `trunk.status.changed` has had its schema, its generated payload and its subject builder since
// W7, and no Go way to publish one: the TypeScript control plane was the only producer, and it
// builds its subject through `subjectFor.trunk`. `apps/sipd`'s trunk-registration FSM is the first
// Go producer, and it is the AUTHORITATIVE one — the process that actually sends the REGISTER and
// reads the carrier's answer is the only thing that knows whether a trunk is up.
//
// One constructor rather than three, because the family has one event. The shape still matches
// registration.go and sip_dialog.go: derive the subject inside, so a caller cannot publish a
// payload whose subject names a different trunk.
//
// # trunkID is a parameter, not a payload field
//
// The divergence from its two siblings, and it is the schema's decision rather than this file's:
// `TrunkStatusChangedData` carries `status`, `reason`, `latencyMs` and `endpoint` — the facts that
// CHANGED — while the trunk's identity is the subject's job (`trunk.evt.v1.<orgId>.<trunkId>`).
// Registration derives its middle token from the payload's AOR and SIP dialog from the payload's
// leg id because both of those are also facts a consumer needs in hand; a trunk id already arrives
// with the message that carries it.

// NewTrunkStatusChangedEnvelope builds a `status.changed` event, deriving
// trunk.evt.v1.<orgId>.<trunkId>.status.changed.
//
// The status vocabulary is closed and generated — see TrunkStatusChangedStatusValues. `unknown` is
// a real member and the right answer before the first REGISTER has been answered: it is distinct
// from `down`, which is a carrier that was asked and did not work, and publishing `down` for a
// trunk nobody has tried yet is how an alerting rule learns to cry wolf at boot.
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
