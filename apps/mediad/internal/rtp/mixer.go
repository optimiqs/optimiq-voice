package rtp

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Rung 6 of plans/mediad-design.md §2: N-way mixing with mix-minus per participant. The ladder calls
// it "the hard one — this is where jambonz/LiveKit spent years", and the reason is that every
// simplification available at rungs 2-5 stops being available here at once.
//
// A two-party bridge is two pointers and a header rewrite: no decode, no clock, no buffer, no
// arithmetic on the samples. A conference is all four. Every participant must be DECODED (they may
// have negotiated different codecs), ALIGNED (their packets arrive on N unrelated networks and the
// mix needs one frame from each on one clock), SUMMED, and RE-ENCODED per participant — because the
// audio each of them receives is different from the audio every other one receives.
//
// # Mix-minus, and why it is not optional
//
// A participant must not hear themselves. Not because it is untidy: the loop from their microphone
// to their own earpiece is a delayed copy of their own voice at roughly a hundred milliseconds,
// which is the single most disruptive artefact in telephony — it is the effect used deliberately in
// psychology experiments to make people unable to speak. So each participant's own contribution is
// subtracted from the sum they receive, and it is a SUBTRACTION rather than N separate sums, which
// is what keeps an N-party conference O(N) in mixing work rather than O(N²).
//
// That subtraction is only valid because the sum is accumulated WITHOUT clamping, in int32, and
// clamped once per participant after the subtraction. A mixer that saturated into the total would
// find that total-minus-self is not the sum of the others, and the error would appear as a burst of
// distortion in everybody's audio at exactly the moment two people talked loudly at once.
//
// # The seam the volume controls will need
//
// Two gain hooks per member, both unity today: `gainRx` scales what a participant CONTRIBUTES and
// `gainTx` scales what they RECEIVE. Two rather than one because they are different features — "turn
// that participant down for everybody" and "turn everything down for that participant" — and a
// single knob would make the first indistinguishable from the second on a two-party call and
// impossible on a larger one.

// ErrNotInConversation is returned when there is nothing to tap or nothing to leave.
var ErrNotInConversation = errors.New("rtp: the session is not in a bridge or a conference")

// ErrConferenceCodec is returned when a member's codec cannot be decoded for the mix.
//
// The one refusal a conference makes that is not about the request: an Opus leg cannot join a mix
// because this build has no Opus codec (see internal/audio/g722.go for the cgo decision), and a mix
// is the one operation that cannot be served by passing bytes through.
var ErrConferenceCodec = errors.New("rtp: this codec cannot be mixed")

// unityGain is 1.0 in the mixer's Q8 fixed point: 256 units to the whole.
//
// Fixed point rather than float64 because the mix is integer arithmetic from end to end and one
// float in the middle of it would mean a conversion per sample per member per tick for a precision
// nobody can hear. Eight fractional bits is a resolution of about 0.03 dB near unity, which is finer
// than any volume control a person will ever be given.
const unityGain int32 = 256

// Side names one half of a two-party conversation.
//
// The vocabulary `rpc.media.v1.tap-session` carries, and the same one `MediaPort.TapSide` defines:
// a SIDE is a party in a conversation, where a DIRECTION is a property of one channel. The
// distinction is the whole reason the tap contract is not a snoop — see design doc §10 question 4's
// W6 addendum.
type Side string

// The four sides.
const (
	// SideA is the TARGET session — the leg the tap names. See the note on TapOptions about why this
	// convention exists and what the contract still owes it.
	SideA Side = "a"
	// SideB is the other party in the target's conversation.
	SideB Side = "b"
	// SideBoth is everybody in the conversation.
	SideBoth Side = "both"
	// SideNone is nobody. Only ever meaningful on `speakTo`, where it is the silent supervisor.
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

// Audience is the set of members one routing decision applies to.
//
// `all` rather than an enumerated set for the common case, and that is a performance decision with a
// correctness consequence: a plain conference is every member with `all` on both sides, which is
// exactly the shape the total-minus-self subtraction is valid for. An enumerated audience takes the
// explicit path, which is O(N) per member — right for a tap, which is one member out of three, and
// wrong as the general case.
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
	// GainRx and GainTx are Q8 fixed-point scalings; zero means unity. See the package note.
	GainRx int32
	GainTx int32
	// TapID marks this member as a TAP rather than a participant, for the diagnostics and for
	// Untap. Empty for a real party to the call.
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

	// gainRx and gainTx are read on the mixer goroutine and written by a control command, which is
	// what makes them atomics rather than fields under the conference lock: a volume change must not
	// have to wait for a tick, and a tick must not have to take a lock per member per frame.
	gainRx atomic.Int32
	gainTx atomic.Int32

	// contribution is this member's decoded, gained frame for the tick in progress. Owned by the
	// mixer goroutine alone, and reused across ticks so a conference does not allocate N frames fifty
	// times a second.
	contribution []int32
	// marked is false until this member's first mixed frame has gone out, which is the frame that
	// carries the marker bit — the stream is switching to the mixer's clock exactly once.
	marked bool
}

