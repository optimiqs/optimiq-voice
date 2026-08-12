package profile

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
)

// Action is what an ACL entry does when it matches.
type Action string

const (
	// ActionAllow admits the source.
	ActionAllow Action = "allow"
	// ActionDeny refuses it.
	ActionDeny Action = "deny"
)

// Valid reports whether the action is one of the two this evaluator implements.
func (a Action) Valid() bool { return a == ActionAllow || a == ActionDeny }

// Entry is one ACL rule: a network, what to do with it, and how strongly it is held.
//
// The shape mirrors `sip_acl_entry` in packages/pbx-db (a native PostgreSQL `cidr`, an action, a
// priority and a scope described as "the anti-toll-fraud boundary"), deliberately, because design
// §8.1 says the entries reach this edge as a derived read model written by apps/api and WATCHED
// here rather than read per INVITE. That read model does not exist yet; this type is what it
// deserialises into, and the evaluator below is what it compiles to.
type Entry struct {
	// Prefix is the network. A single host is a /32 or /128 and needs no special case.
	Prefix netip.Prefix
	Action Action
	// Priority breaks ties between entries of equal specificity. Higher wins. It exists because two
	// rules for the same network with different actions is a real configuration — an operator adds
	// a deny for a range and then an allow for one customer inside it — and resolving that by
	// insertion order would make the answer depend on how the read model was rebuilt.
	Priority int
	// TrunkID attributes an allow to a carrier. It is what turns "this packet may enter" into
	// "this packet is Telnyx", which is the attribution an INVITE from an unauthenticated source
	// needs before the engine can be asked whose call it is.
	TrunkID string
	// Label is free text for the log and the refusal record.
	Label string
}

// ParseEntry builds an Entry from the textual form the read model carries.
//
// A bare address is accepted and becomes a host prefix, because that is how an operator writes "one
// SBC" and refusing it would push the /32 into their head.
func ParseEntry(cidr string, action Action, priority int, trunkID, label string) (Entry, error) {
	if !action.Valid() {
		return Entry{}, fmt.Errorf("profile: %q is not a valid ACL action", action)
	}
	trimmed := strings.TrimSpace(cidr)
	if trimmed == "" {
		return Entry{}, errors.New("profile: an ACL entry needs a network")
	}
	if prefix, err := netip.ParsePrefix(trimmed); err == nil {
		// Masked so a sloppy `10.0.0.7/24` behaves as the /24 it means rather than never matching.
		return Entry{
			Prefix: prefix.Masked(), Action: action, Priority: priority,
			TrunkID: trunkID, Label: label,
		}, nil
	}
	address, err := netip.ParseAddr(trimmed)
	if err != nil {
		return Entry{}, fmt.Errorf("profile: %q is neither an address nor a CIDR network: %w", cidr, err)
	}
	return Entry{
		Prefix:   netip.PrefixFrom(address, address.BitLen()),
		Action:   action,
		Priority: priority,
		TrunkID:  trunkID,
		Label:    label,
	}, nil
}

// ACL is a compiled list of entries, evaluated in process.
//
// # In process, and never a KV get per INVITE
//
// A KV get per INVITE is a broker round trip inside a SIP transaction, on the one code path whose
// rate an attacker controls (design §8.1). So the entries are compiled once, sorted once, and
// matched against an address with no allocation and no I/O. Rebuilding on a watch update is a
// pointer swap.
type ACL struct {
	entries []Entry
	// defaultAllow is what happens when nothing matches. It is FALSE for every ACL this package
	// builds and there is no constructor that sets it true: an ACL whose default is allow is not an
	// ACL, and the one place a profile wants "everyone" is the internal profile, which authenticates
	// with digest instead and therefore has no ACL at all.
	defaultAllow bool
}

// NewACL compiles entries into an evaluator.
//
// The sort is the whole implementation: most specific first (a /32 beats a /24), then priority,
// then deny before allow at equal specificity and priority. That last tie-break is deliberate and
// is the only defensible one — when a configuration is ambiguous, the safe reading of an
// anti-toll-fraud boundary is the closed one.
func NewACL(entries []Entry) *ACL {
	compiled := append([]Entry(nil), entries...)
	sort.SliceStable(compiled, func(i, j int) bool {
		left, right := compiled[i], compiled[j]
		if left.Prefix.Bits() != right.Prefix.Bits() {
			return left.Prefix.Bits() > right.Prefix.Bits()
		}
		if left.Priority != right.Priority {
			return left.Priority > right.Priority
		}
		return left.Action == ActionDeny && right.Action == ActionAllow
	})
	return &ACL{entries: compiled}
}

// Len reports how many entries the ACL holds. Diagnostics and the boot log.
func (a *ACL) Len() int {
	if a == nil {
		return 0
	}
	return len(a.entries)
}

// Match evaluates one source address.
//
// The address is the OBSERVED transport source, `host:port` or a bare host. Never a header: an ACL
// that matched on a Via or a From would be an ACL an attacker writes.
func (a *ACL) Match(source string) (Entry, bool) {
	if a == nil || len(a.entries) == 0 {
		return Entry{}, false
	}
	address, ok := addressOf(source)
	if !ok {
		return Entry{}, false
	}
	for _, entry := range a.entries {
		if entry.Prefix.Contains(address) {
			return entry, entry.Action == ActionAllow
		}
	}
	return Entry{}, a.defaultAllow
}

// addressOf extracts a comparable address from `host:port`, a bare host, or an IPv6 form with
// brackets. A hostname answers false: an ACL cannot resolve names on the request path without
// putting a DNS lookup inside a SIP transaction, and a name that resolves differently per query is
// not a security boundary.
func addressOf(source string) (netip.Addr, bool) {
	trimmed := strings.TrimSpace(source)
	if trimmed == "" {
		return netip.Addr{}, false
	}
	if host, _, err := net.SplitHostPort(trimmed); err == nil {
		trimmed = host
	}
	trimmed = strings.Trim(trimmed, "[]")
	address, err := netip.ParseAddr(trimmed)
	if err != nil {
		return netip.Addr{}, false
	}
	// An IPv4-mapped IPv6 address (`::ffff:203.0.113.7`) arrives from a dual-stack listener and must
	// match an IPv4 rule, or every v4 CIDR silently stops working the day the socket becomes v6.
	return address.Unmap(), true
}
