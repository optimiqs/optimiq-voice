package dialog

import (
	"cmp"
	"context"
	"errors"
	"maps"
	"slices"
	"sync"
	"time"

	"github.com/emiago/sipgo/sip"
)

// Store errors, distinguished so a caller can answer 481 rather than 500 and can tell a genuine
// collision from a lookup miss.
var (
	// ErrDuplicateLeg means a dialog already exists under that legId. It is never a wire condition:
	// leg ids are minted here for inbound and by the engine for outbound, and a collision is a bug
	// or a replayed command, not a phone doing something unusual.
	ErrDuplicateLeg = errors.New("dialog: a dialog with that legId already exists")
	// ErrUnknownDialog is a lookup miss — the `unknown_dialog` refusal reason, and 481 on the wire.
	ErrUnknownDialog = errors.New("dialog: no such dialog")
)

// Store is this instance's dialog table, and the in-memory truth: a dialog's transaction state,
// timers and socket are all local, so there is nothing to distribute (design §6.1). What IS
// distributed is a CLAIM per dialog in the `sip-dialogs` bucket, whose only job is reaping — a
// survivor publishes the terminations a dead owner never got to (design §6.2). It is not failover.
//
// The store is safe for concurrent use; a *Dialog it hands out is NOT (see the package comment). It
// therefore lends pointers and never mutates a dialog, except Rebind, which touches the index.
type Store struct {
	mu sync.RWMutex
	// byLeg is the authority. Everything else is an index into it.
	byLeg map[string]*Dialog
	// byIdentity maps a full dialog triple to a legId: the lookup for every mid-dialog request.
	byIdentity map[string]string
	// byEarly maps a Call-ID plus our own tag to a legId, for the window before the far end's tag
	// is known. A UAC's CANCEL, its Timer B and its 100 all land in that window.
	byEarly map[string]string
	// claims is the rendered Claim per legId, kept as a VALUE under this lock. The heartbeat sweep
	// runs on the reaper's goroutine, so rendering a claim off the dialog there would race the
	// owner: the claim is rendered by the OWNER (Insert, Rebind, Touch) and the sweep copies values.
	claims map[string]Claim

	instanceID string
	lease      time.Duration
	now        func() time.Time
}

// StoreOptions configures a Store. Every field a test needs is here.
type StoreOptions struct {
	// InstanceID stamps every claim and is what an engine command's subject token addresses (design
	// §10.2), because a dialog lives on exactly one process.
	InstanceID string
	// Lease is how long a claim is valid without a heartbeat. It bounds how long a dead instance's
	// calls stay unreaped, and therefore how late a CDR can be.
	Lease time.Duration
	// Now is injectable so lease expiry is testable without sleeping.
	Now func() time.Time
}

// NewStore builds an empty store.
func NewStore(opts StoreOptions) *Store {
	store := &Store{
		byLeg:      make(map[string]*Dialog),
		byIdentity: make(map[string]string),
		byEarly:    make(map[string]string),
		claims:     make(map[string]Claim),
		instanceID: opts.InstanceID,
		lease:      opts.Lease,
		now:        opts.Now,
	}
	if store.now == nil {
		store.now = time.Now
	}
	if store.lease <= 0 {
		// Ninety seconds: long enough for a thirty-second heartbeat to survive a broker blip, short
		// enough that a rescheduled pod's calls are reaped well inside a billing cycle.
		store.lease = 90 * time.Second
	}
	return store
}

// InstanceID reports the instance token this store stamps on claims.
func (s *Store) InstanceID() string { return s.instanceID }

// Insert adds a dialog and indexes it.
func (s *Store) Insert(dialog *Dialog) error {
	if dialog == nil {
		return ErrNoLegID
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.byLeg[dialog.LegID]; exists {
		return ErrDuplicateLeg
	}
	s.byLeg[dialog.LegID] = dialog
	s.index(dialog)
	s.claims[dialog.LegID] = s.claimFor(dialog)
	return nil
}

// index writes both index entries for a dialog. Called with the lock held.
func (s *Store) index(dialog *Dialog) {
	if dialog.Identity.Established() {
		s.byIdentity[dialog.Identity.Key()] = dialog.LegID
	}
	if dialog.Identity.SIPCallID != "" && dialog.Identity.LocalTag != "" {
		s.byEarly[dialog.Identity.EarlyKey()] = dialog.LegID
	}
}

// Rebind re-indexes a dialog whose remote tag has just been learned. A UAC dialog's identity is
// incomplete until the far end answers with a tag (RFC 3261 §12.1.2), while the BYE arriving ten
// minutes later is matched on the complete triple.
func (s *Store) Rebind(legID string, identity Identity) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	dialog, found := s.byLeg[legID]
	if !found {
		return ErrUnknownDialog
	}
	delete(s.byIdentity, dialog.Identity.Key())
	dialog.Identity = identity
	s.index(dialog)
	s.claims[legID] = s.claimFor(dialog)
	return nil
}

