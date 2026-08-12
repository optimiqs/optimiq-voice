package dialog

import (
	"context"
	"errors"
	"sort"
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

// Store is this instance's dialog table.
//
// # What it is, and what it deliberately is not
//
// It is the in-memory truth. Dialogs live in memory and there is no other option: a dialog's
// transaction state, its retransmission timers and its socket are all local, and its Contact tells
// the far end which host to send mid-dialog requests to (design §6.1). A second process cannot
// receive the BYE and cannot retransmit the 2xx, so there is nothing to distribute.
//
// What IS distributed is a CLAIM — one record per dialog in a `sip-dialogs` KV bucket, carrying a
// lease its owner heartbeats (design §6.2). The claim exists for exactly one job: reaping. When an
// instance dies, a survivor finds the expired claims and publishes the terminations their owner
// never got to, so the engine writes CDR rows for calls that ended when a pod was rescheduled.
// It is NOT failover; nothing can fail a dialog over.
//
// # Ownership
//
// The store is safe for concurrent use. A *Dialog it hands out is NOT — one goroutine owns one
// dialog (see the package comment). The store therefore lends pointers and never mutates a dialog
// itself; the one exception is Rebind, which touches the index and not the dialog.
type Store struct {
	mu sync.RWMutex
	// byLeg is the authority. Everything else is an index into it.
	byLeg map[string]*Dialog
	// byIdentity maps a full dialog triple to a legId: the lookup for every mid-dialog request.
	byIdentity map[string]string
	// byEarly maps a Call-ID plus our own tag to a legId, for the window before the far end's tag
	// is known. A UAC's CANCEL, its Timer B and its 100 all land in that window.
	byEarly map[string]string

	instanceID string
	lease      time.Duration
	now        func() time.Time
}

// StoreOptions configures a Store. Every field a test needs is here.
type StoreOptions struct {
	// InstanceID stamps every claim, and is what an engine command's subject token addresses
	// (design §10.2). A dialog lives on one process, so the command for it must too.
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
		instanceID: opts.InstanceID,
		lease:      opts.Lease,
		now:        opts.Now,
	}
	if store.now == nil {
		store.now = time.Now
	}
	if store.lease <= 0 {
		// Ninety seconds: long enough that a heartbeat every thirty has two chances to land through
		// a broker blip, short enough that a rescheduled pod's calls are reaped inside a support
		// call rather than inside a billing cycle.
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

// Rebind re-indexes a dialog whose remote tag has just been learned.
//
// It exists because a UAC dialog's identity is INCOMPLETE until the far end answers with a tag
// (RFC 3261 §12.1.2), and the BYE that arrives ten minutes later is matched on the complete triple.
// A store that never re-indexed would answer 481 to every mid-dialog request on every outbound call.
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
	return nil
}

// Get looks a dialog up by its leg id, which is the only key.
func (s *Store) Get(legID string) (*Dialog, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	dialog, found := s.byLeg[legID]
	return dialog, found
}

// MatchRequest finds the dialog a mid-dialog request belongs to.
//
// The full triple first, then the early index. The order matters: a re-INVITE on a confirmed dialog
// and a CANCEL for one that is still early both arrive as requests, and matching the early index
// first would let a stranger who guessed a Call-ID and our tag reach a confirmed call.
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

// MatchResponse finds the dialog a response to one of OUR requests belongs to.
//
// A response is matched on the early key, because the whole point of the first response with a tag
// is that we did not know the tag before it. Once the tag is known, Rebind moves the dialog into
// the full index and later responses match there too — hence both lookups.
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
// # The tag mapping, which is the whole of RFC 3891 §3 and is easy to get backwards
//
// The tags in a Replaces are written from the point of view of the UA that SENDS it. So the
// `to-tag` is compared against OUR local tag and the `from-tag` against the remote one — the same
// orientation an incoming request has, which is why this is a plain identity lookup and not a
// second index.
//
// `early-only` narrows the match to a dialog that has not been answered, and is refused rather than
// ignored when the dialog is confirmed: it exists so a transfer target can decline to replace a
// call that has already been picked up by somebody else, and ignoring it would complete a transfer
// into a live conversation.
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
	delete(s.byIdentity, dialog.Identity.Key())
	delete(s.byEarly, dialog.Identity.EarlyKey())
}

