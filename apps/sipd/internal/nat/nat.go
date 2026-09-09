// Package nat decides where a far end really is when it is not where it says it is.
//
// A SIP message carries three addresses a NAT breaks differently: the top Via (fixed by RFC 3581
// rport/received, which sipgo's transport already applies), the Contact that addresses mid-dialog
// requests (RFC 3261 §12.1.1, which nothing else fixes), and the SDP `c=` line for media (which
// mediad latches per RFC 4961, but only if told to expect a mismatch). This package decides the
// second and third and records why. It is a pure function of observed and advertised addresses: no
// sockets, no state, no probes.
//
// STUN, TURN and ICE are out of scope — they are a media-plane concern where the RTP sockets are.
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
	// ModeAuto rewrites only when the advertised and observed addresses disagree. The default: a
	// phone advertising a reachable Contact keeps it, along with parameters (`+sip.instance`, `gr`,
	// `ob`) some devices route on.
	ModeAuto Mode = "auto"
	// ModeAlways sends every mid-dialog request to the observed source regardless — what a
	// carrier-facing profile wants behind an SBC that never updates its Contact. It breaks a far end
	// with a legitimately different signalling path.
	ModeAlways Mode = "always"
	// ModeNever trusts the Contact absolutely, for a profile whose peers are all on-net.
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
	// KeepaliveNone leaves it to the device's own registration refresh: wrong behind any router
	// whose UDP timeout (typically 30-60s) is shorter than the registration interval.
	KeepaliveNone KeepaliveMethod = "none"
	// KeepaliveCRLF is RFC 5626 §3.5.1's double-CRLF ping. It only works when the DEVICE sends it,
	// so choosing it means advertising a registration interval short enough for the device's timer.
	KeepaliveCRLF KeepaliveMethod = "crlf"
	// KeepaliveOptions sends an OPTIONS to each binding on an interval. Unlike CRLF it also tells us
	// when the device has gone.
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

// Policy is one profile's NAT position. It is data: the internal and external profiles hold
// different instances of it.
type Policy struct {
	// ContactRewrite decides mid-dialog request addressing.
	ContactRewrite Mode
	// TrustRPort applies RFC 3581 to responses. A separate knob from ContactRewrite because the two
	// fail differently: without rport the far end never sees the 200; without the Contact rewrite it
	// sees the 200 and then cannot be reached again.
	TrustRPort bool
	// KeepaliveMethod and KeepaliveInterval keep a pinhole open.
	KeepaliveMethod   KeepaliveMethod
	KeepaliveInterval time.Duration
	// MaxRegistrationInterval clamps what the registrar may grant, so a device behind NAT cannot
	// talk itself into a 3600-second registration its router forgets after sixty. Zero means no clamp.
	MaxRegistrationInterval time.Duration
}

// DefaultInternalPolicy is what a profile serving registered desk phones wants: rewrite on
// evidence, trust rport, and clamp registrations to five minutes so a device behind a home router
// refreshes often enough to keep its pinhole open.
func DefaultInternalPolicy() Policy {
	return Policy{
		ContactRewrite:          ModeAuto,
		TrustRPort:              true,
		KeepaliveMethod:         KeepaliveOptions,
		KeepaliveInterval:       30 * time.Second,
		MaxRegistrationInterval: 300 * time.Second,
	}
}

// DefaultExternalPolicy is what a profile serving carriers wants: always rewrite, because a
// carrier's Contact is frequently an internal SBC address meaningless to us, and no registration
// clamp, because a trunk authenticates by source IP or registers to us on a different path.
func DefaultExternalPolicy() Policy {
	return Policy{
		ContactRewrite:  ModeAlways,
		TrustRPort:      true,
		KeepaliveMethod: KeepaliveOptions,
		// A minute rather than thirty seconds: a carrier is not behind a consumer NAT, so this is a
		// reachability probe feeding trunk.status* rather than a pinhole ping.
		KeepaliveInterval: 60 * time.Second,
	}
}

