package profile

import (
	"strings"
	"testing"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
)

func mustEntry(t *testing.T, cidr string, action Action, priority int, trunkID string) Entry {
	t.Helper()
	entry, err := ParseEntry(cidr, action, priority, trunkID, cidr)
	if err != nil {
		t.Fatalf("ParseEntry(%q): %v", cidr, err)
	}
	return entry
}

// Most specific first, then priority, then deny wins: the closed reading of an ambiguous
// configuration.
func TestACLMatch(t *testing.T) {
	acl := NewACL([]Entry{
		mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "trunk-telnyx"),
		mustEntry(t, "203.0.113.66/32", ActionDeny, 0, ""),
		mustEntry(t, "192.0.2.0/24", ActionDeny, 0, ""),
		mustEntry(t, "192.0.2.7", ActionAllow, 0, "trunk-partner"),
		mustEntry(t, "198.51.100.0/24", ActionAllow, 5, "trunk-high"),
		mustEntry(t, "198.51.100.0/24", ActionDeny, 1, ""),
	})

	cases := []struct {
		name    string
		source  string
		allowed bool
		trunkID string
	}{
		{"inside an allowed range", "203.0.113.10:5060", true, "trunk-telnyx"},
		{"a /32 deny beats the enclosing /24 allow", "203.0.113.66:5060", false, ""},
		{"a bare host allow beats the enclosing deny", "192.0.2.7:5060", true, "trunk-partner"},
		{"inside a denied range", "192.0.2.8:5060", false, ""},
		{"a higher priority wins at equal specificity", "198.51.100.4:5060", true, "trunk-high"},
		{"nothing matches: the default is closed", "8.8.8.8:5060", false, ""},
		{"an IPv4-mapped IPv6 source still matches a v4 rule", "[::ffff:203.0.113.10]:5060", true, "trunk-telnyx"},
		{"a bare host with no port", "203.0.113.10", true, "trunk-telnyx"},
		{"a hostname is not resolved and therefore never matches", "phone.example.com:5060", false, ""},
		{"an empty source matches nothing", "", false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			entry, allowed := acl.Match(tc.source)
			if allowed != tc.allowed {
				t.Fatalf("allowed = %v, want %v (entry %+v)", allowed, tc.allowed, entry)
			}
			if allowed && entry.TrunkID != tc.trunkID {
				t.Errorf("trunkId = %q, want %q", entry.TrunkID, tc.trunkID)
			}
		})
	}
}

func TestEmptyAndNilACLsRefuseEverything(t *testing.T) {
	var absent *ACL
	if _, allowed := absent.Match("203.0.113.1:5060"); allowed {
		t.Error("a nil ACL must refuse")
	}
	if absent.Len() != 0 {
		t.Error("a nil ACL has no entries")
	}
	empty := NewACL(nil)
	if _, allowed := empty.Match("203.0.113.1:5060"); allowed {
		t.Error("an empty ACL must refuse: there is no constructor that opens the default")
	}
}

func TestParseEntry(t *testing.T) {
	t.Run("a sloppy CIDR is masked to the network it means", func(t *testing.T) {
		entry := mustEntry(t, "10.0.0.7/24", ActionAllow, 0, "")
		if entry.Prefix.String() != "10.0.0.0/24" {
			t.Errorf("prefix = %s, want the masked network", entry.Prefix)
		}
	})
	t.Run("a bare address becomes a host prefix", func(t *testing.T) {
		if got := mustEntry(t, "203.0.113.7", ActionAllow, 0, "").Prefix.String(); got != "203.0.113.7/32" {
			t.Errorf("prefix = %s, want a /32", got)
		}
		if got := mustEntry(t, "2001:db8::1", ActionAllow, 0, "").Prefix.String(); got != "2001:db8::1/128" {
			t.Errorf("prefix = %s, want a /128", got)
		}
	})
	t.Run("nonsense is refused rather than ignored", func(t *testing.T) {
		for _, value := range []string{"", "  ", "not-a-network", "10.0.0.0/99"} {
			if _, err := ParseEntry(value, ActionAllow, 0, "", ""); err == nil {
				t.Errorf("ParseEntry(%q) must fail", value)
			}
		}
		if _, err := ParseEntry("10.0.0.0/8", Action("maybe"), 0, "", ""); err == nil {
			t.Error("an invented action must be refused")
		}
	})
}

