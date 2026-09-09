package subscribe

import (
	"encoding/xml"
	"strconv"
	"strings"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/mwi"
)

// Content types, per RFC 4235 §4 and RFC 3842 §5.
const (
	dialogInfoContentType     = "application/dialog-info+xml"
	messageSummaryContentType = "application/simple-message-summary"
)

// dialogInfoNamespace is the XML namespace RFC 4235 §4.1 registers. Phones match on it; a body in
// no namespace is dropped by several of them.
const dialogInfoNamespace = "urn:ietf:params:xml:ns:dialog-info"

// The RFC 4235 §3.7.1 dialog states this edge emits, and the only ones. `trying` and `proceeding`
// are absent: the presence bucket aggregates a device's channels rather than one INVITE's progress,
// and a BLF key renders them identically to `early`.
const (
	dialogStateEarly      = "early"
	dialogStateConfirmed  = "confirmed"
	dialogStateTerminated = "terminated"
)

// dialogStateFor maps a device state onto the dialog state a busy-lamp key renders.
//
// The mapping is lossy in one place: `held` becomes `confirmed`, like `active`. A BLF key has three
// renderings, so RFC 4235's richer `<local>`/`sendonly` form would change no lamp and is parsed
// badly by several phones.
//
// The second result reports whether a `<dialog>` element should be emitted at all: its ABSENCE, not
// a state value, is what clears a lamp (RFC 4235 §3.7).
func dialogStateFor(state contract.PresenceDeviceState) (string, bool) {
	switch state {
	case contract.PresenceDeviceStateRinging:
		return dialogStateEarly, true
	case contract.PresenceDeviceStateActive,
		contract.PresenceDeviceStateActiveMulti,
		contract.PresenceDeviceStateHeld,
		contract.PresenceDeviceStateUnheld:
		return dialogStateConfirmed, true
	case contract.PresenceDeviceStateHangup:
		return dialogStateTerminated, true
	default:
		// `down`, and anything a future engine writes that this build does not know. Dark is the safe
		// direction: a lamp stuck lit on a free extension stops a receptionist transferring a call.
		return "", false
	}
}

// dialogInfoDocument is the marshalled shape of RFC 4235's `<dialog-info>`.
//
// Marshalled with encoding/xml rather than assembled with fmt: `entity` and the dialog `id` carry
// wire-supplied values, and concatenation there is how `"` or `<` becomes an injected element.
type dialogInfoDocument struct {
	XMLName xml.Name `xml:"dialog-info"`
	Xmlns   string   `xml:"xmlns,attr"`
	// Version increments per subscription, never per resource. RFC 4235 §3.3: a watcher discards a
	// notification whose version is not greater than the last one it processed, which is what makes
	// two NOTIFYs reordered on UDP settle on the newer state rather than the later-arriving one.
	Version int `xml:"version,attr"`
	// State is `full` on every notification: this edge reports one aggregate dialog, so a partial
	// would be no smaller and would oblige the phone to hold a merge buffer.
	State  string            `xml:"state,attr"`
	Entity string            `xml:"entity,attr"`
	Dialog *dialogInfoDialog `xml:"dialog,omitempty"`
}

type dialogInfoDialog struct {
	// ID identifies the dialog within the resource. This edge reports an aggregate, so there is
	// exactly one and its id is the extension number — stable, so updates are not read as new calls.
	ID    string `xml:"id,attr"`
	State string `xml:"state"`
}

// dialogInfoBody renders the notification body for one `dialog` subscription.
//
// `entity` is the AOR of the watched extension, echoed from the SUBSCRIBE's Request-URI so a phone
// with several BLF keys can tell which one moved.
func dialogInfoBody(entity, extensionNumber string, state contract.PresenceDeviceState, version int) ([]byte, error) {
	document := dialogInfoDocument{
		Xmlns:   dialogInfoNamespace,
		Version: version,
		State:   "full",
		Entity:  entity,
	}
	if dialogState, present := dialogStateFor(state); present {
		document.Dialog = &dialogInfoDialog{ID: extensionNumber, State: dialogState}
	}

	encoded, err := xml.Marshal(document)
	if err != nil {
		return nil, err
	}
	// The declaration is not optional in practice: several handsets reject a dialog-info body that
	// does not open with one.
	return append([]byte(xml.Header), encoded...), nil
}

// messageSummaryBody renders the notification body for one `message-summary` subscription
// (RFC 3842 §6).
//
// The format is a header block, not XML, and the line endings are CRLF: it is parsed by the same
// header parser the phone already has, and a body with bare LFs is silently ignored by several of
// them.
//
//	Messages-Waiting: yes
//	Message-Account: sip:1001@acme.example.com
//	Voice-Message: 2/8 (0/0)
//
// The parenthesised pair is the urgent counts, emitted as `(0/0)` rather than omitted: the contract
// has no urgent voicemail, and several handsets reject the whole line without the pair.
func messageSummaryBody(account string, counts mwi.Counts) []byte {
	waiting := "no"
	if counts.Waiting() {
		waiting = "yes"
	}
	var builder strings.Builder
	builder.WriteString("Messages-Waiting: ")
	builder.WriteString(waiting)
	builder.WriteString("\r\n")
	if account != "" {
		builder.WriteString("Message-Account: ")
		builder.WriteString(account)
		builder.WriteString("\r\n")
	}
	builder.WriteString("Voice-Message: ")
	builder.WriteString(strconv.Itoa(max(counts.New, 0)))
	builder.WriteString("/")
	builder.WriteString(strconv.Itoa(max(counts.Saved, 0)))
	builder.WriteString(" (0/0)\r\n")
	return []byte(builder.String())
}