// Decision is where a mid-dialog request should actually go, and why.
type Decision struct {
	// Target is the URI to put in the Request-URI.
	Target sip.Uri
	// Destination is the transport-level address to SEND to, host:port, when it differs from the
	// target's own. The Contact stays the address so the far end still recognises the URI it gave
	// us, while the packet goes somewhere that works.
	Destination string
	// Rewritten reports whether the observed address won.
	Rewritten bool
	// Reason is a short token for the log: "same-address", "nat-detected", "policy-always",
	// "policy-never", "no-observed".
	Reason string
}

// TargetFor decides where a mid-dialog request for one far end goes. The Contact is always kept as
// the Request-URI in every mode, per RFC 3261 §12.2.1.1: rewriting the remote target changes the
// identity of the resource rather than the route to it. Only the DESTINATION changes.
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

// SameEndpoint reports whether a Contact URI and an observed `host:port` name the same place. Host
// and port both: a symmetric NAT commonly preserves the address and changes the port, and comparing
// hosts alone would send a BYE to a port nobody is listening on. A missing Contact port means 5060.
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
// end behind a NAT" question on its own.
func NeedsRewrite(contact sip.Uri, observed string) bool {
	if observed == "" {
		return false
	}
	return !SameEndpoint(contact, observed)
}

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
	// address verbatim, port included. That is the point of rport, and what makes SIP work through a
	// symmetric NAT.
	SymmetricDestination string
}

// FixVia computes the received/rport parameters for a top Via against an observed source. It does
// not mutate the Via: sipgo's transport does that for responses it sends, and this exists so the
// same rule applies to the requests this edge originates within a dialog.
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

// MediaHint is what the signalling plane can tell the media plane about a far end that is not where
// its SDP says it is.
//
// A hint and not a rewrite: sipd forwards an offer it does not parse, and editing a `c=` line would
// make a media decision in the signalling plane. mediad latches onto the first RTP packet's source
// (RFC 4961 latch-once) and latches far more reliably when told to expect one. Nothing here reads an
// SDP body except the connection address.
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

// ConnectionAddress reads the address out of an SDP `c=` line and nothing else. The media-level
// line wins over the session-level one, per RFC 4566 §5.7.
func ConnectionAddress(sdp []byte) string {
	if len(sdp) == 0 {
		return ""
	}
	sessionLevel := ""
	mediaLevel := ""
	sawMedia := false
	for raw := range strings.SplitSeq(string(sdp), "\n") {
		line := strings.TrimRight(raw, "\r")
		switch {
		case strings.HasPrefix(line, "m="):
			sawMedia = true
		case strings.HasPrefix(line, "c="):
			fields := strings.Fields(strings.TrimPrefix(line, "c="))
			if len(fields) < 3 {
				continue
			}
			// A multicast address carries a TTL suffix (`224.2.1.1/127`) that would make every
			// comparison below fail.
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

// IsPrivate reports whether an address cannot have reached us across the internet: RFC 1918 v4,
// RFC 4193 v6 unique-local, link-local, and loopback. A name that is not an IP address answers
// false, because resolving it would put a DNS lookup on the INVITE path for a guess.
func IsPrivate(address string) bool {
	ip := net.ParseIP(address)
	if ip == nil {
		return false
	}
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()
}

// RegistrationInterval clamps a granted registration interval to what this profile's NAT position
// can survive. A device granted an hour loses its pinhole in a minute and is unreachable for
// fifty-nine while both ends believe it is registered; clamping needs no cooperation from it.
func (p Policy) RegistrationInterval(granted time.Duration) time.Duration {
	if p.MaxRegistrationInterval <= 0 {
		return granted
	}
	return min(granted, p.MaxRegistrationInterval)
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

func itoa(value int) string { return strconv.Itoa(value) }

// parsePort reads a numeric port and refuses everything else. strconv rather than net.LookupPort:
// LookupPort accepts service names and would consult the resolver on the response path.
func parsePort(raw string) (int, error) { return strconv.Atoi(raw) }
