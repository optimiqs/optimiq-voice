// Package rtp is mediad's packet path: a port-pair allocator over a configured range, and a
// Session that owns one bound pair for the life of one call leg.
//
// Rung 2 of plans/mediad-design.md §2: a port is allocated, RTP arrives on it, the far end is
// learned from the packets themselves (symmetric RTP), and two sessions RELAY to each other, which
// is what a bridged call is. Playback is the same substrate with a file as the source and recording
// is the same substrate with a tee; both are later rungs.
//
// What it deliberately does NOT have is in plans/mediad-design.md §6: no jitter buffer (a relay
// must not add one — the receiving endpoint already has one, and two in series make the call
// worse), no transcoding, no packet loss concealment, no SRTP, no RTCP reading.
package rtp

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"time"

	pionrtp "github.com/pion/rtp"
)

// Mode is what a Session does with the RTP it receives.
type Mode string

const (
	// ModeInactive receives, counts and discards. It is what a leg that is ringing but not yet
	// answered should be in, and it is the safe default: a session in an unrecognised mode must
	// not accidentally source audio.
	ModeInactive Mode = "inactive"

	// ModeRelay forwards received payloads to a peer session, and is what a bridged leg is in.
	//
	// A session is put in this mode at allocation and has NO PEER until a bridge-sessions command
	// gives it one; until then it receives, counts and discards, exactly like ModeInactive. That is
	// the correct behaviour for a leg that has answered but is not yet talking to anybody — a
	// caller listening to ringback while the B-leg rings.
	ModeRelay Mode = "relay"

	// ModeEcho reflects received payloads back to the source.
	//
	// A DIAGNOSTIC, not a product capability, and design doc open question 5 asked whether it
	// should survive rung 2. It does, and it is now unreachable from the wire: no field in
	// `rpc.media.v1.allocate-session` selects it, and only MEDIAD_ECHO_DIAGNOSTIC=true makes the
	// manager produce it. The cost of keeping it is one branch in the packet path; the value is the
	// simplest possible smoke test of a real deployment's ports and NAT, needing no second party.
	// What it must never be is reachable by a production call path, which is what the flag settles.
	ModeEcho Mode = "echo"
)

// Payload types mediad handles.
//
// G.711 only, and PASSTHROUGH only: bytes in, same bytes out. There is no transcoding in v1 (design
// doc §7) — a codec mismatch is resolved in SDP negotiation by refusing the offer, not in the media
// path by resampling. PCMU/PCMA are the two every endpoint on earth supports, so passthrough covers
// the bridged-call cutover without a single DSP operation.
const (
	// PayloadTypePCMU is G.711 µ-law, RFC 3551 static PT 0.
	PayloadTypePCMU uint8 = 0
	// PayloadTypePCMA is G.711 A-law, RFC 3551 static PT 8.
	PayloadTypePCMA uint8 = 8
	// PayloadTypeTelephoneEvent is the DE-FACTO RFC 4733 DTMF type, and a DEFAULT rather than a
	// rule: the type is dynamic, real endpoints offer 96, 100 and 101, and each session now carries
	// whatever its own SDP negotiation settled on (see Session.telephoneEventPayloadType). This
	// constant is what an answer proposes when the offer left the choice open.
	PayloadTypeTelephoneEvent uint8 = 101
)

// SupportedPayloadTypes is what a session accepts, in the order it would be offered.
func SupportedPayloadTypes() []uint8 {
	return []uint8{PayloadTypePCMU, PayloadTypePCMA, PayloadTypeTelephoneEvent}
}

// maxPacketSize bounds one read. A 20 ms G.711 frame is 160 bytes of payload plus a 12-byte
// header; 1500 is an Ethernet MTU and leaves room for extensions and CSRCs without letting a
// malicious sender size our buffer.
const maxPacketSize = 1500

