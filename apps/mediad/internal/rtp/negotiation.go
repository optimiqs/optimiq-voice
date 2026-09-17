package rtp

import (
	"errors"
	"sync"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// Negotiation is what one offer/answer exchange committed to for a session: the SDP body handed
// back to the requester and the local crypto attribute that body advertises.
//
// It belongs to the session it names — a released session's negotiation is dropped with it — and is
// versioned, so a pending answer can be tied to the generation that offered it. The SDP and the
// SRTPContext protecting the packets it describes are committed TOGETHER (see Negotiate): that is
// what stops a retry advertising one key while the socket encrypts with another.
type Negotiation struct {
	// Generation counts the committed exchanges on this session, starting at 1.
	Generation uint64
	// Request identifies the command that produced this result. An identical command replays the
	// result instead of drawing new key material.
	Request string
	// SDP is the answer or offer body that was handed back.
	SDP string
	// Local is the crypto attribute that body advertises; the zero value is a plain-RTP leg.
	Local sdp.Crypto
	// Pending is true while Local has no counterpart yet: a leg create-offer keyed, waiting for the
	// callee's answer. Settling that answer commits a new generation with Pending false.
	Pending bool
}

// Committed reports whether any exchange has completed for the session.
func (n Negotiation) Committed() bool { return n.Generation > 0 }

// negotiations holds one lock and one committed result per session id. The lock has to live outside
// the session because the FIRST exchange runs before the session exists.
type negotiations struct {
	mu        sync.Mutex
	locks     map[string]*negotiationLock
	committed map[string]Negotiation
}

type negotiationLock struct {
	mu   sync.Mutex
	refs int
}

func (n *negotiations) acquire(sessionID string) *negotiationLock {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.locks == nil {
		n.locks = make(map[string]*negotiationLock)
	}
	held, ok := n.locks[sessionID]
	if !ok {
		held = &negotiationLock{}
		n.locks[sessionID] = held
	}
	held.refs++
	return held
}

func (n *negotiations) release(sessionID string, held *negotiationLock) {
	n.mu.Lock()
	defer n.mu.Unlock()
	held.refs--
	if held.refs == 0 && n.locks[sessionID] == held {
		delete(n.locks, sessionID)
	}
}

func (n *negotiations) current(sessionID string) Negotiation {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.committed[sessionID]
}

func (n *negotiations) commit(sessionID string, committed Negotiation) {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.committed == nil {
		n.committed = make(map[string]Negotiation)
	}
	n.committed[sessionID] = committed
}

// forget drops a session's negotiation. Called when the session ends and when a session id is bound
// afresh, so a reused id never inherits the key material of the call before it.
func (n *negotiations) forget(sessionID string) {
	n.mu.Lock()
	defer n.mu.Unlock()
	delete(n.committed, sessionID)
}

// Negotiate runs one offer/answer exchange for a session id under a lock private to that id.
//
// exchange sees the negotiation the session last committed and whether request matches it — a
// retried command. It may allocate the session, since the lock it runs under is not the manager's.
// It returns the negotiation to commit together with the SRTP context that negotiation implies, or
// a nil negotiation to commit nothing, which is what a replay does: the caller answers with the
// prior SDP and the session keeps the context it is already encrypting with.
//
// The generation is assigned here; the caller does not set it.
func (m *Manager) Negotiate(
	sessionID, request string,
	exchange func(prior Negotiation, replay bool) (*Negotiation, *SRTPContext, error),
) (Negotiation, error) {
	if sessionID == "" {
		return Negotiation{}, errors.New("rtp: a session id is required")
	}
	held := m.negotiating.acquire(sessionID)
	defer m.negotiating.release(sessionID, held)
	held.mu.Lock()
	defer held.mu.Unlock()

	prior := m.negotiating.current(sessionID)
	committed, secure, err := exchange(prior, prior.Committed() && prior.Request == request)
	if err != nil {
		return Negotiation{}, err
	}
	if committed == nil {
		return prior, nil
	}

	next := *committed
	if next.Request == "" {
		// A settle carries the offer's identity forward, so a later retry of that offer still
		// replays it; a fresh exchange takes the request that produced it.
		next.Request = request
	}
	next.Generation = prior.Generation + 1
	if secure != nil {
		session, err := m.liveSession(sessionID)
		if err != nil {
			return Negotiation{}, err
		}
		// The context replaces whatever the session held: a rekey is a new generation, and the SDP
		// that advertises it is committed in the same breath.
		session.srtp.Store(secure)
	}
	m.negotiating.commit(sessionID, next)
	return next, nil
}
