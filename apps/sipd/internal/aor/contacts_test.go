package aor

import (
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

var contactNow = time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC)

func testBinding() kv.Binding {
	return kv.Binding{
		OrgID:            "018f0000-0000-7000-8000-000000000000",
		AOR:              "sip:1001@acme.example.com",
		AORHash:          "aorhash",
		Transport:        contract.SIPTransportUDP,
		RegisteredAt:     contract.EventTime{Time: contactNow},
		ExpiresAt:        contract.EventTime{Time: contactNow.Add(5 * time.Minute)},
		ExpiresInSeconds: 300,
	}
}

func testContact(uri string, q float64, registeredAt time.Time) Contact {
	return Contact{
		URI:           uri,
		Transport:     "udp",
		SourceAddress: "203.0.113.7:5060",
		UserAgent:     "TestPhone/1.0",
		Instance:      "urn:uuid:" + uri,
		Q:             q,
		CallID:        "call-" + uri,
		CSeq:          7,
		RegisteredAt:  registeredAt,
		ExpiresAt:     registeredAt.Add(5 * time.Minute),
	}
}

// The whole backward-compatibility contract: the flat fields and contacts[0] are the same contact,
// written by one function so no code path can produce a value where they disagree. Every existing
// reader keeps working and sees the PREFERRED device rather than the only one.
func TestTheFlatFieldsAndTheFirstContactAreTheSameContact(t *testing.T) {
	set := NewSet([]Contact{
		testContact("sip:1001@192.0.2.10:5060", 0.5, contactNow),
		testContact("sip:1001@192.0.2.20:5060", 1.0, contactNow),
	}, contactNow)

	binding := ApplyToBinding(testBinding(), set)

	if len(binding.Contacts) != 2 {
		t.Fatalf("contacts = %d, want 2", len(binding.Contacts))
	}
	primary := binding.Contacts[0]
	if binding.Contact != primary.URI {
		t.Fatalf("flat contact %q != contacts[0] %q", binding.Contact, primary.URI)
	}
	if binding.SourceAddress != primary.SourceAddress {
		t.Fatalf("flat sourceAddress %q != contacts[0] %q", binding.SourceAddress, primary.SourceAddress)
	}
	if binding.Instance != primary.Instance {
		t.Fatalf("flat instance %q != contacts[0] %q", binding.Instance, primary.Instance)
	}
	if binding.CallID != primary.CallID || binding.CSeq != primary.CSeq {
		t.Fatal("the flat registration-dialog fields disagree with contacts[0]")
	}
	// And the primary is the highest-q contact, not merely the first one supplied.
	if primary.URI != "sip:1001@192.0.2.20:5060" {
		t.Fatalf("contacts[0] = %q, want the q=1.0 contact", primary.URI)
	}
}

// The array is written in PREFERENCE order, so the engine forks in the order it is handed and RFC
// 3261 §16.6's ordering is not something two processes each re-derive.
func TestTheArrayIsWrittenInPreferenceOrder(t *testing.T) {
	set := NewSet([]Contact{
		testContact("sip:c@10.0.0.3", 0.2, contactNow),
		testContact("sip:a@10.0.0.1", 1.0, contactNow),
		testContact("sip:b@10.0.0.2", 0.6, contactNow),
	}, contactNow)

	binding := ApplyToBinding(testBinding(), set)

	want := []string{"sip:a@10.0.0.1", "sip:b@10.0.0.2", "sip:c@10.0.0.3"}
	for index, uri := range want {
		if binding.Contacts[index].URI != uri {
			t.Fatalf("contacts[%d] = %q, want %q", index, binding.Contacts[index].URI, uri)
		}
	}
}

// A round trip must lose nothing that decides fork order or dialog matching. That is why kv.Contact
// carries q, regId, callId and cseq, which the Zod element does not name — the schema is `.loose()`
// precisely so a writer may.
func TestASetRoundTripsThroughABinding(t *testing.T) {
	original := NewSet([]Contact{
		testContact("sip:a@10.0.0.1", 1.0, contactNow),
		testContact("sip:b@10.0.0.2", 0.6, contactNow.Add(-time.Minute)),
	}, contactNow)

	restored := FromBinding(ApplyToBinding(testBinding(), original))

	if restored.Len() != original.Len() {
		t.Fatalf("round trip produced %d contacts, want %d", restored.Len(), original.Len())
	}
	for index, contact := range restored.Contacts() {
		want := original.Contacts()[index]
		switch {
		case contact.URI != want.URI:
			t.Fatalf("contact %d uri = %q, want %q", index, contact.URI, want.URI)
		case contact.Q != want.Q:
			t.Fatalf("contact %d q = %v, want %v", index, contact.Q, want.Q)
		case contact.CallID != want.CallID || contact.CSeq != want.CSeq:
			t.Fatalf("contact %d lost its registration dialog", index)
		case contact.Instance != want.Instance:
			t.Fatalf("contact %d lost its +sip.instance", index)
		case !contact.ExpiresAt.Equal(want.ExpiresAt):
			t.Fatalf("contact %d lost its deadline", index)
		}
	}
}