// Stats is a session's counters, copied out under lock for logging and for the control surface.
type Stats struct {
	PacketsReceived uint64
	PacketsSent     uint64
	BytesReceived   uint64
	Malformed       uint64
	UnsupportedPT   uint64
	ForeignSource   uint64
	// SuppressedByPlayback counts peer frames dropped because a prompt was playing towards this
	// leg. Counted rather than silent: "the other party could not be heard for six seconds" is a
	// support ticket, and this is the number that explains it was a prompt rather than a fault.
	SuppressedByPlayback uint64
	// SuppressedByDtmf counts outbound audio frames dropped because a digit string was being
	// generated towards this leg. Same argument as the counter above, on a much shorter window: a
	// digit takes the outbound stream for a few hundred milliseconds, and this is what says so.
	SuppressedByDtmf uint64
	// DtmfPacketsSent counts RFC 4733 telephone-event packets this session ORIGINATED. It does not
	// count relayed ones, which are somebody else's digits passing through and are already in
	// PacketsSent.
	DtmfPacketsSent  uint64
	LastPacketUnixMs int64
}

// Session owns one RTP/RTCP port pair for the life of one call leg.
type Session struct {
	// ID is the engine-assigned session identifier. mediad never invents it: the engine has to be
	// able to release a session whose allocate reply it never saw, which is only possible if the
	// name was the engine's to begin with.
	ID string
	// SSRC identifies this session's own stream, RFC 3550 §5.1. Random per session.
	SSRC uint32

	// OrgID, CallID and LegID are carried, never acted on. mediad routes on session ids alone; these
	// exist so a lifecycle event and a directory entry can be attributed to a tenant and a call
	// without the engine having to correlate them after the fact.
	OrgID  string
	CallID string
	LegID  string

	mode  Mode
	ports *PortPair
	log   *slog.Logger

	// audioPayloadType is the ONE G.711 type this session negotiated. Per-session rather than a
	// package constant, because negotiation is per leg: one call can have a PCMU A-leg and a PCMA
	// B-leg, and a session must drop what its own answer did not agree to.
	audioPayloadType uint8
	// telephoneEventPayloadType is the RFC 4733 type this session negotiated, or 0 for none.
	telephoneEventPayloadType uint8

	// peer is the session this one forwards to, set by Bridge and cleared by Unbridge.
	//
	// Guarded by its own RWMutex rather than the stats lock: it is read on EVERY packet (50 times a
	// second per call) and written twice in a call's life, which is the exact shape an RWMutex is
	// for. Sharing the stats mutex would serialise the read path behind counter updates.
	peerMu sync.RWMutex
	peer   *Session

	// remote is the far end, LEARNED from the first packet rather than configured. See latch.
	remoteMu sync.RWMutex
	remote   *net.UDPAddr

	// sequence is this session's own outbound counter. A relay does not reuse the sender's numbers:
	// two streams sharing a sequence space is exactly what a jitter buffer cannot untangle.
	//
	// ATOMIC, not a plain uint16, and the reason is the relay's threading: a session's outbound
	// packets are written by its PEER's read goroutine, and across an unbridge/re-bridge (an
	// attended transfer) the old peer's goroutine can still be in flight while the new one starts.
	// Two writers, briefly, is exactly the window `-race` catches and a production deploy does not.
	// The counter is 32-bit and truncated on use because Go has no atomic uint16.
	sequence atomic.Uint32

	// lastTimestamp is the RTP timestamp this session most recently put on the wire.
	//
	// Written by the relay (which keeps the SENDER's timestamp, so this only records it) and read
	// and advanced by playback (which has its own clock). Keeping the two on one counter is what
	// makes a prompt starting mid-call continue the stream's timestamp rather than reset it — see
	// Session.nextPlaybackTimestamp.
	lastTimestamp atomic.Uint32

	// playback is the prompt currently sourcing this session's outbound frames, or nil.
	//
	// An atomic POINTER rather than a mutex-guarded field because it is read on the peer's packet
	// path — 50 times a second per bridged call, in forward — and written twice per prompt.
	playback atomic.Pointer[Playback]

	// dtmf is the digit string currently owning this session's outbound stream, or nil. Read on the
	// packet path for the same reason `playback` is, and set for a few hundred milliseconds at a
	// time. See DtmfInjection for why a digit takes the stream rather than sharing it.
	dtmf atomic.Pointer[DtmfInjection]
	// dtmfMu serialises whole digit STRINGS. Digits are a sequence — a caller that sent "12" and
	// then "34" wants "1234" — so a second string queues behind the first instead of interleaving
	// its packets into the middle of a digit somebody else is still sending.
	dtmfMu sync.Mutex

	// recording is the file this session's audio is being written to, or nil. Read on the packet
	// path on both directions; see Recording for what it captures and what it does not.
	recording atomic.Pointer[Recording]

	// markNextForward makes the next relayed packet carry the RTP marker bit. Set when a playback
	// ends, because the outbound stream is switching back to the peer's timestamp clock and a
	// receiver needs to be told a new talkspurt begins rather than left to read the jump as loss.
	markNextForward atomic.Bool

	// newTicker builds the playback pacing clock. Swapped in tests so a prompt is stepped frame by
	// frame without a suite that sleeps for the length of every clip it plays.
	newTicker func(time.Duration) (<-chan time.Time, func())

	statsMu sync.Mutex
	stats   Stats

	closeOnce sync.Once
	done      chan struct{}
	createdAt time.Time
}

