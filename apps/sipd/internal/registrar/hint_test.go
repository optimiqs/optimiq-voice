package registrar_test

import (
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// testContact is the binding every hint test registers; without a Contact a REGISTER is a query
// and stores nothing.
const testContact = "Contact: <sip:1001@203.0.113.9:5060>"

// The registrar is a kv.Hint: its expiry table lets a re-REGISTER CAS against the revision this
// process committed instead of reading it back first.

func TestLastKnownReturnsTheCommittedBinding(t *testing.T) {
	h := newHarness(t, nil)

	if _, found := h.registrar.LastKnown(testOrg, h.aorHash); found {
		t.Fatal("an AOR that has never registered must not produce a hint")
	}

	if response := h.register(testContact); response.StatusCode != 200 {
		t.Fatalf("REGISTER: want 200, got %d", response.StatusCode)
	}

	hint, found := h.registrar.LastKnown(testOrg, h.aorHash)
	if !found {
		t.Fatal("a granted binding must produce a hint")
	}
	stored, present, err := h.store.Get(t.Context(), testOrg, h.aorHash)
	if err != nil || !present {
		t.Fatalf("reading the stored binding: present=%v err=%v", present, err)
	}
	// A hint carrying the wrong revision costs every refresh a rejected CAS and a re-read, which is
	// worse than not hinting at all.
	if hint.Revision != stored.Revision {
		t.Fatalf("hint revision %d, stored revision %d", hint.Revision, stored.Revision)
	}
	if hint.AOR != stored.AOR || hint.OrgID != stored.OrgID {
		t.Fatalf("hint %+v does not describe the stored binding %+v", hint, stored)
	}
}

func TestLastKnownIsDroppedWhenTheBindingGoes(t *testing.T) {
	h := newHarness(t, nil)
	if response := h.register(testContact); response.StatusCode != 200 {
		t.Fatalf("REGISTER: want 200, got %d", response.StatusCode)
	}
	if response := h.register("Contact: *", "Expires: 0"); response.StatusCode != 200 {
		t.Fatalf("de-REGISTER: want 200, got %d", response.StatusCode)
	}
	if _, found := h.registrar.LastKnown(testOrg, h.aorHash); found {
		t.Fatal("a de-registered AOR must not keep producing a hint")
	}
}

func TestLastKnownRefusesAnUnbuildableKey(t *testing.T) {
	h := newHarness(t, nil)
	if _, err := contract.RegistrationKVKey("", h.aorHash); err == nil {
		t.Skip("an empty orgId is a legal key in this contract; nothing to assert")
	}
	if _, found := h.registrar.LastKnown("", h.aorHash); found {
		t.Fatal("a key that cannot be built must not produce a hint")
	}
}
