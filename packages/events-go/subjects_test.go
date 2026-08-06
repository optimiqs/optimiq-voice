package events

import (
	"encoding/json"
	"errors"
	"testing"
)

// Behaviour the golden cannot express: the rejection paths. A subject builder that quietly accepts
// a dot, a wildcard or an empty token is how a tenant's events end up on another tenant's subject.

func TestSubjectBuildersRejectBadTokens(t *testing.T) {
	const org = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"

	bad := []struct {
		name  string
		value string
	}{
		{"empty", ""},
		{"dotted", "org.sub"},
		{"single wildcard", "*"},
		{"trailing wildcard", ">"},
		{"space", "org id"},
		{"at sign", "1001@example.com"},
		{"newline", "org\n"},
	}

	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := CallSubject(tc.value, "call", "channel.created"); err == nil {
				t.Errorf("CallSubject accepted orgId %q", tc.value)
			}
			if _, err := CallSubject(org, tc.value, "channel.created"); err == nil {
				t.Errorf("CallSubject accepted callId %q", tc.value)
			}
			if _, err := RegistrationKVKey(org, tc.value); err == nil {
				t.Errorf("RegistrationKVKey accepted aorHash %q", tc.value)
			}
		})
	}

	var tokenErr *SubjectTokenError
	_, err := CallSubject("org id", "call", "channel.created")
	if !errors.As(err, &tokenErr) {
		t.Fatalf("error = %v, want a *SubjectTokenError callers can inspect", err)
	}
	if tokenErr.Role != "orgId" || tokenErr.Value != "org id" {
		t.Errorf("error = %+v, want the offending role and value preserved", tokenErr)
	}
}

func TestEventNamesMayBeDottedButNotWild(t *testing.T) {
	const org = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"

	if _, err := CallSubject(org, "call", "channel.record.started"); err != nil {
		t.Errorf("a multi-token event name must be accepted: %v", err)
	}
	for _, event := range []string{"", "channel..started", ".started", "started.", "channel.*"} {
		if _, err := CallSubject(org, "call", event); err == nil {
			t.Errorf("CallSubject accepted event %q", event)
		}
	}
}

func TestParseSubjectRejectsWildcardsAndOtherMajors(t *testing.T) {
	for _, subject := range []string{
		"calls.evt.v1.org.*.channel.created",
		"calls.evt.v1.org.call.>",
		"calls.evt.v2.org.call.channel.created",
		"calls.evt",
		"",
	} {
		if _, ok := ParseSubject(subject); ok {
			t.Errorf("ParseSubject(%q) succeeded; a filter or a foreign major is not a delivery subject", subject)
		}
	}

	if _, err := ParseSubjectOrError("nope"); err == nil {
		t.Error("ParseSubjectOrError should report an unknown subject")
	}
}

func TestEventFamilyForSubjectExcludesRPC(t *testing.T) {
	if _, ok := EventFamilyForSubject(SubjectRoutingResolveRPC); ok {
		t.Error("an rpc subject has no event family: it is request-reply, never JetStream")
	}
	family, ok := EventFamilyForSubject("sip.reg.v1.org.abcdef.registered")
	if !ok || family != FamilyRegistration {
		t.Errorf("EventFamilyForSubject = %q/%v, want registration/true", family, ok)
	}
}

func TestUnknownEventTypesSurviveParsing(t *testing.T) {
	// Additive evolution: a v1.n producer may emit a type this build has never heard of, and the
	// consumer must still be able to route and log it rather than dropping it at parse time.
	parsed, ok := ParseSubject("calls.evt.v1.org.call.channel.transcoded")
	if !ok {
		t.Fatal("an unknown event name must still parse")
	}
	if parsed.Event != "channel.transcoded" {
		t.Errorf("Event = %q, want the name preserved verbatim", parsed.Event)
	}
	if IsEventTypeOfFamily(FamilyCall, parsed.Event) {
		t.Error("IsEventTypeOfFamily should report false for a type outside this build")
	}
	if NewDataFor(parsed.Event) != nil {
		t.Error("NewDataFor should return nil rather than guess at an unknown payload")
	}
}

func TestCheckSubjectCatchesTenantMismatch(t *testing.T) {
	const orgA = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	const orgB = "01930a11-2233-7445-8899-aabbccddeeff"

	subject, err := AuditSubject(orgA)
	if err != nil {
		t.Fatal(err)
	}
	envelope := NewEnvelope(EventTypeAuditRecorded, EnvelopeInput[json.RawMessage]{
		OrgID:   orgB,
		Subject: subject,
		Source:  "api",
		Data:    json.RawMessage(`{}`),
	})
	if err := CheckSubject(subject, envelope); err == nil {
		t.Error("an envelope whose orgId is not its subject's org must be rejected")
	}

	envelope.OrgID = orgA
	if err := CheckSubject(subject, envelope); err != nil {
		t.Errorf("a consistent envelope must pass: %v", err)
	}
	if err := CheckSubject("audit.evt.v1.other", envelope); err == nil {
		t.Error("an envelope delivered on a different subject must be rejected")
	}
}

func TestNewEventIDIsUUIDv7AndUnique(t *testing.T) {
	seen := make(map[string]struct{}, 128)
	for range 128 {
		id := NewEventID()
		if len(id) != 36 || id[14] != '7' {
			t.Fatalf("NewEventID = %q, want a UUID v7 (the envelope's ordering + dedupe key)", id)
		}
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("NewEventID produced %q twice", id)
		}
		seen[id] = struct{}{}
	}
}

func TestCDRPassthroughSurvivesRoundTrip(t *testing.T) {
	const wire = `{"id":"0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c",` +
		`"callId":"0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c","leg":"a","direction":"inbound",` +
		`"fromNumber":"+441632960111","toNumber":"1001","destinationType":"extension",` +
		`"startedAt":"2026-08-05T10:00:00.000Z","durationMs":1,"billsecMs":0,` +
		`"hangupCause":"NORMAL_CLEARING","hangupCauseCode":16,"disposition":"answered",` +
		`"conferenceRoomId":"room-7","mediaStats":{"mos":4.31}}`

	var data CDRLegWriteData
	if err := json.Unmarshal([]byte(wire), &data); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(data.Extra) != 2 {
		t.Fatalf("Extra = %v, want the two keys outside the pinned contract", data.Extra)
	}
	if string(data.Extra["conferenceRoomId"]) != `"room-7"` {
		t.Errorf("Extra[conferenceRoomId] = %s", data.Extra["conferenceRoomId"])
	}

	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]any
	if err := json.Unmarshal(encoded, &round); err != nil {
		t.Fatalf("unmarshal round trip: %v", err)
	}
	if round["conferenceRoomId"] != "room-7" {
		t.Errorf("passthrough key lost on re-encode: %v", round)
	}
	if round["hangupCause"] != "NORMAL_CLEARING" {
		t.Errorf("pinned field lost on re-encode: %v", round)
	}
}
