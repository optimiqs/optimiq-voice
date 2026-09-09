package rtp

import (
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// N-way mixing with mix-minus per participant: every member is decoded, aligned on one clock,
// summed, and re-encoded, because the audio each receives differs from every other's.
//
// A participant must not hear themselves — delayed self-audio is the most disruptive artefact in
// telephony — so each member receives the room total MINUS their own contribution. Subtracting keeps
// the room O(N) rather than O(N²), and it is only valid because the total is accumulated WITHOUT
// clamping, in int32, and clamped once per member after the subtraction. Saturating into the total
// would make total-minus-self stop being the sum of the others.
//
// gainRx scales what a member CONTRIBUTES and gainTx what they RECEIVE; they are separate knobs
// because "turn that participant down for everybody" and "turn everything down for them" differ.

// ErrNotInConversation is returned when there is nothing to tap or nothing to leave.
var ErrNotInConversation = errors.New("rtp: the session is not in a bridge or a conference")

// ErrConferenceCodec is returned when a member's codec cannot be decoded for the mix. A mix is the
// one operation that cannot be served by passing bytes through.
var ErrConferenceCodec = errors.New("rtp: this codec cannot be mixed")

// unityGain is 1.0 in the mixer's Q8 fixed point: 256 units to the whole. Fixed point keeps the mix
// integer arithmetic end to end; eight fractional bits is about 0.03 dB near unity.
const unityGain int32 = 256

// Side names one half of a two-party conversation. A SIDE is a party in a conversation, where a
// DIRECTION is a property of one channel.
type Side string

// The four sides.
const (
	// SideA is the TARGET session — the leg the tap names.
	SideA Side = "a"
	// SideB is the other party in the target's conversation.
	SideB Side = "b"
	// SideBoth is everybody in the conversation.
	SideBoth Side = "both"
	// SideNone is nobody. Only meaningful on `speakTo`, where it is the silent supervisor.
	SideNone Side = "none"
)

// ParseSide validates a side from the wire.
func ParseSide(raw string) (Side, error) {
	switch Side(raw) {
	case SideA, SideB, SideBoth, SideNone:
		return Side(raw), nil
	default:
		return "", fmt.Errorf("rtp: unknown conversation side %q (want a, b, both or none)", raw)
	}
}

// Audience is the set of members one routing decision applies to. The `all` case is the shape the
// total-minus-self subtraction is valid for; an enumerated audience takes an O(N)-per-member path.
type Audience struct {
	all bool
	ids map[string]struct{}
}

// Everyone is the audience a plain conference participant has on both sides.
func Everyone() Audience { return Audience{all: true} }

// Nobody is the empty audience: an eavesdropper's `speakTo`.
func Nobody() Audience { return Audience{} }

// Only is an audience of named members.
func Only(ids ...string) Audience {
	set := make(map[string]struct{}, len(ids))
	for _, id := range ids {
		if id != "" {
			set[id] = struct{}{}
		}
	}
	return Audience{ids: set}
}

// All reports whether this audience is everybody.
func (a Audience) All() bool { return a.all }

func (a Audience) includes(id string) bool {
	if a.all {
		return true
	}
	_, ok := a.ids[id]
	return ok
}

// JoinOptions is one seat at a conference.
type JoinOptions struct {
	// Hear is which members' audio reaches this one. Everyone, for a plain participant.
	Hear Audience
	// SpeakTo is which members this one's audio reaches. Everyone, for a plain participant.
	SpeakTo Audience
	// GainRx and GainTx are Q8 fixed-point scalings; zero means unity.
	GainRx int32
	GainTx int32
	// TapID marks this member as a tap rather than a participant. Empty for a party to the call.
	TapID string
}

// Member is one seat at a conference: a session, its jitter buffer, its codecs and its routing.
type Member struct {
	conference *Conference
	session    *Session
	jitter     *JitterBuffer
	decoder    audio.FrameDecoder
	encoder    audio.FrameEncoder

	hear    Audience
	speakTo Audience
	tapID   string

	// gainRx and gainTx are read on the mixer goroutine and written by control commands, so they are
	// atomics rather than fields under the conference lock.
	gainRx atomic.Int32
	gainTx atomic.Int32

	// contribution is this member's decoded, gained frame for the tick in progress. Owned by the
	// mixer goroutine alone and reused across ticks.
	contribution []int32
	// marked is false until this member's first mixed frame has gone out; that frame carries the
	// marker bit, since the stream switches to the mixer's clock exactly once.
	marked bool
}

// SessionID names the member.
func (m *Member) SessionID() string { return m.session.ID }

// TapID is non-empty when this member is a tap rather than a party to the call.
func (m *Member) TapID() string { return m.tapID }

// SetGain adjusts one member's contribution and reception scaling. Zero means unity.
func (m *Member) SetGain(rx, tx int32) {
	if rx <= 0 {
		rx = unityGain
	}
	if tx <= 0 {
		tx = unityGain
	}
	m.gainRx.Store(rx)
	m.gainTx.Store(tx)
}

// Gain reports the current scalings.
func (m *Member) Gain() (rx, tx int32) { return m.gainRx.Load(), m.gainTx.Load() }

// JitterStats is this member's buffer's counters.
func (m *Member) JitterStats() JitterStats { return m.jitter.Stats() }

// receive hands one arrived packet to this member's jitter buffer. Telephone-event packets are NOT
// buffered — decoding one writes noise into the mix — and are relayed instead; see forwardEvent.
func (m *Member) receive(packet *pionrtp.Packet, now time.Time) {
	if tePT := m.session.TelephoneEventPayloadType(); tePT != 0 &&
		packet.PayloadType == tePT {
		m.conference.forwardEvent(m, packet)
		return
	}
	m.jitter.Push(packet.SequenceNumber, packet.Timestamp, packet.Payload, now)
}

// Conference is N sessions hearing the sum of each other.
type Conference struct {
	// ID is the caller-assigned identifier, and stays the bridge id when a tap converted a two-party
	// call into a room, so the engine can tear down what it created under the name it used.
	ID string

	manager *Manager
	log     *slog.Logger

	mu      sync.Mutex
	members map[string]*Member
	// order is the members in join order, so the mix — and its saturation behaviour — is deterministic.
	order []string

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}

	// total, mixed, out and pending belong to the mix loop and nothing else touches them; they are
	// reused across ticks to keep the 20 ms deadline free of GC pressure.
	total   []int32
	mixed   []int32
	out     []int16
	pending []mixFrame
}

