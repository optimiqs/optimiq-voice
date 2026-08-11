// Package transfer implements SIP REFER at the edge: the desk phone's TRANSFER key.
//
// # Why this lives in the SIP edge and not in the call engine
//
// The engine already transfers calls. What it cannot do is HEAR a phone ask, because a REFER is
// signalling and signalling terminates here — the engine is in the media path, not the SIP path. So
// the edge parses the REFER, decides whether the phone is allowed to send it, and asks the engine
// over `rpc.sip.v1.transfer`. Nothing about transfer semantics is decided in this package; it
// decides only who may ask, and reports the answer back to the phone per RFC 3515.
//
// # What is deliberately NOT here
//
// A dialog layer. `apps/sipd` is a registrar: it has no INVITE path, holds no call state and is not
// a B2BUA, so it cannot check that the `Call-ID` on a REFER names a dialog it is part of — there are
// no dialogs it is part of. See the doc comment on Handler for what it checks instead, and why that
// is a real boundary rather than a weaker version of one.
package transfer

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/emiago/sipgo/sip"
)

// Parse failures, distinguished so the handler can map them to statuses and the tests can assert the
// reason rather than the number.
var (
	// ErrNoReferTo means the REFER carried no Refer-To header at all. RFC 3515 §2.4.1 makes it
	// mandatory, so this is a malformed request rather than a request for something unsupported.
	ErrNoReferTo = errors.New("transfer: the REFER carried no Refer-To header")
	// ErrMalformedReferTo means the header would not parse as a name-addr or addr-spec.
	ErrMalformedReferTo = errors.New("transfer: the Refer-To header is malformed")
	// ErrUnsupportedReferTo means it parsed but names something this edge will not act on: a
	// non-SIP scheme, or a URI with no user part to dial.
	ErrUnsupportedReferTo = errors.New("transfer: the Refer-To target is not dialable")
	// ErrMalformedReplaces means the Replaces parameter was present and unparsable. Refused rather
	// than ignored: ignoring it would silently turn an attended transfer into a blind one, dropping
	// the consultation the user is talking to.
	ErrMalformedReplaces = errors.New("transfer: the Replaces parameter is malformed")
)

// Target is the Refer-To URI, taken apart.
//
// User is what the engine dials, because a dial plan consumes a destination string and not a URI.
// Host and URI come along for the log and for the day a REFER to a foreign domain has to be refused
// explicitly rather than quietly dialled as a local extension.
type Target struct {
	User string
	Host string
	// URI is the target verbatim, WITHOUT the Replaces header — that is carried separately, and
	// leaving it embedded here would put the same fact on the wire twice in two encodings.
	URI string
}

// Replaces is a parsed RFC 3891 Replaces parameter: the dialog an attended transfer completes into.
type Replaces struct {
	CallID    string
	ToTag     string
	FromTag   string
	EarlyOnly bool
}

// Refer is everything this edge can learn from one REFER.
//
// The dialog identifiers are recorded VERBATIM and asserted to be nothing: a `Call-ID` is a string
// the phone chose, and this process is not in the dialog it names. They are a lookup key for the
// engine and never an authorisation — see Handler.
type Refer struct {
	// CallID, FromTag and ToTag are the dialog triple of the call being transferred (RFC 3261 §12),
	// as they appear on the REFER. FromTag is therefore the transferor's.
	CallID  string
	FromTag string
	ToTag   string
	// CSeq is the REFER's sequence number. RFC 3515 §2.4.4 keys the implicit subscription's
	// `Event: refer;id=<cseq>` on exactly this, so the NOTIFY cannot be built without it.
	CSeq     uint32
	Target   Target
	Replaces *Replaces
}

// Attended reports whether the phone completed a consultation itself and is asking for the two
// dialogs to be joined. A REFER is attended exactly when it carries a Replaces (RFC 5589 §7).
func (r Refer) Attended() bool { return r.Replaces != nil }

