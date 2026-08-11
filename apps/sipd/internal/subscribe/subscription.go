package subscribe

import (
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Package-level vocabulary and the in-memory subscription table.
//
// # Why the table is instance-local, and not a KV directory
//
// Every other piece of live state on this platform is in a NATS KV bucket, so the absence of one
// here is a decision rather than an omission. Three reasons, in order of weight:
//
//  1. A subscription is not a fact about a tenant, it is HALF OF A SIP DIALOG. Sending a valid
//     in-dialog NOTIFY needs the Call-ID, both tags, the local CSeq counter, the dialog-info version
//     counter, and the observed source address the phone is actually reachable at behind its NAT.
//     Replicating all of that would let another instance compose a NOTIFY — and it still could not
//     SEND one, because the phone's NAT pinhole was opened toward the socket the SUBSCRIBE arrived
//     on and no other instance is behind it. A directory of subscriptions nobody else can serve is a
//     directory that only tells you what you have lost.
//
//  2. The failure it would mitigate is bounded by a knob we already have. If an instance dies, its
//     subscribers' lamps freeze until they re-subscribe. RFC 6665 §4.2.1 lets the notifier GRANT a
//     shorter interval than the phone asked for, so the grant is clamped (default 600 seconds), and
//     the worst case is ten minutes of stale lamp at a cost of one SUBSCRIBE per phone per ten
//     minutes. A graceful shutdown does better still: every subscription is terminated with
//     `reason=deactivated`, which RFC 6665 §4.1.2.4 defines as "re-subscribe immediately", so a
//     rolling deploy moves the fleet rather than stalling it.
//
//  3. It costs a bucket, a permission set and a reconciliation loop to hold state whose natural
//     lifetime is one process. The registrations bucket earns its keep because a binding is read by
//     something that is not sipd; nothing outside this process has any use for the fact that phone X
//     is watching extension Y.
//
// What WOULD change this: shared line appearance, where a seizure has to be arbitrated across
// instances, and a park-slot BLF whose resource is not an extension. Both are named as deferred.

// EventPackage is a SIP event package this edge serves (RFC 6665 §4.4).
type EventPackage string

const (
	// EventDialog is RFC 4235's `dialog` package — what a busy-lamp key subscribes to.
	EventDialog EventPackage = "dialog"
	// EventMessageSummary is RFC 3842's `message-summary` package — the voicemail lamp.
	EventMessageSummary EventPackage = "message-summary"
)

// AllowEvents is the `Allow-Events` header value: every package this edge serves.
//
// `refer` is on it because internal/transfer answers REFER, whose implicit subscription is an event
// package too (RFC 3515 §2.1). Advertising the honest list is what lets a phone decide it can use a
// BLF key at all — several vendors probe it before subscribing rather than trying and handling 489.
const AllowEvents = "dialog, message-summary, refer"

var supportedEvents = map[EventPackage]struct{}{
	EventDialog:         {},
	EventMessageSummary: {},
}

// Supported reports whether this edge serves an event package.
func Supported(event EventPackage) bool {
	_, ok := supportedEvents[event]
	return ok
}

// contentTypeFor is the body type one package's notifications carry.
func contentTypeFor(event EventPackage) string {
	if event == EventMessageSummary {
		return messageSummaryContentType
	}
	return dialogInfoContentType
}

// Subscription is one accepted subscription and the dialog state needed to notify it.
//
// It is NOT a full RFC 3261 dialog: there is no route set, and nothing here survives a restart. It
// is the minimum that puts a NOTIFY on the wire which the phone will accept as belonging to the
// subscription it created — the same shape, and the same reasoning, as transfer.Dialog.
type Subscription struct {
	// Event is the package. Resource is what is being watched: an extension number for `dialog`, the
	// subscriber's own SIP user for `message-summary`.
	Event    EventPackage
	OrgID    string
	Resource string
	// Entity is the AOR form of Resource, echoed into the body so a phone with several BLF keys can
	// tell which one moved.
	Entity string
	// Subscriber is the authenticated SIP user that created it, kept for the log and for the
	// message-summary `Message-Account` line.
	Subscriber string

	// Recipient is the request-URI of a notification: the subscriber's Contact, or its To address
	// when the SUBSCRIBE carried none.
	Recipient sip.Uri
	// Local is this edge's identity in the dialog — the SUBSCRIBE's To address — and the tag it
	// answered the 200 with. They become the NOTIFY's From, because a notification travels the other
	// way.
	Local     sip.Uri
	LocalTag  string
	Remote    sip.Uri
	RemoteTag string
	CallID    string
	// MintedLocalTag records that the SUBSCRIBE carried no To tag, so LocalTag is one this edge
	// generated. The 200 has to carry that exact string — sipgo would otherwise mint its own and not
	// say which, and a phone that cannot match the tags drops every notification silently.
	MintedLocalTag bool
	// EventID is the `id` parameter of the Event header, when the phone supplied one. It MUST be
	// echoed on every notification (RFC 6665 §8.2.1) or the phone cannot match them.
	EventID string
	// Transport and Destination pin the notification to the socket the SUBSCRIBE arrived on. A phone
	// behind NAT is reachable at the address we OBSERVED and generally at no other.
	Transport   string
	Destination string

	expiresAt atomic.Int64
	cseq      atomic.Uint32
	version   atomic.Uint32
}

// Key identifies the subscription's dialog. RFC 6665 §4.4.1: a subscription is identified by the
// Call-ID, the two tags and the event id — not by the resource, because one phone may hold two
// subscriptions to the same extension on two line keys.
func (s *Subscription) Key() string {
	return strings.Join([]string{s.CallID, s.LocalTag, s.RemoteTag, s.EventID}, "\x00")
}

// NextCSeq returns the sequence number for the next NOTIFY. Notifications within one subscription
// must increment (RFC 3261 §12.2.1.1), or the phone treats the second as a retransmit of the first
// and never sees the new state.
func (s *Subscription) NextCSeq() uint32 { return s.cseq.Add(1) }

// NextVersion returns the `version` attribute for the next dialog-info body. It is per SUBSCRIPTION
// and starts at 0, per RFC 4235 §3.3, so a watcher can discard a notification reordered on UDP.
func (s *Subscription) NextVersion() int {
	return int(s.version.Add(1) - 1)
}

// Refresh extends the subscription to the given deadline.
func (s *Subscription) Refresh(deadline time.Time) { s.expiresAt.Store(deadline.UnixMilli()) }

// ExpiresAt returns the current deadline.
func (s *Subscription) ExpiresAt() time.Time {
	return time.UnixMilli(s.expiresAt.Load())
}

// RemainingSeconds is what goes into the `Subscription-State: active;expires=` parameter, never
// negative and never zero while the subscription is live — a phone that reads `expires=0` on an
// active subscription treats it as already gone.
func (s *Subscription) RemainingSeconds(now time.Time) int {
	remaining := int(s.ExpiresAt().Sub(now) / time.Second)
	if remaining < 1 {
		return 1
	}
	return remaining
}

// Expired reports whether the granted interval has lapsed.
func (s *Subscription) Expired(now time.Time) bool { return !now.Before(s.ExpiresAt()) }

// resourceKey indexes subscriptions by what they watch.
type resourceKey struct {
	event    EventPackage
	orgID    string
	resource string
}

// Table holds this instance's subscriptions, indexed both ways: by dialog for refresh and
// termination, and by watched resource for the fan-out.
//
// Two indexes rather than one map plus a scan, because the fan-out runs on every presence change in
// the whole deployment and a linear scan there is the difference between a lamp that keeps up and
// one that lags behind a busy queue.
type Table struct {
	mu        sync.RWMutex
	byDialog  map[string]*Subscription
	byResourc map[resourceKey]map[string]*Subscription
}

// NewTable returns an empty table.
func NewTable() *Table {
	return &Table{
		byDialog:  make(map[string]*Subscription),
		byResourc: make(map[resourceKey]map[string]*Subscription),
	}
}

// Put inserts or replaces a subscription and reports whether it replaced an existing one.
func (t *Table) Put(subscription *Subscription) bool {
	key := subscription.Key()
	index := resourceKey{
		event:    subscription.Event,
		orgID:    subscription.OrgID,
		resource: subscription.Resource,
	}

	t.mu.Lock()
	defer t.mu.Unlock()
	_, replaced := t.byDialog[key]
	t.byDialog[key] = subscription
	watchers, found := t.byResourc[index]
	if !found {
		watchers = make(map[string]*Subscription)
		t.byResourc[index] = watchers
	}
	watchers[key] = subscription
	return replaced
}

// Get returns the subscription for a dialog key.
func (t *Table) Get(key string) (*Subscription, bool) {
	t.mu.RLock()
	defer t.mu.RUnlock()
	subscription, found := t.byDialog[key]
	return subscription, found
}

// Remove deletes a subscription and reports whether it was there.
func (t *Table) Remove(key string) (*Subscription, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	subscription, found := t.byDialog[key]
	if !found {
		return nil, false
	}
	t.removeLocked(key, subscription)
	return subscription, true
}

func (t *Table) removeLocked(key string, subscription *Subscription) {
	delete(t.byDialog, key)
	index := resourceKey{
		event:    subscription.Event,
		orgID:    subscription.OrgID,
		resource: subscription.Resource,
	}
	if watchers, found := t.byResourc[index]; found {
		delete(watchers, key)
		if len(watchers) == 0 {
			delete(t.byResourc, index)
		}
	}
}

// Watchers returns every subscription watching one resource, in a stable order so a test can assert
// what went out and in what sequence.
func (t *Table) Watchers(event EventPackage, orgID, resource string) []*Subscription {
	t.mu.RLock()
	defer t.mu.RUnlock()
	watchers := t.byResourc[resourceKey{event: event, orgID: orgID, resource: resource}]
	return sorted(watchers)
}

// All returns every subscription, in a stable order.
func (t *Table) All() []*Subscription {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return sorted(t.byDialog)
}

// TakeExpired removes and returns every subscription whose granted interval has lapsed.
func (t *Table) TakeExpired(now time.Time) []*Subscription {
	t.mu.Lock()
	defer t.mu.Unlock()

	var lapsed []*Subscription
	for key, subscription := range t.byDialog {
		if subscription.Expired(now) {
			lapsed = append(lapsed, subscription)
			t.removeLocked(key, subscription)
		}
	}
	sort.Slice(lapsed, func(i, j int) bool { return lapsed[i].Key() < lapsed[j].Key() })
	return lapsed
}

// Drain removes and returns every subscription. Used on the shutdown path, where each one is told
// `terminated;reason=deactivated` so the phone re-subscribes to a surviving instance at once.
func (t *Table) Drain() []*Subscription {
	t.mu.Lock()
	defer t.mu.Unlock()
	drained := sorted(t.byDialog)
	t.byDialog = make(map[string]*Subscription)
	t.byResourc = make(map[resourceKey]map[string]*Subscription)
	return drained
}

// Len returns how many subscriptions this instance holds.
func (t *Table) Len() int {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return len(t.byDialog)
}

func sorted(subscriptions map[string]*Subscription) []*Subscription {
	keys := make([]string, 0, len(subscriptions))
	for key := range subscriptions {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	ordered := make([]*Subscription, 0, len(keys))
	for _, key := range keys {
		ordered = append(ordered, subscriptions[key])
	}
	return ordered
}

// SubscriptionState is the `Subscription-State` header of one NOTIFY (RFC 6665 §8.2.3).
type SubscriptionState struct {
	// State is `active` while the subscription lives and `terminated` for the final notification.
	State string
	// Expires is the remaining lifetime in seconds. Only meaningful while active.
	Expires int
	// Reason accompanies `terminated`, and it is not decoration: RFC 6665 §4.1.2.4 makes it the
	// instruction. `timeout` means "re-subscribe on your own schedule", `deactivated` means
	// "re-subscribe NOW", `noresource` means "stop asking".
	Reason string
}

func (s SubscriptionState) String() string {
	value := s.State
	if s.State == "active" && s.Expires > 0 {
		value += ";expires=" + strconv.Itoa(s.Expires)
	}
	if s.Reason != "" {
		value += ";reason=" + s.Reason
	}
	return value
}

// The terminal states this edge sends, and what each one asks the phone to do.
var (
	// StateTerminatedTimeout is a subscription that ran out. The phone re-subscribes on its own
	// schedule.
	StateTerminatedTimeout = SubscriptionState{State: "terminated", Reason: "timeout"}
	// StateTerminatedDeactivated is this instance going away. RFC 6665 §4.1.2.4: the subscriber
	// SHOULD re-subscribe immediately, which is what turns a rolling deploy into a blip rather than
	// an outage of every lamp in the fleet.
	StateTerminatedDeactivated = SubscriptionState{State: "terminated", Reason: "deactivated"}
	// StateTerminatedClient is the answer to an unsubscribe (`Expires: 0`). `noresource` rather than
	// `timeout`, because the subscriber asked to stop and telling it to come back would produce a
	// loop.
	StateTerminatedClient = SubscriptionState{State: "terminated", Reason: "noresource"}
)

func activeState(remaining int) SubscriptionState {
	return SubscriptionState{State: "active", Expires: remaining}
}
