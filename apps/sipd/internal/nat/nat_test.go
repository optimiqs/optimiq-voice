package nat

import (
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
)

func contact(host string, port int) sip.Uri {
	return sip.Uri{Scheme: "sip", User: "1001", Host: host, Port: port}
}

// The Contact ALWAYS stays the Request-URI; what the policy changes is the destination — which is a
// transport concern and is exactly where a NAT lives.
func TestTargetFor(t *testing.T) {
	cases := []struct {
		name            string
		mode            Mode
		contact         sip.Uri
		observed        string
		wantRewritten   bool
		wantDestination string
		wantReason      string
	}{
		{
			name:       "auto keeps a Contact that matches the source",
			mode:       ModeAuto,
			contact:    contact("203.0.113.7", 5060),
			observed:   "203.0.113.7:5060",
			wantReason: "same-address",
		},
		{
			name:            "auto rewrites when the host differs",
			mode:            ModeAuto,
			contact:         contact("192.168.1.42", 5060),
			observed:        "203.0.113.7:5060",
			wantRewritten:   true,
			wantDestination: "203.0.113.7:5060",
			wantReason:      "nat-detected",
		},
		{
			name:            "auto rewrites when only the PORT differs: a symmetric NAT",
			mode:            ModeAuto,
			contact:         contact("203.0.113.7", 5060),
			observed:        "203.0.113.7:41234",
			wantRewritten:   true,
			wantDestination: "203.0.113.7:41234",
			wantReason:      "nat-detected",
		},
		{
			name:       "a Contact with no port compares against 5060",
			mode:       ModeAuto,
			contact:    contact("203.0.113.7", 0),
			observed:   "203.0.113.7:5060",
			wantReason: "same-address",
		},
		{
			name:            "always rewrites even when the addresses agree",
			mode:            ModeAlways,
			contact:         contact("203.0.113.7", 5060),
			observed:        "203.0.113.7:5060",
			wantRewritten:   true,
			wantDestination: "203.0.113.7:5060",
			wantReason:      "policy-always",
		},
		{
			name:       "never trusts the Contact absolutely",
			mode:       ModeNever,
			contact:    contact("192.168.1.42", 5060),
			observed:   "203.0.113.7:5060",
			wantReason: "policy-never",
		},
		{
			name:       "no observed address means nothing to rewrite to",
			mode:       ModeAuto,
			contact:    contact("192.168.1.42", 5060),
			observed:   "",
			wantReason: "no-observed",
		},
		{
			name:       "always with no observed address cannot rewrite either",
			mode:       ModeAlways,
			contact:    contact("192.168.1.42", 5060),
			observed:   "",
			wantReason: "no-observed",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			decision := Policy{ContactRewrite: tc.mode}.TargetFor(tc.contact, tc.observed)
			if decision.Target.Host != tc.contact.Host {
				t.Errorf("the Request-URI changed to %q; it must always stay the Contact", decision.Target.Host)
			}
			if decision.Rewritten != tc.wantRewritten {
				t.Errorf("rewritten = %v, want %v", decision.Rewritten, tc.wantRewritten)
			}
			if decision.Destination != tc.wantDestination {
				t.Errorf("destination = %q, want %q", decision.Destination, tc.wantDestination)
			}
			if decision.Reason != tc.wantReason {
				t.Errorf("reason = %q, want %q", decision.Reason, tc.wantReason)
			}
		})
	}
}

func TestSameEndpointAndNeedsRewrite(t *testing.T) {
	cases := []struct {
		name     string
		contact  sip.Uri
		observed string
		same     bool
	}{
		{"identical", contact("203.0.113.7", 5060), "203.0.113.7:5060", true},
		{"case-insensitive host", sip.Uri{Host: "Phone.Example.Com", Port: 5060}, "phone.example.com:5060", true},
		{"different port", contact("203.0.113.7", 5060), "203.0.113.7:5061", false},
		{"different host", contact("192.168.1.1", 5060), "203.0.113.7:5060", false},
		{"an observed value with no port defaults to 5060", contact("203.0.113.7", 5060), "203.0.113.7", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SameEndpoint(tc.contact, tc.observed); got != tc.same {
				t.Errorf("SameEndpoint = %v, want %v", got, tc.same)
			}
			if got := NeedsRewrite(tc.contact, tc.observed); got == tc.same {
				t.Errorf("NeedsRewrite = %v, want %v", got, !tc.same)
			}
		})
	}
	if NeedsRewrite(contact("192.168.1.1", 5060), "") {
		t.Error("with no observed address there is no evidence of a NAT")
	}
}