// Touch re-renders a dialog's cached claim. It MUST be called from the goroutine that owns the
// dialog: the read of the dialog's fields happens there and only the resulting value crosses the
// lock.
func (s *Store) Touch(dialog *Dialog) {
	if dialog == nil {
		return
	}
	claim := s.claimFor(dialog)
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, held := s.byLeg[dialog.LegID]; !held {
		return
	}
	s.claims[dialog.LegID] = claim
}

// Get looks a dialog up by its leg id, which is the only key.
func (s *Store) Get(legID string) (*Dialog, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	dialog, found := s.byLeg[legID]
	return dialog, found
}

// MatchRequest finds the dialog a mid-dialog request belongs to: the full triple first, then the
// early index. The order matters — matching early first would let someone who guessed a Call-ID and
// our tag reach a confirmed call.
func (s *Store) MatchRequest(req *sip.Request) (*Dialog, bool) {
	identity, err := identityOfIncoming(req)
	if err != nil {
		return nil, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if legID, found := s.byIdentity[identity.Key()]; found {
		dialog, ok := s.byLeg[legID]
		return dialog, ok
	}
	if legID, found := s.byEarly[identity.EarlyKey()]; found {
		dialog, ok := s.byLeg[legID]
		return dialog, ok
	}
	return nil, false
}

// Membership is who an in-dialog request acts as: the identity the DIALOG carries, copied out under
// the store's lock so no *Dialog escapes to a goroutine that does not own it.
type Membership struct {
	LegID string
	OrgID string
	// AccountAOR is the far end's address of record, empty when the dialog has no account (a trunk
	// leg, or a bare URI).
	AccountAOR string
}

// MatchEstablished resolves an in-dialog request against a CONFIRMED dialog and reports the identity
// to act as. Unlike MatchRequest it does not fall back to the early index: both tags must match, and
// they are unguessable secrets shared only with the dialog's peers, so membership of an established
// dialog is itself the authorisation an in-dialog request needs (RFC 3261 §12.2 — such a request's
// From is the dialog's local URI and asserts nothing).
func (s *Store) MatchEstablished(req *sip.Request) (Membership, bool) {
	identity, err := identityOfIncoming(req)
	if err != nil || !identity.Established() {
		return Membership{}, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	legID, found := s.byIdentity[identity.Key()]
	if !found {
		return Membership{}, false
	}
	dialog, ok := s.byLeg[legID]
	if !ok || !dialog.state.Answered() {
		return Membership{}, false
	}
	return Membership{LegID: dialog.LegID, OrgID: dialog.OrgID, AccountAOR: dialog.AccountAOR}, true
}

// MatchResponse finds the dialog a response to one of OUR requests belongs to. The first response
// with a tag can only match on the early key; once Rebind has run, later responses match the full
// index — hence both lookups.
func (s *Store) MatchResponse(res *sip.Response) (*Dialog, bool) {
	identity, err := identityOfResponse(res)
	if err != nil {
		return nil, false
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if legID, found := s.byIdentity[identity.Key()]; found {
		dialog, ok := s.byLeg[legID]
		return dialog, ok
	}
	if legID, found := s.byEarly[identity.EarlyKey()]; found {
		dialog, ok := s.byLeg[legID]
		return dialog, ok
	}
	return nil, false
}

// FindReplaced resolves an RFC 3891 Replaces triple against this instance's dialogs.
//
// Per RFC 3891 §3 the tags are written from the sender's point of view, so `to-tag` compares against
// OUR local tag and `from-tag` against the remote one — the same orientation as an incoming request,
// which is why this is a plain identity lookup. `earlyOnly` is REFUSED rather than ignored on a
// confirmed dialog, so a transfer cannot complete into a call somebody else already picked up.
func (s *Store) FindReplaced(callID, toTag, fromTag string, earlyOnly bool) (*Dialog, error) {
	identity := Identity{SIPCallID: callID, LocalTag: toTag, RemoteTag: fromTag}
	if !identity.Established() {
		return nil, ErrUnknownDialog
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	legID, found := s.byIdentity[identity.Key()]
	if !found {
		return nil, ErrUnknownDialog
	}
	dialog, ok := s.byLeg[legID]
	if !ok {
		return nil, ErrUnknownDialog
	}
	if !dialog.state.Alive() {
		return nil, ErrDialogGone
	}
	if earlyOnly && dialog.state.Answered() {
		return nil, ErrInvalidState
	}
	return dialog, nil
}

// Remove drops a dialog and both of its index entries.
func (s *Store) Remove(legID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	dialog, found := s.byLeg[legID]
	if !found {
		return
	}
	delete(s.byLeg, legID)
	delete(s.claims, legID)
	delete(s.byIdentity, dialog.Identity.Key())
	delete(s.byEarly, dialog.Identity.EarlyKey())
}

// Len reports how many dialogs this instance holds, which is what decides whether a drain may
// finish.
func (s *Store) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.byLeg)
}

// LegIDs returns every leg id this instance holds, sorted, so a drain and a test both iterate
// deterministically.
func (s *Store) LegIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return slices.Sorted(maps.Keys(s.byLeg))
}

// Claim is the `sip-dialogs` record: what a SECOND process can truthfully say about a dialog it
// does not hold (design §6.2).
//
// It is NOT organisation-scoped as a key: an engine reconciling a `legId`, or a sipd reaping a dead
// peer, has no org to prefix with. The org travels in the value.
type Claim struct {
	LegID      string `json:"legId"`
	InstanceID string `json:"instanceId"`
	OrgID      string `json:"orgId,omitempty"`
	CallID     string `json:"callId,omitempty"`
	// Role is "uas" when we answered and "uac" when we called.
	Role string `json:"role"`
	// SIPCallID, LocalTag and RemoteTag are the dialog triple: a lookup key, never an authorisation.
	SIPCallID string `json:"sipCallId"`
	LocalTag  string `json:"localTag,omitempty"`
	RemoteTag string `json:"remoteTag,omitempty"`
	State     string `json:"state"`
	// RemoteAddress is the observed source, host:port.
	RemoteAddress string `json:"remoteAddress,omitempty"`
	Transport     string `json:"transport,omitempty"`
	TrunkID       string `json:"trunkId,omitempty"`
	Profile       string `json:"profile,omitempty"`
	// CreatedAt and ExpiresAt are epoch milliseconds, matching every other live-state record on
	// this backbone.
	CreatedAt int64 `json:"createdAt"`
	ExpiresAt int64 `json:"expiresAt"`
}

// Expired reports whether the claim's lease has lapsed at the given instant, meaning its owner has
// stopped heartbeating.
func (c Claim) Expired(now time.Time) bool {
	return now.UnixMilli() >= c.ExpiresAt
}

// ClaimFor renders the current claim for a dialog this instance holds. It reads the dialog, so it
// runs on the goroutine that owns it and never on the sweep's.
func (s *Store) ClaimFor(dialog *Dialog) Claim { return s.claimFor(dialog) }

func (s *Store) claimFor(dialog *Dialog) Claim {
	now := s.now()
	return Claim{
		LegID:         dialog.LegID,
		InstanceID:    s.instanceID,
		OrgID:         dialog.OrgID,
		CallID:        dialog.CallID,
		Role:          dialog.Role.String(),
		SIPCallID:     dialog.Identity.SIPCallID,
		LocalTag:      dialog.Identity.LocalTag,
		RemoteTag:     dialog.Identity.RemoteTag,
		State:         dialog.state.String(),
		RemoteAddress: dialog.Target.Observed,
		Transport:     dialog.Target.Transport,
		TrunkID:       dialog.TrunkID,
		Profile:       dialog.Profile,
		CreatedAt:     dialog.createdAt.UnixMilli(),
		ExpiresAt:     now.Add(s.lease).UnixMilli(),
	}
}

// Claims returns a copy of every live dialog's claim, for the heartbeat sweep. It copies the values
// the owning goroutines rendered rather than reading the dialogs (see the `claims` field), and
// stamps a fresh lease deadline, which is what the heartbeat is for.
func (s *Store) Claims() []Claim {
	expires := s.now().Add(s.lease).UnixMilli()
	s.mu.RLock()
	claims := make([]Claim, 0, len(s.claims))
	for _, claim := range s.claims {
		claim.ExpiresAt = expires
		claims = append(claims, claim)
	}
	s.mu.RUnlock()

	slices.SortFunc(claims, func(a, b Claim) int { return cmp.Compare(a.LegID, b.LegID) })
	return claims
}

// ClaimStore is the `sip-dialogs` bucket, as an interface. NATSClaimStore (claims.go) is the
// production implementation; the seam exists so the unit suite runs with no broker and no socket.
// Every method takes a context because the real one is network I/O on a shutdown path.
type ClaimStore interface {
	Put(ctx context.Context, claim Claim) error
	Delete(ctx context.Context, legID string) error
	// All returns every claim in the bucket, including other instances'. It is the reaper's input
	// and is not on any request path.
	All(ctx context.Context) ([]Claim, error)
}

// MemoryClaimStore is an in-process ClaimStore. It backs the unit tests and lets sipd run without
// the bucket; it is NOT a deployment option for more than one instance, because a claim only one
// process can see reaps nothing.
type MemoryClaimStore struct {
	mu     sync.RWMutex
	claims map[string]Claim
}

var _ ClaimStore = (*MemoryClaimStore)(nil)

// NewMemoryClaimStore returns an empty store.
func NewMemoryClaimStore() *MemoryClaimStore {
	return &MemoryClaimStore{claims: make(map[string]Claim)}
}

// Put implements ClaimStore.
func (m *MemoryClaimStore) Put(_ context.Context, claim Claim) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.claims[claim.LegID] = claim
	return nil
}