func TestProfileValidateRefusesTheDangerousCombinations(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "t")})

	cases := []struct {
		name    string
		profile Profile
		want    string
	}{
		{
			name:    "an external profile with an empty ACL",
			profile: Profile{Name: "ext", Kind: KindExternal, Auth: AuthTrunkACL, Context: ContextUntrusted, NAT: nat.DefaultExternalPolicy()},
			want:    "accepts INVITEs from the whole internet",
		},
		{
			name: "an external profile that resolves in the internal context",
			profile: Profile{Name: "ext", Kind: KindExternal, Auth: AuthTrunkACL, ACL: acl,
				Context: ContextInternal, NAT: nat.DefaultExternalPolicy()},
			want: "dial back out through a trunk",
		},
		{
			name: "an external profile serving REGISTER",
			profile: Profile{Name: "ext", Kind: KindExternal, Auth: AuthTrunkACL, ACL: acl,
				Context: ContextUntrusted, AllowRegistration: true, NAT: nat.DefaultExternalPolicy()},
			want: "must not serve REGISTER",
		},
		{
			name: "an external profile authenticating with digest",
			profile: Profile{Name: "ext", Kind: KindExternal, Auth: AuthDigest, ACL: acl,
				Context: ContextUntrusted, NAT: nat.DefaultExternalPolicy()},
			want: "must authenticate by trunk ACL",
		},
		{
			name: "an internal profile authenticating by source address",
			profile: Profile{Name: "int", Kind: KindInternal, Auth: AuthTrunkACL,
				Context: ContextInternal, NAT: nat.DefaultInternalPolicy()},
			want: "must authenticate with digest",
		},
		{
			name: "an internal profile carrying an ACL as well",
			profile: Profile{Name: "int", Kind: KindInternal, Auth: AuthDigest, ACL: acl,
				Context: ContextInternal, NAT: nat.DefaultInternalPolicy()},
			want: "must not carry an ACL",
		},
		{
			name: "a TLS listener with no certificate",
			profile: Profile{Name: "int", Kind: KindInternal, Auth: AuthDigest, Context: ContextInternal,
				NAT: nat.DefaultInternalPolicy(), Listeners: []Listener{{Network: "tls", Addr: "0.0.0.0:5061"}}},
			want: "needs both a certificate and a key",
		},
		{
			name: "a plaintext listener carrying a certificate",
			profile: Profile{Name: "int", Kind: KindInternal, Auth: AuthDigest, Context: ContextInternal,
				NAT:       nat.DefaultInternalPolicy(),
				Listeners: []Listener{{Network: "udp", Addr: "0.0.0.0:5060", TLSCertFile: "cert.pem"}}},
			want: "does not terminate TLS",
		},
		{
			name: "a transport sipgo does not serve",
			profile: Profile{Name: "int", Kind: KindInternal, Auth: AuthDigest, Context: ContextInternal,
				NAT: nat.DefaultInternalPolicy(), Listeners: []Listener{{Network: "sctp", Addr: "0.0.0.0:5060"}}},
			want: "not a transport sipgo serves",
		},
		{
			name:    "a profile with no name",
			profile: Profile{Kind: KindInternal, Auth: AuthDigest, Context: ContextInternal, NAT: nat.DefaultInternalPolicy()},
			want:    "needs a name",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.profile.Validate()
			if err == nil {
				t.Fatal("Validate must refuse this profile")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error = %q, want it to mention %q", err, tc.want)
			}
		})
	}
}

func TestTheStandardProfilesValidate(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "t")})
	if err := Internal("internal", Listener{Network: "udp", Addr: "0.0.0.0:5060"}).Validate(); err != nil {
		t.Errorf("the standard internal profile must validate: %v", err)
	}
	if err := External("external", acl).Validate(); err != nil {
		t.Errorf("the standard external profile must validate: %v", err)
	}
	if Internal("i").Context != ContextInternal || External("e", acl).Context != ContextUntrusted {
		t.Error("the two profiles must resolve in different contexts; that is the whole boundary")
	}
}

func TestNewSetRefusesTwoProfilesOnOneListener(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "t")})
	internal := Internal("internal", Listener{Network: "udp", Addr: "0.0.0.0:5060"})
	external := External("external", acl, Listener{Network: "udp", Addr: "0.0.0.0:5060"})

	if _, err := NewSet(internal, external); err == nil {
		t.Fatal("two profiles on one socket must be refused")
	} else if !strings.Contains(err.Error(), "one socket cannot have two policies") {
		t.Errorf("error = %q", err)
	}

	if _, err := NewSet(); err == nil {
		t.Error("a set with no profiles must be refused")
	}
	if _, err := NewSet(internal, Internal("internal", Listener{Network: "tcp", Addr: "0.0.0.0:5070"})); err == nil {
		t.Error("two profiles with one name must be refused")
	}
}

func request(t *testing.T, transport, source, destination string) *sip.Request {
	t.Helper()
	req := sip.NewRequest(sip.INVITE, sip.Uri{Scheme: "sip", User: "1002", Host: "acme.example.com"})
	req.SetTransport(transport)
	req.SetSource(source)
	req.SetDestination(destination)
	return req
}

