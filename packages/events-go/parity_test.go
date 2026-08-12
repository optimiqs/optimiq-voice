package events

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

// Cross-language parity.
//
// testdata/parity.json is produced BY the TypeScript implementation (packages/events/src) during
// `pnpm --filter @optimiq-voice/events codegen`. Every assertion below therefore compares this
// package against the behaviour of the real contract, not against a second hand-written copy of it.
//
// If a TypeScript change is not mirrored here, one of these fails. If a Go change diverges, the
// same. That is the entire point: the generated structs cover SHAPE, and this file covers the
// BEHAVIOUR that cannot be generated — subject assembly, AOR hashing, subject matching, KV keys and
// the stream/bucket definitions.

type goldenParsedSubject struct {
	Kind      string `json:"kind"`
	Family    string `json:"family"`
	Version   string `json:"version"`
	OrgID     string `json:"orgId"`
	CallID    string `json:"callId"`
	AORHash   string `json:"aorHash"`
	QueueID   string `json:"queueId"`
	MailboxID string `json:"mailboxId"`
	SessionID string `json:"sessionId"`
	TrunkID   string `json:"trunkId"`
	Event     string `json:"event"`
	Service   string `json:"service"`
	Method    string `json:"method"`
}

type goldenStream struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Subjects          []string `json:"subjects"`
	Retention         string   `json:"retention"`
	Storage           string   `json:"storage"`
	Discard           string   `json:"discard"`
	MaxAgeMs          int64    `json:"maxAgeMs"`
	MaxMsgs           int64    `json:"maxMsgs"`
	MaxBytes          int64    `json:"maxBytes"`
	MaxMsgsPerSubject int64    `json:"maxMsgsPerSubject"`
	DuplicateWindowMs int64    `json:"duplicateWindowMs"`
	NumReplicas       int      `json:"numReplicas"`
}

type goldenKVBucket struct {
	Name              string `json:"name"`
	Description       string `json:"description"`
	TTLMs             int64  `json:"ttlMs"`
	History           uint8  `json:"history"`
	Storage           string `json:"storage"`
	MaxValueSizeBytes int32  `json:"maxValueSizeBytes"`
	MaxBytes          int64  `json:"maxBytes"`
	NumReplicas       int    `json:"numReplicas"`
}

type golden struct {
	SubjectVersion string            `json:"subjectVersion"`
	SubjectRoots   map[string]string `json:"subjectRoots"`
	RPCSubjects    map[string]string `json:"rpcSubjects"`
	QueueScopeAll  string            `json:"queueScopeAll"`

	AORSubjectTokens []struct {
		AOR   string `json:"aor"`
		Token string `json:"token"`
	} `json:"aorSubjectTokens"`

	DIDIndexTokens []struct {
		DID   string `json:"did"`
		Token string `json:"token"`
	} `json:"didIndexTokens"`

	SubjectBuilders []struct {
		Builder string   `json:"builder"`
		Args    []string `json:"args"`
		Subject string   `json:"subject"`
	} `json:"subjectBuilders"`

	SubjectFilters []struct {
		Filter string   `json:"filter"`
		Args   []string `json:"args"`
		Result string   `json:"result"`
	} `json:"subjectFilters"`

	ParseSubject []struct {
		Subject string               `json:"subject"`
		Parsed  *goldenParsedSubject `json:"parsed"`
	} `json:"parseSubject"`

	MatchesSubject []struct {
		Filter  string `json:"filter"`
		Subject string `json:"subject"`
		Matches bool   `json:"matches"`
	} `json:"matchesSubject"`

	KVKeys []struct {
		Builder string   `json:"builder"`
		Args    []string `json:"args"`
		Key     string   `json:"key"`
	} `json:"kvKeys"`

	Streams   []goldenStream   `json:"streams"`
	KVBuckets []goldenKVBucket `json:"kvBuckets"`

	Vocabularies      map[string][]string `json:"vocabularies"`
	EventVocabularies map[string][]string `json:"eventVocabularies"`

	EventTypes []struct {
		Family string `json:"family"`
		Type   string `json:"type"`
		GoType string `json:"goType"`
	} `json:"eventTypes"`

	EventSamples []struct {
		Name     string          `json:"name"`
		GoType   string          `json:"goType"`
		Envelope json.RawMessage `json:"envelope"`
	} `json:"eventSamples"`
}