// RFC 3581: `received` is added whenever the source host differs, and `rport` ONLY when the sender
// asked for it — some stacks reject a response whose Via grew a parameter they did not offer.
func TestFixVia(t *testing.T) {
	via := func(host string, rport bool) *sip.ViaHeader {
		header := &sip.ViaHeader{Host: host, Port: 5060, Params: sip.NewParams()}
		if rport {
			header.Params.Add("rport", "")
		}
		return header
	}

	t.Run("a source that differs adds received", func(t *testing.T) {
		fix := Policy{TrustRPort: true}.FixVia(via("192.168.1.42", false), "203.0.113.7:41234")
		if fix.Received != "203.0.113.7" || !fix.Applied {
			t.Errorf("fix = %+v, want received to be added", fix)
		}
		if fix.RPort != 0 {
			t.Error("rport must not be added when the sender did not ask")
		}
	})

	t.Run("a requested rport is honoured and gives a symmetric destination", func(t *testing.T) {
		fix := Policy{TrustRPort: true}.FixVia(via("192.168.1.42", true), "203.0.113.7:41234")
		if fix.RPort != 41234 || fix.SymmetricDestination != "203.0.113.7:41234" {
			t.Errorf("fix = %+v, want the source port echoed back", fix)
		}
	})

	t.Run("a profile that does not trust rport declines it", func(t *testing.T) {
		fix := Policy{TrustRPort: false}.FixVia(via("192.168.1.42", true), "203.0.113.7:41234")
		if fix.RPort != 0 || fix.SymmetricDestination != "" {
			t.Errorf("fix = %+v, want rport declined", fix)
		}
		if fix.Received != "203.0.113.7" {
			t.Error("received is required by RFC 3261 §18.2.1 regardless of rport")
		}
	})

	t.Run("a matching host needs no received", func(t *testing.T) {
		fix := Policy{TrustRPort: true}.FixVia(via("203.0.113.7", false), "203.0.113.7:5060")
		if fix.Applied {
			t.Errorf("fix = %+v, want nothing applied", fix)
		}
	})

	t.Run("no via and no source are both no-ops", func(t *testing.T) {
		bare := Policy{}
		if bare.FixVia(nil, "203.0.113.7:5060").Applied {
			t.Error("a nil Via cannot be fixed")
		}
		if bare.FixVia(via("x", true), "").Applied {
			t.Error("with no observed source there is nothing to write")
		}
	})
}