// SessionID names the member.
func (m *Member) SessionID() string { return m.session.ID }

// TapID is non-empty when this member is a tap rather than a party to the call.
func (m *Member) TapID() string { return m.tapID }

// SetGain adjusts one member's contribution and reception scaling. Zero means unity.
//
// The seam W10's volume controls need, exposed now rather than later because the alternative is
// discovering at the point of use that the mixer has nowhere to put a gain and adding one to a
// shipped mix loop.
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

// receive hands one arrived packet to this member's jitter buffer.
//
// Telephone-event packets are NOT buffered: a digit is not audio, and putting one through a decoder
// writes four bytes of noise into everybody's mix. They are relayed to the conference exactly as
// they cross a bridge — see Conference.forwardEvent — so a participant pressing a feature code in a
// room is still heard by the room, and by the engine's own detector, which ran before this.
func (m *Member) receive(packet *pionrtp.Packet, now time.Time) {
	if m.session.telephoneEventPayloadType != 0 &&
		packet.PayloadType == m.session.telephoneEventPayloadType {
		m.conference.forwardEvent(m, packet)
		return
	}
	m.jitter.Push(packet.SequenceNumber, packet.Timestamp, packet.Payload, now)
}

// Conference is N sessions hearing the sum of each other.
type Conference struct {
	// ID is the caller-assigned identifier. A bridge id when a two-party call was converted into
	// one by a tap, which is deliberate: the engine must be able to tear down what it created under
	// the name it created it with, whether or not somebody supervised it in between.
	ID string

	manager *Manager
	log     *slog.Logger

	mu      sync.Mutex
	members map[string]*Member
	// order is the members in join order, so a mix is deterministic and a test can assert on it.
	// Map iteration order would make the saturation behaviour of a loud conference unreproducible.
	order []string

	stopOnce sync.Once
	stop     chan struct{}
	done     chan struct{}
}

// Members lists the session ids in the room, in join order.
func (c *Conference) Members() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.order...)
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
	// The codecs are built BEFORE the lock and before anything is mutated, because this is the one
	// step that can refuse: a leg whose codec cannot be decoded cannot be in a mix at all, and
	// discovering that after seating it would mean a member in the room contributing nothing.
	decoder, err := audio.NewFrameDecoder(session.format)
	if err != nil {
		return nil, fmt.Errorf("%w: %s cannot be decoded for a mix: %w",
			ErrConferenceCodec, session.format, err)
	}
	encoder, err := audio.NewFrameEncoder(session.format)
	if err != nil {
		return nil, fmt.Errorf("%w: %s cannot be encoded from a mix: %w",
			ErrConferenceCodec, session.format, err)
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
		// Re-joining is a re-POINT rather than a second seat: a supervisor escalating from whisper to
		// barge is exactly this, and taking the member out and putting them back would drop their
		// jitter buffer and reset their codec mid-sentence.
		existing.hear, existing.speakTo = opts.Hear, opts.SpeakTo
		existing.SetGain(opts.GainRx, opts.GainTx)
		c.mu.Unlock()
		return existing, nil
	}
	c.members[session.ID] = member
	c.order = append(c.order, session.ID)
	c.mu.Unlock()

	// A session in a conference has no peer: the mix replaces the relay entirely. Clearing the
	// pointer here rather than leaving it is what stops a leg being in a bridge and a room at once,
	// which would deliver every frame twice under one SSRC.
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
	// The leg is about to start hearing something else — a relay, a prompt, or nothing — from a
	// different timestamp clock. Same flag, same reason, as the end of a prompt.
	member.session.markNextForward.Store(true)

	// The buffer's counters are logged HERE and nowhere else, because this is the only moment they
	// are final and still attached to a participant. "Which participant had the bad network" is a
	// question somebody asks after a conference rather than during one, and it is unanswerable from
	// anywhere else.
	stats := member.jitter.Stats()
	c.log.Info("a member left the mix",
		"sessionId", sessionID, "tapId", member.tapID,
		"framesPlayed", stats.Popped, "lost", stats.Lost, "late", stats.Late,
		"reordered", stats.Reordered, "maxDepthFrames", stats.MaxDepthFrames)
	return true
}

// forwardEvent relays one telephone-event packet to everybody the sender speaks to.
//
// Digits cross a conference for the same reason they cross a bridge: the payload is bytes, the
// format is identical whatever the audio codec is, and only the payload TYPE needs renumbering
// between two legs that negotiated differently. Putting them through the mix instead would decode a
// digit as audio, which is a click in everybody's ears and no digit at the far end.
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
		target.session.forward(packet, from.session.telephoneEventPayloadType)
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