// Options configures a Session.
type Options struct {
	// ID is required.
	ID string
	// Ports is the allocated pair the session takes ownership of. Closing the session closes it.
	Ports *PortPair
	// OrgID, CallID and LegID are carried through to lifecycle events and the session directory.
	OrgID  string
	CallID string
	LegID  string
	// Mode defaults to ModeRelay.
	Mode Mode
	// AudioPayloadType is the negotiated G.711 type. Defaults to PCMU.
	AudioPayloadType uint8
	// TelephoneEventPayloadType is the negotiated RFC 4733 type; 0 means the offer had none.
	TelephoneEventPayloadType uint8
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// SSRC forces the synchronisation source. Zero means "generate one". Tests set it; nothing
	// else should.
	SSRC uint32
	// Ticker builds the playback pacing clock, defaulting to time.NewTicker. Tests substitute a
	// channel they drive by hand.
	Ticker func(time.Duration) (<-chan time.Time, func())
}

// NewSession takes ownership of a port pair.
//
// Ownership is the point: from here on exactly one thing closes those sockets and returns the port
// to the allocator, and it is Session.Close. A caller that both held the pair and had a session
// over it would eventually double-release one.
func NewSession(opts Options) (*Session, error) {
	switch {
	case opts.ID == "":
		return nil, errors.New("rtp: a session id is required")
	case opts.Ports == nil:
		return nil, errors.New("rtp: a session needs an allocated port pair")
	}

	mode := opts.Mode
	if mode == "" {
		mode = ModeRelay
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}

	ssrc := opts.SSRC
	if ssrc == 0 {
		var err error
		if ssrc, err = randomSSRC(); err != nil {
			return nil, err
		}
	}

	ticker := opts.Ticker
	if ticker == nil {
		ticker = systemTicker
	}

	return &Session{
		ID:                        opts.ID,
		SSRC:                      ssrc,
		newTicker:                 ticker,
		OrgID:                     opts.OrgID,
		CallID:                    opts.CallID,
		LegID:                     opts.LegID,
		mode:                      mode,
		ports:                     opts.Ports,
		audioPayloadType:          opts.AudioPayloadType,
		telephoneEventPayloadType: opts.TelephoneEventPayloadType,
		log:                       logger.With("sessionId", opts.ID, "rtpPort", opts.Ports.Port, "ssrc", ssrc),
		done:                      make(chan struct{}),
		createdAt:                 time.Now(),
	}, nil
}

// systemTicker is the production playback clock: a real 20 ms ticker.
func systemTicker(interval time.Duration) (<-chan time.Time, func()) {
	ticker := time.NewTicker(interval)
	return ticker.C, ticker.Stop
}

