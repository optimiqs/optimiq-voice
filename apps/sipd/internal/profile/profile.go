// Package profile is the internal/external trust boundary as a structure: a listener, an
// authentication policy, a NAT policy and a routing context, bound together and validated at boot.
//
// The load-bearing rule is design §8.3 — a digest-authenticated INVITE admits with the tenant's
// INTERNAL context and a trunk-matched INVITE with the UNTRUSTED one, because unauthenticated
// traffic must never resolve in a trunk-capable context.
//
// A profile is not a virtual host and not a multi-realm mechanism: one realm per process still holds
// (`SIPD_REALM`), and a profile changes the policy applied to traffic, not the identity space.
package profile

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
)

// Kind is the trust class of a profile.
type Kind string

const (
	// KindInternal serves registered devices. Every request is digest-authenticated against the
	// realm's credentials, and the resulting calls resolve in the tenant's internal context.
	KindInternal Kind = "internal"
	// KindExternal serves carriers. Requests are authenticated by SOURCE ADDRESS against the trunk
	// ACL, and the resulting calls resolve in the untrusted context — which is what stops an
	// inbound PSTN call from dialling another trunk and turning this PBX into an open relay.
	KindExternal Kind = "external"
)

// Valid reports whether the kind is one this package implements.
func (k Kind) Valid() bool { return k == KindInternal || k == KindExternal }

// AuthMode is how a request on a profile proves it may be here.
type AuthMode string

const (
	// AuthDigest requires an RFC 7616 digest answer against the realm's credentials — the same
	// Authenticator the registrar and the REFER handler share.
	AuthDigest AuthMode = "digest"
	// AuthTrunkACL requires the source address to match an allow entry in the profile's ACL. There
	// is no shared secret, which is why the routing context it produces is the untrusted one.
	AuthTrunkACL AuthMode = "trunk-acl"
)

// Valid reports whether the mode is one this package implements.
func (m AuthMode) Valid() bool { return m == AuthDigest || m == AuthTrunkACL }

// RoutingContext is the token that travels on the admission request and gates what the engine will
// resolve. The spellings are the two Asterisk contexts this replaces.
type RoutingContext string

const (
	// ContextInternal is a tenant's own dial plan: extensions, features, and trunks for outbound.
	ContextInternal RoutingContext = "internal"
	// ContextUntrusted is what a carrier's INVITE resolves in: DIDs and nothing else. A call that
	// arrived here can reach an extension and can never reach a trunk.
	ContextUntrusted RoutingContext = "inbound-untrusted"
)

// Listener is one bound socket a profile owns.
type Listener struct {
	// Network is sipgo's transport name: udp, tcp, tls, ws or wss.
	Network string
	// Addr is the bind address, host:port.
	Addr string
	// TLSCertFile and TLSKeyFile are required for tls and wss and refused for the rest.
	TLSCertFile string
	TLSKeyFile  string
}

// Secure reports whether the listener terminates TLS.
func (l Listener) Secure() bool {
	return l.Network == "tls" || l.Network == "wss"
}

// WebSocket reports whether the listener speaks SIP over WebSocket (RFC 7118), which is the
// transport a browser softphone has and the only one it has.
func (l Listener) WebSocket() bool {
	return l.Network == "ws" || l.Network == "wss"
}

// Profile is one trust boundary.
type Profile struct {
	// Name identifies the profile in logs, on the dialog claim and in refusal records.
	Name string
	Kind Kind
	// Listeners are the sockets this profile owns. A profile with none is legal only in a test.
	Listeners []Listener
	// Auth is how requests prove themselves.
	Auth AuthMode
	// ACL is the source-address list. Required for AuthTrunkACL and refused for AuthDigest — a
	// profile that authenticated with a password AND a source address would be two boundaries whose
	// interaction nobody has reasoned about.
	ACL *ACL
	// NAT is the address-rewriting position for this class of peer.
	NAT nat.Policy
	// Context is the routing context calls admitted on this profile resolve in.
	Context RoutingContext
	// AllowRegistration says whether REGISTER is served here. False on an external profile: a
	// carrier does not register TO us on the same listener it sends INVITEs on, and leaving
	// REGISTER open on a carrier-facing socket is an invitation to a credential-stuffing run.
	AllowRegistration bool
	// MaxSessions caps concurrent dialogs admitted on this profile, zero meaning uncapped. It is
	// the per-profile half of the capacity refusal; the per-trunk half is `trunk.maxChannels` and
	// lives with the trunk.
	MaxSessions int
}

