// Package aor is the multi-contact location model: one address of record, several devices.
//
// # What is wrong today
//
// The registrar takes `contacts[0]` and silently ignores the rest (parity-audit row 1.3), so one
// AOR has one binding and a desk phone plus a softphone is a phone that steals the other's calls
// every time it refreshes. `extension.maxRegistrations` exists in packages/pbx-db and reaches
// nothing. This package is the model that fixes both: a SET of contacts per AOR, each with its own
// expiry and q-value, with a cap enforced by a documented eviction rule.
//
// # What it deliberately does not do: fork
//
// The engine forks, and it forks better than a SIP UAC could (design §5.3): `dialSimultaneous`
// mints one channel id per attempt, installs a watcher on each BEFORE any originate is issued,
// settles on the first answer, gives the loser `LOSE_RACE`, and produces one CDR row per attempt.
// A sipd that forked would have to reproduce the race, the per-attempt accounting and the
// confirmation flow in a process that has no CDR and no plan.
//
// So this package's job is to REPORT the contacts, in the order RFC 3261 §16.6 says to try them,
// and the engine originates one dialog per contact. Selection is a pure function; nothing here
// dials anything.
package aor

import (
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

// DefaultQ is the q-value of a contact that states none.
//
// RFC 3261 §20.10 says an absent `q` means the contact has no stated preference, and §16.6 orders
// by DECREASING q. One is the top of the range, so an unqualified contact outranks any contact that
// explicitly lowered itself — which is the right reading: a device that said `q=0.5` asked to be
// second, and a device that said nothing did not.
const DefaultQ = 1.0

// Contact is one device bound to an address of record.
//
// It is a superset of what internal/kv.Binding carries for a single contact, and the JSON tags are
// chosen to match it field for field, so a list-valued binding is the same shape repeated rather
// than a second vocabulary. The value the registrar writes stays backward compatible: the
// highest-priority contact continues to populate the flat `contact`/`transport`/`sourceAddress`
// fields that `registrationBindingSchema` defines, and the set travels alongside in `contacts`.
//
// `registrationBindingSchema.contacts` now EXISTS — an optional, `.loose()`, ten-element array — so
// this is no longer a shape waiting for a contract. The two halves are written together by
// ApplyToBinding and read together by FromBinding, and the wire type they meet at is kv.Contact.
// The schema being `.loose()` is still what lets this struct carry `q`, `regId`, `callId` and
// `cseq`, which the array's element does not name and this process needs to round-trip.
type Contact struct {
	// URI is the contact exactly as the device offered it, parameters included.
	URI string `json:"contact"`
	// Transport is the transport the binding was established over.
	Transport string `json:"transport,omitempty"`
	// SourceAddress is the observed signalling peer, host:port. The address that actually works.
	SourceAddress string `json:"sourceAddress,omitempty"`
	// UserAgent is the device's own description of itself.
	UserAgent string `json:"userAgent,omitempty"`
	// Instance is the device's `+sip.instance` (RFC 5626). It is the ONLY stable identity a device
	// has across a changed IP address or a changed port, which is what makes it the right key for
	// "is this the same phone re-registering, or a second one".
	Instance string `json:"instance,omitempty"`
	// RegID is the RFC 5626 `reg-id` parameter: one device with two flows (wifi and cellular)
	// registers twice with the same instance and different reg-ids, and both are legitimately live.
	RegID int `json:"regId,omitempty"`
	// Q is the preference, higher first.
	Q float64 `json:"q,omitempty"`
	// CallID and CSeq identify the registration dialog, so an out-of-order REGISTER for one contact
	// can be recognised (RFC 3261 §10.3 step 6).
	CallID string `json:"callId,omitempty"`
	CSeq   uint32 `json:"cseq,omitempty"`
	// RegisteredAt and ExpiresAt bound the binding.
	RegisteredAt time.Time `json:"registeredAt"`
	ExpiresAt    time.Time `json:"expiresAt"`
}

// Expired reports whether this contact's granted interval has lapsed.
func (c Contact) Expired(now time.Time) bool { return !now.Before(c.ExpiresAt) }

// Key is the identity a re-registration matches on.
//
// # The rule, and why it is not simply the URI
//
// RFC 3261 §10.3 step 6 says a contact matches an existing binding when the URIs match. RFC 5626
// §5.4 refines it for the case that actually happens: a device behind NAT gets a new source port on
// every reboot, so its Contact URI changes while the DEVICE has not. Matching on the URI alone
// leaves the old binding in place until it expires, and the AOR accumulates dead contacts for one
// phone until the cap evicts a live one.
//
// So: instance plus reg-id when the device supplies them, and the URI otherwise. That is exactly
// what RFC 5626 prescribes, and it is what makes the cap below a cap on DEVICES rather than on
// reboots.
func (c Contact) Key() string {
	if c.Instance != "" {
		return c.Instance + "\x00" + strconv.Itoa(c.RegID)
	}
	return c.URI
}

// Set is every live contact for one address of record.
//
// It is a value type with methods that return new sets rather than mutating in place, so the
// registrar can compute the result of a REGISTER, decide whether to accept it, and only then write
// — which is what stops a rejected registration from having already evicted somebody.
type Set struct {
	contacts []Contact
}

// NewSet builds a set from contacts, dropping any that have already lapsed.
func NewSet(contacts []Contact, now time.Time) Set {
	live := make([]Contact, 0, len(contacts))
	for _, contact := range contacts {
		if !contact.Expired(now) {
			live = append(live, contact)
		}
	}
	return Set{contacts: live}
}

// Len reports how many contacts the set holds.
func (s Set) Len() int { return len(s.contacts) }

// Contacts returns the set in preference order.
func (s Set) Contacts() []Contact {
	ordered := append([]Contact(nil), s.contacts...)
	sortByPreference(ordered)
	return ordered
}

// Primary returns the contact an INVITE goes to when only one may be tried, and whether there is
// one. It is the highest-q, most-recently-registered contact — the same head of the list Contacts
// returns, named separately because that is what the flat KV fields carry.
func (s Set) Primary() (Contact, bool) {
	ordered := s.Contacts()
	if len(ordered) == 0 {
		return Contact{}, false
	}
	return ordered[0], true
}

// Groups partitions the set into equal-preference groups, in decreasing q order.
//
// # Why groups and not a flat list
//
// RFC 3261 §16.6 is specific: contacts of EQUAL q may be tried in parallel, and contacts of
// different q must be tried in sequence. A flat list loses that distinction, and the engine's
// forking would either ring a `q=0.2` backup phone at the same time as the `q=1.0` desk phone — so
// the backup rings on every call, which is the whole thing q exists to prevent — or ring them one
// at a time and take four times as long to reach a user with four devices.
//
// So the engine receives groups: fork within a group, fall through between them.
func (s Set) Groups() [][]Contact {
	ordered := s.Contacts()
	groups := make([][]Contact, 0, len(ordered))
	for index, contact := range ordered {
		if index > 0 && qOf(ordered[index-1]) == qOf(contact) {
			groups[len(groups)-1] = append(groups[len(groups)-1], contact)
			continue
		}
		groups = append(groups, []Contact{contact})
	}
	return groups
}

// Outcome is what applying a registration to a set did.
type Outcome struct {
	// Set is the result.
	Set Set
	// Replaced is true when the contact matched an existing binding rather than adding one.
	Replaced bool
	// Evicted is the contact removed to make room, if any.
	Evicted *Contact
	// Refused is true when the cap could not be satisfied and the registration must be rejected.
	Refused bool
}

// Bind adds or refreshes one contact, enforcing a maximum.
//
// # The eviction rule, and why it is not "refuse the newcomer"
//
// A cap can be enforced two ways when a new device registers into a full AOR: refuse the new one,
// or evict the oldest. RFC 3261 §10.3 step 8 permits either. This implementation evicts the
// LEAST PREFERRED, breaking ties by the OLDEST registration, and the reason is what each failure
// mode looks like to a person:
//
//   - Refusing the newcomer means the phone somebody just plugged in does not work, with no
//     indication of why, while a phone that was unplugged three weeks ago and is still inside its
//     registration interval holds the slot. That is the failure an administrator gets a ticket for.
//   - Evicting the least preferred means a device stops receiving calls and its next refresh —
//     which is at most one registration interval away — puts it back, evicting somebody else. That
//     is visible, self-correcting, and it is what a cap set too low actually looks like.
//
// A REFRESH of a contact that is already bound never evicts anything, whatever the cap: the device
// already has its slot, and refusing a refresh would drop a working phone because the cap was
// lowered.
func (s Set) Bind(contact Contact, max int, now time.Time) Outcome {
	live := NewSet(s.contacts, now)
	key := contact.Key()

	for index, existing := range live.contacts {
		if existing.Key() == key {
			// A refresh extends a binding, it does not create one. Keeping the original instant is
			// what makes any "registered for" figure mean anything.
			contact.RegisteredAt = existing.RegisteredAt
			updated := append([]Contact(nil), live.contacts...)
			updated[index] = contact
			return Outcome{Set: Set{contacts: updated}, Replaced: true}
		}
	}

	if max > 0 && len(live.contacts) >= max {
		ordered := live.Contacts()
		victim := ordered[len(ordered)-1]
		if qOf(victim) > qOf(contact) {
			// Every existing contact outranks the newcomer. Evicting one would take a slot from a
			// device the tenant explicitly preferred and give it to one that explicitly asked to be
			// last, which inverts the whole point of a q-value.
			return Outcome{Set: live, Refused: true}
		}
		remaining := make([]Contact, 0, len(live.contacts))
		for _, candidate := range live.contacts {
			if candidate.Key() != victim.Key() {
				remaining = append(remaining, candidate)
			}
		}
		evicted := victim
		return Outcome{
			Set:     Set{contacts: append(remaining, contact)},
			Evicted: &evicted,
		}
	}
	return Outcome{Set: Set{contacts: append(append([]Contact(nil), live.contacts...), contact)}}
}

// Unbind removes one contact by key and reports whether it was there.
func (s Set) Unbind(key string, now time.Time) (Set, bool) {
	live := NewSet(s.contacts, now)
	remaining := make([]Contact, 0, len(live.contacts))
	removed := false
	for _, contact := range live.contacts {
		if contact.Key() == key {
			removed = true
			continue
		}
		remaining = append(remaining, contact)
	}
	return Set{contacts: remaining}, removed
}

// Clear removes every contact — `Contact: *` with `Expires: 0`.
func (s Set) Clear() Set { return Set{} }

// Expire removes every lapsed contact and returns both the survivors and the lapsed ones, so the
// sweeper can publish one `expired` event per device rather than one per AOR.
func (s Set) Expire(now time.Time) (Set, []Contact) {
	live := make([]Contact, 0, len(s.contacts))
	lapsed := make([]Contact, 0)
	for _, contact := range s.contacts {
		if contact.Expired(now) {
			lapsed = append(lapsed, contact)
			continue
		}
		live = append(live, contact)
	}
	sortByPreference(lapsed)
	return Set{contacts: live}, lapsed
}

// sortByPreference orders contacts the way RFC 3261 §16.6 requires, with two documented tie-breaks.
//
//  1. Decreasing q. The RFC's rule and the only one it states.
//  2. Most recently registered first. A device that just registered is the one a user just picked
//     up; a device that registered an hour ago is more likely to be the one on the desk they left.
//  3. The contact URI, lexicographically, so the order is DETERMINISTIC. Without a final tie-break
//     two contacts registered in the same millisecond would swap places between reads, and a test
//     asserting the fork order would be flaky for reasons nobody would find.
func sortByPreference(contacts []Contact) {
	sort.SliceStable(contacts, func(i, j int) bool {
		left, right := contacts[i], contacts[j]
		if qOf(left) != qOf(right) {
			return qOf(left) > qOf(right)
		}
		if !left.RegisteredAt.Equal(right.RegisteredAt) {
			return left.RegisteredAt.After(right.RegisteredAt)
		}
		return left.URI < right.URI
	})
}

func qOf(contact Contact) float64 {
	if contact.Q <= 0 {
		return DefaultQ
	}
	return contact.Q
}

// ParseQ reads the `q` parameter off a Contact header.
//
// RFC 3261 §20.10 restricts it to 0 through 1 with at most three decimal places. A value outside
// that range is treated as ABSENT rather than clamped: a device that sent `q=5` is a device whose
// parameter we do not understand, and clamping it to 1 would silently promote it above every
// correctly-behaved contact.
func ParseQ(header *sip.ContactHeader) float64 {
	if header == nil || header.Params == nil {
		return DefaultQ
	}
	raw, present := header.Params.Get("q")
	if !present {
		return DefaultQ
	}
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || value < 0 || value > 1 {
		return DefaultQ
	}
	if value == 0 {
		// `q=0` is legal and means "never use this unless there is nothing else". Zero would be
		// indistinguishable from "absent" in the struct, so it is stored as the smallest value the
		// three-decimal grammar allows and ordered accordingly.
		return 0.001
	}
	return value
}

// ParseRegID reads the RFC 5626 `reg-id` parameter, defaulting to zero for a device that sends
// none — which is every device that does not implement SIP outbound.
func ParseRegID(header *sip.ContactHeader) int {
	if header == nil || header.Params == nil {
		return 0
	}
	raw, present := header.Params.Get("reg-id")
	if !present {
		return 0
	}
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || value < 0 {
		return 0
	}
	return value
}

// ParseInstance reads `+sip.instance`, stripping the angle brackets and quotes a device wraps its
// URN in. A value that is not a URN is kept verbatim: it is opaque to us and only ever compared
// against itself.
func ParseInstance(header *sip.ContactHeader) string {
	if header == nil || header.Params == nil {
		return ""
	}
	raw, present := header.Params.Get("+sip.instance")
	if !present {
		return ""
	}
	return strings.Trim(strings.Trim(strings.TrimSpace(raw), `"`), "<>")
}

// FromBinding lifts a stored binding into a set.
//
// # Two shapes, one reader
//
// A binding written before `contacts` existed carries one flat contact and no array; one written
// since carries both. This function is the single place that asks which, so no caller has to — the
// same job `contactsOf` does on the TypeScript side, and for the same reason: "does this binding
// have a contacts array" asked at four call sites is four chances to answer it differently.
//
// The ARRAY wins when it is present, and the flat fields are not merged in on top of it. They are
// a COPY of the array's head by construction (see ApplyToBinding), so merging them would either
// change nothing or, on a binding some other writer had corrupted, silently duplicate the primary
// contact into the fork set — and a duplicated contact is a phone that rings twice.
func FromBinding(binding kv.Binding) Set {
	if len(binding.Contacts) > 0 {
		contacts := make([]Contact, 0, len(binding.Contacts))
		for _, stored := range binding.Contacts {
			contacts = append(contacts, Contact{
				URI:           stored.URI,
				Transport:     string(stored.Transport),
				SourceAddress: stored.SourceAddress,
				UserAgent:     stored.UserAgent,
				Instance:      stored.Instance,
				RegID:         stored.RegID,
				Q:             stored.Q,
				CallID:        stored.CallID,
				CSeq:          stored.CSeq,
				RegisteredAt:  stored.RegisteredAt.Time,
				ExpiresAt:     stored.ExpiresAt.Time,
			})
		}
		return Set{contacts: contacts}
	}
	if binding.Contact == "" {
		return Set{}
	}
	return Set{contacts: []Contact{{
		URI:           binding.Contact,
		Transport:     string(binding.Transport),
		SourceAddress: binding.SourceAddress,
		UserAgent:     binding.UserAgent,
		Instance:      binding.Instance,
		CallID:        binding.CallID,
		CSeq:          binding.CSeq,
		Q:             DefaultQ,
		RegisteredAt:  binding.RegisteredAt.Time,
		ExpiresAt:     binding.ExpiresAt.Time,
	}}}
}

// ApplyToBinding writes a set back onto a binding: the whole set into `contacts`, and the flat
// fields pointed at the primary.
//
// That is the whole backward-compatibility contract in one function, and the reason it is ONE
// function rather than two. An existing reader — the engine's location lookup, an admin UI's device
// list — sees the same `contact`, `transport` and `sourceAddress` it always saw, now describing the
// preferred device rather than the only one; a reader that knows about the set reads the set; and
// the two cannot drift, because there is no code path that writes one without writing the other.
//
// The order written is PREFERENCE order, so `contacts[0]` is the primary and the flat fields are a
// copy of it. A reader that wants the fork order gets it without sorting, which matters because the
// engine's `dialSimultaneous` forks in the order it is handed and RFC 3261 §16.6's ordering is not
// something two processes should each re-derive.
//
// The set is capped at ten on the way out, matching `registrationBindingSchema.contacts.max(10)`.
// A binding that exceeded it would be REFUSED by every TypeScript reader — the whole value, not the
// eleventh contact — so a registrar that wrote eleven would take an AOR offline rather than lose one
// device. The cap that normally applies is SIPD_MAX_CONTACTS and is enforced by Set.Bind long
// before this; this is the backstop that keeps the value parseable whatever happens upstream.
func ApplyToBinding(binding kv.Binding, set Set) kv.Binding {
	ordered := set.Contacts()
	if len(ordered) == 0 {
		binding.Contact = ""
		binding.Contacts = nil
		return binding
	}
	if len(ordered) > MaxStoredContacts {
		ordered = ordered[:MaxStoredContacts]
	}

	stored := make([]kv.Contact, 0, len(ordered))
	for _, contact := range ordered {
		transport := contract.SIPTransport(contact.Transport)
		if transport == "" {
			// The element schema requires a transport and closes the vocabulary. A contact recorded
			// without one is a bug upstream; inheriting the binding's is the honest repair, because
			// every contact on one AOR that this registrar wrote arrived over some transport it knew.
			transport = binding.Transport
		}
		stored = append(stored, kv.Contact{
			URI:           contact.URI,
			Transport:     transport,
			UserAgent:     contact.UserAgent,
			SourceAddress: contact.SourceAddress,
			DeviceID:      binding.DeviceID,
			Instance:      contact.Instance,
			RegID:         contact.RegID,
			Q:             contact.Q,
			CallID:        contact.CallID,
			CSeq:          contact.CSeq,
			RegisteredAt:  contract.EventTime{Time: contact.RegisteredAt},
			ExpiresAt:     contract.EventTime{Time: contact.ExpiresAt},
		})
	}

	primary := ordered[0]
	binding.Contact = primary.URI
	binding.SourceAddress = primary.SourceAddress
	binding.UserAgent = primary.UserAgent
	binding.Instance = primary.Instance
	binding.CallID = primary.CallID
	binding.CSeq = primary.CSeq
	if transport := contract.SIPTransport(primary.Transport); transport != "" {
		binding.Transport = transport
	}
	binding.Contacts = stored
	return binding
}

// MaxStoredContacts is the ceiling `registrationBindingSchema.contacts` states, restated here
// because this is the writer and a writer that exceeds a reader's bound produces a value nobody can
// parse. Ten: an AOR with more than ten live bindings is a misconfigured provisioning run or a
// device in a REGISTER loop, and forking to eleven endpoints is a way to ring an entire office from
// one call rather than a feature anybody asked for.
const MaxStoredContacts = 10