// mixFrame is one member's finished frame, waiting to be written OUTSIDE the room lock: a socket
// write under c.mu would stall every join, leave and Members(), some of which hold Manager.mu.
type mixFrame struct {
	session *Session
	payload []byte
	marker  bool
}

// Members lists the session ids in the room, in join order.
func (c *Conference) Members() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.order)
}

// Member finds a seat by session id.
func (c *Conference) Member(sessionID string) (*Member, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	member, ok := c.members[sessionID]
	return member, ok
}

// Len is how many seats are taken.
func (c *Conference) Len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.members)
}

// Done is closed once the mix loop has stopped.
func (c *Conference) Done() <-chan struct{} { return c.done }

// Stop ends the mix loop. Idempotent.
func (c *Conference) Stop() { c.stopOnce.Do(func() { close(c.stop) }) }

// join seats a session. Caller holds nothing; the conference takes its own lock.
func (c *Conference) join(session *Session, opts JoinOptions) (*Member, error) {
	// The codecs are built before the lock and before anything is mutated: this is the one step that
	// can refuse, and a refusal after seating would leave a member contributing nothing.
	format := session.Format()
	decoder, err := audio.NewFrameDecoder(format)
	if err != nil {
		return nil, fmt.Errorf("%w: %s cannot be decoded for a mix: %w",
			ErrConferenceCodec, format, err)
	}
	encoder, err := audio.NewFrameEncoder(format)
	if err != nil {
		return nil, fmt.Errorf("%w: %s cannot be encoded from a mix: %w",
			ErrConferenceCodec, format, err)
	}

	member := &Member{
		conference:   c,
		session:      session,
		jitter:       NewJitterBuffer(session.clockRate()),
		decoder:      decoder,
		encoder:      encoder,
		hear:         opts.Hear,
		speakTo:      opts.SpeakTo,
		tapID:        opts.TapID,
		contribution: make([]int32, audio.FrameSamples),
	}
	member.SetGain(opts.GainRx, opts.GainTx)

	c.mu.Lock()
	if existing, ok := c.members[session.ID]; ok {
		// Re-joining re-points an existing seat (a supervisor escalating whisper to barge); reseating
		// would drop the jitter buffer and reset the codec mid-sentence.
		existing.hear, existing.speakTo = opts.Hear, opts.SpeakTo
		existing.SetGain(opts.GainRx, opts.GainTx)
		c.mu.Unlock()
		return existing, nil
	}
	c.members[session.ID] = member
	c.order = append(c.order, session.ID)
	c.mu.Unlock()

	// A session in a conference has no peer: the mix replaces the relay. Leaving the pointer would
	// put a leg in a bridge and a room at once, delivering every frame twice under one SSRC.
	session.SetPeer(nil)
	session.transcode.Store(nil)
	session.mixMember.Store(member)
	return member, nil
}