func loadGolden(t *testing.T) golden {
	t.Helper()
	raw, err := os.ReadFile("testdata/parity.json")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	var g golden
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatalf("decode golden: %v", err)
	}
	return g
}

// builderFor returns a helper that unwraps a (string, error) builder result, so a golden case can
// be written as `must(CallSubject(a, b, c))`.
func builderFor(t *testing.T) func(string, error) string {
	return func(subject string, err error) string {
		t.Helper()
		if err != nil {
			t.Fatalf("builder returned an error: %v", err)
		}
		return subject
	}
}

func TestParityConstants(t *testing.T) {
	g := loadGolden(t)

	if g.SubjectVersion != SubjectVersion {
		t.Errorf("SubjectVersion = %q, golden %q", SubjectVersion, g.SubjectVersion)
	}
	if g.QueueScopeAll != QueueScopeAll {
		t.Errorf("QueueScopeAll = %q, golden %q", QueueScopeAll, g.QueueScopeAll)
	}

	roots := map[string]string{
		"call":         SubjectRootCall,
		"registration": SubjectRootRegistration,
		"queue":        SubjectRootQueue,
		"voicemail":    SubjectRootVoicemail,
		"media":        SubjectRootMedia,
		"trunk":        SubjectRootTrunk,
		"cdrLeg":       SubjectRootCDRLeg,
		"audit":        SubjectRootAudit,
		"provision":    SubjectRootProvision,
	}
	if !reflect.DeepEqual(roots, g.SubjectRoots) {
		t.Errorf("subject roots = %v, golden %v", roots, g.SubjectRoots)
	}

	rpc := map[string]string{
		"routingResolve":          SubjectRoutingResolveRPC,
		"authzCheck":              SubjectAuthzCheckRPC,
		"voicemailList":           SubjectVoicemailListRPC,
		"pbxExtensionFeature":     SubjectExtensionFeatureRPC,
		"pbxLastCaller":           SubjectLastCallerRPC,
		"pbxFileGreeting":         SubjectFileGreetingRPC,
		"sipCredential":           SubjectSipCredentialRPC,
		"sipTransfer":             SubjectSipTransferRPC,
		"mediaAllocateSession":    SubjectMediaAllocateSessionRPC,
		"mediaBridgeSessions":     SubjectMediaBridgeSessionsRPC,
		"mediaUnbridgeSessions":   SubjectMediaUnbridgeSessionsRPC,
		"mediaReleaseSession":     SubjectMediaReleaseSessionRPC,
		"mediaStartPlayback":      SubjectMediaStartPlaybackRPC,
		"mediaStopPlayback":       SubjectMediaStopPlaybackRPC,
		"mediaSendDtmf":           SubjectMediaSendDtmfRPC,
		"mediaStartRecording":     SubjectMediaStartRecordingRPC,
		"mediaStopRecording":      SubjectMediaStopRecordingRPC,
		"mediaTapSession":         SubjectMediaTapSessionRPC,
		"mediaUntapSession":       SubjectMediaUntapSessionRPC,
		"mediaMuteSession":        SubjectMediaMuteSessionRPC,
		"mediaHoldSession":        SubjectMediaHoldSessionRPC,
		"engineOriginate":         SubjectOriginateRPC,
		"engineParkHandoff":       SubjectParkHandoffRPC,
		"engineSessionVerb":       SubjectSessionVerbRPC,
		"engineConferenceControl": SubjectConferenceControlRPC,
		"sessionAnnounce":         SubjectSessionAnnounceRPC,
	}
	if !reflect.DeepEqual(rpc, g.RPCSubjects) {
		t.Errorf("rpc subjects = %v, golden %v", rpc, g.RPCSubjects)
	}
}

