package aor

import (
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

var now = time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC)

func contact(uri string, q float64, registeredAgo time.Duration, expiresIn time.Duration) Contact {
	return Contact{
		URI:          uri,
		Q:            q,
		RegisteredAt: now.Add(-registeredAgo),
		ExpiresAt:    now.Add(expiresIn),
	}
}

func urisOf(contacts []Contact) []string {
	uris := make([]string, 0, len(contacts))
	for _, candidate := range contacts {
		uris = append(uris, candidate.URI)
	}
	return uris
}

func assertOrder(t *testing.T, got []Contact, want ...string) {
	t.Helper()
	uris := urisOf(got)
	if len(uris) != len(want) {
		t.Fatalf("contacts = %v, want %v", uris, want)
	}
	for index := range want {
		if uris[index] != want[index] {
			t.Fatalf("contacts = %v, want %v", uris, want)
		}
	}
}

// RFC 3261 §16.6: decreasing q. The two tie-breaks after it are ours, and the last one exists so
// the order is deterministic rather than flaky.
func TestPreferenceOrder(t *testing.T) {
	set := NewSet([]Contact{
		contact("sip:mobile@10.0.0.3", 0.2, time.Minute, time.Hour),
		contact("sip:desk@10.0.0.1", 1.0, time.Hour, time.Hour),
		contact("sip:soft@10.0.0.2", 1.0, time.Minute, time.Hour),
		contact("sip:aaa@10.0.0.4", 1.0, time.Minute, time.Hour),
	}, now)

	assertOrder(t, set.Contacts(),
		// Same q and same instant: the URI breaks the tie, deterministically.
		"sip:aaa@10.0.0.4", "sip:soft@10.0.0.2",
		// Same q, registered longer ago.
		"sip:desk@10.0.0.1",
		// Lower q, last.
		"sip:mobile@10.0.0.3")

	primary, found := set.Primary()
	if !found || primary.URI != "sip:aaa@10.0.0.4" {
		t.Errorf("primary = %+v, want the head of the list", primary)
	}
	if _, found := (Set{}).Primary(); found {
		t.Error("an empty set has no primary")
	}
}

// A contact that states no q outranks one that explicitly lowered itself: saying nothing is not the
// same as asking to be second.
func TestUnqualifiedContactsOutrankLoweredOnes(t *testing.T) {
	set := NewSet([]Contact{
		contact("sip:lowered@10.0.0.1", 0.5, 0, time.Hour),
		contact("sip:silent@10.0.0.2", 0, 0, time.Hour),
	}, now)
	assertOrder(t, set.Contacts(), "sip:silent@10.0.0.2", "sip:lowered@10.0.0.1")
}

// Equal q may be tried in PARALLEL and different q must be tried in SEQUENCE. A flat list loses
// that, and the engine would either ring the backup phone on every call or take four times as long.
func TestGroupsPartitionByPreference(t *testing.T) {
	set := NewSet([]Contact{
		contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour),
		contact("sip:soft@10.0.0.2", 1.0, 0, time.Hour),
		contact("sip:mobile@10.0.0.3", 0.5, 0, time.Hour),
		contact("sip:last@10.0.0.4", 0.1, 0, time.Hour),
	}, now)

	groups := set.Groups()
	if len(groups) != 3 {
		t.Fatalf("groups = %d, want 3", len(groups))
	}
	if len(groups[0]) != 2 {
		t.Errorf("the first group has %d contacts, want the two equal-q ones", len(groups[0]))
	}
	if len(groups[1]) != 1 || groups[1][0].URI != "sip:mobile@10.0.0.3" {
		t.Errorf("the second group = %v", urisOf(groups[1]))
	}
	if len(groups[2]) != 1 || groups[2][0].URI != "sip:last@10.0.0.4" {
		t.Errorf("the third group = %v", urisOf(groups[2]))
	}
	if len((Set{}).Groups()) != 0 {
		t.Error("an empty set has no groups")
	}
}