// The local address wins, because it is the only selector a sender cannot influence.
func TestSetFor(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "trunk-telnyx")})
	internal := Internal("internal",
		Listener{Network: "udp", Addr: "0.0.0.0:5060"},
		Listener{Network: "tcp", Addr: "0.0.0.0:5060"})
	external := External("external", acl,
		Listener{Network: "udp", Addr: "0.0.0.0:5080"})

	set, err := NewSet(internal, external)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}

	t.Run("the local address is authoritative", func(t *testing.T) {
		got, err := set.For(request(t, "UDP", "203.0.113.9:5060", "0.0.0.0:5080"))
		if err != nil || got.Name != "external" {
			t.Fatalf("For = %v / %v, want the external profile", got.Name, err)
		}
		// Even a source the external ACL would allow lands on the INTERNAL profile when it arrives
		// on the internal socket, which is what makes the socket the boundary.
		got, err = set.For(request(t, "UDP", "203.0.113.9:5060", "0.0.0.0:5060"))
		if err != nil || got.Name != "internal" {
			t.Fatalf("For = %v / %v, want the internal profile", got.Name, err)
		}
	})

	t.Run("a transport only one profile serves resolves without any address matching", func(t *testing.T) {
		got, err := set.For(request(t, "TCP", "8.8.8.8:5060", ""))
		if err != nil || got.Name != "internal" {
			t.Fatalf("For = %v / %v, want the internal profile", got.Name, err)
		}
	})

	t.Run("a shared transport falls back to the source ACL", func(t *testing.T) {
		got, err := set.For(request(t, "UDP", "203.0.113.9:5060", ""))
		if err != nil || got.Name != "external" {
			t.Fatalf("For = %v / %v, want the external profile", got.Name, err)
		}
	})

	t.Run("an unknown stranger falls to the internal profile, where it is challenged", func(t *testing.T) {
		got, err := set.For(request(t, "UDP", "8.8.8.8:5060", ""))
		if err != nil || got.Name != "internal" {
			t.Fatalf("For = %v / %v, want a 401 rather than a call", got.Name, err)
		}
	})

	t.Run("a transport no profile serves is refused outright", func(t *testing.T) {
		if _, err := set.For(request(t, "WS", "8.8.8.8:5060", "")); err == nil {
			t.Error("there is no default profile")
		}
	})

	t.Run("a nil request is refused", func(t *testing.T) {
		if _, err := set.For(nil); err == nil {
			t.Error("a nil request claims no profile")
		}
	})
}

func TestSetAccessors(t *testing.T) {
	internal := Internal("internal", Listener{Network: "udp", Addr: "0.0.0.0:5060"})
	set, err := NewSet(internal)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	if len(set.Profiles()) != 1 || len(set.Listeners()) != 1 {
		t.Errorf("the set must expose exactly what was declared")
	}
	if _, found := set.ByName("internal"); !found {
		t.Error("ByName must find a declared profile")
	}
	if _, found := set.ByName("nope"); found {
		t.Error("ByName must not invent one")
	}
}

func TestListenerClassification(t *testing.T) {
	cases := []struct {
		network string
		secure  bool
		ws      bool
	}{
		{"udp", false, false},
		{"tcp", false, false},
		{"tls", true, false},
		{"ws", false, true},
		{"wss", true, true},
	}
	for _, tc := range cases {
		t.Run(tc.network, func(t *testing.T) {
			listener := Listener{Network: tc.network}
			if listener.Secure() != tc.secure {
				t.Errorf("Secure() = %v, want %v", listener.Secure(), tc.secure)
			}
			if listener.WebSocket() != tc.ws {
				t.Errorf("WebSocket() = %v, want %v", listener.WebSocket(), tc.ws)
			}
		})
	}
}

// The default configuration: SIPD_EXTERNAL_LISTEN_ADDR is empty, so the external profile has no
// listener of its own, shares the main socket and is selected by source address alone.
func TestSetForSelectsAListenerlessExternalProfileBySource(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "trunk-telnyx")})
	internal := Internal("internal", Listener{Network: "udp", Addr: "0.0.0.0:5060"})
	external := External("external", acl)

	set, err := NewSet(internal, external)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}

	got, err := set.For(request(t, "UDP", "203.0.113.9:5060", ""))
	if err != nil || got.Name != "external" {
		t.Fatalf("a carrier INVITE resolved to %q / %v, want the external profile", got.Name, err)
	}
	if got.Context != ContextUntrusted {
		t.Errorf("context = %q, want the untrusted one", got.Context)
	}

	// The listener cannot separate the two here, because the external profile has none of its own:
	// a carrier and a phone arrive on the same socket, so the ACL decides and an address it allows
	// is external wherever it landed. Giving the external profile its own socket
	// (SIPD_EXTERNAL_LISTEN_ADDR) is what makes the listener the boundary again — see
	// TestSetForPrefersTheArrivalListenerOverTheSourceACL.
	got, err = set.For(request(t, "UDP", "203.0.113.9:5060", "0.0.0.0:5060"))
	if err != nil || got.Name != "external" {
		t.Fatalf("For = %q / %v, want the external profile", got.Name, err)
	}

	// A stranger the ACL does not claim falls to the internal profile, where it is challenged.
	got, err = set.For(request(t, "UDP", "8.8.8.8:5060", ""))
	if err != nil || got.Name != "internal" {
		t.Fatalf("For = %q / %v, want the internal profile", got.Name, err)
	}
}