func TestParityAORSubjectToken(t *testing.T) {
	for _, tc := range loadGolden(t).AORSubjectTokens {
		token, err := AORSubjectToken(tc.AOR)
		if err != nil {
			t.Errorf("AORSubjectToken(%q): %v", tc.AOR, err)
			continue
		}
		if token != tc.Token {
			t.Errorf("AORSubjectToken(%q) = %q, golden %q", tc.AOR, token, tc.Token)
		}
	}

	if _, err := AORSubjectToken("   "); err == nil {
		t.Error("AORSubjectToken(blank) should reject: an empty AOR has no stable token")
	}
}

func TestParityDIDIndexToken(t *testing.T) {
	for _, tc := range loadGolden(t).DIDIndexTokens {
		tok, err := DIDIndexToken(tc.DID)
		if err != nil {
			t.Errorf("DIDIndexToken(%q): %v", tc.DID, err)
			continue
		}
		if tok != tc.Token {
			t.Errorf("DIDIndexToken(%q) = %q, golden %q", tc.DID, tok, tc.Token)
		}
	}

	if _, err := DIDIndexToken("+ -()"); err == nil {
		t.Error("DIDIndexToken with no digits should reject: there is no key to write it under")
	}
}

func TestParitySubjectBuilders(t *testing.T) {
	must := builderFor(t)
	for _, tc := range loadGolden(t).SubjectBuilders {
		var got string
		switch tc.Builder {
		case "call":
			got = must(CallSubject(tc.Args[0], tc.Args[1], tc.Args[2]))
		case "registration":
			got = must(RegistrationSubject(tc.Args[0], tc.Args[1], tc.Args[2]))
		case "queue":
			got = must(QueueSubject(tc.Args[0], tc.Args[1], tc.Args[2]))
		case "voicemail":
			got = must(VoicemailSubject(tc.Args[0], tc.Args[1], tc.Args[2]))
		case "media":
			got = must(MediaSubject(tc.Args[0], tc.Args[1], tc.Args[2]))
		case "trunk":
			got = must(TrunkSubject(tc.Args[0], tc.Args[1], tc.Args[2]))
		case "cdrLeg":
			got = must(CDRLegSubject(tc.Args[0]))
		case "audit":
			got = must(AuditSubject(tc.Args[0]))
		case "provision":
			got = must(ProvisionSubject(tc.Args[0]))
		default:
			t.Fatalf("golden names builder %q, which this package does not implement", tc.Builder)
		}
		if got != tc.Subject {
			t.Errorf("%s(%v) = %q, golden %q", tc.Builder, tc.Args, got, tc.Subject)
		}
	}
}