// Address only. Never a codec, never a payload type — reading more would put a media decision in
// the signalling plane.
func TestConnectionAddress(t *testing.T) {
	cases := []struct {
		name string
		sdp  string
		want string
	}{
		{"session level only", "v=0\r\nc=IN IP4 192.168.1.42\r\nm=audio 40000 RTP/AVP 0\r\n", "192.168.1.42"},
		{
			name: "the media level wins",
			sdp:  "v=0\r\nc=IN IP4 192.168.1.42\r\nm=audio 40000 RTP/AVP 0\r\nc=IN IP4 203.0.113.7\r\n",
			want: "203.0.113.7",
		},
		{"a multicast TTL suffix is stripped", "v=0\r\nc=IN IP4 224.2.1.1/127\r\n", "224.2.1.1"},
		{"IPv6", "v=0\r\nc=IN IP6 2001:db8::1\r\n", "2001:db8::1"},
		{"no connection line at all", "v=0\r\nm=audio 40000 RTP/AVP 0\r\n", ""},
		{"a malformed connection line is skipped", "v=0\r\nc=IN\r\n", ""},
		{"an empty body", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConnectionAddress([]byte(tc.sdp)); got != tc.want {
				t.Errorf("ConnectionAddress = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestIsPrivate(t *testing.T) {
	cases := map[string]bool{
		"10.0.0.1":     true,
		"192.168.1.42": true,
		"172.16.0.1":   true,
		"127.0.0.1":    true,
		"169.254.1.1":  true,
		"fd00::1":      true,
		"203.0.113.7":  false,
		"8.8.8.8":      false,
		// A hostname is not resolved: a DNS lookup on the INVITE path for a guess is worse than
		// answering "we do not know".
		"phone.example.com": false,
		"":                  false,
	}
	for address, want := range cases {
		t.Run(address, func(t *testing.T) {
			if got := IsPrivate(address); got != want {
				t.Errorf("IsPrivate(%q) = %v, want %v", address, got, want)
			}
		})
	}
}

// The hint is evidence for mediad's latch, and the private-address case is proof rather than
// suspicion: no packet from 192.168.x.x reached us over the internet.
func TestHintFor(t *testing.T) {
	behindNAT := HintFor(
		[]byte("v=0\r\nc=IN IP4 192.168.1.42\r\nm=audio 40000 RTP/AVP 0\r\n"),
		"203.0.113.7:41234")
	if !behindNAT.Mismatch || !behindNAT.Private {
		t.Errorf("hint = %+v, want a mismatch on a private address", behindNAT)
	}
	if behindNAT.AdvertisedMedia != "192.168.1.42" || behindNAT.SignallingSource != "203.0.113.7:41234" {
		t.Errorf("hint = %+v, want both addresses recorded", behindNAT)
	}

	onNet := HintFor([]byte("v=0\r\nc=IN IP4 203.0.113.7\r\n"), "203.0.113.7:5060")
	if onNet.Mismatch || onNet.Private {
		t.Errorf("hint = %+v, want no mismatch", onNet)
	}

	noBody := HintFor(nil, "203.0.113.7:5060")
	if noBody.Mismatch || noBody.AdvertisedMedia != "" {
		t.Errorf("hint = %+v, want nothing claimed about a body that is not there", noBody)
	}
}

// A device behind a consumer router granted an hour loses its pinhole in a minute and is
// unreachable for fifty-nine while both ends believe it is registered.
func TestRegistrationIntervalClamp(t *testing.T) {
	internal := DefaultInternalPolicy()
	if got := internal.RegistrationInterval(3600 * time.Second); got != 300*time.Second {
		t.Errorf("granted = %s, want the profile's clamp of 300s", got)
	}
	if got := internal.RegistrationInterval(120 * time.Second); got != 120*time.Second {
		t.Errorf("granted = %s, want the request honoured when it is already short enough", got)
	}
	external := DefaultExternalPolicy()
	if got := external.RegistrationInterval(3600 * time.Second); got != 3600*time.Second {
		t.Errorf("granted = %s, want no clamp on a carrier profile", got)
	}
}

func TestKeepaliveDue(t *testing.T) {
	now := time.Date(2026, 8, 12, 9, 0, 0, 0, time.UTC)
	policy := DefaultInternalPolicy()

	if policy.KeepaliveDue(now.Add(-10*time.Second), now) {
		t.Error("a binding touched ten seconds ago is not due on a thirty-second interval")
	}
	if !policy.KeepaliveDue(now.Add(-30*time.Second), now) {
		t.Error("exactly the interval is due")
	}
	crlf := Policy{KeepaliveMethod: KeepaliveCRLF, KeepaliveInterval: time.Second}
	if crlf.KeepaliveDue(now.Add(-time.Hour), now) {
		t.Error("CRLF keepalive is the device's job; this edge originates nothing")
	}
	none := Policy{KeepaliveMethod: KeepaliveNone}
	if none.KeepaliveDue(now.Add(-time.Hour), now) {
		t.Error("a profile with no keepalive method must never be due")
	}
}

func TestPolicyVocabularies(t *testing.T) {
	for _, mode := range []Mode{ModeAuto, ModeAlways, ModeNever} {
		if !mode.Valid() {
			t.Errorf("%q must be valid", mode)
		}
	}
	if Mode("sometimes").Valid() {
		t.Error("an invented rewrite mode must not be valid")
	}
	for _, method := range []KeepaliveMethod{KeepaliveNone, KeepaliveCRLF, KeepaliveOptions} {
		if !method.Valid() {
			t.Errorf("%q must be valid", method)
		}
	}
	if KeepaliveMethod("ping").Valid() {
		t.Error("an invented keepalive method must not be valid")
	}
	if DefaultExternalPolicy().ContactRewrite != ModeAlways {
		t.Error("a carrier's Contact is frequently an internal SBC address; the external default rewrites")
	}
	if DefaultInternalPolicy().ContactRewrite != ModeAuto {
		t.Error("a device profile rewrites on evidence rather than by default")
	}
}
