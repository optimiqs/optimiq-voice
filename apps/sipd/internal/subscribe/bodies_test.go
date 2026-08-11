package subscribe

import (
	"encoding/xml"
	"strings"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
)

// The notification bodies are the only part of this package a handset actually parses, and a phone
// that dislikes one does not complain — it leaves the lamp where it was. So the tests PARSE what the
// builders produce rather than string-matching it: an assertion that survives a whitespace change
// but fails on a wrong element is the one worth having.

// parsedDialogInfo is the reader's view of the document, deliberately declared apart from the
// writer's struct so a rename on one side fails here instead of passing vacuously.
type parsedDialogInfo struct {
	XMLName xml.Name `xml:"dialog-info"`
	Version int      `xml:"version,attr"`
	State   string   `xml:"state,attr"`
	Entity  string   `xml:"entity,attr"`
	Dialogs []struct {
		ID    string `xml:"id,attr"`
		State string `xml:"state"`
	} `xml:"dialog"`
}

func parseDialogInfo(t *testing.T, body []byte) parsedDialogInfo {
	t.Helper()
	if !strings.HasPrefix(string(body), "<?xml") {
		t.Fatalf("the body does not open with an XML declaration:\n%s", body)
	}
	var document parsedDialogInfo
	if err := xml.Unmarshal(body, &document); err != nil {
		t.Fatalf("parsing the dialog-info body: %v\n%s", err, body)
	}
	return document
}

func TestDialogInfoBodyRendersEveryDeviceState(t *testing.T) {
	const entity = "sip:1001@acme.example.com"

	cases := []struct {
		state     contract.PresenceDeviceState
		hasDialog bool
		dialog    string
	}{
		{contract.PresenceDeviceStateDown, false, ""},
		{contract.PresenceDeviceStateRinging, true, "early"},
		{contract.PresenceDeviceStateActive, true, "confirmed"},
		{contract.PresenceDeviceStateActiveMulti, true, "confirmed"},
		{contract.PresenceDeviceStateHeld, true, "confirmed"},
		{contract.PresenceDeviceStateUnheld, true, "confirmed"},
		{contract.PresenceDeviceStateHangup, true, "terminated"},
	}

	for _, testCase := range cases {
		body, err := dialogInfoBody(entity, "1001", testCase.state, 0)
		if err != nil {
			t.Fatalf("%s: %v", testCase.state, err)
		}
		document := parseDialogInfo(t, body)

		if document.XMLName.Space != dialogInfoNamespace {
			// Phones match on the namespace; a body in none is dropped by several of them.
			t.Errorf("%s: namespace = %q, want %q",
				testCase.state, document.XMLName.Space, dialogInfoNamespace)
		}
		if document.Entity != entity {
			t.Errorf("%s: entity = %q, want %q", testCase.state, document.Entity, entity)
		}
		if document.State != "full" {
			t.Errorf("%s: state = %q, want full", testCase.state, document.State)
		}
		if !testCase.hasDialog {
			if len(document.Dialogs) != 0 {
				t.Errorf("%s: got %d dialog elements, want none — the ABSENCE is what clears a lamp",
					testCase.state, len(document.Dialogs))
			}
			continue
		}
		if len(document.Dialogs) != 1 {
			t.Fatalf("%s: got %d dialog elements, want exactly one",
				testCase.state, len(document.Dialogs))
		}
		if document.Dialogs[0].State != testCase.dialog {
			t.Errorf("%s: dialog state = %q, want %q",
				testCase.state, document.Dialogs[0].State, testCase.dialog)
		}
		if document.Dialogs[0].ID != "1001" {
			t.Errorf("%s: dialog id = %q, want the extension number",
				testCase.state, document.Dialogs[0].ID)
		}
	}
}