// randomSSRC draws a non-zero 32-bit identifier.
//
// crypto/rand rather than math/rand: an SSRC an outsider can predict is the handle for injecting
// audio into a call, because a receiver keyed on SSRC accepts a matching stream. It is cheap
// insurance on a value drawn once per call.
func randomSSRC() (uint32, error) {
	var buf [4]byte
	for attempt := 0; attempt < 4; attempt++ {
		if _, err := rand.Read(buf[:]); err != nil {
			return 0, fmt.Errorf("rtp: drawing an SSRC: %w", err)
		}
		// Zero is reserved here as the "unset" sentinel in Options, so it is redrawn.
		if ssrc := binary.BigEndian.Uint32(buf[:]); ssrc != 0 {
			return ssrc, nil
		}
	}
	return 0, errors.New("rtp: could not draw a non-zero SSRC")
}

// LocalPort is the even RTP port this session listens on.
func (s *Session) LocalPort() int { return s.ports.Port }

// Mode reports what the session does with received audio.
func (s *Session) Mode() Mode { return s.mode }

// Stats copies the counters out.
func (s *Session) Stats() Stats {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	return s.stats
}

// Remote is the learned far end, or nil before the first packet.
func (s *Session) Remote() *net.UDPAddr {
	s.remoteMu.RLock()
	defer s.remoteMu.RUnlock()
	return s.remote
}

// Idle reports how long since the last received packet. Before the first packet it is measured
// from creation, so a session that never receives anything is still reaped.
func (s *Session) Idle(now time.Time) time.Duration {
	s.statsMu.Lock()
	last := s.stats.LastPacketUnixMs
	s.statsMu.Unlock()
	if last == 0 {
		return now.Sub(s.createdAt)
	}
	return now.Sub(time.UnixMilli(last))
}

// Run reads RTP until the context is cancelled or the session is closed. It returns nil on either.
//
// One goroutine per session, blocking on ReadFromUDP. That is the right shape at this scale — the
// kernel does the multiplexing, each call's latency is independent of every other call's, and a
// goroutine parked on a read costs a few kilobytes of stack. If a profile ever says otherwise the
// replacement is batched reads (recvmmsg) behind this same method, which is why the loop is the
// only thing that touches the socket.
func (s *Session) Run(ctx context.Context) error {
	// Unblock the read when the caller gives up. Closing the socket is the only way to interrupt
	// a blocked ReadFromUDP; a read deadline would work too, but at 50 packets a second per call
	// it would mean resetting a timer 50 times a second per call for no benefit.
	stop := context.AfterFunc(ctx, func() { _ = s.ports.RTP.Close() })
	defer stop()

	buf := make([]byte, maxPacketSize)
	for {
		n, from, err := s.ports.RTP.ReadFromUDP(buf)
		if err != nil {
			// A closed socket is how both shutdown paths end. Neither is a failure.
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) || s.isClosed() {
				return nil
			}
			return fmt.Errorf("rtp: reading on port %d: %w", s.ports.Port, err)
		}
		s.handlePacket(buf[:n], from)
	}
}

func (s *Session) handlePacket(raw []byte, from *net.UDPAddr) {
	now := time.Now()

	var packet pionrtp.Packet
	if err := packet.Unmarshal(raw); err != nil {
		// Counted, not logged. A media port is an open UDP socket on the internet and anything at
		// all can be sent to it; logging per packet would turn a trivial flood into a disk-fill.
		s.count(func(st *Stats) { st.Malformed++ })
		return
	}

	if !s.latch(from) {
		s.count(func(st *Stats) { st.ForeignSource++ })
		return
	}

	s.count(func(st *Stats) {
		st.PacketsReceived++
		st.BytesReceived += uint64(len(raw))
		st.LastPacketUnixMs = now.UnixMilli()
	})

	if !s.accepts(packet.PayloadType) {
		// v1 is G.711 passthrough. A payload type this session did not negotiate means SDP
		// negotiation let something through it should not have, so it is counted as the negotiation
		// bug it is and dropped rather than forwarded — forwarding it would put bytes the far end
		// cannot decode into a live call.
		s.count(func(st *Stats) { st.UnsupportedPT++ })
		return
	}

	// The recording tap, and it is HERE rather than in relay for a reason: a leg is recorded whether
	// or not it is bridged. A voicemail message is a session with no peer at all, and a tap wired
	// into the forwarding path would produce an empty file for exactly the case recording exists for.
	// Telephone-event packets are excluded — a digit is not audio, and decoding one as G.711 writes
	// four bytes of noise into the file.
	if recorder := s.recording.Load(); recorder != nil && packet.PayloadType == s.audioPayloadType {
		recorder.Received(packet.Payload)
	}

	switch s.mode {
	case ModeEcho:
		s.echo(&packet, from)
	case ModeRelay:
		s.relay(&packet)
	}
}