func TestParitySubjectFilters(t *testing.T) {
	must := builderFor(t)
	for _, tc := range loadGolden(t).SubjectFilters {
		var got string
		switch tc.Filter {
		case "allCalls":
			got = AllCallsFilter()
		case "callsInOrg":
			got = must(CallsInOrgFilter(tc.Args[0]))
		case "call":
			got = must(CallFilter(tc.Args[0], tc.Args[1]))
		case "callEventInOrg":
			got = must(CallEventInOrgFilter(tc.Args[0], tc.Args[1]))
		case "callEvent":
			got = must(CallEventFilter(tc.Args[0]))
		case "allRegistrations":
			got = AllRegistrationsFilter()
		case "registrationsInOrg":
			got = must(RegistrationsInOrgFilter(tc.Args[0]))
		case "registrationsForAor":
			got = must(RegistrationsForAORFilter(tc.Args[0], tc.Args[1]))
		case "registrationEventInOrg":
			got = must(RegistrationEventInOrgFilter(tc.Args[0], tc.Args[1]))
		case "allQueues":
			got = AllQueuesFilter()
		case "queuesInOrg":
			got = must(QueuesInOrgFilter(tc.Args[0]))
		case "queue":
			got = must(QueueFilter(tc.Args[0], tc.Args[1]))
		case "queueEventInOrg":
			got = must(QueueEventInOrgFilter(tc.Args[0], tc.Args[1]))
		case "allVoicemail":
			got = AllVoicemailFilter()
		case "voicemailInOrg":
			got = must(VoicemailInOrgFilter(tc.Args[0]))
		case "voicemailBox":
			got = must(VoicemailBoxFilter(tc.Args[0], tc.Args[1]))
		case "voicemailEventInOrg":
			got = must(VoicemailEventInOrgFilter(tc.Args[0], tc.Args[1]))
		case "allMedia":
			got = AllMediaFilter()
		case "mediaInOrg":
			got = must(MediaInOrgFilter(tc.Args[0]))
		case "mediaSession":
			got = must(MediaSessionFilter(tc.Args[0], tc.Args[1]))
		case "mediaEventInOrg":
			got = must(MediaEventInOrgFilter(tc.Args[0], tc.Args[1]))
		case "allTrunks":
			got = AllTrunksFilter()
		case "trunksInOrg":
			got = must(TrunksInOrgFilter(tc.Args[0]))
		case "trunkStatusInOrg":
			got = must(TrunkStatusInOrgFilter(tc.Args[0]))
		case "allCdrLegs":
			got = AllCDRLegsFilter()
		case "cdrLegsInOrg":
			got = must(CDRLegsInOrgFilter(tc.Args[0]))
		case "allAudit":
			got = AllAuditFilter()
		case "auditInOrg":
			got = must(AuditInOrgFilter(tc.Args[0]))
		case "allProvision":
			got = AllProvisionFilter()
		case "provisionInOrg":
			got = must(ProvisionInOrgFilter(tc.Args[0]))
		default:
			t.Fatalf("golden names filter %q, which this package does not implement", tc.Filter)
		}
		if got != tc.Result {
			t.Errorf("%s(%v) = %q, golden %q", tc.Filter, tc.Args, got, tc.Result)
		}
	}
}

func TestParityParseSubject(t *testing.T) {
	for _, tc := range loadGolden(t).ParseSubject {
		parsed, ok := ParseSubject(tc.Subject)
		if tc.Parsed == nil {
			if ok {
				t.Errorf("ParseSubject(%q) succeeded but TypeScript rejects it", tc.Subject)
			}
			continue
		}
		if !ok {
			t.Errorf("ParseSubject(%q) failed but TypeScript accepts it", tc.Subject)
			continue
		}
		got := goldenParsedSubject{
			Kind:      string(parsed.Kind),
			Family:    parsed.Family,
			Version:   parsed.Version,
			OrgID:     parsed.OrgID,
			CallID:    parsed.CallID,
			AORHash:   parsed.AORHash,
			QueueID:   parsed.QueueID,
			MailboxID: parsed.MailboxID,
			SessionID: parsed.SessionID,
			TrunkID:   parsed.TrunkID,
			Event:     parsed.Event,
			Service:   parsed.Service,
			Method:    parsed.Method,
		}
		if got != *tc.Parsed {
			t.Errorf("ParseSubject(%q) = %+v, golden %+v", tc.Subject, got, *tc.Parsed)
		}
	}
}

func TestParityMatchesSubject(t *testing.T) {
	for _, tc := range loadGolden(t).MatchesSubject {
		if got := MatchesSubject(tc.Filter, tc.Subject); got != tc.Matches {
			t.Errorf("MatchesSubject(%q, %q) = %v, golden %v", tc.Filter, tc.Subject, got, tc.Matches)
		}
	}
}