// RFC 5626 §5.4: a device behind NAT gets a new port on every reboot, so its Contact URI changes
// while the DEVICE has not. Matching on the URI alone accumulates dead contacts for one phone.
func TestContactKeyPrefersTheInstance(t *testing.T) {
	first := Contact{URI: "sip:desk@10.0.0.1:5060", Instance: "urn:uuid:abc", RegID: 1}
	rebooted := Contact{URI: "sip:desk@10.0.0.1:41231", Instance: "urn:uuid:abc", RegID: 1}
	otherFlow := Contact{URI: "sip:desk@10.0.0.1:5060", Instance: "urn:uuid:abc", RegID: 2}
	anonymous := Contact{URI: "sip:desk@10.0.0.1:5060"}

	if first.Key() != rebooted.Key() {
		t.Error("a reboot must match the same binding")
	}
	if first.Key() == otherFlow.Key() {
		t.Error("two flows of one device (RFC 5626 reg-id) are two live bindings")
	}
	if anonymous.Key() != "sip:desk@10.0.0.1:5060" {
		t.Errorf("a device with no instance keys on its URI, got %q", anonymous.Key())
	}
}

func TestBind(t *testing.T) {
	t.Run("a refresh replaces rather than adds, and keeps the original instant", func(t *testing.T) {
		original := contact("sip:desk@10.0.0.1", 1.0, time.Hour, time.Minute)
		set := NewSet([]Contact{original}, now)

		refreshed := contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour)
		outcome := set.Bind(refreshed, 5, now)
		if !outcome.Replaced || outcome.Set.Len() != 1 {
			t.Fatalf("outcome = %+v, want a replacement", outcome)
		}
		got, _ := outcome.Set.Primary()
		if !got.RegisteredAt.Equal(original.RegisteredAt) {
			t.Error("a refresh extends a binding; it does not create one")
		}
		if !got.ExpiresAt.Equal(refreshed.ExpiresAt) {
			t.Error("a refresh must move the deadline")
		}
	})

	t.Run("a second device is added", func(t *testing.T) {
		set := NewSet([]Contact{contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour)}, now)
		outcome := set.Bind(contact("sip:soft@10.0.0.2", 1.0, 0, time.Hour), 5, now)
		if outcome.Replaced || outcome.Set.Len() != 2 || outcome.Evicted != nil {
			t.Fatalf("outcome = %+v, want a second contact", outcome)
		}
	})

	t.Run("the cap evicts the least preferred rather than refusing the newcomer", func(t *testing.T) {
		set := NewSet([]Contact{
			contact("sip:desk@10.0.0.1", 1.0, time.Minute, time.Hour),
			contact("sip:old@10.0.0.2", 0.2, time.Minute, time.Hour),
		}, now)

		outcome := set.Bind(contact("sip:new@10.0.0.3", 1.0, 0, time.Hour), 2, now)
		if outcome.Refused {
			t.Fatal("the phone somebody just plugged in must work")
		}
		if outcome.Evicted == nil || outcome.Evicted.URI != "sip:old@10.0.0.2" {
			t.Fatalf("evicted = %+v, want the least preferred", outcome.Evicted)
		}
		assertOrder(t, outcome.Set.Contacts(), "sip:new@10.0.0.3", "sip:desk@10.0.0.1")
	})

	t.Run("a newcomer that every existing contact outranks is refused", func(t *testing.T) {
		set := NewSet([]Contact{
			contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour),
			contact("sip:soft@10.0.0.2", 1.0, 0, time.Hour),
		}, now)

		outcome := set.Bind(contact("sip:backup@10.0.0.3", 0.1, 0, time.Hour), 2, now)
		if !outcome.Refused {
			t.Fatal("evicting a preferred device for one that asked to be last inverts the q-value")
		}
		if outcome.Set.Len() != 2 {
			t.Errorf("a refused bind must change nothing, got %d contacts", outcome.Set.Len())
		}
	})

	t.Run("a refresh is never refused, whatever the cap", func(t *testing.T) {
		existing := contact("sip:desk@10.0.0.1", 1.0, time.Hour, time.Minute)
		set := NewSet([]Contact{existing, contact("sip:soft@10.0.0.2", 1.0, 0, time.Hour)}, now)

		outcome := set.Bind(contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour), 1, now)
		if outcome.Refused || !outcome.Replaced {
			t.Error("lowering the cap must not drop a working phone on its next refresh")
		}
	})

	t.Run("a lapsed contact frees its slot", func(t *testing.T) {
		set := NewSet([]Contact{
			contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour),
			contact("sip:dead@10.0.0.2", 1.0, 0, -time.Minute),
		}, now)
		if set.Len() != 1 {
			t.Fatalf("NewSet kept %d contacts, want the lapsed one dropped", set.Len())
		}
		outcome := set.Bind(contact("sip:new@10.0.0.3", 1.0, 0, time.Hour), 2, now)
		if outcome.Evicted != nil || outcome.Set.Len() != 2 {
			t.Errorf("outcome = %+v, want the lapsed slot reused with no eviction", outcome)
		}
	})

	t.Run("zero means uncapped", func(t *testing.T) {
		set := Set{}
		for index := 0; index < 20; index++ {
			outcome := set.Bind(contact("sip:x"+string(rune('a'+index))+"@10.0.0.1", 1.0, 0, time.Hour), 0, now)
			if outcome.Refused {
				t.Fatalf("bind %d was refused with no cap", index)
			}
			set = outcome.Set
		}
		if set.Len() != 20 {
			t.Errorf("Len = %d, want 20", set.Len())
		}
	})
}