// A binding written before the array existed still yields a set. This is the compatibility path and
// it is what makes the change deployable in either deploy order.
func TestABindingWithNoArrayStillYieldsItsSingleContact(t *testing.T) {
	binding := testBinding()
	binding.Contact = "sip:1001@192.0.2.10:5060"
	binding.SourceAddress = "203.0.113.7:5060"
	binding.Instance = "urn:uuid:old"

	set := FromBinding(binding)

	if set.Len() != 1 {
		t.Fatalf("contacts = %d, want 1", set.Len())
	}
	primary, _ := set.Primary()
	if primary.URI != binding.Contact {
		t.Fatalf("uri = %q, want %q", primary.URI, binding.Contact)
	}
	if primary.Q != DefaultQ {
		t.Fatalf("q = %v, want the default %v", primary.Q, DefaultQ)
	}
}

// The array WINS when it is present and the flat fields are not merged on top. They are a copy of
// its head by construction, so merging would either change nothing or duplicate the primary into
// the fork set — and a duplicated contact is a phone that rings twice.
func TestTheArrayWinsAndTheFlatFieldsAreNotMergedIn(t *testing.T) {
	set := NewSet([]Contact{
		testContact("sip:a@10.0.0.1", 1.0, contactNow),
		testContact("sip:b@10.0.0.2", 0.6, contactNow),
	}, contactNow)
	binding := ApplyToBinding(testBinding(), set)
	// Corrupt the flat field, as a badly-behaved writer would.
	binding.Contact = "sip:stale@10.0.0.99"

	restored := FromBinding(binding)

	if restored.Len() != 2 {
		t.Fatalf("contacts = %d, want 2; the flat field was merged in", restored.Len())
	}
	for _, contact := range restored.Contacts() {
		if contact.URI == "sip:stale@10.0.0.99" {
			t.Fatal("the corrupt flat contact reached the fork set")
		}
	}
}

// An empty set clears both halves. A binding left with a stale `contact` and no array would be a
// phone the engine keeps dialling after it de-registered.
func TestAnEmptySetClearsBothHalves(t *testing.T) {
	binding := ApplyToBinding(testBinding(), Set{})

	if binding.Contact != "" {
		t.Fatalf("flat contact = %q, want it cleared", binding.Contact)
	}
	if binding.Contacts != nil {
		t.Fatalf("contacts = %v, want nil", binding.Contacts)
	}
}

// `registrationBindingSchema.contacts` is capped at ten and a value that exceeded it would be
// REFUSED by every TypeScript reader — the whole value, not the eleventh contact. So a registrar
// that wrote eleven would take an AOR offline rather than lose one device.
func TestTheStoredArrayIsCappedAtTheSchemaBound(t *testing.T) {
	contacts := make([]Contact, 0, MaxStoredContacts+3)
	for index := 0; index < MaxStoredContacts+3; index++ {
		contacts = append(contacts,
			testContact("sip:1001@10.0.0."+string(rune('a'+index)), 1.0, contactNow))
	}
	binding := ApplyToBinding(testBinding(), NewSet(contacts, contactNow))

	if len(binding.Contacts) != MaxStoredContacts {
		t.Fatalf("stored %d contacts, want the schema bound of %d",
			len(binding.Contacts), MaxStoredContacts)
	}
	if binding.Contact == "" {
		t.Fatal("the flat contact was cleared by the cap")
	}
}

// A contact recorded without a transport inherits the binding's. The element schema REQUIRES one
// and closes the vocabulary, so an empty string would make the whole value unparseable.
func TestAContactWithNoTransportInheritsTheBindings(t *testing.T) {
	contact := testContact("sip:1001@10.0.0.1", 1.0, contactNow)
	contact.Transport = ""
	binding := ApplyToBinding(testBinding(), NewSet([]Contact{contact}, contactNow))

	if binding.Contacts[0].Transport != contract.SIPTransportUDP {
		t.Fatalf("transport = %q, want the binding's udp", binding.Contacts[0].Transport)
	}
}
