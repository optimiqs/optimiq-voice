package transfer_test

import (
	"errors"
	"strings"
	"testing"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/transfer"
)

// REFER parsing, driven from wire text rather than from hand-built structs.
//
// The point is that these are the bytes a Yealink, a Polycom or a Linphone actually puts on the
// socket — including the ones that spell things differently — so a parser that only works against
// the shapes this repository invented is caught here rather than in a support ticket.

func parseRefer(t *testing.T, lines ...string) (transfer.Refer, error) {
	t.Helper()
	return transfer.ParseRefer(buildRefer(t, lines...))
}

func buildRefer(t *testing.T, extra ...string) *sip.Request {
	t.Helper()

	lines := []string{
		"REFER sip:1001@acme.example.com SIP/2.0",
		"Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK99;rport",
		"Max-Forwards: 70",
		"From: <sip:1001@acme.example.com>;tag=fromtag",
		"To: <sip:+15551230000@acme.example.com>;tag=totag",
		"Call-ID: 3c26700c1adf-6qgy0fkn7cvb",
		"CSeq: 7 REFER",
		"Contact: <sip:1001@203.0.113.9:5060>",
		"User-Agent: Yealink SIP-T46U 108.86.0.40",
	}
	lines = append(lines, extra...)
	lines = append(lines, "Content-Length: 0", "", "")

	message, err := sip.NewParser().ParseSIP([]byte(strings.Join(lines, "\r\n")))
	if err != nil {
		t.Fatalf("building the REFER: %v", err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		t.Fatalf("parsed a %T, want a request", message)
	}
	req.SetTransport("UDP")
	req.SetSource("203.0.113.9:5060")
	return req
}

func TestParseReferBlind(t *testing.T) {
	refer, err := parseRefer(t, "Refer-To: <sip:1002@acme.example.com>")
	if err != nil {
		t.Fatalf("ParseRefer: %v", err)
	}

	if refer.Target.User != "1002" {
		t.Errorf("target user = %q, want 1002", refer.Target.User)
	}
	if refer.Target.Host != "acme.example.com" {
		t.Errorf("target host = %q, want acme.example.com", refer.Target.Host)
	}
	if refer.Attended() {
		t.Error("a Refer-To with no Replaces is a BLIND transfer")
	}
	// The dialog triple travels verbatim: the edge asserts nothing about it, the engine resolves it.
	if refer.CallID != "3c26700c1adf-6qgy0fkn7cvb" {
		t.Errorf("call id = %q", refer.CallID)
	}
	if refer.FromTag != "fromtag" || refer.ToTag != "totag" {
		t.Errorf("tags = %q/%q, want fromtag/totag", refer.FromTag, refer.ToTag)
	}
	// RFC 3515 §2.4.4 keys the implicit subscription on the REFER's CSeq.
	if refer.CSeq != 7 {
		t.Errorf("cseq = %d, want 7", refer.CSeq)
	}
}

func TestParseReferLowercasesTheTargetHostOnly(t *testing.T) {
	// The host is case-insensitive (RFC 3261 §19.1.4); the user part is NOT, and lower-casing it
	// would turn extension "Sales" into a destination the dial plan has never heard of.
	refer, err := parseRefer(t, "Refer-To: <sip:Sales@ACME.Example.COM>")
	if err != nil {
		t.Fatalf("ParseRefer: %v", err)
	}
	if refer.Target.User != "Sales" {
		t.Errorf("target user = %q, want Sales", refer.Target.User)
	}
	if refer.Target.Host != "acme.example.com" {
		t.Errorf("target host = %q, want acme.example.com", refer.Target.Host)
	}
}

func TestParseReferAcceptsABareAddrSpec(t *testing.T) {
	// Legal per RFC 3261 §20 when the value has no parameters, and some handsets send it.
	refer, err := parseRefer(t, "Refer-To: sip:1002@acme.example.com")
	if err != nil {
		t.Fatalf("ParseRefer: %v", err)
	}
	if refer.Target.User != "1002" {
		t.Errorf("target user = %q, want 1002", refer.Target.User)
	}
}

func TestParseReferAcceptsTheCompactForm(t *testing.T) {
	refer, err := parseRefer(t, "r: <sip:1002@acme.example.com>")
	if err != nil {
		t.Fatalf("ParseRefer: %v", err)
	}
	if refer.Target.User != "1002" {
		t.Errorf("target user = %q, want 1002", refer.Target.User)
	}
}

func TestParseReferAttended(t *testing.T) {
	refer, err := parseRefer(t,
		"Refer-To: <sip:1002@acme.example.com?Replaces=aa11%40203.0.113.9%3Bto-tag%3Db2%3Bfrom-tag%3Dc3>")
	if err != nil {
		t.Fatalf("ParseRefer: %v", err)
	}

	if !refer.Attended() {
		t.Fatal("a Refer-To carrying Replaces is an ATTENDED transfer")
	}
	if refer.Replaces.CallID != "aa11@203.0.113.9" {
		t.Errorf("replaces call id = %q", refer.Replaces.CallID)
	}
	if refer.Replaces.ToTag != "b2" || refer.Replaces.FromTag != "c3" {
		t.Errorf("replaces tags = %q/%q, want b2/c3", refer.Replaces.ToTag, refer.Replaces.FromTag)
	}
	if refer.Replaces.EarlyOnly {
		t.Error("early-only was not present and must not be inferred")
	}
	// The Replaces is carried as its own field, so it must not also be embedded in the URI.
	if strings.Contains(strings.ToLower(refer.Target.URI), "replaces") {
		t.Errorf("target uri still carries the Replaces: %q", refer.Target.URI)
	}
}

func TestParseReferAttendedIsFoundWhateverTheCase(t *testing.T) {
	// Handsets are not consistent about this, and a missed Replaces silently downgrades an attended
	// transfer to a blind one — which drops the consultation leg the user is talking to.
	refer, err := parseRefer(t,
		"Refer-To: <sip:1002@acme.example.com?replaces=aa11%3Bto-tag%3Db2%3Bfrom-tag%3Dc3%3Bearly-only>")
	if err != nil {
		t.Fatalf("ParseRefer: %v", err)
	}
	if !refer.Attended() {
		t.Fatal("a lower-case `replaces` is the same header")
	}
	if !refer.Replaces.EarlyOnly {
		t.Error("early-only was present and must be carried")
	}
}

func TestParseReferRejections(t *testing.T) {
	cases := []struct {
		name   string
		header string
		want   error
	}{
		{"no Refer-To at all", "", transfer.ErrNoReferTo},
		{"an empty Refer-To", "Refer-To: ", transfer.ErrNoReferTo},
		{"a scheme this edge will not dial", "Refer-To: <tel:+15551230000>", transfer.ErrUnsupportedReferTo},
		{"a target with no user part", "Refer-To: <sip:acme.example.com>", transfer.ErrUnsupportedReferTo},
		{
			"a Replaces with no to-tag",
			"Refer-To: <sip:1002@acme.example.com?Replaces=aa11%3Bfrom-tag%3Dc3>",
			transfer.ErrMalformedReplaces,
		},
		{
			"a Replaces with no from-tag",
			"Refer-To: <sip:1002@acme.example.com?Replaces=aa11%3Bto-tag%3Db2>",
			transfer.ErrMalformedReplaces,
		},
		{
			"a Replaces with no call-id",
			"Refer-To: <sip:1002@acme.example.com?Replaces=%3Bto-tag%3Db2%3Bfrom-tag%3Dc3>",
			transfer.ErrMalformedReplaces,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var extra []string
			if tc.header != "" {
				extra = append(extra, tc.header)
			}
			if _, err := parseRefer(t, extra...); !errors.Is(err, tc.want) {
				t.Errorf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestParseReferRejectsAnUnparsableTarget(t *testing.T) {
	// sipgo's message parser rejects most malformed Refer-To values before a handler ever sees them,
	// so this one is injected as a generic header. The branch still has to exist: the parser's
	// tolerance is not a contract, and a value it starts accepting must not reach the engine unread.
	req := buildRefer(t)
	req.AppendHeader(sip.NewHeader("Refer-To", "not an address at all"))

	if _, err := transfer.ParseRefer(req); !errors.Is(err, transfer.ErrMalformedReferTo) {
		t.Errorf("error = %v, want %v", err, transfer.ErrMalformedReferTo)
	}
}

func TestParseReplacesTolerantOfQuotesAndSpacing(t *testing.T) {
	replaces, err := transfer.ParseReplaces("aa11%40host%3B%20to-tag%3D%22b2%22%3B%20from-tag%3Dc3")
	if err != nil {
		t.Fatalf("ParseReplaces: %v", err)
	}
	if replaces.ToTag != "b2" || replaces.FromTag != "c3" {
		t.Errorf("tags = %q/%q, want b2/c3", replaces.ToTag, replaces.FromTag)
	}
}