func TestParityKVKeys(t *testing.T) {
	for _, tc := range loadGolden(t).KVKeys {
		var got string
		var err error
		switch tc.Builder {
		case "registration":
			got, err = RegistrationKVKey(tc.Args[0], tc.Args[1])
		case "channel":
			got, err = ChannelKVKey(tc.Args[0], tc.Args[1], tc.Args[2])
		case "presence":
			got, err = PresenceKVKey(tc.Args[0], tc.Args[1])
		case "agentState":
			got, err = AgentStateKVKey(tc.Args[0], tc.Args[1])
		case "routingCache":
			got, err = RoutingCacheKVKey(tc.Args[0], tc.Args[1], tc.Args[2:]...)
		case "didIndex":
			got, err = DIDIndexKVKey(tc.Args[0])
		case "queueMembership":
			got, err = QueueMembershipKVKey(tc.Args[0], tc.Args[1])
		case "queueWaiting":
			got, err = QueueWaitingKVKey(tc.Args[0], tc.Args[1])
		case "mediaSession":
			got, err = MediaSessionKVKey(tc.Args[0])
		default:
			t.Fatalf("golden names KV key builder %q, which this package does not implement", tc.Builder)
		}
		if err != nil {
			t.Errorf("%s(%v): %v", tc.Builder, tc.Args, err)
			continue
		}
		if got != tc.Key {
			t.Errorf("%s(%v) = %q, golden %q", tc.Builder, tc.Args, got, tc.Key)
		}
	}
}

func TestParityStreams(t *testing.T) {
	g := loadGolden(t)
	if len(g.Streams) != len(EventStreams) {
		t.Fatalf("EventStreams has %d entries, golden %d", len(EventStreams), len(g.Streams))
	}
	for index, want := range g.Streams {
		got := EventStreams[index]
		if got.Name != want.Name {
			t.Fatalf("EventStreams[%d].Name = %q, golden %q (apply order is part of the contract)",
				index, got.Name, want.Name)
		}
		mirror := goldenStream{
			Name:              got.Name,
			Description:       got.Description,
			Subjects:          got.Subjects,
			Retention:         string(got.Retention),
			Storage:           string(got.Storage),
			Discard:           string(got.Discard),
			MaxAgeMs:          got.MaxAge.Milliseconds(),
			MaxMsgs:           got.MaxMsgs,
			MaxBytes:          got.MaxBytes,
			MaxMsgsPerSubject: got.MaxMsgsPerSubject,
			DuplicateWindowMs: got.DuplicateWindow.Milliseconds(),
			NumReplicas:       got.NumReplicas,
		}
		if !reflect.DeepEqual(mirror, want) {
			t.Errorf("stream %s = %+v, golden %+v", got.Name, mirror, want)
		}
	}
}

func TestParityKVBuckets(t *testing.T) {
	g := loadGolden(t)
	if len(g.KVBuckets) != len(KVBuckets) {
		t.Fatalf("KVBuckets has %d entries, golden %d", len(KVBuckets), len(g.KVBuckets))
	}
	for index, want := range g.KVBuckets {
		got := KVBuckets[index]
		mirror := goldenKVBucket{
			Name:              got.Name,
			Description:       got.Description,
			TTLMs:             got.TTL.Milliseconds(),
			History:           got.History,
			Storage:           string(got.Storage),
			MaxValueSizeBytes: got.MaxValueSize,
			MaxBytes:          got.MaxBytes,
			NumReplicas:       got.NumReplicas,
		}
		if !reflect.DeepEqual(mirror, want) {
			t.Errorf("bucket %s = %+v, golden %+v", got.Name, mirror, want)
		}
	}
}

