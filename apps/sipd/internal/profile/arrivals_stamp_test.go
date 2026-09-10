package profile

import (
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
)

// optionsDatagram is a whole SIP request, which is what a UDP read hands the filter.
func optionsDatagram(extra ...string) []byte {
	message := "OPTIONS sip:probe@127.0.0.1 SIP/2.0\r\n" +
		"Via: SIP/2.0/UDP 127.0.0.1:40000;branch=z9hG4bKstamp\r\n" +
		"From: <sip:probe@127.0.0.1>;tag=probe\r\n" +
		"To: <sip:probe@127.0.0.1>\r\n" +
		"Call-ID: stamp\r\n" +
		"CSeq: 1 OPTIONS\r\n" +
		"Max-Forwards: 70\r\n" +
		strings.Join(extra, "") +
		"Content-Length: 0\r\n\r\n"
	return []byte(message)
}

func parseFiltered(t *testing.T, arrivals *Arrivals, local string, data []byte) *sip.Request {
	t.Helper()
	filter := arrivals.ReadFilter()
	filtered, err := filter(sip.TransportReadProps{
		Transport:  "udp",
		LocalAddr:  addr(local),
		RemoteAddr: addr("127.0.0.1:40000"),
	}, data)
	if err != nil {
		t.Fatalf("read filter: %v", err)
	}
	message, err := sip.NewParser().ParseSIP(filtered)
	if err != nil {
		t.Fatalf("parsing the filtered datagram: %v", err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		t.Fatalf("parsed %T, want a request", message)
	}
	req.SetTransport("udp")
	req.SetSource("127.0.0.1:40000")
	return req
}

// R07: provenance must belong to the MESSAGE. sipgo dispatches each parsed request to its own
// goroutine, so a second datagram from the same endpoint to another listener can be read and
// recorded before the first handler ever looks. Reading the two datagrams back to back and only
// then asking for the first one's profile is that interleaving, made deterministic.
func TestArrivalsCarryProvenancePerMessageNotPerPeer(t *testing.T) {
	set, err := NewSet(
		Internal("internal", Listener{Network: "udp", Addr: "127.0.0.1:5160"}),
		External("external", NewACL([]Entry{mustEntry(t, "127.0.0.1/32", ActionAllow, 0, "trunk-loopback")}),
			Listener{Network: "udp", Addr: "127.0.0.1:5170"}),
	)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	onInternal := parseFiltered(t, arrivals, "127.0.0.1:5160", optionsDatagram())
	onExternal := parseFiltered(t, arrivals, "127.0.0.1:5170", optionsDatagram())

	owner, err := set.For(onInternal)
	if err != nil {
		t.Fatalf("For(internal datagram): %v", err)
	}
	if owner.Name != "internal" {
		t.Errorf("the first datagram chose %q; a later datagram from the same endpoint overwrote its provenance", owner.Name)
	}
	if owner, err := set.For(onExternal); err != nil || owner.Name != "external" {
		t.Errorf("For(external datagram) = %q / %v, want the external profile", owner.Name, err)
	}
}

// A peer that writes the stamp header itself must not get to choose its own profile.
func TestArrivalsIgnoreASenderSuppliedStamp(t *testing.T) {
	set, err := NewSet(
		Internal("internal", Listener{Network: "udp", Addr: "127.0.0.1:5160"}),
		External("external", NewACL([]Entry{mustEntry(t, "10.0.0.0/8", ActionAllow, 0, "trunk")}),
			Listener{Network: "udp", Addr: "127.0.0.1:5170"}),
	)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	forged := optionsDatagram(
		arrivalHeaderName+": udp/127.0.0.1:5170\r\n",
		"X-Optimiq-Arrival: udp/127.0.0.1:5170\r\n\tstill-folded\r\n",
	)
	req := parseFiltered(t, arrivals, "127.0.0.1:5160", forged)

	if values := req.GetHeaders(arrivalHeaderName); len(values) != 1 {
		t.Fatalf("the message carries %d stamps, want exactly ours", len(values))
	}
	owner, err := set.For(req)
	if err != nil {
		t.Fatalf("For: %v", err)
	}
	if owner.Name != "internal" {
		t.Errorf("a forged stamp chose %q, want the listener the datagram really arrived on", owner.Name)
	}
}

// The body must survive the rewrite byte for byte, or Content-Length stops describing it.
func TestArrivalStampPreservesTheBody(t *testing.T) {
	body := "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\n"
	data := []byte("INVITE sip:a@127.0.0.1 SIP/2.0\r\nCall-ID: body\r\nContent-Length: " +
		itoa(len(body)) + "\r\n\r\n" + body)

	stamped := stampArrival("udp", addr("127.0.0.1:5160"), data)
	_, got, split := strings.Cut(string(stamped), "\r\n\r\n")
	if !split || got != body {
		t.Fatalf("body = %q, want it untouched", got)
	}
}

// A stream read is not a message boundary, so those bytes are never rewritten.
func TestArrivalStampLeavesStreamTransportsAlone(t *testing.T) {
	data := optionsDatagram()
	if got := stampArrival("tcp", addr("127.0.0.1:5160"), data); string(got) != string(data) {
		t.Error("a TCP read was rewritten")
	}
	if got := stampArrival("udp", nil, data); string(got) != string(data) {
		t.Error("a read with no local address was rewritten")
	}
	if got := stampArrival("udp", addr("127.0.0.1:5160"), []byte("garbage")); string(got) != "garbage" {
		t.Error("a datagram with no header terminator was rewritten")
	}
}

// The registrar's NAT clamp is per profile, so it follows the same listener selection as everything
// else: a device on the internal listener is clamped, a carrier peer is not.
func TestMaxRegistrationIntervalFollowsTheArrivingProfile(t *testing.T) {
	set, err := NewSet(
		Internal("internal", Listener{Network: "udp", Addr: "127.0.0.1:5160"}),
		External("external", NewACL([]Entry{mustEntry(t, "127.0.0.1/32", ActionAllow, 0, "trunk-loopback")}),
			Listener{Network: "udp", Addr: "127.0.0.1:5170"}),
	)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	onInternal := parseFiltered(t, arrivals, "127.0.0.1:5160", optionsDatagram())
	if got := set.MaxRegistrationInterval(onInternal); got != 300*time.Second {
		t.Errorf("internal clamp = %s, want the 300-second device default", got)
	}
	onExternal := parseFiltered(t, arrivals, "127.0.0.1:5170", optionsDatagram())
	if got := set.MaxRegistrationInterval(onExternal); got != 0 {
		t.Errorf("external clamp = %s, want no clamp on a carrier profile", got)
	}
}
