package events_test

import (
	"testing"

	events "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	trunkTestOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	trunkTestTrunk = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b57"
)

func TestNewTrunkStatusChangedEnvelopeDerivesItsSubject(t *testing.T) {
	t.Parallel()

	envelope, err := events.NewTrunkStatusChangedEnvelope(trunkTestTrunk, events.EnvelopeInput[events.TrunkStatusChangedData]{
		OrgID:  trunkTestOrg,
		Source: "sipd",
		Data:   events.TrunkStatusChangedData{Status: events.TrunkStatusChangedStatusUp},
	})
	if err != nil {
		t.Fatalf("NewTrunkStatusChangedEnvelope: %v", err)
	}

	want := "trunk.evt.v1." + trunkTestOrg + "." + trunkTestTrunk + ".status.changed"
	if envelope.Subject != want {
		t.Errorf("Subject = %q; want %q", envelope.Subject, want)
	}
	if envelope.Type != events.EventTypeTrunkStatusChanged {
		t.Errorf("Type = %q; want %q", envelope.Type, events.EventTypeTrunkStatusChanged)
	}
	if envelope.OrgID != trunkTestOrg {
		t.Errorf("OrgID = %q; want %q", envelope.OrgID, trunkTestOrg)
	}
	// A caller that supplied neither gets both, which is what makes this constructor usable from a
	// FSM transition that has no opinion about ids or clocks.
	if envelope.ID == "" {
		t.Error("ID is empty; the constructor should default it to a UUID v7")
	}
	if envelope.At.IsZero() {
		t.Error("At is zero; the constructor should default it to now")
	}
}

// A bad org or trunk id is an ERROR and never a subject with a mangled token in it.
//
// The publish path is a trunk FSM transition, so the alternative to failing here is a message on a
// subject no consumer filters for — a trunk that silently stops reporting its health, which is the
// one thing this event exists to prevent.
func TestNewTrunkStatusChangedEnvelopeRejectsBadTokens(t *testing.T) {
	t.Parallel()

	for name, input := range map[string]struct{ org, trunk string }{
		"empty org":      {"", trunkTestTrunk},
		"empty trunk":    {trunkTestOrg, ""},
		"dotted org":     {"org.with.dots", trunkTestTrunk},
		"wildcard trunk": {trunkTestOrg, "*"},
		"whitespace org": {"has space", trunkTestTrunk},
		"chevron trunk":  {trunkTestOrg, ">"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			if _, err := events.NewTrunkStatusChangedEnvelope(input.trunk, events.EnvelopeInput[events.TrunkStatusChangedData]{
				OrgID: input.org,
				Data:  events.TrunkStatusChangedData{Status: events.TrunkStatusChangedStatusDown},
			}); err == nil {
				t.Fatal("expected an error; got none")
			}
		})
	}
}
