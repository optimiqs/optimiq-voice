package rtp

import (
	"fmt"
	"time"
)

// The Manager's half of rung 6: rooms, seats, and the tap that is a seat with asymmetric routing.
//
// # A tap IS a mix-minus participant, and this file is where that claim is cashed
//
// plans/mediad-design.md §10 question 4's W6 addendum records the project lead's decision, and it is
// the reason `rpc.media.v1.tap-session` was shaped the way it was before there was anything here to
// serve it:
//
//	A tap is NOT a snoop channel at the contract level. It is an ASYMMETRIC BRIDGE PARTICIPANT.
//	`speakTo: "none"` is a participant whose contribution is subtracted from everybody's mix,
//	`speakTo: "a"` is one whose contribution appears in exactly one peer's mix — so the rung-6
//	mixer serves this contract BY ARRIVING, not by being extended.
//
// It arrived, and it does. `Tap` below constructs a `JoinOptions` and calls the same `join` a plain
// participant calls. Eavesdrop, whisper and barge are three `Audience` pairs with no branch between
// them, which is what the addendum predicted and is the whole test of whether the prediction was
// right.
//
// # Tapping a two-party call converts it from a relay into a mix, and that costs something
//
// A bridge is two pointers and no buffer. A conference is a jitter buffer, a decode and an encode
// per participant. So the moment a supervisor listens to a call, that call gains the mixer's playout
// delay — sixty milliseconds at the starting depth — and the two parties' codecs start going through
// a decode/encode round trip they were passing through before.
//
// That is stated rather than hidden because it is audible at the transition and somebody will ask.
// The alternative — a listener fed from a copy of the relay — cannot work for whisper or barge,
// which need audio going the other way, and would mean two implementations of supervision where the
// contract was deliberately shaped to need one. The conversion is also why the conference keeps the
// BRIDGE's id: the engine tears down what it created, under the name it created it with, and a
// supervisor having joined in between must not change that.
//
// The call does NOT convert back when the tap leaves. Switching a live conversation from mix to
// relay means dropping the buffered frames and resetting both codecs mid-sentence — an audible click
// and a moment of silence — to give back sixty milliseconds on a call that has already had them.
// The seam for doing it is `Manager.LeaveConference` returning the last two members, and it is
// deliberately not taken.

// TapOptions is one supervisor joining a conversation on asymmetric terms.
type TapOptions struct {
	// TapID is the caller-assigned handle. `untap-session` carries nothing else.
	TapID string
	// TapSessionID is the supervisor's OWN media session, already allocated. mediad does not create
	// it: a tap is a routing statement about sessions that exist, not a second kind of session.
	TapSessionID string
	// TargetSessionID names any leg in the conversation being joined.
	TargetSessionID string
	// TargetSide is which side of the conversation TargetSessionID IS — SideA or SideB.
	//
	// EMPTY means "not declared", and that is a supported state rather than a defect: it is what a
	// caller compiled before `rpc.media.v1.tap-session` grew the field sends, and it is read as
	// SideA — the target-first convention this file used to enforce by join order. See resolveAudiences.
	TargetSide Side
	// Hear is which parties reach the supervisor; SpeakTo is which parties the supervisor reaches.
	Hear    Side
	SpeakTo Side
	// Mode is the feature's own name for the combination — `eavesdrop`, `whisper`, `barge`. For LOGS
	// only and deliberately not authoritative, exactly as `MediaPort.TapRequest.mode` says: Hear and
	// SpeakTo are the contract, and a driver that branched on this could disagree with them.
	Mode string
}