func TestParityVocabularies(t *testing.T) {
	g := loadGolden(t)

	asStrings := func(values any) []string {
		v := reflect.ValueOf(values)
		out := make([]string, v.Len())
		for i := range out {
			out[i] = v.Index(i).String()
		}
		return out
	}

	named := map[string][]string{
		"LegSide":             asStrings(LegSideValues),
		"CallDirection":       asStrings(CallDirectionValues),
		"HangupSide":          asStrings(HangupSideValues),
		"BridgeMode":          asStrings(BridgeModeValues),
		"DTMFSource":          asStrings(DTMFSourceValues),
		"RecordingKind":       asStrings(RecordingKindValues),
		"RecordingStopReason": asStrings(RecordingStopReasonValues),
		"SIPTransport":        asStrings(SIPTransportValues),
		"AgentStatus":         asStrings(AgentStatusValues),
		"TapMode":             asStrings(TapModeValues),
		"TapEndReason":        asStrings(TapEndReasonValues),
	}
	if !reflect.DeepEqual(named, g.Vocabularies) {
		t.Errorf("telephony vocabularies = %v, golden %v", named, g.Vocabularies)
	}

	events := map[string][]string{
		"call":         EventTypesOfFamily(FamilyCall),
		"registration": EventTypesOfFamily(FamilyRegistration),
		"queue":        EventTypesOfFamily(FamilyQueue),
		"voicemail":    EventTypesOfFamily(FamilyVoicemail),
		"media":        EventTypesOfFamily(FamilyMedia),
		"trunk":        EventTypesOfFamily(FamilyTrunk),
	}
	if !reflect.DeepEqual(events, g.EventVocabularies) {
		t.Errorf("event vocabularies = %v, golden %v", events, g.EventVocabularies)
	}
}

func TestParityEventTypeRegistry(t *testing.T) {
	g := loadGolden(t)
	if len(g.EventTypes) != len(EventTypes) {
		t.Fatalf("EventTypes has %d entries, golden %d", len(EventTypes), len(g.EventTypes))
	}
	for index, want := range g.EventTypes {
		got := EventTypes[index]
		if string(got.Family) != want.Family || got.Type != want.Type {
			t.Errorf("EventTypes[%d] = %s/%s, golden %s/%s",
				index, got.Family, got.Type, want.Family, want.Type)
		}
		if NewDataFor(got.Type) == nil {
			t.Errorf("NewDataFor(%q) returned nil for a type in this contract version", got.Type)
		}
	}
}

// canonical re-encodes JSON through a generic value so key order stops mattering: Go marshals
// struct fields in declaration order and map keys in sorted order, TypeScript in insertion order.
//
// It also drops explicit nulls. Every nullable field in the contract is `.nullish()` — null and
// absent are the same statement ("there is no originating leg"), the TypeScript schema accepts
// both, and the cdr-db column they land in is nullable either way. Go models that as *T with
// omitempty, which necessarily writes "absent"; treating the two as distinct here would fail the
// comparison over a difference the contract says does not exist.
func canonical(t *testing.T, raw []byte) string {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("canonicalise: %v", err)
	}
	out, err := json.Marshal(dropNulls(value))
	if err != nil {
		t.Fatalf("canonicalise: %v", err)
	}
	return string(out)
}

func dropNulls(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		cleaned := make(map[string]any, len(typed))
		for key, member := range typed {
			if member == nil {
				continue
			}
			cleaned[key] = dropNulls(member)
		}
		return cleaned
	case []any:
		cleaned := make([]any, 0, len(typed))
		for _, member := range typed {
			cleaned = append(cleaned, dropNulls(member))
		}
		return cleaned
	default:
		return value
	}
}