// Len reports how many dialogs this instance holds. It is the number that decides whether a drain
// may finish, and the one a readiness probe should refuse to shut down under.
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
	ids := make([]string, 0, len(s.byLeg))
	for id := range s.byLeg {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// ---------------------------------------------------------------------------------------------
// claims
// ---------------------------------------------------------------------------------------------

// Claim is the `sip-dialogs` record: what a SECOND process can truthfully say about a dialog it
// does not hold (design §6.2).
//
// The field set and the JSON spellings mirror the design document's example record. It is NOT
// organisation-scoped as a key — the third exception after `did-index` and `media-sessions`, for
// the identical reason: the reader does not know the tenant. An engine reconciling a `legId` from a
// `leg-ended`, or a surviving sipd reaping a dead peer, has no org to prefix with. The org travels
// in the value.
type Claim struct {
	LegID      string `json:"legId"`
	InstanceID string `json:"instanceId"`
	OrgID      string `json:"orgId,omitempty"`
	CallID     string `json:"callId,omitempty"`
	// Role is "uas" when we answered and "uac" when we called.
	Role string `json:"role"`
	// SIPCallID, LocalTag and RemoteTag are the dialog triple. A LOOKUP KEY and never an
	// authorisation — the rule `sipTransferRequestSchema.sipCallId` already states.
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

// Expired reports whether the claim's lease has lapsed at the given instant. A lapsed claim is one
// whose owner has stopped heartbeating, which means either the process died or it cannot reach the
// broker — and both of those are calls nobody will ever write a CDR for unless somebody reaps them.
func (c Claim) Expired(now time.Time) bool {
	return now.UnixMilli() >= c.ExpiresAt
}

// ClaimFor renders the current claim for a dialog this instance holds.
func (s *Store) ClaimFor(dialog *Dialog) Claim {
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

// Claims renders every live dialog's claim, for the heartbeat sweep.
func (s *Store) Claims() []Claim {
	s.mu.RLock()
	dialogs := make([]*Dialog, 0, len(s.byLeg))
	for _, dialog := range s.byLeg {
		dialogs = append(dialogs, dialog)
	}
	s.mu.RUnlock()

	claims := make([]Claim, 0, len(dialogs))
	for _, dialog := range dialogs {
		claims = append(claims, s.ClaimFor(dialog))
	}
	sort.Slice(claims, func(i, j int) bool { return claims[i].LegID < claims[j].LegID })
	return claims
}

// ClaimStore is the `sip-dialogs` bucket, as an interface.
//
// # Why this is an interface with a memory implementation today
//
// The bucket DEFINITION — its name, TTL, storage and limits — belongs in packages/events-go
// alongside every other one, so sipd cannot disagree with the TypeScript services about what it is
// talking to (the rule internal/kv states). That definition does not exist yet and is not this
// module's to add. So the seam is here, the memory implementation backs the tests and a
// single-instance deployment, and the NATS one is a forty-line file the moment the contract lands.
//
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
	sort.Slice(claims, func(i, j int) bool { return claims[i].LegID < claims[j].LegID })
	return claims, nil
}

// Orphans returns the claims that belong to some OTHER instance and whose lease has lapsed.
//
// It is deliberately not "every expired claim": our own expired claim means our own heartbeat is
// late, and reaping our own live calls because the broker was slow would turn a network blip into
// dropped calls. A claim we still hold is refreshed by the next heartbeat; a claim we do not hold
// and that nobody has refreshed is a dead instance's, and publishing its termination is the only
// way the engine ever writes those CDR rows.
func Orphans(claims []Claim, instanceID string, now time.Time) []Claim {
	orphans := make([]Claim, 0)
	for _, claim := range claims {
		if claim.InstanceID == instanceID || !claim.Expired(now) {
			continue
		}
		orphans = append(orphans, claim)
	}
	sort.Slice(orphans, func(i, j int) bool { return orphans[i].LegID < orphans[j].LegID })
	return orphans
}