func TestUnbindAndClear(t *testing.T) {
	set := NewSet([]Contact{
		contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour),
		contact("sip:soft@10.0.0.2", 1.0, 0, time.Hour),
	}, now)

	after, removed := set.Unbind("sip:desk@10.0.0.1", now)
	if !removed || after.Len() != 1 {
		t.Fatalf("Unbind removed=%v len=%d", removed, after.Len())
	}
	if _, removed := after.Unbind("sip:desk@10.0.0.1", now); removed {
		t.Error("removing an absent contact must report false")
	}
	if set.Clear().Len() != 0 {
		t.Error("Contact:* with Expires:0 drops everything")
	}
}

// One `expired` event per DEVICE, which is what a presence consumer needs; one per AOR would say a
// user went offline when one of their three phones did.
func TestExpireReportsEachLapsedContact(t *testing.T) {
	set := NewSet([]Contact{
		contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour),
		contact("sip:soft@10.0.0.2", 1.0, 0, time.Hour),
	}, now)
	// NewSet already dropped anything lapsed, so build the lapsed state explicitly.
	set = Set{contacts: []Contact{
		contact("sip:desk@10.0.0.1", 1.0, 0, time.Hour),
		contact("sip:soft@10.0.0.2", 1.0, 0, -time.Minute),
		contact("sip:mobile@10.0.0.3", 0.5, 0, -time.Hour),
	}}

	live, lapsed := set.Expire(now)
	if live.Len() != 1 {
		t.Errorf("live = %d, want 1", live.Len())
	}
	if len(lapsed) != 2 {
		t.Fatalf("lapsed = %d, want 2", len(lapsed))
	}
	assertOrder(t, lapsed, "sip:soft@10.0.0.2", "sip:mobile@10.0.0.3")
}