// mixOnce produces and sends one frame of audio to every member.
//
// # The shape of the arithmetic, in order
//
//  1. Every member's next frame is popped from their jitter buffer, decoded, and scaled by their own
//     receive gain into an int32 contribution. A member with nothing to play contributes SILENCE
//     rather than being skipped, which is what keeps the mix on a clock.
//  2. The contributions of everybody who speaks to everybody are summed into one unclamped total.
//  3. Each member's mix is that total minus their own contribution, plus the contributions of any
//     member whose audience is restricted and includes them.
//  4. The result is scaled by the member's transmit gain, clamped ONCE, encoded in their own codec,
//     and written out of their own socket.
//
// Step 3 is where mix-minus lives and step 2 is why it is affordable: the total is computed once for
// the whole room, so adding a participant costs one decode and one encode rather than one more sum
// per existing participant.
func (c *Conference) mixOnce() {
	c.mu.Lock()
	defer c.mu.Unlock()

	if len(c.order) == 0 {
		return
	}

	total := make([]int32, audio.FrameSamples)
	for _, id := range c.order {
		member := c.members[id]
		gain := member.gainRx.Load()

		frame, ok := member.jitter.Pop()
		if !ok {
			for index := range member.contribution {
				member.contribution[index] = 0
			}
			continue
		}
		samples := member.decoder.DecodeFrame(frame)
		for index := 0; index < audio.FrameSamples; index++ {
			member.contribution[index] = int32(samples[index]) * gain / unityGain
		}

		if member.speakTo.All() {
			for index := range total {
				total[index] += member.contribution[index]
			}
		}
	}

	mixed := make([]int32, audio.FrameSamples)
	out := make([]int16, audio.FrameSamples)
	for _, id := range c.order {
		member := c.members[id]

		if member.hear.All() {
			copy(mixed, total)
			if member.speakTo.All() {
				// MINUS SELF. The one line the whole rung is named after.
				for index := range mixed {
					mixed[index] -= member.contribution[index]
				}
			}
			// A member with a restricted audience is not in `total`, so their contribution has to be
			// added explicitly to whoever they do speak to.
			c.addRestrictedLocked(mixed, member)
		} else {
			for index := range mixed {
				mixed[index] = 0
			}
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
			// One clamp, at the end. See the package note on why saturating into the running total
			// would break the subtraction above.
			out[index] = clampSample(mixed[index] * gain / unityGain)
		}

		marker := !member.marked
		member.marked = true
		member.session.sendMixFrame(member.encoder.EncodeFrame(out), marker)
	}
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

// clampSample saturates one summed sample into the 16-bit range.
//
// Saturation and not a wrap, for the reason audio.MixInto states: a wrap turns a loud moment into a
// full-amplitude sign flip, which is a bang rather than distortion.
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

// sendMixFrame writes one mixed frame out of this session's socket.
//
// It shares the session's SSRC, sequence counter and timestamp clock with the relay and with
// playback, for the third time and for the same reason: a mix is not a second stream, it is this
// leg's outbound audio sourced from a room rather than from a peer.
//
// Every suppression the other sources obey applies here too, and in the same order — a digit being
// generated at this leg owns the stream, a prompt playing at this leg replaces the room, and a held
// or muted-out leg hears neither. That last one is what makes muting a conference participant
// outbound work at all.
func (s *Session) sendMixFrame(payload []byte, marker bool) {
	if s.dtmfActive() {
		s.count(func(st *Stats) { st.SuppressedByDtmf++ })
		return
	}
	if s.playback.Load() != nil {
		// A prompt played AT a conference member replaces the room for its duration, exactly as it
		// replaces a peer. "You are the only participant" is that prompt, and a caller hearing it
		// mixed under the room would be hearing the thing it says is not there.
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
			PayloadType:    s.audioPayloadType,
			SequenceNumber: s.nextSequence(),
			Timestamp:      s.nextPlaybackTimestamp(),
			SSRC:           s.SSRC,
			Marker:         marker,
		},
		Payload: payload,
	}

	encoded, err := out.Marshal()
	if err != nil {
		s.log.Debug("cannot marshal a mixed frame", "error", err)
		return
	}
	if _, err := s.ports.RTP.WriteToUDP(encoded, to); err != nil {
		// Per-packet and self-correcting, exactly as a relayed frame is. A conference is not torn
		// down because one participant's frame did not make it out.
		s.log.Debug("cannot send a mixed frame", "error", err, "remote", to.String())
		return
	}
	s.countSent(uint32(len(payload)))
	s.count(func(st *Stats) { st.MixedFramesSent++ })

	// The SEND half of a `both` recording, for a member being recorded: what this leg was told, which
	// is the rest of the room.
	if recorder := s.recording.Load(); recorder != nil {
		recorder.Sent(payload)
	}
}