// accepts reports whether a payload type is one this session negotiated.
func (s *Session) accepts(pt uint8) bool {
	if pt == s.audioPayloadType {
		return true
	}
	return s.telephoneEventPayloadType != 0 && pt == s.telephoneEventPayloadType
}

// AudioPayloadType is the G.711 type this session negotiated.
func (s *Session) AudioPayloadType() uint8 { return s.audioPayloadType }

// TelephoneEventPayloadType is the RFC 4733 type this session negotiated, or 0.
func (s *Session) TelephoneEventPayloadType() uint8 { return s.telephoneEventPayloadType }

// SetPeer points this session's forwarding at another. Bridge calls it on BOTH sessions.
func (s *Session) SetPeer(peer *Session) {
	s.peerMu.Lock()
	defer s.peerMu.Unlock()
	s.peer = peer
}

// Peer is the session this one forwards to, or nil when it is not bridged.
func (s *Session) Peer() *Session {
	s.peerMu.RLock()
	defer s.peerMu.RUnlock()
	return s.peer
}

// relay forwards a received packet to the peer session, out of the PEER's socket.
//
// # Why the header is rewritten rather than passed through
//
// The payload is passed through byte for byte — that is what makes rung 2 achievable with no DSP,
// and it is what carries RFC 4733 DTMF for free, since a telephone-event payload is just bytes to a
// relay. The HEADER is not passed through, and each rewritten field is a separate decision:
//
//   - SSRC becomes the outgoing session's own. Two legs are two independent RTP sessions; handing
//     leg B a stream stamped with leg A's SSRC would make B's jitter buffer see the synchronisation
//     source change every time the bridge is re-pointed (an attended transfer), which endpoints
//     read as "a different sender started talking" and handle by resetting — an audible click at
//     best. One stable SSRC per leg for the life of the leg is what an endpoint expects.
//
//   - Sequence numbers become the outgoing session's own, and increment by one per forwarded
//     packet. Passing A's through would leak A's losses into B's loss statistics and, worse, would
//     make the sequence space JUMP on a re-bridge, which a jitter buffer reads as catastrophic loss
//     and answers with concealment noise.
//
//   - Timestamp is KEPT. It is the frame's sampling instant, and a relay does not resample, so it
//     is still true. Rewriting it would be inventing a clock.
//
//   - Marker is KEPT. On a telephone-event payload it is the start-of-digit flag, and dropping it
//     turns every DTMF press into one an IVR cannot detect.
//
//   - Payload type is TRANSLATED for telephone-event only. G.711 is refused at bridge time when the
//     two legs disagree (see Manager.Bridge), so the audio type always matches. The RFC 4733 type is
//     dynamic and the two legs routinely land on different numbers (101 and 96 are both common);
//     the payload FORMAT is identical, so renumbering is correct and is the whole reason DTMF
//     survives a bridge between two phones that negotiated differently.
func (s *Session) relay(packet *pionrtp.Packet) {
	peer := s.Peer()
	if peer == nil {
		// Allocated but not yet bridged. Received, counted, discarded — which is exactly right for
		// a leg that has answered and is listening to ringback.
		return
	}
	peer.forward(packet, s.telephoneEventPayloadType)
}