// TestParityEventSamples is the shape half of the parity proof: every sample envelope built by the
// TypeScript makers is decoded into the generated Go structs and re-encoded. A field the emitter
// got wrong — a missing json tag, a value type where a pointer was needed, a dropped passthrough
// key — changes the bytes and fails here.
func TestParityEventSamples(t *testing.T) {
	g := loadGolden(t)
	if len(g.EventSamples) == 0 {
		t.Fatal("golden carries no event samples")
	}

	for _, sample := range g.EventSamples {
		t.Run(sample.Name, func(t *testing.T) {
			raw, err := UnmarshalRaw(sample.Envelope)
			if err != nil {
				t.Fatalf("decode envelope: %v", err)
			}
			if err := CheckSubject(raw.Subject, raw); err != nil {
				t.Fatalf("golden envelope fails its own subject cross-check: %v", err)
			}

			payload := NewDataFor(raw.Type)
			if payload == nil {
				t.Fatalf("NewDataFor(%q) is nil; the registry is missing an event type", raw.Type)
			}
			if err := json.Unmarshal(raw.Data, payload); err != nil {
				t.Fatalf("decode payload into %T: %v", payload, err)
			}
			reEncodedData, err := json.Marshal(payload)
			if err != nil {
				t.Fatalf("re-encode payload: %v", err)
			}
			if got, want := canonical(t, reEncodedData), canonical(t, raw.Data); got != want {
				t.Errorf("payload round-trip lost or invented fields:\n got %s\nwant %s", got, want)
			}

			// Whole-envelope round trip, which additionally pins the EventTime formatting.
			reEncodedEnvelope, err := Marshal(raw)
			if err != nil {
				t.Fatalf("re-encode envelope: %v", err)
			}
			if got, want := canonical(t, reEncodedEnvelope), canonical(t, sample.Envelope); got != want {
				t.Errorf("envelope round-trip differs:\n got %s\nwant %s", got, want)
			}
		})
	}
}

// TestParityRegistrationConstructors proves the Go constructors derive the same subject and the
// same data.aorHash as makeRegistrationEvent does, using the golden's own sample as the oracle.
func TestParityRegistrationConstructors(t *testing.T) {
	g := loadGolden(t)

	for _, sample := range g.EventSamples {
		if sample.Name != "registration.registered" {
			continue
		}
		want, err := Unmarshal[RegistrationRegisteredData](sample.Envelope)
		if err != nil {
			t.Fatalf("decode golden: %v", err)
		}

		// Deliberately pass a WRONG aorHash: the constructor must overwrite it from the AOR.
		data := want.Data
		data.AORHash = "deadbeefdeadbeefdeadbeefdeadbeef"

		got, err := NewRegistrationRegisteredEnvelope(EnvelopeInput[RegistrationRegisteredData]{
			OrgID:         want.OrgID,
			Source:        want.Source,
			ID:            want.ID,
			At:            want.At.Time,
			TraceID:       want.TraceID,
			CorrelationID: want.CorrelationID,
			Data:          data,
		})
		if err != nil {
			t.Fatalf("NewRegistrationRegisteredEnvelope: %v", err)
		}
		if got.Subject != want.Subject {
			t.Errorf("subject = %q, golden %q", got.Subject, want.Subject)
		}
		if got.Data.AORHash != want.Data.AORHash {
			t.Errorf("data.aorHash = %q, golden %q", got.Data.AORHash, want.Data.AORHash)
		}

		encoded, err := Marshal(got)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if canonical(t, encoded) != canonical(t, sample.Envelope) {
			t.Errorf("constructed envelope differs from the TypeScript one:\n got %s\nwant %s",
				canonical(t, encoded), canonical(t, sample.Envelope))
		}
		return
	}
	t.Fatal("golden carries no registration.registered sample")
}

func TestEventTimeMarshalsLikeToISOString(t *testing.T) {
	instant := time.Date(2026, 8, 5, 10, 0, 0, 0, time.UTC)
	encoded, err := json.Marshal(NewEventTime(instant))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != `"2026-08-05T10:00:00.000Z"` {
		t.Errorf("EventTime = %s, want the millisecond-precision shape Date.toISOString() emits", encoded)
	}

	// A non-UTC input must still serialise as UTC: the schema rejects offsets on purpose.
	offset := time.FixedZone("CEST", 2*60*60)
	encoded, err = json.Marshal(NewEventTime(time.Date(2026, 8, 5, 12, 0, 0, 0, offset)))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(encoded) != `"2026-08-05T10:00:00.000Z"` {
		t.Errorf("EventTime = %s, want the same instant normalised to UTC", encoded)
	}
}
