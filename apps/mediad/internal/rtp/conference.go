package rtp

import (
	"fmt"
	"time"
)

// Conference rooms, seats, and the tap that is a seat with asymmetric routing.
//
// A tap is an asymmetric bridge participant, not a snoop channel: Tap builds a JoinOptions and calls
// the same join a plain participant calls, so eavesdrop, whisper and barge are three Audience pairs
// with no branch between them.
//
// Tapping a two-party call converts the relay into a mix under the BRIDGE's id (the engine tears
// down what it created, under the name it created it with). The conversation gains the mixer's
// playout delay and a decode/encode round trip, which is audible at the transition. It is NOT
// converted back when the tap leaves: that would drop buffered frames and reset both codecs
// mid-sentence.

// TapOptions is one supervisor joining a conversation on asymmetric terms.
type TapOptions struct {
	// TapID is the caller-assigned handle. `untap-session` carries nothing else.
	TapID string
	// TapSessionID is the supervisor's OWN media session, already allocated. mediad does not create
	// it: a tap is a routing statement about sessions that exist, not a second kind of session.
	TapSessionID string
	// TargetSessionID names any leg in the conversation being joined.
	TargetSessionID string
	// TargetSide is which side of the conversation TargetSessionID IS — SideA or SideB. Empty means
	// "not declared" and is read as SideA, the target-first convention. See resolveAudiences.
	TargetSide Side
	// Hear is which parties reach the supervisor; SpeakTo is which parties the supervisor reaches.
	Hear    Side
	SpeakTo Side
	// Mode is the feature's own name for the combination — `eavesdrop`, `whisper`, `barge`. For logs
	// only and not authoritative: Hear and SpeakTo are the contract.
	Mode string
}

// TapResult is what a successful tap produced.
type TapResult struct {
	// ConferenceID is the room the tap joined, which is the BRIDGE id when a two-party call was
	// converted into one.
	ConferenceID string
	// SessionIDs is everybody in the room afterwards, including the tap.
	SessionIDs []string
	// Converted is true when a two-party relay became a mix to serve this tap.
	Converted bool
}

// Conference returns a live room by id.
func (m *Manager) Conference(conferenceID string) (*Conference, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	conference, ok := m.conferences[conferenceID]
	return conference, ok
}

// ConferenceOf reports which room a session is in, if any.
func (m *Manager) ConferenceOf(sessionID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conferenceOfLocked(sessionID)
}

func (m *Manager) conferenceOfLocked(sessionID string) (string, bool) {
	for id, conference := range m.conferences {
		if _, ok := conference.Member(sessionID); ok {
			return id, true
		}
	}
	return "", false
}

// JoinConference seats a session in a room, creating the room if it is the first one there.
//
// Idempotent on (conference, session): re-joining re-points the member's routing and gain rather
// than taking a second seat, which is what a supervisor escalating from whisper to barge needs and
// what a retried command must not break.
func (m *Manager) JoinConference(conferenceID, sessionID string, opts JoinOptions) error {
	if conferenceID == "" {
		return fmt.Errorf("rtp: a conference id is required")
	}
	if !opts.Hear.All() && opts.Hear.ids == nil {
		opts.Hear = Nobody()
	}

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return ErrClosed
	}
	session, ok := m.sessions[sessionID]
	if !ok {
		m.mu.Unlock()
		return fmt.Errorf("%w: %s", ErrUnknownSession, sessionID)
	}
	// A session is in exactly one conversation; being in a bridge and a room at once would deliver
	// every frame twice under one SSRC. It does NOT leave the room it is about to join: re-joining
	// the same room is a re-point, and a leave/join would drop the jitter buffer and reset the codec
	// mid-sentence.
	m.unbridgeSessionLocked(sessionID)
	if current, ok := m.conferenceOfLocked(sessionID); ok && current != conferenceID {
		m.leaveConferenceLocked(sessionID)
	}

	conference, existed := m.conferences[conferenceID]
	if !existed {
		conference = m.newConferenceLocked(conferenceID)
	}
	m.mu.Unlock()

	// join runs outside the manager lock: it builds a codec pair, and holding the map's mutex across
	// every join would serialise call setup behind conference setup.
	if _, err := conference.join(session, opts); err != nil {
		// A room created for this join and unable to take it is torn down rather than left running
		// an empty mix loop nobody will destroy.
		if !existed {
			m.destroyConferenceIfEmpty(conferenceID)
		}
		return err
	}

	m.log.Info("session joined a conference",
		"conferenceId", conferenceID, "sessionId", sessionID,
		"members", conference.Len(), "tapId", opts.TapID)
	return nil
}