// forward writes a packet out of THIS session's socket, to THIS session's latched far end.
//
// Called on the receiving session's peer, so all the socket and sequence state it touches is its
// own — which is what keeps the two directions of a bridge from sharing anything but the payload
// bytes.
func (s *Session) forward(packet *pionrtp.Packet, sourceTelephoneEventPT uint8) {
	if s.dtmfActive() {
		// A digit is being generated towards this leg. It occupies a SPAN of the outbound timestamp
		// clock rather than a point — every packet of a digit carries the timestamp it started at —
		// so an audio frame let out in the middle of that span puts a second clock inside the digit
		// and the receiver either regenerates a tone of the wrong length or drops it. See
		// DtmfInjection.
		s.count(func(st *Stats) { st.SuppressedByDtmf++ })
		return
	}

	if s.playback.Load() != nil {
		// A prompt is playing towards this leg, and a session has ONE outbound stream. Interleaving
		// the peer's frames into it would put two unrelated timestamp clocks under one SSRC, which
		// is the one thing a jitter buffer cannot untangle. See the Playback doc for why REPLACE is
		// the rung 1 rule and what it deliberately does not interrupt — the digits travelling the
		// other way, which is how barge-in works.
		s.count(func(st *Stats) { st.SuppressedByPlayback++ })
		return
	}

	to := s.Remote()
	if to == nil {
		// The far end of this leg has not spoken yet, so there is no address to send to. Symmetric
		// RTP is a learned address, and a leg that has not sent has not taught us one; dropping is
		// the only honest option, and it self-corrects on the first packet from that side.
		return
	}

	payloadType := packet.PayloadType
	if sourceTelephoneEventPT != 0 && payloadType == sourceTelephoneEventPT {
		if s.telephoneEventPayloadType == 0 {
			// This leg never negotiated telephone-event, so there is no number to send DTMF under.
			// Dropped rather than sent as audio: an RFC 4733 payload rendered as G.711 is a loud
			// click, which is worse than a missing digit.
			s.count(func(st *Stats) { st.UnsupportedPT++ })
			return
		}
		payloadType = s.telephoneEventPayloadType
	}

	// The marker survives the relay, and is additionally FORCED on the first packet after a prompt
	// ends: the outbound stream is switching back from the playback clock to the peer's, and a
	// receiver told "new talkspurt" resumes cleanly where one left to infer a timestamp jump answers
	// with concealment noise.
	marker := packet.Marker || s.markNextForward.Swap(false)

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    payloadType,
			SequenceNumber: s.nextSequence(),
			Timestamp:      packet.Timestamp,
			SSRC:           s.SSRC,
			Marker:         marker,
		},
		Payload: packet.Payload,
	}

	encoded, err := out.Marshal()
	if err != nil {
		s.log.Debug("cannot marshal a relayed packet", "error", err)
		return
	}
	s.lastTimestamp.Store(packet.Timestamp)
	if _, err := s.ports.RTP.WriteToUDP(encoded, to); err != nil {
		// Per-packet and self-correcting. A call is not torn down because one frame did not make it
		// out, and logging every send failure on a congested link is how a media server fills a
		// disk while it is already struggling.
		s.log.Debug("cannot relay a packet", "error", err, "remote", to.String())
		return
	}
	s.count(func(st *Stats) { st.PacketsSent++ })

	// The SEND half of a `both` recording: what this leg was told, which is the other party talking.
	// Tapped after the write rather than before it, so the file holds what actually went out.
	// Telephone-event payloads are excluded for the same reason they are on the receive side.
	if recorder := s.recording.Load(); recorder != nil && payloadType == s.audioPayloadType {
		recorder.Sent(packet.Payload)
	}
}

// latch binds the session to the first source address it hears from, and refuses every other one.
//
// # Symmetric RTP, and why it is learned rather than configured
//
// RFC 4961: send to the address a peer's packets came FROM, not the one its SDP claimed. Behind
// NAT those differ on essentially every residential and mobile endpoint — the SDP carries a
// private address the endpoint sincerely believes in, and the only address that works is the one
// the NAT rewrote on the way out. Learning it from the packets is how every production media
// server does this, and it is why mediad can serve a phone behind a router it knows nothing about.
//
// # Why it latches ONCE
//
// The address is learned from whoever speaks first and then frozen. An implementation that
// re-latched on every packet would let anybody who can guess a port take over a call in progress:
// spray one RTP packet at the port and the media server starts sending the conversation to the
// attacker. Freezing means an attacker must beat the legitimate endpoint to the first packet on a
// port that was allocated for this call microseconds earlier.
//
// The cost is that an endpoint which legitimately changes address mid-call — a phone handing over
// from Wi-Fi to LTE — is cut off. That is the correct trade for v0 and the correct place to revisit
// it is a re-INVITE from the signalling plane, which is authenticated, rather than a heuristic in
// the packet path, which is not.
func (s *Session) latch(from *net.UDPAddr) bool {
	s.remoteMu.RLock()
	current := s.remote
	s.remoteMu.RUnlock()

	if current != nil {
		return current.IP.Equal(from.IP) && current.Port == from.Port
	}

	s.remoteMu.Lock()
	defer s.remoteMu.Unlock()
	// Re-check: two packets can race the read lock above, and the loser must not overwrite the
	// winner's latch.
	if s.remote != nil {
		return s.remote.IP.Equal(from.IP) && s.remote.Port == from.Port
	}
	s.remote = &net.UDPAddr{IP: append(net.IP(nil), from.IP...), Port: from.Port, Zone: from.Zone}
	s.log.Debug("latched to the far end", "remote", s.remote.String())
	return true
}

