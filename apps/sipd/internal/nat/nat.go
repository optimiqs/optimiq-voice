// Package nat is sipd's answer to "the far end is not where it says it is".
//
// # The problem, stated once
//
// A SIP message carries three addresses that a NAT breaks differently. The top Via says where to
// send RESPONSES; RFC 3581's `rport` and `received` parameters fix it, and sipgo's transport layer
// already applies them to responses it sends. The Contact says where to send mid-dialog REQUESTS
// (RFC 3261 §12.1.1); nothing fixes that, and a phone behind NAT routinely puts `192.168.1.42` in
// it — so the BYE for a call, or the NOTIFY for a lamp, is addressed to an unroutable host and the
// call never ends. The SDP `c=` line says where to send MEDIA; mediad latches on the source of the
// first packet (RFC 4961) and therefore fixes that one itself, but only if it is told to expect the
// mismatch.
//
// This package decides which address wins for the second and third of those, and records why. It
// is a pure function of what was observed and what was advertised: no sockets, no state, no probes.
//
// # Explicitly out of scope
//
// STUN, TURN and ICE. There is no STUN client here and there is not going to be one in this wave —
// the parity audit's row 1.13 records the gap across the whole platform, and closing it is a media
// plane question first (ICE candidate gathering belongs where the RTP sockets are) and a WebRTC
// question second. What this package does instead is the thing a server-side B2BUA can do without
// the far end's cooperation: prefer the address the packets actually came from.
package nat