// A value outside the RFC's range is treated as ABSENT rather than clamped: a device that sent
// `q=5` is one whose parameter we do not understand, and clamping would promote it above every
// correctly-behaved contact.
func TestParseQ(t *testing.T) {
	header := func(params ...string) *sip.ContactHeader {
		contactHeader := &sip.ContactHeader{Params: sip.NewParams()}
		for index := 0; index+1 < len(params); index += 2 {
			contactHeader.Params.Add(params[index], params[index+1])
		}
		return contactHeader
	}

	cases := []struct {
		name   string
		header *sip.ContactHeader
		want   float64
	}{
		{"absent is the default", header(), DefaultQ},
		{"a stated preference", header("q", "0.5"), 0.5},
		{"exactly one", header("q", "1.0"), 1.0},
		{"zero is legal and orders last", header("q", "0"), 0.001},
		{"above the range is treated as absent", header("q", "5"), DefaultQ},
		{"below the range is treated as absent", header("q", "-1"), DefaultQ},
		{"nonsense is treated as absent", header("q", "high"), DefaultQ},
		{"a nil header", nil, DefaultQ},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseQ(tc.header); got != tc.want {
				t.Errorf("ParseQ = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestParseRegIDAndInstance(t *testing.T) {
	header := &sip.ContactHeader{Params: sip.NewParams()}
	header.Params.Add("reg-id", "2")
	header.Params.Add("+sip.instance", `"<urn:uuid:0c2fd66b>"`)

	if got := ParseRegID(header); got != 2 {
		t.Errorf("ParseRegID = %d, want 2", got)
	}
	if got := ParseInstance(header); got != "urn:uuid:0c2fd66b" {
		t.Errorf("ParseInstance = %q, want the URN with its quoting stripped", got)
	}

	empty := &sip.ContactHeader{Params: sip.NewParams()}
	if ParseRegID(empty) != 0 || ParseInstance(empty) != "" {
		t.Error("absent parameters must be zero values")
	}
	if ParseRegID(nil) != 0 || ParseInstance(nil) != "" {
		t.Error("a nil header must be safe")
	}

	bad := &sip.ContactHeader{Params: sip.NewParams()}
	bad.Params.Add("reg-id", "-3")
	if ParseRegID(bad) != 0 {
		t.Error("a negative reg-id is not a flow identifier")
	}
}

// The compatibility path: a reader that finds no contacts array still gets a set, and the flat
// fields keep pointing at the preferred device.
func TestBindingRoundTrip(t *testing.T) {
	binding := kv.Binding{
		OrgID:            "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
		AOR:              "sip:1001@acme.example.com",
		AORHash:          "hash",
		Contact:          "sip:1001@10.0.0.1:5060",
		Transport:        contract.SIPTransportUDP,
		SourceAddress:    "203.0.113.7:41234",
		UserAgent:        "Yealink",
		Instance:         "urn:uuid:abc",
		RegisteredAt:     contract.NewEventTime(now.Add(-time.Hour)),
		ExpiresAt:        contract.NewEventTime(now.Add(time.Hour)),
		ExpiresInSeconds: 3600,
	}

	set := FromBinding(binding)
	if set.Len() != 1 {
		t.Fatalf("FromBinding produced %d contacts, want 1", set.Len())
	}
	lifted, _ := set.Primary()
	if lifted.URI != binding.Contact || lifted.SourceAddress != binding.SourceAddress {
		t.Errorf("lifted = %+v, want the binding's fields", lifted)
	}

	// A second device registers, and the flat fields follow the PREFERRED one.
	outcome := set.Bind(Contact{
		URI:           "sip:1001@10.0.0.2:5060",
		SourceAddress: "203.0.113.8:5060",
		Q:             1.0,
		RegisteredAt:  now,
		ExpiresAt:     now.Add(time.Hour),
	}, 5, now)

	updated := ApplyToBinding(binding, outcome.Set)
	if updated.Contact != "sip:1001@10.0.0.2:5060" {
		t.Errorf("contact = %q, want the newly preferred device", updated.Contact)
	}
	if updated.SourceAddress != "203.0.113.8:5060" {
		t.Errorf("sourceAddress = %q, want the preferred device's", updated.SourceAddress)
	}
	// The fields an older reader depends on are still there and still describe a real device.
	if updated.OrgID != binding.OrgID || updated.AOR != binding.AOR {
		t.Error("the identity fields must survive untouched")
	}

	if empty := ApplyToBinding(binding, Set{}); empty.Contact != "" {
		t.Error("an AOR with no contacts must not claim one")
	}
	if FromBinding(kv.Binding{}).Len() != 0 {
		t.Error("a binding with no contact lifts to an empty set")
	}
}