// newConferenceLocked creates a room and starts its mix loop. Caller holds m.mu.
func (m *Manager) newConferenceLocked(conferenceID string) *Conference {
	conference := &Conference{
		ID:      conferenceID,
		manager: m,
		log:     m.log.With("conferenceId", conferenceID),
		members: make(map[string]*Member),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	m.conferences[conferenceID] = conference

	m.running.Add(1)
	go func() {
		defer m.running.Done()
		conference.run()
	}()
	return conference
}

// LeaveConference takes a session out of whatever room it is in.
//
// It reports the room and whether the session was in one, so a retried leave answers honestly rather
// than as a failure — the same shape `Unbridge` uses for the same reason.
func (m *Manager) LeaveConference(sessionID string) (string, bool) {
	m.mu.Lock()
	conferenceID, ok := m.leaveConferenceLocked(sessionID)
	m.mu.Unlock()

	if !ok {
		return "", false
	}
	m.destroyConferenceIfEmpty(conferenceID)
	return conferenceID, true
}

// leaveConferenceLocked removes a session from its room. Caller holds m.mu.
func (m *Manager) leaveConferenceLocked(sessionID string) (string, bool) {
	for id, conference := range m.conferences {
		if conference.leave(sessionID) {
			// Any tap whose own session just left goes with it: a record outliving its session is a
			// supervisor the engine believes is still listening.
			for tapID, record := range m.taps {
				if record.tapSessionID == sessionID {
					delete(m.taps, tapID)
				}
			}
			return id, true
		}
	}
	return "", false
}

// DestroyConference ends a room and returns everybody in it to having no conversation.
//
// The sessions survive: destroying a room is not hanging up the calls in it. The engine decides what
// happens to a participant whose conference ended.
func (m *Manager) DestroyConference(conferenceID string) ([]string, bool) {
	m.mu.Lock()
	conference, ok := m.conferences[conferenceID]
	if !ok {
		m.mu.Unlock()
		return nil, false
	}
	delete(m.conferences, conferenceID)
	for tapID, record := range m.taps {
		if record.conferenceID == conferenceID {
			delete(m.taps, tapID)
		}
	}
	m.mu.Unlock()

	members := conference.Members()
	for _, sessionID := range members {
		conference.leave(sessionID)
	}
	conference.Stop()

	m.log.Info("conference destroyed", "conferenceId", conferenceID, "members", len(members))
	return members, true
}

// destroyConferenceIfEmpty reaps a room nobody is in. Rooms are implicit — created by the first join
// — so the last leave must reap them or their mix loop ticks forever.
func (m *Manager) destroyConferenceIfEmpty(conferenceID string) {
	m.mu.Lock()
	conference, ok := m.conferences[conferenceID]
	if !ok || conference.Len() > 0 {
		m.mu.Unlock()
		return
	}
	delete(m.conferences, conferenceID)
	m.mu.Unlock()

	conference.Stop()
	m.log.Info("conference emptied and destroyed", "conferenceId", conferenceID)
}

// tapRecord is what Untap needs to take a tap down.
type tapRecord struct {
	conferenceID string
	tapSessionID string
	mode         string
	startedAt    time.Time
}

// Tap joins a supervisor to a conversation on asymmetric terms.
//
// The `a`/`b` letters are resolved through TapOptions.TargetSide, which says which side the target
// leg is; an empty TargetSide is read as SideA. Join order is therefore cosmetic (still
// deterministic, for readable logs and tests). On a room with more than two members `a`/`b` have no
// meaning and are refused by name rather than guessed from join order.
func (m *Manager) Tap(opts TapOptions) (TapResult, error) {
	switch {
	case opts.TapID == "":
		return TapResult{}, fmt.Errorf("rtp: a tap id is required")
	case opts.TapSessionID == "":
		return TapResult{}, fmt.Errorf("rtp: a tap needs the supervisor's own session id")
	case opts.TargetSessionID == "":
		return TapResult{}, fmt.Errorf("rtp: a tap needs a target session id")
	case opts.TapSessionID == opts.TargetSessionID:
		// A session tapping itself is a loop.
		return TapResult{}, fmt.Errorf("rtp: a session cannot tap itself")
	}

	conferenceID, converted, peers, err := m.conversationFor(opts.TargetSessionID)
	if err != nil {
		return TapResult{}, err
	}

	hear, speakTo, err := resolveAudiences(opts, peers)
	if err != nil {
		return TapResult{}, err
	}

	if err := m.JoinConference(conferenceID, opts.TapSessionID, JoinOptions{
		Hear:    hear,
		SpeakTo: speakTo,
		TapID:   opts.TapID,
	}); err != nil {
		return TapResult{}, err
	}

	m.mu.Lock()
	m.taps[opts.TapID] = tapRecord{
		conferenceID: conferenceID,
		tapSessionID: opts.TapSessionID,
		mode:         opts.Mode,
		startedAt:    m.now(),
	}
	conference := m.conferences[conferenceID]
	m.mu.Unlock()

	members := []string{}
	if conference != nil {
		members = conference.Members()
	}

	m.log.Info("a tap joined a conversation",
		"tapId", opts.TapID, "conferenceId", conferenceID,
		"tapSessionId", opts.TapSessionID, "targetSessionId", opts.TargetSessionID,
		"hear", string(opts.Hear), "speakTo", string(opts.SpeakTo), "mode", opts.Mode,
		"convertedFromRelay", converted)

	return TapResult{ConferenceID: conferenceID, SessionIDs: members, Converted: converted}, nil
}

// Untap takes a tap down, leaving the monitored conversation running.
//
// Reports whether there was one, so a retried untap answers honestly. The conversation stays a
// conference afterwards — see the file note on why it is not converted back.
func (m *Manager) Untap(tapID string) (string, bool) {
	m.mu.Lock()
	record, ok := m.taps[tapID]
	if ok {
		delete(m.taps, tapID)
	}
	m.mu.Unlock()

	if !ok {
		return "", false
	}
	m.LeaveConference(record.tapSessionID)
	m.log.Info("a tap left", "tapId", tapID, "conferenceId", record.conferenceID,
		"listenedForMs", m.now().Sub(record.startedAt).Milliseconds())
	return record.tapSessionID, true
}

// TapConference reports which room a tap is in, if any.
func (m *Manager) TapConference(tapID string) (string, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, ok := m.taps[tapID]
	return record.conferenceID, ok
}

// conversationFor finds — or builds — the room the target session's conversation happens in.
//
// Three cases:
//
//  1. Already in a conference: use it.
//  2. In a two-party bridge: convert the relay into a conference under the bridge's id.
//  3. In neither: refused, rather than served as a room of one.
func (m *Manager) conversationFor(targetSessionID string) (string, bool, []string, error) {
	m.mu.Lock()
	if _, ok := m.sessions[targetSessionID]; !ok {
		m.mu.Unlock()
		return "", false, nil, fmt.Errorf("%w: %s", ErrUnknownSession, targetSessionID)
	}
	if conferenceID, ok := m.conferenceOfLocked(targetSessionID); ok {
		conference := m.conferences[conferenceID]
		m.mu.Unlock()
		return conferenceID, false, conference.Members(), nil
	}

	var bridgeID string
	var pair [2]string
	for id, members := range m.bridges {
		if members[0] == targetSessionID || members[1] == targetSessionID {
			bridgeID, pair = id, members
			break
		}
	}
	m.mu.Unlock()

	if bridgeID == "" {
		return "", false, nil, fmt.Errorf("%w: %s", ErrNotInConversation, targetSessionID)
	}

	// Both legs join target-first, for a deterministic member list; the letters come from
	// TapOptions.TargetSide, not from this order.
	ordered := [2]string{targetSessionID, pair[0]}
	if pair[0] == targetSessionID {
		ordered[1] = pair[1]
	}
	for _, sessionID := range ordered {
		if err := m.JoinConference(bridgeID, sessionID, JoinOptions{
			Hear:    Everyone(),
			SpeakTo: Everyone(),
		}); err != nil {
			// Half-converted must not survive: one leg mixing and one relaying is a call where one
			// party can hear and the other cannot.
			m.DestroyConference(bridgeID)
			return "", false, nil, err
		}
	}
	return bridgeID, true, ordered[:], nil
}

// resolveAudiences turns the tap's two sides into the two member sets the mixer routes on.
//
// The target is whichever side TapOptions.TargetSide names, and the other party is the other letter.
// An empty TargetSide is read as SideA.
func resolveAudiences(opts TapOptions, peers []string) (hear, speakTo Audience, err error) {
	targetSide := opts.TargetSide
	if targetSide == "" {
		targetSide = SideA
	}
	if targetSide != SideA && targetSide != SideB {
		// `both` and `none` answer "which parties", not "which one is this leg".
		return Audience{}, Audience{}, fmt.Errorf(
			"rtp: targetSide must be %q or %q, got %q", SideA, SideB, targetSide)
	}

	sideOf := func(side Side) (Audience, error) {
		switch side {
		case SideBoth:
			return Everyone(), nil
		case SideNone:
			return Nobody(), nil
		case SideA, SideB:
			if side == targetSide {
				return Only(opts.TargetSessionID), nil
			}
			other, ok := otherParty(peers, opts.TargetSessionID, opts.TapSessionID)
			if !ok {
				return Audience{}, fmt.Errorf(
					"%w: side %q names the other party of a two-party conversation, and %s is in a room "+
						"of %d; use both or none",
					ErrNotInConversation, side, opts.TargetSessionID, len(peers))
			}
			return Only(other), nil
		default:
			return Audience{}, fmt.Errorf("rtp: unknown conversation side %q", side)
		}
	}

	if hear, err = sideOf(opts.Hear); err != nil {
		return Audience{}, Audience{}, err
	}
	if speakTo, err = sideOf(opts.SpeakTo); err != nil {
		return Audience{}, Audience{}, err
	}
	return hear, speakTo, nil
}

// otherParty finds the one member of a two-party conversation that is not the target or the tap. It
// answers false for a room without exactly one, turning `a`/`b` on an N-way conference into a refusal.
func otherParty(peers []string, targetSessionID, tapSessionID string) (string, bool) {
	var found string
	for _, id := range peers {
		if id == targetSessionID || id == tapSessionID {
			continue
		}
		if found != "" {
			return "", false
		}
		found = id
	}
	return found, found != ""
}
