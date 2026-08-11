package mwi

import (
	"log/slog"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	testOrg     = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testMailbox = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b52"
)

// envelopeFor builds the wire message apps/api's VoicemailMwiPublisher would put on the bus, through
// the SAME contract helpers it uses — so a change to the envelope shape breaks this test rather than
// producing a lamp that silently stops moving.
func envelopeFor(t *testing.T, orgID string, data contract.VoicemailMWIUpdatedData) *nats.Msg {
	t.Helper()

	subject, err := contract.VoicemailSubject(orgID, testMailbox, contract.EventTypeVoicemailMWIUpdated)
	if err != nil {
		t.Fatalf("VoicemailSubject: %v", err)
	}
	envelope := contract.NewEnvelope(contract.EventTypeVoicemailMWIUpdated,
		contract.EnvelopeInput[contract.VoicemailMWIUpdatedData]{
			OrgID:   orgID,
			Subject: subject,
			Source:  "api",
			At:      time.Date(2026, 8, 11, 10, 0, 0, 0, time.UTC),
			Data:    data,
		})
	payload, err := contract.Marshal(envelope)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	return &nats.Msg{Subject: subject, Data: payload}
}

func newSource(t *testing.T) *NATSSource {
	t.Helper()
	// The decoder is exercised directly; the connection is never dialled.
	return &NATSSource{conn: &nats.Conn{}, log: slog.New(slog.DiscardHandler), latest: map[string]Update{}}
}

func TestSubjectMatchesOnlyTheCountEvent(t *testing.T) {
	// `mwi.updated` is a DOTTED event name, so the subject has six tokens. A `>` after the org would
	// also match `message.left`, which is the engine's event about a recording and says nothing about
	// a count.
	if Subject != "voicemail.evt.v1.*.*.mwi.updated" {
		t.Fatalf("Subject = %q", Subject)
	}
	left, err := contract.VoicemailSubject(testOrg, testMailbox, contract.EventTypeVoicemailMessageLeft)
	if err != nil {
		t.Fatalf("VoicemailSubject: %v", err)
	}
	if contract.MatchesSubject(Subject, left) {
		t.Errorf("%q matches the filter, so a recording would be decoded as a count", left)
	}
	updated, err := contract.VoicemailSubject(testOrg, testMailbox, contract.EventTypeVoicemailMWIUpdated)
	if err != nil {
		t.Fatalf("VoicemailSubject: %v", err)
	}
	if !contract.MatchesSubject(Subject, updated) {
		t.Errorf("%q does not match the filter", updated)
	}
}

func TestDecodeReadsTheCountsAndRemembersThem(t *testing.T) {
	source := newSource(t)
	extension := "1001"

	update, ok := source.decode(envelopeFor(t, testOrg, contract.VoicemailMWIUpdatedData{
		MailboxNumber:   "1001",
		ExtensionNumber: &extension,
		NewCount:        2,
		SavedCount:      8,
	}))
	if !ok {
		t.Fatal("a well-formed event was dropped")
	}
	if update.OrgID != testOrg || update.Mailbox != "1001" || update.Extension != "1001" {
		t.Fatalf("decoded as %#v", update)
	}
	if update.Counts != (Counts{New: 2, Saved: 8}) {
		t.Errorf("counts = %#v", update.Counts)
	}

	source.remember(update)
	// The cache is what makes the immediate NOTIFY on a fresh subscription true: the event that
	// established the counts may be hours old, and without it a phone with nine messages is told it
	// has none.
	if counts, found := source.Last(testOrg, "1001"); !found || counts.New != 2 {
		t.Errorf("Last = (%#v, %v)", counts, found)
	}
	if _, found := source.Last("another-org", "1001"); found {
		t.Error("the cache is not scoped by tenant")
	}
}

// The same check the publisher side runs. An envelope whose orgId is not the org in its subject
// would let this edge attribute a tenant's message counts to another tenant's phones — the one
// mistake in this package that is not merely a wrong lamp.
func TestDecodeRefusesAnEnvelopeThatDisagreesWithItsSubject(t *testing.T) {
	source := newSource(t)

	msg := envelopeFor(t, testOrg, contract.VoicemailMWIUpdatedData{MailboxNumber: "1001", NewCount: 1})
	// Deliver it on ANOTHER tenant's subject, which is what a forged or misrouted publish looks like.
	other, err := contract.VoicemailSubject(
		"018f4f5e-1c2a-7a3b-9c4d-5e6f70819294", testMailbox, contract.EventTypeVoicemailMWIUpdated)
	if err != nil {
		t.Fatalf("VoicemailSubject: %v", err)
	}
	msg.Subject = other

	if _, ok := source.decode(msg); ok {
		t.Error("an envelope that disagrees with its delivery subject was accepted")
	}
}

func TestDecodeDropsUnparsableAndEmptyEvents(t *testing.T) {
	source := newSource(t)

	if _, ok := source.decode(&nats.Msg{Subject: Subject, Data: []byte("{not json")}); ok {
		t.Error("an unparsable event was accepted")
	}
	if _, ok := source.decode(envelopeFor(t, testOrg, contract.VoicemailMWIUpdatedData{})); ok {
		t.Error("an event naming no mailbox and no extension was accepted")
	}
}

// apps/api leaves `extensionNumber` unset today, so the fallback to the mailbox number is the ONLY
// thing that makes MWI match a SIP account. It is a documented approximation, and this pins it.
func TestMatchesAccount(t *testing.T) {
	cases := []struct {
		name   string
		update Update
		user   string
		want   bool
	}{
		{"extension wins when present",
			Update{OrgID: testOrg, Mailbox: "8001", Extension: "1001"}, "1001", true},
		{"and excludes the mailbox number when it does",
			Update{OrgID: testOrg, Mailbox: "8001", Extension: "1001"}, "8001", false},
		{"the mailbox number is the fallback",
			Update{OrgID: testOrg, Mailbox: "1001"}, "1001", true},
		{"another account is not matched",
			Update{OrgID: testOrg, Mailbox: "1001"}, "1002", false},
		{"another tenant is never matched",
			Update{OrgID: "other", Mailbox: "1001"}, "1001", false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := testCase.update.MatchesAccount(testOrg, testCase.user); got != testCase.want {
				t.Errorf("MatchesAccount(%q) = %v, want %v", testCase.user, got, testCase.want)
			}
		})
	}
}

// Saved messages do not light a lamp. RFC 3842's `Messages-Waiting` is about the `new` folder, and a
// phone lit by an archive is one nobody can ever clear.
func TestOnlyUnreadMessagesLightTheLamp(t *testing.T) {
	if (Counts{Saved: 12}).Waiting() {
		t.Error("saved messages lit the lamp")
	}
	if !(Counts{New: 1}).Waiting() {
		t.Error("an unread message did not light the lamp")
	}
}

func TestMemorySourceRoundTrips(t *testing.T) {
	source := NewMemorySource()
	updates, err := source.Updates(t.Context())
	if err != nil {
		t.Fatalf("Updates: %v", err)
	}

	source.Publish(Update{OrgID: testOrg, Mailbox: "1001", Counts: Counts{New: 3}})
	if update := <-updates; update.Counts.New != 3 {
		t.Errorf("the update arrived as %#v", update)
	}
	if counts, found := source.Last(testOrg, "1001"); !found || counts.New != 3 {
		t.Errorf("Last = (%#v, %v)", counts, found)
	}
}