// TapResult is what a successful tap produced.
type TapResult struct {
	// ConferenceID is the room the tap joined, which is the BRIDGE id when a two-party call was
	// converted into one.
	ConferenceID string
	// SessionIDs is everybody in the room afterwards, including the tap.
	SessionIDs []string
	// Converted is true when a two-party relay became a mix to serve this tap. The one fact an
	// operator needs to explain "the call developed an echo the moment I started listening".
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
	// A session is in exactly one conversation. Leaving whatever it was in first is what stops a leg
	// being in a bridge and a room at once, which would deliver every frame twice under one SSRC.
	//
	// It does NOT leave the room it is about to join, and that exception is load-bearing: re-joining
	// the same room is a RE-POINT — a supervisor escalating from whisper to barge — and taking the
	// member out and putting them back would drop their jitter buffer and reset their codec
	// mid-sentence, which the coached agent hears as a gap in the middle of being coached.
	m.unbridgeSessionLocked(sessionID)
	if current, ok := m.conferenceOfLocked(sessionID); ok && current != conferenceID {
		m.leaveConferenceLocked(sessionID)
	}

	conference, existed := m.conferences[conferenceID]
	if !existed {
		conference = m.newConferenceLocked(conferenceID)
	}
	m.mu.Unlock()

	// join OUTSIDE the manager lock: it builds a codec pair, which allocates, and holding the map's
	// mutex across every join in the process would serialise call setup behind conference setup.
	if _, err := conference.join(session, opts); err != nil {
		// A room that was created for this join and could not take it is torn down again rather than
		// left running an empty mix loop nobody will ever destroy.
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
			// Any tap whose own session just left is gone with it. A tap record that outlived its
			// session would be a supervisor the engine believes is still listening, which is the one
			// direction on a compliance surface where the wrong answer is expensive.
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
// The sessions SURVIVE. Destroying a room is not hanging up the calls in it, exactly as unbridging
// is not hanging up the two legs: the engine decides what happens to a participant whose conference
// ended, and a media plane that released them would be making that decision on the far side of the
// seam.
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

// destroyConferenceIfEmpty reaps a room nobody is in.
//
// Rooms are implicit — created by the first join — so they have to be reaped by the last leave, or
// every conference that ever happened would leave a mix loop ticking fifty times a second forever.
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

// Tap joins a supervisor to a conversation on asymmetric terms. Rung 6.
//
// # How `a` and `b` are resolved, and the obligation that has now moved
//
// `MediaPort.TapRequest` has always carried a `targetSide` saying which side of the call the target
// leg IS, because on ARI a tap is a direction on one channel and "speak to the agent" is only
// implementable once you know whether this channel is the agent. `rpc.media.v1.tap-session` did not
// carry it, so this implementation fixed the only convention it could defend from the ids in the
// request — `a` is the TARGET and `b` is the other party — and enforced it by joining the two legs
// TARGET-FIRST when it converted a relay into a mix. That worked and it put the obligation in the
// wrong place: the engine had to pass, as `targetSessionId`, the leg it would have called side `a`,
// which is a rule living in prose on both sides of a language border.
//
// The field is on the wire now. {@link TapOptions.TargetSide} says which side the target is, the
// letters are resolved through it, and an engine that knows its supervisor is monitoring the B-leg
// of an inbound call says so instead of reordering its arguments. An EMPTY TargetSide is read as
// SideA, which is exactly the old convention — so a caller that has not been taught to send it
// behaves as it always did.
//
// Join order is consequently cosmetic. It is still deterministic (see conversationFor) because a
// deterministic member order makes a log line and a test readable, and no longer because anything
// depends on it.
//
// On a room with more than two members the letters have no meaning at all, and `a`/`b` are refused
// by name rather than resolved to whoever happens to be second in the join order.
func (m *Manager) Tap(opts TapOptions) (TapResult, error) {
	switch {
	case opts.TapID == "":
		return TapResult{}, fmt.Errorf("rtp: a tap id is required")
	case opts.TapSessionID == "":
		return TapResult{}, fmt.Errorf("rtp: a tap needs the supervisor's own session id")
	case opts.TargetSessionID == "":
		return TapResult{}, fmt.Errorf("rtp: a tap needs a target session id")
	case opts.TapSessionID == opts.TargetSessionID:
		// A session tapping itself is a loop, and the only way to ask for one is a caller that has
		// confused the supervisor's leg with the agent's.
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
// CONFERENCE afterwards — see the package note on why it is not converted back.
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
// Three cases, and the middle one is the interesting one:
//
//  1. Already in a conference: use it.
//  2. In a two-party BRIDGE: convert the relay into a conference under the BRIDGE's id.
//  3. In neither: there is no conversation to join, and a tap on a leg that is talking to nobody is
//     refused rather than served as a room of one. A supervisor listening to silence and being told
//     it worked is worse than being told there was nothing to listen to.
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

	// The conversion. Both legs join TARGET-FIRST, which used to be what made `a` the target and `b`
	// the other party. It no longer carries that meaning — TapOptions.TargetSide does — and the order
	// is kept because a deterministic member list is what makes a log line and a test readable.
	ordered := [2]string{targetSessionID, pair[0]}
	if pair[0] == targetSessionID {
		ordered[1] = pair[1]
	}
	for _, sessionID := range ordered {
		if err := m.JoinConference(bridgeID, sessionID, JoinOptions{
			Hear:    Everyone(),
			SpeakTo: Everyone(),
		}); err != nil {
			// Half-converted is the one state that must not survive: one leg mixing and one relaying
			// is a call where one party can hear and the other cannot. Everything goes back.
			m.DestroyConference(bridgeID)
			return "", false, nil, err
		}
	}
	return bridgeID, true, ordered[:], nil
}

// resolveAudiences turns the tap's two sides into the two member sets the mixer routes on.
//
// The letters are resolved THROUGH TapOptions.TargetSide, which is the whole of what that field
// bought: the target is whichever side the caller said it is, and the other party is the other
// letter. An empty TargetSide means the caller has not been taught to send one and is read as SideA
// — the target-first convention this file enforced by join order before the field existed.
func resolveAudiences(opts TapOptions, peers []string) (hear, speakTo Audience, err error) {
	targetSide := opts.TargetSide
	if targetSide == "" {
		targetSide = SideA
	}
	if targetSide != SideA && targetSide != SideB {
		// `both` and `none` are answers to "which parties", not to "which one is this leg". A caller
		// sending one has confused the two fields, and guessing which they meant is how a whisper
		// ends up coaching the customer.
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

// otherParty finds the one member of a two-party conversation that is not the target or the tap.
//
// It answers `false` for a room that does not have exactly one, which is what turns `a`/`b` on an
// N-way conference into a refusal that names the gap rather than a guess about join order.
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