// Internal builds the standard internal profile: digest, auto NAT rewrite, internal context,
// registration served.
func Internal(name string, listeners ...Listener) Profile {
	return Profile{
		Name:              name,
		Kind:              KindInternal,
		Listeners:         listeners,
		Auth:              AuthDigest,
		NAT:               nat.DefaultInternalPolicy(),
		Context:           ContextInternal,
		AllowRegistration: true,
	}
}

// External builds the standard carrier profile: source-address ACL, always-rewrite NAT, untrusted
// context, registration refused.
func External(name string, acl *ACL, listeners ...Listener) Profile {
	return Profile{
		Name:              name,
		Kind:              KindExternal,
		Listeners:         listeners,
		Auth:              AuthTrunkACL,
		ACL:               acl,
		NAT:               nat.DefaultExternalPolicy(),
		Context:           ContextUntrusted,
		AllowRegistration: false,
	}
}

// Validate refuses the combinations that are a security problem rather than a preference. They are
// boot failures and not warnings: a misconfigured edge that starts is one an attacker discovers
// before an operator does.
func (p Profile) Validate() error {
	var problems []string
	if strings.TrimSpace(p.Name) == "" {
		problems = append(problems, "a profile needs a name")
	}
	if !p.Kind.Valid() {
		problems = append(problems, fmt.Sprintf("%q is not a valid profile kind", p.Kind))
	}
	if !p.Auth.Valid() {
		problems = append(problems, fmt.Sprintf("%q is not a valid authentication mode", p.Auth))
	}
	if !p.NAT.ContactRewrite.Valid() {
		problems = append(problems, fmt.Sprintf("%q is not a valid contact-rewrite mode", p.NAT.ContactRewrite))
	}
	if !p.NAT.KeepaliveMethod.Valid() {
		problems = append(problems, fmt.Sprintf("%q is not a valid keepalive method", p.NAT.KeepaliveMethod))
	}
	switch p.Kind {
	case KindExternal:
		if p.Auth != AuthTrunkACL {
			problems = append(problems,
				"an external profile must authenticate by trunk ACL: digest against a carrier is a credential we do not have")
		}
		if p.ACL.Len() == 0 && !p.ACL.Watched() {
			problems = append(problems,
				"an external profile with an empty ACL accepts INVITEs from the whole internet")
		}
		// A watched ACL may be empty at boot: it is empty only for the window between the profile
		// being built and the `sip-acl` replay landing, and failing boot there would let a briefly
		// slow broker take the whole SIP edge down. It fails closed meanwhile. A statically empty one
		// is a misconfigured SIPD_TRUNK_ACL and is better reported at boot.
		if p.Context != ContextUntrusted {
			problems = append(problems,
				"an external profile must resolve in the untrusted context, or an inbound PSTN call can dial back out through a trunk")
		}
		if p.AllowRegistration {
			problems = append(problems,
				"an external profile must not serve REGISTER: it is a carrier-facing socket, not a device one")
		}
	case KindInternal:
		if p.Auth != AuthDigest {
			problems = append(problems,
				"an internal profile must authenticate with digest: a source-address check is not a credential")
		}
		if p.ACL.Len() > 0 {
			problems = append(problems,
				"an internal profile must not carry an ACL: two boundaries whose interaction nobody has reasoned about is worse than one")
		}
		if p.Context != ContextInternal {
			problems = append(problems, "an internal profile must resolve in the internal context")
		}
	}
	for _, listener := range p.Listeners {
		if err := listener.validate(); err != nil {
			problems = append(problems, err.Error())
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("profile %q is invalid:\n  - %s", p.Name, strings.Join(problems, "\n  - "))
	}
	return nil
}

func (l Listener) validate() error {
	switch l.Network {
	case "udp", "tcp", "ws":
		if l.TLSCertFile != "" || l.TLSKeyFile != "" {
			return fmt.Errorf("listener %s/%s names a certificate but does not terminate TLS", l.Network, l.Addr)
		}
	case "tls", "wss":
		if l.TLSCertFile == "" || l.TLSKeyFile == "" {
			return fmt.Errorf("listener %s/%s needs both a certificate and a key", l.Network, l.Addr)
		}
	default:
		return fmt.Errorf("%q is not a transport sipgo serves (udp, tcp, tls, ws, wss)", l.Network)
	}
	if strings.TrimSpace(l.Addr) == "" {
		return fmt.Errorf("listener %s has no bind address", l.Network)
	}
	return nil
}

// ErrNoProfile means no profile claims a request. A refusal and not a fallback: applying the
// friendliest available policy to an unowned packet is how an internal profile serves the internet.
var ErrNoProfile = errors.New("profile: no profile claims that request")

// Set is the collection of profiles this process serves.
type Set struct {
	profiles []Profile
	// byListener maps `network/addr` to a profile, which is the authoritative selector when the
	// transport tells us which socket a message arrived on.
	byListener map[string]int
}

// NewSet validates every profile and indexes the listeners. Two profiles on one listener is refused:
// a packet arriving on a shared socket would have two policies and no way to choose.
func NewSet(profiles ...Profile) (*Set, error) {
	set := &Set{byListener: make(map[string]int)}
	var problems []string
	names := make(map[string]bool, len(profiles))

	for _, candidate := range profiles {
		if err := candidate.Validate(); err != nil {
			problems = append(problems, err.Error())
			continue
		}
		if names[candidate.Name] {
			problems = append(problems, fmt.Sprintf("two profiles are both named %q", candidate.Name))
			continue
		}
		names[candidate.Name] = true
		for _, listener := range candidate.Listeners {
			key := listenerKey(listener.Network, listener.Addr)
			if existing, taken := set.byListener[key]; taken {
				problems = append(problems, fmt.Sprintf(
					"profiles %q and %q both listen on %s: one socket cannot have two policies",
					profiles[existing].Name, candidate.Name, key))
				continue
			}
			set.byListener[key] = len(set.profiles)
		}
		set.profiles = append(set.profiles, candidate)
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("the profile set is invalid:\n  - %s", strings.Join(problems, "\n  - "))
	}
	if len(set.profiles) == 0 {
		return nil, errors.New("profile: at least one profile is required")
	}
	return set, nil
}

// Profiles returns the set's profiles in declaration order.
func (s *Set) Profiles() []Profile { return s.profiles }

// Listeners returns every listener in the set, so main can bind exactly what the profiles declare
// rather than a separately-configured list that could drift from them.
func (s *Set) Listeners() []Listener {
	listeners := make([]Listener, 0, len(s.profiles))
	for _, candidate := range s.profiles {
		listeners = append(listeners, candidate.Listeners...)
	}
	return listeners
}

// ByName looks a profile up, for the paths that already know which one they are on.
func (s *Set) ByName(name string) (Profile, bool) {
	for _, candidate := range s.profiles {
		if candidate.Name == name {
			return candidate, true
		}
	}
	return Profile{}, false
}

// For decides which profile owns a request, in this order:
//
//  1. The LOCAL address the message arrived on — the only selector the sender cannot influence.
//  2. The transport, when exactly one profile serves it.
//  3. The SOURCE address against each external profile's ACL, including an external profile with no
//     listeners of its own. Last, because it is the only step where the sender's own address
//     participates in choosing the policy applied to it.
//
// Nothing matching is ErrNoProfile, and the caller answers 403. There is no default profile.
func (s *Set) For(req *sip.Request) (Profile, error) {
	if req == nil {
		return Profile{}, ErrNoProfile
	}
	transport := strings.ToLower(req.Transport())

	if local := req.Destination(); local != "" {
		if index, found := s.byListener[listenerKey(transport, local)]; found {
			return s.profiles[index], nil
		}
	}

	matches := make([]int, 0, len(s.profiles))
	for index, candidate := range s.profiles {
		for _, listener := range candidate.Listeners {
			if strings.EqualFold(listener.Network, transport) {
				matches = append(matches, index)
				break
			}
		}
	}
	// An external profile with no listeners of its own never appears in `matches`, so the transport
	// step would otherwise see only the internal profile and answer every carrier INVITE with a
	// digest challenge no carrier can answer. The source step has to run first when one exists.
	shared := slices.ContainsFunc(s.profiles, func(candidate Profile) bool {
		return candidate.Kind == KindExternal && len(candidate.Listeners) == 0
	})
	if !shared && len(matches) == 1 {
		return s.profiles[matches[0]], nil
	}

	source := req.Source()
	for index, candidate := range s.profiles {
		if candidate.Kind != KindExternal {
			continue
		}
		if len(candidate.Listeners) > 0 && !slices.Contains(matches, index) {
			continue
		}
		if _, allowed := candidate.ACL.Match(source); allowed {
			return candidate, nil
		}
	}
	if len(matches) == 1 {
		return s.profiles[matches[0]], nil
	}
	// A source no external ACL claims falls to the single internal profile serving this transport,
	// where it is challenged for a digest it does not have: a 401 rather than a 403, and not a call.
	internal := make([]int, 0, len(matches))
	for _, index := range matches {
		if s.profiles[index].Kind == KindInternal {
			internal = append(internal, index)
		}
	}
	if len(internal) == 1 {
		return s.profiles[internal[0]], nil
	}
	return Profile{}, ErrNoProfile
}

func listenerKey(network, addr string) string {
	return strings.ToLower(network) + "/" + strings.ToLower(addr)
}
