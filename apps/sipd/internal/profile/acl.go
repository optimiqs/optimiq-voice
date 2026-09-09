package profile

import (
	"cmp"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync/atomic"
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

// Entry is one ACL rule: a network, what to do with it, and how strongly it is held. The shape
// mirrors `sip_acl_entry` in packages/pbx-db, which reaches this edge as the `sip-acl` read model
// that internal/acl watches and compiles into these.
type Entry struct {
	// Prefix is the network. A single host is a /32 or /128 and needs no special case.
	Prefix netip.Prefix
	Action Action
	// Priority breaks ties between entries of equal specificity. Higher wins. Resolving such ties by
	// insertion order would make the answer depend on how the read model was rebuilt.
	Priority int
	// TrunkID attributes an allow to a carrier — the attribution an INVITE from an unauthenticated
	// source needs before the engine can be asked whose call it is.
	TrunkID string
	// Label is free text for the log and the refusal record.
	Label string
}

// ParseEntry builds an Entry from the textual form the read model carries. A bare address is
// accepted and becomes a host prefix, because that is how an operator writes "one SBC".
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

// ACL is a compiled list of entries, evaluated in process and never as a KV get per INVITE: that
// would be a broker round trip inside a SIP transaction, on the one code path whose rate an attacker
// controls. Entries are compiled and sorted once; a watch update is a pointer swap.
type ACL struct {
	// entries is an atomic pointer so a match on the request path takes no lock at all; an RWMutex
	// would put a lock acquisition inside a SIP transaction on the one path an attacker paces.
	entries atomic.Pointer[[]Entry]
	// watched records that this ACL is fed by a KV watch rather than fixed at boot. It changes
	// exactly one thing: whether an empty ACL is a valid external profile. See Profile.Validate.
	watched bool
	// defaultAllow is what happens when nothing matches. It is false for every ACL this package
	// builds and no constructor sets it true: an ACL whose default is allow is not an ACL.
	defaultAllow bool
}

// NewACL compiles entries into an evaluator.
func NewACL(entries []Entry) *ACL {
	acl := &ACL{}
	acl.store(entries)
	return acl
}

// NewWatchedACL compiles entries into an evaluator that expects to be Replaced. A separate
// constructor rather than a flag because the difference is a security property a caller should have
// to type: a watched ACL may legitimately be empty at boot, and a fixed one may not.
func NewWatchedACL(entries []Entry) *ACL {
	acl := &ACL{watched: true}
	acl.store(entries)
	return acl
}

// Replace swaps the whole entry set, compiled and sorted. Wholesale rather than incremental: an ACL
// applied in pieces has moments where a deny has been removed and its replacement has not yet
// arrived, so every read must see either the old policy or the new one and never a blend.
func (a *ACL) Replace(entries []Entry) {
	if a == nil {
		return
	}
	a.store(entries)
}

// store compiles and installs an entry set. The sort is the whole implementation: most specific
// first (a /32 beats a /24), then priority descending (internal/acl inverts the column's "lower
// first" at the border), then deny before allow — the closed reading of an ambiguous configuration.
func (a *ACL) store(entries []Entry) {
	compiled := slices.Clone(entries)
	slices.SortStableFunc(compiled, func(left, right Entry) int {
		if order := cmp.Compare(right.Prefix.Bits(), left.Prefix.Bits()); order != 0 {
			return order
		}
		if order := cmp.Compare(right.Priority, left.Priority); order != 0 {
			return order
		}
		if left.Action == ActionDeny && right.Action == ActionAllow {
			return -1
		}
		if left.Action == ActionAllow && right.Action == ActionDeny {
			return 1
		}
		return 0
	})
	a.entries.Store(&compiled)
}

// load reads the current entry set. A nil pointer is an ACL that was never compiled, which matches
// nothing — the same answer an empty one gives, and the safe one.
func (a *ACL) load() []Entry {
	if a == nil {
		return nil
	}
	entries := a.entries.Load()
	if entries == nil {
		return nil
	}
	return *entries
}

// Watched reports whether this ACL is fed by a KV watch.
func (a *ACL) Watched() bool {
	if a == nil {
		return false
	}
	return a.watched
}

// Len reports how many entries the ACL holds.
func (a *ACL) Len() int {
	if a == nil {
		return 0
	}
	return len(a.load())
}

// Match evaluates one source address, which must be the OBSERVED transport source, `host:port` or a
// bare host. Never a header: an ACL that matched on a Via or a From is an ACL an attacker writes.
func (a *ACL) Match(source string) (Entry, bool) {
	entries := a.load()
	if len(entries) == 0 {
		// An empty ACL matches nothing, so one whose bucket has not loaded yet refuses every carrier:
		// an outage an operator notices, rather than an open relay nobody does.
		return Entry{}, false
	}
	address, ok := addressOf(source)
	if !ok {
		return Entry{}, false
	}
	for _, entry := range entries {
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