// The hole this closes: sipgo leaves Destination() empty on every inbound message, so before the
// arrivals table the source step decided every request on a shared transport — and a tenant's trunk
// ACL entry covering an office network reclassified that office's digest-authenticated phones as
// digest-free carrier peers.
func TestSetForPrefersTheArrivalListenerOverTheSourceACL(t *testing.T) {
	// The office network is in the trunk ACL, as a tenant that owns a trunk there can arrange.
	acl := NewACL([]Entry{mustEntry(t, "198.51.100.0/24", ActionAllow, 0, "trunk-telnyx")})
	internal := Internal("internal",
		Listener{Network: "udp", Addr: "0.0.0.0:5160"},
		Listener{Network: "tcp", Addr: "0.0.0.0:5160"})
	external := External("external", acl,
		Listener{Network: "udp", Addr: "0.0.0.0:5162"},
		Listener{Network: "tcp", Addr: "0.0.0.0:5162"})

	set, err := NewSet(internal, external)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	phone := addr("198.51.100.7:5060")
	for _, transport := range []string{"udp", "tcp"} {
		arrivals.Observe(transport, addr("0.0.0.0:5160"), phone)
		got, err := set.For(request(t, transport, phone.String(), ""))
		if err != nil || got.Name != "internal" {
			t.Fatalf("%s: For = %q / %v, want the internal profile", transport, got.Name, err)
		}
		if got.Auth != AuthDigest {
			t.Errorf("%s: auth = %q, want the phone to be challenged", transport, got.Auth)
		}
	}

	// The carrier on the external listener is still admitted, on the same source address.
	arrivals.Observe("udp", addr("0.0.0.0:5162"), phone)
	got, err := set.For(request(t, "udp", phone.String(), ""))
	if err != nil || got.Name != "external" {
		t.Fatalf("For = %q / %v, want the external profile", got.Name, err)
	}
	if got.Context != ContextUntrusted {
		t.Errorf("context = %q, want the untrusted one", got.Context)
	}
}

// A listener bound to a wildcard is reported by the kernel as 0.0.0.0:port, and one bound to a
// concrete address is reported with that address; the port settles both when the spellings differ.
func TestSetForFallsBackToTheListenerPort(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "198.51.100.0/24", ActionAllow, 0, "trunk-telnyx")})
	internal := Internal("internal", Listener{Network: "udp", Addr: ":5160"})
	external := External("external", acl, Listener{Network: "udp", Addr: ":5162"})

	set, err := NewSet(internal, external)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	arrivals.Observe("udp", addr("0.0.0.0:5160"), addr("198.51.100.7:5060"))
	got, err := set.For(request(t, "udp", "198.51.100.7:5060", ""))
	if err != nil || got.Name != "internal" {
		t.Fatalf("For = %q / %v, want the internal profile", got.Name, err)
	}
}

// The default deployment: no SIPD_EXTERNAL_LISTEN_ADDR, so the external profile owns no socket and
// the source ACL is the only thing that can admit a carrier. That must keep working.
func TestSetForStillAdmitsAListenerlessCarrierWithArrivalsInPlace(t *testing.T) {
	acl := NewACL([]Entry{mustEntry(t, "203.0.113.0/24", ActionAllow, 0, "trunk-telnyx")})
	internal := Internal("internal", Listener{Network: "udp", Addr: "0.0.0.0:5160"})
	external := External("external", acl)

	set, err := NewSet(internal, external)
	if err != nil {
		t.Fatalf("NewSet: %v", err)
	}
	arrivals := NewArrivals(16)
	set.TrackArrivals(arrivals)

	arrivals.Observe("udp", addr("0.0.0.0:5160"), addr("203.0.113.9:5060"))
	got, err := set.For(request(t, "udp", "203.0.113.9:5060", ""))
	if err != nil || got.Name != "external" {
		t.Fatalf("For = %q / %v, want the external profile", got.Name, err)
	}
}