import (
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Mode is how aggressively Contact rewriting is applied.
type Mode string

const (
	// ModeAuto rewrites only when the advertised address and the observed one disagree in a way
	// that means NAT. It is the right default: a phone on the same LAN that advertises a reachable
	// Contact keeps it, which matters because a Contact carries parameters (`+sip.instance`, `gr`,
	// `ob`) that a rewrite would have to preserve and that some devices route on.
	ModeAuto Mode = "auto"
	// ModeAlways sends every mid-dialog request to the observed source regardless. It is what a
	// carrier-facing profile wants when the carrier is behind an SBC that never updates its
	// Contact, and it is a hammer: a far end with a legitimately different signalling and media
	// path is broken by it.
	ModeAlways Mode = "always"
	// ModeNever trusts the Contact absolutely. It exists so a lab can prove a bug is not this
	// package's, and for a profile whose peers are all on-net.
	ModeNever Mode = "never"
)

// Valid reports whether the mode is one this package implements.
func (m Mode) Valid() bool {
	switch m {
	case ModeAuto, ModeAlways, ModeNever:
		return true
	default:
		return false
	}
}

// KeepaliveMethod is how a registered device is kept reachable through its NAT pinhole.
type KeepaliveMethod string

const (
	// KeepaliveNone leaves it to the device's own registration refresh. Correct on a LAN and wrong
	// behind anything with a UDP timeout shorter than the registration interval — which is most
	// consumer routers, at 30 to 60 seconds against a typical 300-second REGISTER.
	KeepaliveNone KeepaliveMethod = "none"
	// KeepaliveCRLF is RFC 5626 §3.5.1's double-CRLF ping. It is two bytes, it is what a device
	// implementing SIP outbound expects, and it costs nothing — but it only works when the DEVICE
	// sends it, so choosing it here means advertising a short enough registration interval that the
	// device's own timer does the work.
	KeepaliveCRLF KeepaliveMethod = "crlf"
	// KeepaliveOptions sends an OPTIONS to each binding on an interval. This edge already ANSWERS
	// OPTIONS (`registrar.HandleOptions`) and has a SIP client that originates NOTIFY, so
	// originating OPTIONS is the same machinery pointed at the location service — and unlike CRLF
	// it also tells us the device has gone, which is the qualify half of parity-audit row 1.7.
	KeepaliveOptions KeepaliveMethod = "options"
)

// Valid reports whether the method is one this package implements.
func (m KeepaliveMethod) Valid() bool {
	switch m {
	case KeepaliveNone, KeepaliveCRLF, KeepaliveOptions:
		return true
	default:
		return false
	}
}

// Policy is one profile's NAT position. It is data, and the two profiles a deployment has
// (internal and external) hold different instances of it — which is exactly the structural
// separation parity-audit row 1.26 says is missing today.
type Policy struct {
	// ContactRewrite decides mid-dialog request addressing.
	ContactRewrite Mode
	// TrustRPort applies RFC 3581 to responses. Off means "reply to the Via's stated host and
	// port", which is correct on a trusted LAN and is a response that never arrives from anywhere
	// else. It is a separate knob from ContactRewrite because responses and requests fail
	// differently: without rport the far end never sees the 200, without the Contact rewrite it
	// sees the 200 and then cannot be reached again.
	TrustRPort bool
	// KeepaliveMethod and KeepaliveInterval keep a pinhole open.
	KeepaliveMethod   KeepaliveMethod
	KeepaliveInterval time.Duration
	// MaxRegistrationInterval clamps what the registrar may grant on this profile, so a device
	// behind NAT cannot talk itself into a 3600-second registration that its router forgets after
	// sixty. Zero means "do not clamp", which is the internal profile's answer.
	MaxRegistrationInterval time.Duration
}

// DefaultInternalPolicy is what a profile serving registered desk phones wants.
//
// Rewrite on evidence, trust rport, and clamp the registration interval to five minutes so a
// device behind a home router refreshes often enough to keep its pinhole open even if it asked for
// an hour.
func DefaultInternalPolicy() Policy {
	return Policy{
		ContactRewrite:          ModeAuto,
		TrustRPort:              true,
		KeepaliveMethod:         KeepaliveOptions,
		KeepaliveInterval:       30 * time.Second,
		MaxRegistrationInterval: 300 * time.Second,
	}
}

// DefaultExternalPolicy is what a profile serving carriers wants.
//
// Always rewrite: a carrier's Contact is frequently an internal SBC address that is meaningless to
// us, and there is no registration to clamp because a trunk either registers to US (a different
// path) or authenticates by source IP.
func DefaultExternalPolicy() Policy {
	return Policy{
		ContactRewrite:  ModeAlways,
		TrustRPort:      true,
		KeepaliveMethod: KeepaliveOptions,
		// A minute rather than thirty seconds: a carrier is not behind a consumer NAT, so this is a
		// reachability probe rather than a pinhole ping, and it feeds trunk.status* (design's
		// S-trunk rung) rather than keeping a hole open.
		KeepaliveInterval: 60 * time.Second,
	}
}

// Decision is where a mid-dialog request should actually go, and why.
type Decision struct {
	// Target is the URI to put in the Request-URI.
	Target sip.Uri
	// Destination is the transport-level address to SEND to, host:port, when it differs from the
	// target's own host and port. It is the same split `transfer/handler.go` already draws for
	// NOTIFY: the Contact stays the address, the observed source becomes the destination, so the
	// far end still recognises the URI it gave us while the packet goes somewhere that works.
	Destination string
	// Rewritten reports whether the observed address won.
	Rewritten bool
	// Reason is a short token for the log: "same-address", "nat-detected", "policy-always",
	// "policy-never", "no-observed".
	Reason string
}

// TargetFor decides where a mid-dialog request for one far end goes.
//
// The Contact is ALWAYS kept as the Request-URI, in every mode. That is not a compromise, it is the
// correct reading of RFC 3261 §12.2.1.1: the remote target URI is what the far end asked to be
// addressed as, and rewriting it changes the identity of the resource rather than the route to it.
// What the policy changes is the DESTINATION — the socket we write to — which is a transport
// concern and is exactly where a NAT lives.
func (p Policy) TargetFor(contact sip.Uri, observed string) Decision {
	decision := Decision{Target: contact}

	switch p.ContactRewrite {
	case ModeNever:
		decision.Reason = "policy-never"
		return decision
	case ModeAlways:
		if observed == "" {
			decision.Reason = "no-observed"
			return decision
		}
		decision.Destination = observed
		decision.Rewritten = true
		decision.Reason = "policy-always"
		return decision
	}

	if observed == "" {
		decision.Reason = "no-observed"
		return decision
	}
	if SameEndpoint(contact, observed) {
		decision.Reason = "same-address"
		return decision
	}
	decision.Destination = observed
	decision.Rewritten = true
	decision.Reason = "nat-detected"
	return decision
}

// SameEndpoint reports whether a Contact URI and an observed `host:port` name the same place.
//
// Host and port both, because a NAT that preserves the address and changes the port is the common
// case on a symmetric NAT, and comparing hosts alone would call it "same" and then send a BYE to a
// port nobody is listening on. A Contact with no port compares against the default 5060, which is
// what the absence of a port means.
func SameEndpoint(contact sip.Uri, observed string) bool {
	observedHost, observedPort, err := net.SplitHostPort(observed)
	if err != nil {
		observedHost, observedPort = observed, "5060"
	}
	contactPort := contact.Port
	if contactPort == 0 {
		contactPort = 5060
	}
	return strings.EqualFold(contact.Host, observedHost) && itoa(contactPort) == observedPort
}

// NeedsRewrite reports whether the advertised and observed addresses disagree — the "is this far
// end behind a NAT" question on its own, for the log line and for the registrar's decision about
// what to echo in a 200's Contact.
func NeedsRewrite(contact sip.Uri, observed string) bool {
	if observed == "" {
		return false
	}
	return !SameEndpoint(contact, observed)
}

// ---------------------------------------------------------------------------------------------
// RFC 3581: rport and received
// ---------------------------------------------------------------------------------------------

// ViaFix is what RFC 3581 says to add to a top Via before responding.
type ViaFix struct {
	// Received is the `received` parameter: the source host, added whenever it differs from the
	// Via's stated host (RFC 3261 §18.2.1 requires this even without rport).
	Received string
	// RPort is the `rport` parameter's value: the source PORT, added only when the sender ASKED for
	// it by sending a valueless `rport`. Adding it unasked would be answering a question nobody
	// posed, and some stacks reject a response whose Via grew a parameter they did not offer.
	RPort int
	// Applied reports whether anything changed.
	Applied bool
	// SymmetricDestination is where the response must be SENT when rport was requested: the source
	// address verbatim, port included. That is the whole point of rport — "reply to the port I sent
	// from, not the one I claim to listen on" — and it is what makes SIP work through a symmetric
	// NAT at all.
	SymmetricDestination string
}

// FixVia computes the received/rport parameters for a top Via against an observed source.
//
// It does not mutate the Via. sipgo's transport layer performs the mutation on the responses it
// sends; this function is here so the same rule can be applied to the requests this edge
// ORIGINATES within a dialog, and so it can be tested as a table rather than through a socket.
func (p Policy) FixVia(via *sip.ViaHeader, observed string) ViaFix {
	fix := ViaFix{}
	if via == nil || observed == "" {
		return fix
	}
	host, port, err := net.SplitHostPort(observed)
	if err != nil {
		host, port = observed, ""
	}

	if !strings.EqualFold(via.Host, host) {
		fix.Received = host
		fix.Applied = true
	}
	if via.Params == nil {
		return fix
	}
	value, requested := via.Params.Get("rport")
	if !requested {
		return fix
	}
	if !p.TrustRPort {
		// The sender asked and this profile declines. Recorded rather than silently skipped, so a
		// "responses never arrive" report has something in the log to find.
		return fix
	}
	_ = value // a valueless rport is the request; a valued one is a response we are not reading
	if parsed, err := parsePort(port); err == nil && parsed > 0 {
		fix.RPort = parsed
		fix.SymmetricDestination = observed
		fix.Applied = true
	}
	return fix
}

// ---------------------------------------------------------------------------------------------
// media
// ---------------------------------------------------------------------------------------------

// MediaHint is what the signalling plane can tell the media plane about a far end that is not
// where its SDP says it is.
//
// # Why this is a hint and not a rewrite
//
// sipd does not rewrite SDP. It forwards an offer it does not parse (design §5.2), and a process
// that edited a `c=` line would be making a media decision in the signalling plane — the exact
// coupling both design documents refuse. What it CAN do is state the discrepancy: mediad already
// latches onto the source of the first RTP packet (`apps/mediad/internal/rtp/session.go`, RFC 4961
// latch-once), and a latch is far more reliable when the session was told to expect one.
//
// So the hint travels with the offer on the admission RPC, the engine passes it to mediad's
// allocate, and mediad decides. Nothing here touches an SDP body except to read the connection
// ADDRESS — not a codec, not a payload type, not a format list.
type MediaHint struct {
	// SignallingSource is where the far end's SIP packets came from, host:port.
	SignallingSource string
	// AdvertisedMedia is the address in the SDP's connection line, host only.
	AdvertisedMedia string
	// Mismatch reports that the two disagree, which is the evidence for expecting a latch.
	Mismatch bool
	// Private reports that the advertised media address is in an RFC 1918 / RFC 4193 range, which
	// is proof rather than suspicion: no packet from that address reached us over the internet.
	Private bool
}

// HintFor builds the media hint from an SDP body and the observed signalling source.
func HintFor(sdp []byte, signallingSource string) MediaHint {
	hint := MediaHint{SignallingSource: signallingSource}
	hint.AdvertisedMedia = ConnectionAddress(sdp)
	if hint.AdvertisedMedia == "" {
		return hint
	}
	hint.Private = IsPrivate(hint.AdvertisedMedia)
	sourceHost, _, err := net.SplitHostPort(signallingSource)
	if err != nil {
		sourceHost = signallingSource
	}
	hint.Mismatch = sourceHost != "" && !strings.EqualFold(sourceHost, hint.AdvertisedMedia)
	return hint
}

// ConnectionAddress reads the address out of an SDP `c=` line and NOTHING else.
//
// `c=IN IP4 192.168.1.42` — three tokens, and only the third is read. The media-level line wins
// over the session-level one, per RFC 4566 §5.7, because that is the address the media stream
// actually uses.
func ConnectionAddress(sdp []byte) string {
	if len(sdp) == 0 {
		return ""
	}
	sessionLevel := ""
	mediaLevel := ""
	sawMedia := false
	for _, raw := range strings.Split(string(sdp), "\n") {
		line := strings.TrimRight(raw, "\r")
		switch {
		case strings.HasPrefix(line, "m="):
			sawMedia = true
		case strings.HasPrefix(line, "c="):
			fields := strings.Fields(strings.TrimPrefix(line, "c="))
			if len(fields) < 3 {
				continue
			}
			// A multicast address carries a TTL suffix (`224.2.1.1/127`). Nothing in this PBX uses
			// multicast media, and keeping the suffix would make every comparison below fail.
			address, _, _ := strings.Cut(fields[2], "/")
			if sawMedia {
				if mediaLevel == "" {
					mediaLevel = address
				}
				continue
			}
			sessionLevel = address
		}
	}
	if mediaLevel != "" {
		return mediaLevel
	}
	return sessionLevel
}

// IsPrivate reports whether an address is one that cannot have reached us across the internet:
// RFC 1918 v4, RFC 4193 v6 unique-local, link-local, and loopback.
//
// A name that is not an IP address answers false. A hostname in a `c=` line is legal and rare, and
// resolving it here would put a DNS lookup on the INVITE path for a guess.
func IsPrivate(address string) bool {
	ip := net.ParseIP(address)
	if ip == nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()
}

// ---------------------------------------------------------------------------------------------
// keepalive
// ---------------------------------------------------------------------------------------------

// RegistrationInterval clamps a granted registration interval to what this profile's NAT position
// can survive.
//
// A device behind a consumer router that is granted an hour will lose its pinhole in a minute and
// be unreachable for fifty-nine, while both ends believe it is registered. Clamping is the one
// mitigation that needs no cooperation from the device: it refreshes on the interval we grant.
func (p Policy) RegistrationInterval(granted time.Duration) time.Duration {
	if p.MaxRegistrationInterval <= 0 || granted <= p.MaxRegistrationInterval {
		return granted
	}
	return p.MaxRegistrationInterval
}

// KeepaliveDue reports whether a binding last touched at `last` is due for a keepalive at `now`.
// A profile with no keepalive method answers false always, which is what makes the pinger a no-op
// rather than a special case at its call site.
func (p Policy) KeepaliveDue(last, now time.Time) bool {
	if p.KeepaliveMethod != KeepaliveOptions || p.KeepaliveInterval <= 0 {
		return false
	}
	return !now.Before(last.Add(p.KeepaliveInterval))
}

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

func itoa(value int) string { return strconv.Itoa(value) }

// parsePort reads a numeric port and refuses everything else. strconv rather than net.LookupPort
// on purpose: LookupPort accepts service NAMES and would consult the resolver, which is a syscall
// on the response path for a string that came off the wire.
func parsePort(raw string) (int, error) { return strconv.Atoi(raw) }