// ParseRefer extracts the transfer request from a REFER.
//
// It does no authorisation and reads no state; it is a pure function of the message, which is what
// makes every branch below testable from wire text.
func ParseRefer(req *sip.Request) (Refer, error) {
	header := req.GetHeader("Refer-To")
	if header == nil {
		// Some phones spell it with the RFC 3515 compact form.
		header = req.GetHeader("r")
	}
	if header == nil || strings.TrimSpace(header.Value()) == "" {
		return Refer{}, ErrNoReferTo
	}

	var uri sip.Uri
	params := sip.NewParams()
	if _, err := sip.ParseAddressValue(strings.TrimSpace(header.Value()), &uri, &params); err != nil {
		return Refer{}, fmt.Errorf("%w: %w", ErrMalformedReferTo, err)
	}

	switch strings.ToLower(uri.Scheme) {
	case "", "sip", "sips":
	default:
		// `tel:` and friends are legitimate SIP but mean "resolve this somewhere else first". An
		// edge that dialled the user part of a URI scheme it does not understand would be guessing.
		return Refer{}, fmt.Errorf("%w: scheme %q", ErrUnsupportedReferTo, uri.Scheme)
	}
	// An EMPTY Refer-To reaches here as an empty URI rather than as a missing header: sipgo's parser
	// normalises `Refer-To:` into the typed header `<sip:>`. It is a malformed request and must be
	// answered 400, not the 501 that a well-formed but undialable target gets — hence the two errors.
	if strings.TrimSpace(uri.User) == "" && strings.TrimSpace(uri.Host) == "" {
		return Refer{}, ErrNoReferTo
	}
	if strings.TrimSpace(uri.User) == "" {
		return Refer{}, fmt.Errorf("%w: no user part", ErrUnsupportedReferTo)
	}

	refer := Refer{
		CallID:  headerValue(req, "Call-ID"),
		FromTag: tagOf(req.From()),
		ToTag:   tagOfTo(req.To()),
		CSeq:    cseqOf(req),
		Target: Target{
			User: uri.User,
			Host: strings.ToLower(uri.Host),
		},
	}

	// The Replaces travels as a URI HEADER inside the Refer-To (`…?Replaces=…`), escaped, not as a
	// header on the REFER itself. Strip it before rendering the target so the two do not overlap.
	raw, hasReplaces := replacesParam(&uri)
	uri.Headers = nil
	refer.Target.URI = uri.String()

	if hasReplaces {
		replaces, err := ParseReplaces(raw)
		if err != nil {
			return Refer{}, err
		}
		refer.Replaces = &replaces
	}
	return refer, nil
}

// replacesParam pulls the `Replaces` URI header out of a Refer-To, case-insensitively.
//
// sipgo keeps URI header names as written, and phones are not consistent about the capitalisation,
// so a map lookup on the exact string finds the header on some handsets and not on others — and
// "not found" here silently downgrades an attended transfer to a blind one.
func replacesParam(uri *sip.Uri) (string, bool) {
	if uri.Headers == nil {
		return "", false
	}
	for _, name := range uri.Headers.Keys() {
		if !strings.EqualFold(name, "Replaces") {
			continue
		}
		value, _ := uri.Headers.Get(name)
		return value, true
	}
	return "", false
}

// ParseReplaces parses an escaped RFC 3891 Replaces value:
//
//	<call-id>;to-tag=<tag>;from-tag=<tag>[;early-only]
//
// Both tags are REQUIRED by RFC 3891 §3. A Replaces missing one of them does not identify a dialog,
// and accepting it would ask the engine to guess which of two half-matches to tear down.
func ParseReplaces(escaped string) (Replaces, error) {
	value, err := url.QueryUnescape(escaped)
	if err != nil {
		return Replaces{}, fmt.Errorf("%w: %w", ErrMalformedReplaces, err)
	}

	parts := strings.Split(value, ";")
	replaces := Replaces{CallID: strings.TrimSpace(parts[0])}
	if replaces.CallID == "" {
		return Replaces{}, fmt.Errorf("%w: no call-id", ErrMalformedReplaces)
	}

	for _, part := range parts[1:] {
		name, raw, found := strings.Cut(strings.TrimSpace(part), "=")
		name = strings.ToLower(strings.TrimSpace(name))
		raw = strings.Trim(strings.TrimSpace(raw), `"`)
		switch {
		case name == "to-tag" && found:
			replaces.ToTag = raw
		case name == "from-tag" && found:
			replaces.FromTag = raw
		case name == "early-only":
			replaces.EarlyOnly = true
		}
	}

	if replaces.ToTag == "" || replaces.FromTag == "" {
		return Replaces{}, fmt.Errorf("%w: to-tag and from-tag are both required", ErrMalformedReplaces)
	}
	return replaces, nil
}

// ---------------------------------------------------------------------------------------------
// message helpers
// ---------------------------------------------------------------------------------------------

func headerValue(req *sip.Request, name string) string {
	header := req.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}

func tagOf(from *sip.FromHeader) string {
	if from == nil {
		return ""
	}
	tag, _ := from.Params.Get("tag")
	return tag
}

func tagOfTo(to *sip.ToHeader) string {
	if to == nil {
		return ""
	}
	tag, _ := to.Params.Get("tag")
	return tag
}

func cseqOf(req *sip.Request) uint32 {
	if header := req.CSeq(); header != nil {
		return header.SeqNo
	}
	return 0
}

// addressOfRecord renders the AOR of a SIP address in the one spelling the registrar binds: scheme,
// user, and a LOWER-CASED host (RFC 3261 §19.1.4 makes the host case-insensitive). Anything else
// hashes to a different KV key and would report a registered phone as unregistered.
func addressOfRecord(uri sip.Uri) (aor string, user string, ok bool) {
	if uri.User == "" || uri.Host == "" {
		return "", "", false
	}
	scheme := uri.Scheme
	if scheme == "" {
		scheme = "sip"
	}
	return scheme + ":" + uri.User + "@" + strings.ToLower(uri.Host), uri.User, true
}