// Delete implements ClaimStore. Deleting an absent claim is not an error: teardown is idempotent.
func (m *MemoryClaimStore) Delete(_ context.Context, legID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.claims, legID)
	return nil
}

// All implements ClaimStore, in leg-id order so tests are deterministic.
func (m *MemoryClaimStore) All(_ context.Context) ([]Claim, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	claims := make([]Claim, 0, len(m.claims))
	for _, claim := range m.claims {
		claims = append(claims, claim)
	}
	slices.SortFunc(claims, func(a, b Claim) int { return cmp.Compare(a.LegID, b.LegID) })
	return claims, nil
}

// Orphans returns the claims that belong to some OTHER instance and whose lease has lapsed.
//
// Deliberately not "every expired claim": one of our own that has expired means our own heartbeat is
// late, and reaping it would turn a broker blip into dropped calls.
func Orphans(claims []Claim, instanceID string, now time.Time) []Claim {
	return Reapable(claims, instanceID, now, nil)
}

// Reapable returns the claims this instance may terminate on a dead owner's behalf, judged on two
// pieces of evidence rather than one.
//
// The first is the claim's own lease, which is what Orphans has always used. The second is the
// `sip-instances` bucket: an owner with no live lease is a process that stopped renewing seconds
// ago, and waiting out the claim's much longer lease before reaping its dialogs leaves the engine
// holding live channels for a minute and a half after its edge died.
//
// liveInstances is trusted ONLY when it is non-empty. An empty or nil set means "no lease evidence
// this sweep" — an old sipd that writes no lease, a bucket that could not be listed — and the
// caller's own lease is always in a healthy set, so emptiness is exactly the case where the second
// piece of evidence must be ignored rather than read as "every instance in the fleet is dead".
func Reapable(
	claims []Claim,
	instanceID string,
	now time.Time,
	liveInstances map[string]struct{},
) []Claim {
	orphans := make([]Claim, 0)
	for _, claim := range claims {
		if claim.InstanceID == instanceID {
			continue
		}
		ownerGone := false
		if len(liveInstances) > 0 {
			_, alive := liveInstances[claim.InstanceID]
			ownerGone = !alive
		}
		if !ownerGone && !claim.Expired(now) {
			continue
		}
		orphans = append(orphans, claim)
	}
	slices.SortFunc(orphans, func(a, b Claim) int { return cmp.Compare(a.LegID, b.LegID) })
	return orphans
}