// leave takes a session out of the room, reporting whether it was in it.
func (c *Conference) leave(sessionID string) bool {
	c.mu.Lock()
	member, ok := c.members[sessionID]
	if ok {
		delete(c.members, sessionID)
		for index, id := range c.order {
			if id == sessionID {
				c.order = append(c.order[:index], c.order[index+1:]...)
				break
			}
		}
	}
	c.mu.Unlock()

	if !ok {
		return false
	}
	member.session.mixMember.CompareAndSwap(member, nil)
	// The leg is about to hear a different timestamp clock, as at the end of a prompt.
	member.session.markNextForward.Store(true)

	// The only moment the buffer's counters are both final and still attached to a participant.
	stats := member.jitter.Stats()
	c.log.Info("a member left the mix",
		"sessionId", sessionID, "tapId", member.tapID,
		"framesPlayed", stats.Popped, "lost", stats.Lost, "late", stats.Late,
		"reordered", stats.Reordered, "maxDepthFrames", stats.MaxDepthFrames)
	return true
}

// forwardEvent relays one telephone-event packet to everybody the sender speaks to. Only the
// payload type needs renumbering; mixing a digit would be a click and no digit at the far end.
func (c *Conference) forwardEvent(from *Member, packet *pionrtp.Packet) {
	c.mu.Lock()
	targets := make([]*Member, 0, len(c.order))
	for _, id := range c.order {
		member := c.members[id]
		if member == nil || member == from {
			continue
		}
		if from.speakTo.includes(id) && member.hear.includes(from.session.ID) {
			targets = append(targets, member)
		}
	}
	c.mu.Unlock()

	for _, target := range targets {
		target.session.forward(packet, from.session.TelephoneEventPayloadType())
	}
}

// run is the mix loop: one tick, one frame per member, until the conference stops.
func (c *Conference) run() {
	defer close(c.done)

	ticks, stopTicker := c.manager.newTicker(audio.FrameDurationMs * time.Millisecond)
	defer stopTicker()

	for {
		select {
		case <-c.stop:
			return
		case <-ticks:
		}
		c.mixOnce()
	}
}

// mixOnce produces and sends one frame of audio to every member:
//
//  1. Each member's next frame is popped, decoded, and scaled by their receive gain into an int32
//     contribution. A member with nothing to play contributes SILENCE rather than being skipped,
//     which is what keeps the mix on a clock.
//  2. Everybody whose audience is everybody is summed into one UNCLAMPED total.
//  3. Each member's mix is that total minus their own contribution, plus any restricted-audience
//     member who speaks to them.
//  4. The result is scaled by transmit gain, clamped ONCE, encoded, and written out.
func (c *Conference) mixOnce() {
	c.mu.Lock()

	if len(c.order) == 0 {
		c.mu.Unlock()
		return
	}

	total := c.scratchTotal()
	for _, id := range c.order {
		member := c.members[id]
		gain := member.gainRx.Load()

		frame, ok := member.jitter.Pop()
		if !ok {
			clear(member.contribution)
			continue
		}
		samples := member.decoder.DecodeFrame(frame)
		// DecodeFrame copies into the decoder's own scratch, so the frame is dead here and can go back
		// to the buffer. See JitterBuffer.Recycle.
		member.jitter.Recycle(frame)
		for index := range audio.FrameSamples {
			member.contribution[index] = int32(samples[index]) * gain / unityGain
		}

		if member.speakTo.All() {
			for index := range total {
				total[index] += member.contribution[index]
			}
		}
	}

	mixed, out := c.mixed, c.out
	c.pending = c.pending[:0]
	for _, id := range c.order {
		member := c.members[id]

		if member.hear.All() {
			copy(mixed, total)
			if member.speakTo.All() {
				// Mix-minus.
				for index := range mixed {
					mixed[index] -= member.contribution[index]
				}
			}
			// A restricted-audience member is not in `total`, so add them explicitly.
			c.addRestrictedLocked(mixed, member)
		} else {
			clear(mixed)
			for _, otherID := range c.order {
				if otherID == id {
					continue
				}
				other := c.members[otherID]
				if member.hear.includes(otherID) && other.speakTo.includes(id) {
					for index := range mixed {
						mixed[index] += other.contribution[index]
					}
				}
			}
		}

		gain := member.gainTx.Load()
		for index := range mixed {
			// One clamp, at the end: saturating into the running total would break the subtraction.
			out[index] = clampSample(mixed[index] * gain / unityGain)
		}

		marker := !member.marked
		member.marked = true
		// EncodeFrame's output is the one buffer here that is NOT reused: it outlives the lock.
		c.pending = append(c.pending, mixFrame{
			session: member.session,
			payload: member.encoder.EncodeFrame(out),
			marker:  marker,
		})
	}
	pending := c.pending
	c.mu.Unlock()

	for _, frame := range pending {
		frame.session.sendMixFrame(frame.payload, frame.marker)
	}
}

