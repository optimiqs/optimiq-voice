package events

// Registration event constructors — the Go mirror of makeRegistrationEvent in
// packages/events/src/schemas/registration-events.ts.
//
// The AOR hash is derived from the payload's AOR here, exactly as it is there, so a caller cannot
// publish a payload whose AOR disagrees with its subject. sipd is the only producer of these
// today; the engine and the admin API are consumers.
//
// Three explicit constructors rather than one generic: the payloads are distinct generated structs
// with no common interface, and a type-set constraint cannot reach their fields. Explicit beats
// clever, and there will only ever be three.

func registrationEnvelope[T any](
	eventType string,
	aor string,
	in EnvelopeInput[T],
) (Envelope[T], string, error) {
	hash, err := AORSubjectToken(aor)
	if err != nil {
		return Envelope[T]{}, "", err
	}
	subject, err := RegistrationSubject(in.OrgID, hash, eventType)
	if err != nil {
		return Envelope[T]{}, "", err
	}
	in.Subject = subject
	return NewEnvelope(eventType, in), hash, nil
}

// NewRegistrationRegisteredEnvelope builds a `registered` event, deriving
// sip.reg.v1.<orgId>.<aorHash>.registered and stamping Data.AORHash from Data.AOR.
func NewRegistrationRegisteredEnvelope(
	in EnvelopeInput[RegistrationRegisteredData],
) (Envelope[RegistrationRegisteredData], error) {
	envelope, hash, err := registrationEnvelope(EventTypeRegistrationRegistered, in.Data.AOR, in)
	if err != nil {
		return Envelope[RegistrationRegisteredData]{}, err
	}
	envelope.Data.AORHash = hash
	return envelope, nil
}

// NewRegistrationUnregisteredEnvelope builds an `unregistered` event (explicit Expires: 0, or an
// admin/gateway eviction), deriving the subject and stamping Data.AORHash from Data.AOR.
func NewRegistrationUnregisteredEnvelope(
	in EnvelopeInput[RegistrationUnregisteredData],
) (Envelope[RegistrationUnregisteredData], error) {
	envelope, hash, err := registrationEnvelope(EventTypeRegistrationUnregistered, in.Data.AOR, in)
	if err != nil {
		return Envelope[RegistrationUnregisteredData]{}, err
	}
	envelope.Data.AORHash = hash
	return envelope, nil
}

// NewRegistrationExpiredEnvelope builds an `expired` event — the registrar's TTL sweep removing a
// binding nobody refreshed, never a client request.
func NewRegistrationExpiredEnvelope(
	in EnvelopeInput[RegistrationExpiredData],
) (Envelope[RegistrationExpiredData], error) {
	envelope, hash, err := registrationEnvelope(EventTypeRegistrationExpired, in.Data.AOR, in)
	if err != nil {
		return Envelope[RegistrationExpiredData]{}, err
	}
	envelope.Data.AORHash = hash
	return envelope, nil
}