// A state this build does not know must read as "no dialogs", never as a lit lamp: a dark key on a
// busy extension is a smaller lie than a lit key on a free one, because the second makes a
// receptionist not transfer a call.
func TestDialogInfoBodyTreatsAnUnknownStateAsIdle(t *testing.T) {
	body, err := dialogInfoBody("sip:1001@acme.example.com", "1001", "teleported", 3)
	if err != nil {
		t.Fatalf("dialogInfoBody: %v", err)
	}
	if document := parseDialogInfo(t, body); len(document.Dialogs) != 0 {
		t.Errorf("an unknown device state produced a dialog element: %s", body)
	}
}

func TestDialogInfoBodyCarriesTheVersionAWatcherOrdersOn(t *testing.T) {
	body, err := dialogInfoBody("sip:1001@acme.example.com", "1001", contract.PresenceDeviceStateActive, 7)
	if err != nil {
		t.Fatalf("dialogInfoBody: %v", err)
	}
	if document := parseDialogInfo(t, body); document.Version != 7 {
		t.Errorf("version = %d, want 7", document.Version)
	}
}

// The entity and the dialog id come off the wire. Concatenating them into XML is how a Request-URI
// containing a quote produces a malformed body — or, on a permissive parser, an injected element.
func TestDialogInfoBodyEscapesWireSuppliedText(t *testing.T) {
	body, err := dialogInfoBody(`sip:a"<b@acme.example.com`, `1<0"1`, contract.PresenceDeviceStateActive, 0)
	if err != nil {
		t.Fatalf("dialogInfoBody: %v", err)
	}
	if strings.Contains(string(body), `entity="sip:a"<b`) {
		t.Fatalf("the entity reached the wire unescaped:\n%s", body)
	}
	document := parseDialogInfo(t, body)
	if document.Entity != `sip:a"<b@acme.example.com` {
		t.Errorf("entity round-tripped as %q", document.Entity)
	}
	if len(document.Dialogs) != 1 || document.Dialogs[0].ID != `1<0"1` {
		t.Errorf("dialog id did not round-trip: %#v", document.Dialogs)
	}
}

// RFC 3842 §6 is a header block parsed by the phone's own header parser, so the line endings are
// load-bearing: several handsets ignore a body with bare LFs.
func TestMessageSummaryBody(t *testing.T) {
	cases := []struct {
		name    string
		counts  mwi.Counts
		waiting string
		voice   string
	}{
		{"no messages", mwi.Counts{}, "no", "0/0 (0/0)"},
		{"unread only", mwi.Counts{New: 2}, "yes", "2/0 (0/0)"},
		{"unread and saved", mwi.Counts{New: 2, Saved: 8}, "yes", "2/8 (0/0)"},
		{"saved only lights nothing", mwi.Counts{Saved: 8}, "no", "0/8 (0/0)"},
		// A negative count can only come from a corrupt event, and a phone shown `-1` renders
		// something arbitrary. Clamped rather than trusted.
		{"negative counts clamp", mwi.Counts{New: -1, Saved: -4}, "no", "0/0 (0/0)"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body := string(messageSummaryBody("sip:1001@acme.example.com", testCase.counts))
			if strings.Contains(strings.ReplaceAll(body, "\r\n", ""), "\n") {
				t.Fatalf("the body contains a bare LF:\n%q", body)
			}
			fields := map[string]string{}
			for _, line := range strings.Split(strings.TrimSuffix(body, "\r\n"), "\r\n") {
				name, value, found := strings.Cut(line, ": ")
				if !found {
					t.Fatalf("unparsable line %q in:\n%q", line, body)
				}
				fields[name] = value
			}
			if fields["Messages-Waiting"] != testCase.waiting {
				t.Errorf("Messages-Waiting = %q, want %q",
					fields["Messages-Waiting"], testCase.waiting)
			}
			if fields["Voice-Message"] != testCase.voice {
				t.Errorf("Voice-Message = %q, want %q", fields["Voice-Message"], testCase.voice)
			}
			if fields["Message-Account"] != "sip:1001@acme.example.com" {
				t.Errorf("Message-Account = %q", fields["Message-Account"])
			}
		})
	}
}