// scratchTotal hands back the room's zeroed accumulator, allocating it on the first tick.
func (c *Conference) scratchTotal() []int32 {
	if c.total == nil {
		c.total = make([]int32, audio.FrameSamples)
		c.mixed = make([]int32, audio.FrameSamples)
		c.out = make([]int16, audio.FrameSamples)
	}
	clear(c.total)
	return c.total
}

// addRestrictedLocked adds the contributions of members whose audience is enumerated.
func (c *Conference) addRestrictedLocked(mixed []int32, to *Member) {
	for _, otherID := range c.order {
		if otherID == to.session.ID {
			continue
		}
		other := c.members[otherID]
		if other.speakTo.All() || !other.speakTo.includes(to.session.ID) {
			continue
		}
		if !to.hear.includes(otherID) {
			continue
		}
		for index := range mixed {
			mixed[index] += other.contribution[index]
		}
	}
}

// clampSample saturates one summed sample into the 16-bit range. A wrap would turn a loud moment
// into a full-amplitude sign flip.
func clampSample(value int32) int16 {
	switch {
	case value > 32767:
		return 32767
	case value < -32768:
		return -32768
	default:
		return int16(value)
	}
}

// sendMixFrame writes one mixed frame out of this session's socket, sharing the session's SSRC,
// sequence counter and timestamp clock with the relay and with playback. Every suppression the
// other sources obey applies here in the same order: DTMF, then playback, then transmit suppression.
func (s *Session) sendMixFrame(payload []byte, marker bool) {
	if s.dtmfActive() {
		s.count(func(st *Stats) { st.SuppressedByDtmf++ })
		return
	}
	if s.playback.Load() != nil {
		// A prompt played AT a member replaces the room for its duration, as it replaces a peer.
		s.count(func(st *Stats) { st.SuppressedByPlayback++ })
		return
	}
	if s.transmitSuppressed() {
		s.countSuppression()
		return
	}

	to := s.Remote()
	if to == nil {
		return
	}

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    s.AudioPayloadType(),
			SequenceNumber: s.nextSequence(),
			Timestamp:      s.nextPlaybackTimestamp(),
			SSRC:           s.SSRC,
			Marker:         marker,
		},
		Payload: payload,
	}

	encoded, scratch, err := marshalOutbound(&out)
	if err != nil {
		s.log.Debug("cannot marshal a mixed frame", "error", err)
		return
	}
	_, err = s.writeRTP(encoded, to)
	releaseOutbound(scratch)
	if err != nil {
		// Per-packet and self-correcting: a room is not torn down over one undelivered frame.
		s.log.Debug("cannot send a mixed frame", "error", err, "remote", to.String())
		return
	}
	s.countSent(uint32(len(payload)))
	s.count(func(st *Stats) { st.MixedFramesSent++ })

	// The send half of a `both` recording: what this leg was told, which is the rest of the room.
	if recorder := s.recording.Load(); recorder != nil {
		recorder.Sent(payload)
	}
}