// echo reflects a payload back to the latched source.
//
// The header is REWRITTEN, not reused: our own SSRC and our own sequence numbers. Reflecting the
// sender's SSRC would make the stream look to the far end like its own packets coming back, which
// is what loop-detection logic in real endpoints is built to discard. The timestamp is kept,
// because in echo the frame's sampling instant genuinely is the one it arrived with.
func (s *Session) echo(packet *pionrtp.Packet, to *net.UDPAddr) {
	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    packet.PayloadType,
			SequenceNumber: s.nextSequence(),
			Timestamp:      packet.Timestamp,
			SSRC:           s.SSRC,
			// Marker survives: on a telephone-event payload it is the start-of-digit flag, and
			// dropping it would turn every DTMF press into an undetectable one.
			Marker: packet.Marker,
		},
		Payload: packet.Payload,
	}

	encoded, err := out.Marshal()
	if err != nil {
		s.log.Debug("cannot marshal an echo packet", "error", err)
		return
	}
	if _, err := s.ports.RTP.WriteToUDP(encoded, to); err != nil {
		// Send failures are per-packet and self-correcting; a call is not torn down because one
		// frame did not make it out.
		s.log.Debug("cannot send an echo packet", "error", err, "remote", to.String())
		return
	}
	s.count(func(st *Stats) { st.PacketsSent++ })
}

// nextSequence advances and returns this session's outbound RTP sequence number.
func (s *Session) nextSequence() uint16 {
	return uint16(s.sequence.Add(1))
}

func (s *Session) count(mutate func(*Stats)) {
	s.statsMu.Lock()
	defer s.statsMu.Unlock()
	mutate(&s.stats)
}

func (s *Session) isClosed() bool {
	select {
	case <-s.done:
		return true
	default:
		return false
	}
}

// Close stops the session and returns its ports to the allocator. Idempotent.
func (s *Session) Close() error {
	var err error
	s.closeOnce.Do(func() {
		close(s.done)
		err = s.ports.Close()
		stats := s.Stats()
		s.log.Debug("session closed",
			"packetsReceived", stats.PacketsReceived,
			"packetsSent", stats.PacketsSent,
			"malformed", stats.Malformed,
			"foreignSource", stats.ForeignSource)
	})
	return err
}

// Summary flattens the session's facts for a Lifecycle implementation, which must never hold a
// pointer to a Session whose sockets are already closed.
func (s *Session) Summary() SessionSummary {
	remote := ""
	if addr := s.Remote(); addr != nil {
		remote = addr.String()
	}
	return SessionSummary{
		SessionID:  s.ID,
		OrgID:      s.OrgID,
		CallID:     s.CallID,
		LegID:      s.LegID,
		RTPPort:    s.ports.Port,
		Stats:      s.Stats(),
		Duration:   time.Since(s.createdAt),
		RemoteAddr: remote,
	}
}

// LocalAddrPort is the address a caller should advertise for this session, given the public address
// mediad was configured with. The port is the session's; the address is not, because the socket may
// be bound to 0.0.0.0 or to a private address behind NAT.
func (s *Session) LocalAddrPort(public netip.Addr) netip.AddrPort {
	return netip.AddrPortFrom(public, uint16(s.ports.Port))
}
