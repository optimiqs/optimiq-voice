// Package rtp is mediad's packet path: a port-pair allocator over a configured range, and a
// Session that owns one bound pair for the life of one call leg. The far end is learned from the
// packets themselves (symmetric RTP), and two sessions relay to each other to form a bridged call.
//
// The relay is byte-for-byte passthrough with no decode and no buffer. Everything that is not a
// plain relay — conference mixing (the only place a jitter buffer exists), transcoding, playback,
// recording — is a second path reachable only when something asks for it.
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

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Mode is what a Session does with the RTP it receives.
type Mode string

const (
	// ModeInactive receives, counts and discards. The safe default: a session in an unrecognised
	// mode must not accidentally source audio.
	ModeInactive Mode = "inactive"

	// ModeRelay forwards received payloads to a peer session, and is what a bridged leg is in. A
	// session in this mode with no peer yet receives, counts and discards, like ModeInactive.
	ModeRelay Mode = "relay"

	// ModeEcho reflects received payloads back to the source. A DIAGNOSTIC, unreachable from the
	// wire: only MEDIAD_ECHO_DIAGNOSTIC=true makes the manager produce it, and it must never be
	// reachable from a production call path.
	ModeEcho Mode = "echo"
)

// Payload types mediad handles.
const (
	// PayloadTypePCMU is G.711 µ-law, RFC 3551 static PT 0.
	PayloadTypePCMU uint8 = 0
	// PayloadTypePCMA is G.711 A-law, RFC 3551 static PT 8.
	PayloadTypePCMA uint8 = 8
	// PayloadTypeTelephoneEvent is the de-facto RFC 4733 DTMF type. The type is DYNAMIC, so this is
	// only what an answer proposes when the offer left the choice open; each session carries what
	// its own negotiation settled on (see Session.telephoneEventPayloadType).
	PayloadTypeTelephoneEvent uint8 = 101
	// PayloadTypeG722 is ITU-T G.722, RFC 3551 static PT 9.
	PayloadTypeG722 uint8 = 9
)

// FormatDefault is the zero value of audio.Format. Unset and µ-law are the same value, since
// payload type 0 is µ-law, so a caller that names only a payload type still gets a codec.
//
// The consequence is that [AllocateOptions.Format] cannot express "µ-law" distinctly from "unset":
// for the static payload types the NUMBER WINS, so Format FormatULaw with AudioPayloadType
// PayloadTypePCMA yields an A-law session. That is the right way round — the payload type is what
// goes on the wire, and both are derived from the same offer, so they never disagree in practice —
// but a caller that wants a format the number contradicts must pass a non-µ-law Format.
const FormatDefault = audio.FormatULaw

// SupportedPayloadTypes is the STATIC types a session accepts, in the order they would be offered.
// Opus is absent by construction: having no static type, its number comes from the offer.
func SupportedPayloadTypes() []uint8 {
	return []uint8{PayloadTypePCMU, PayloadTypePCMA, PayloadTypeG722, PayloadTypeTelephoneEvent}
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
	// SuppressedByPlayback counts peer frames dropped because a prompt was playing towards this leg.
	SuppressedByPlayback uint64
	// SuppressedByDtmf counts outbound audio frames dropped because a digit string was being
	// generated towards this leg.
	SuppressedByDtmf uint64
	// DtmfPacketsSent counts RFC 4733 telephone-event packets this session ORIGINATED, not relayed
	// ones, which are already in PacketsSent.
	DtmfPacketsSent uint64
	// SuppressedByHold counts frames dropped in either direction because the leg is on hold.
	SuppressedByHold uint64
	// SuppressedByMute counts frames dropped in either direction by an explicit mute.
	SuppressedByMute uint64
	// TransportDroppedRTP and TransportDroppedRTCP count packets a secure transport discarded before
	// this session saw them, because the buffer between its reader and Session.Run was full. Always
	// zero for a plain UDP leg, which has no such buffer.
	TransportDroppedRTP  uint64
	TransportDroppedRTCP uint64
	// Transcoded counts frames decoded and re-encoded on the way to this leg. Its RATIO against
	// PacketsSent is the diagnostic: passthrough is the fast path.
	Transcoded uint64
	// MixedFramesSent counts frames this leg received from a conference mix rather than a relay.
	MixedFramesSent uint64
	// DtmfPacketsReceived counts telephone-event packets that arrived, and DtmfDigitsReceived the
	// keypresses they were de-duplicated into. The RATIO is the diagnostic — RFC 4733 sends roughly
	// eight packets per digit, so equal numbers mean the de-duplication is not running.
	DtmfPacketsReceived uint64
	DtmfDigitsReceived  uint64
	LastPacketUnixMs    int64
}

// Session owns one RTP/RTCP port pair for the life of one call leg.
type Session struct {
	// ID is the engine-assigned session identifier. mediad never invents it, so the engine can
	// release a session whose allocate reply it never saw.
	ID string
	// SSRC identifies this session's own stream, RFC 3550 §5.1. Random per session.
	SSRC uint32

	// OrgID, CallID and LegID are carried, never acted on: mediad routes on session ids alone.
	OrgID  string
	CallID string
	LegID  string

	mode      Mode
	ports     *PortPair
	transport PacketTransport
	// srtp protects the UDP sockets when the leg negotiated SDES (RFC 4568). Nil is a plain RTP
	// leg, which behaves exactly as it did before SRTP existed.
	//
	// ATOMIC for the same reason the codec fields are: a B-leg's remote key is not known at
	// allocation, so create-offer binds the socket unprotected and `accept-answer` settles the
	// context on a control goroutine while the read loop is already running.
	srtp atomic.Pointer[SRTPContext]
	log  *slog.Logger

	// audioPayloadType is the ONE audio type this session negotiated; negotiation is per leg, so a
	// session must drop what its own answer did not agree to.
	//
	// ATOMIC because a B-leg's codec is not known at allocation: the session starts on the offer's
	// default and `accept-answer` settles the real one on a control goroutine while the read
	// goroutine is already looping. The three codec fields move together, stored uint8-in-uint32
	// because Go has no atomic uint8.
	audioPayloadType atomic.Uint32
	// format is what that payload type MEANS: a payload type is a wire label (Opus's is dynamic)
	// and this is the codec.
	format atomic.Uint32
	// telephoneEventPayloadType is the RFC 4733 type this session negotiated, or 0 for none.
	telephoneEventPayloadType atomic.Uint32

	// peer is the session this one forwards to, set by Bridge and cleared by Unbridge. It has its
	// own RWMutex rather than sharing statsMu, which would serialise the read path behind counters.
	peerMu sync.RWMutex
	peer   *Session

	// remote is the far end. Normally LEARNED from the first packet (see latch); SeedRemote may
	// pre-fill it from the negotiated SDP so an early-media announcement has somewhere to go before
	// the far end has spoken.
	remoteMu sync.RWMutex
	remote   *net.UDPAddr
	// remoteLearned distinguishes a latched address from a seeded one. A seeded address is advisory
	// — behind NAT the advertised address is private — so the first packet to arrive replaces it and
	// latches for good. Guarded by remoteMu.
	remoteLearned bool

	// sequence is this session's own outbound counter; a relay does not reuse the sender's numbers.
	//
	// ATOMIC because a session's outbound packets are written by its PEER's read goroutine, and
	// across an unbridge/re-bridge the old peer's goroutine can still be in flight while the new one
	// starts. 32-bit and truncated on use because Go has no atomic uint16.
	sequence atomic.Uint32

	// lastTimestamp is the RTP timestamp this session most recently put on the wire. Written by the
	// relay and advanced by playback, on one counter so a prompt starting mid-call continues the
	// stream's timestamp rather than resetting it. See Session.nextPlaybackTimestamp.
	lastTimestamp atomic.Uint32

	// playback is the prompt currently sourcing this session's outbound frames, or nil. An atomic
	// pointer because it is read on the peer's packet path, in forward.
	playback atomic.Pointer[Playback]

	// dtmf is the digit string currently owning this session's outbound stream, or nil. See
	// DtmfInjection for why a digit takes the stream rather than sharing it.
	dtmf atomic.Pointer[DtmfInjection]
	// dtmfMu serialises whole digit STRINGS, so a second string queues behind the first rather than
	// interleaving its packets into a digit still being sent.
	dtmfMu sync.Mutex

	// dtmfIn is the RECEIVE-side detector, turning the several packets of one RFC 4733 digit back
	// into one keypress. Separate from the generating fields above.
	dtmfIn *dtmfDetector
	// onDtmf is told about each detected digit, on the read goroutine. Set once before the read loop
	// starts, so it needs no synchronisation of its own.
	onDtmf func(*Session, DtmfDigit)

	// recording is the file this session's audio is being written to, or nil.
	recording atomic.Pointer[Recording]

	// markNextForward makes the next relayed packet carry the RTP marker bit. Set when a playback
	// ends, since the outbound stream switches back to the peer's timestamp clock.
	markNextForward atomic.Bool

	// held, mutedIn and mutedOut are atomics because the packet path reads all three per frame; see
	// hold.go for why hold and mute are separate flags and where each gates. RTP silence is expected
	// while held, so rtpGraceUntil restarts the watchdog window on resumption.
	rtpGraceUntil atomic.Int64
	held          atomic.Bool
	mutedIn       atomic.Bool
	mutedOut      atomic.Bool
	// hold serialises the compound hold change (two flags plus a music loop) so an unhold racing a
	// hold cannot leave them disagreeing.
	hold holdState

	// mixMember is this session's seat in a conference, or nil. Its presence REPLACES the relay on
	// the receive path: packets go into a jitter buffer for the mixer rather than a peer's socket.
	mixMember atomic.Pointer[Member]

	// transcode translates the peer's payloads into this session's codec, or nil when the two legs
	// agreed. Nil is the FAST PATH: passthrough stays byte-for-byte.
	transcode atomic.Pointer[Transcoder]

	// quality is the RTCP-facing view of this leg: arrival jitter measured here, and loss, jitter
	// and round-trip time as the far end reported them. See rtcp.go.
	quality qualityState

	// newTicker builds the playback pacing clock. Swapped in tests to step a prompt frame by frame.
	newTicker func(time.Duration) (<-chan time.Time, func())

	// lastPacket is Stats.LastPacketUnixMs, an atomic rather than under statsMu because the reaper
	// reads it for every live session while holding the Manager's global lock.
	lastPacket atomic.Int64

	// lastWrite is when this session last put a packet on the wire, in Unix millis. Read only by
	// the reaper: a leg that has never RECEIVED anything but is relaying its peer's audio — a caller
	// listening to a carrier's announcement before the 200 — is live, not a leak. See Manager.ReapIdle.
	lastWrite atomic.Int64

	statsMu sync.Mutex
	stats   Stats

	closeOnce sync.Once
	done      chan struct{}
	createdAt time.Time
}

// Options configures a Session.
type Options struct {
	Transport PacketTransport
	// SRTP is the negotiated SDES key pair, or nil for a plain RTP leg. Ignored when Transport is
	// set: a WebRTC leg is already DTLS-SRTP.
	SRTP *SRTPContext
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
	// AudioPayloadType is the negotiated audio type. Defaults to PCMU.
	AudioPayloadType uint8
	// Format is the codec that payload type carries. Zero is FormatULaw, which is also what payload
	// type 0 means, so a caller that sets only the number still gets the right codec.
	Format audio.Format
	// TelephoneEventPayloadType is the negotiated RFC 4733 type; 0 means the offer had none.
	TelephoneEventPayloadType uint8
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// SSRC forces the synchronisation source. Zero means "generate one"; only tests should set it.
	SSRC uint32
	// Ticker builds the playback pacing clock, defaulting to time.NewTicker. Tests substitute a
	// channel they drive by hand.
	Ticker func(time.Duration) (<-chan time.Time, func())
	// OnDtmf is called with each digit DETECTED on the receive path, from the read goroutine.
	// Optional: a session with none still decodes and de-duplicates, it just tells nobody.
	OnDtmf func(*Session, DtmfDigit)
	// DtmfMaxDigitDuration bounds one detected digit; zero means DefaultDtmfMaxDigitDuration.
	DtmfMaxDigitDuration time.Duration
	// MuteIn and MuteOut start the session with one or both suppression gates up, which is what a
	// leg whose answer was not `sendrecv` needs. See hold.go.
	MuteIn  bool
	MuteOut bool
}

// NewSession takes ownership of a port pair: from here on Session.Close is the ONLY thing that
// closes those sockets and returns the port to the allocator.
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
	if opts.Transport != nil {
		ssrc = opts.Transport.LocalSSRC()
	}
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

	// FormatDefault is indistinguishable from an explicit FormatULaw, so the static payload type
	// decides here — see FormatDefault. Only the static types can be resolved from the number;
	// Opus is dynamic and must be named.
	format := opts.Format
	if format == FormatDefault {
		format = formatForStaticPayloadType(opts.AudioPayloadType)
	}

	session := &Session{
		ID:        opts.ID,
		SSRC:      ssrc,
		newTicker: ticker,
		OrgID:     opts.OrgID,
		CallID:    opts.CallID,
		LegID:     opts.LegID,
		mode:      mode,
		ports:     opts.Ports,
		transport: opts.Transport,
		dtmfIn:    newDtmfDetector(opts.DtmfMaxDigitDuration),
		onDtmf:    opts.OnDtmf,
		log:       logger.With("sessionId", opts.ID, "rtpPort", opts.Ports.Port, "ssrc", ssrc),
		done:      make(chan struct{}),
		createdAt: time.Now(),
	}
	if opts.SRTP != nil {
		session.srtp.Store(opts.SRTP)
	}
	session.mutedIn.Store(opts.MuteIn)
	session.mutedOut.Store(opts.MuteOut)
	session.audioPayloadType.Store(uint32(opts.AudioPayloadType))
	session.format.Store(uint32(format))
	session.telephoneEventPayloadType.Store(uint32(opts.TelephoneEventPayloadType))
	if opts.Transport != nil {
		session.remote = securePacketSource
	}
	return session, nil
}

// settleCodec re-points this session's negotiated codec, audio payload type and telephone-event
// type: the packet path's half of `accept-answer`.
//
// The three fields are written together so the packet path sees either the pre-answer default or
// the settled codec, never a torn mixture. It MUST run before the leg is bridged, so no live relay
// has its codec changed underneath it.
// SettleSRTP attaches the SDES context a B-leg's answer settled on. Idempotent per session: the
// first context wins, so a retried accept-answer cannot rekey a stream mid-call.
func (s *Session) SettleSRTP(ctx *SRTPContext) {
	if ctx != nil {
		s.srtp.CompareAndSwap(nil, ctx)
	}
}

func (s *Session) settleCodec(format audio.Format, audioPT, telephoneEventPT uint8) {
	s.format.Store(uint32(format))
	s.audioPayloadType.Store(uint32(audioPT))
	s.telephoneEventPayloadType.Store(uint32(telephoneEventPT))
}

// formatForStaticPayloadType resolves RFC 3551's static assignments. See NewSession.
func formatForStaticPayloadType(payloadType uint8) audio.Format {
	switch payloadType {
	case PayloadTypePCMA:
		return audio.FormatALaw
	case PayloadTypeG722:
		return audio.FormatG722
	default:
		return audio.FormatULaw
	}
}

// systemTicker is the production playback clock: a real 20 ms ticker.
func systemTicker(interval time.Duration) (<-chan time.Time, func()) {
	ticker := time.NewTicker(interval)
	return ticker.C, ticker.Stop
}

// randomSSRC draws a non-zero 32-bit identifier. crypto/rand rather than math/rand: a predictable
// SSRC is the handle for injecting audio into a call.
func randomSSRC() (uint32, error) {
	var buf [4]byte
	for range 4 {
		if _, err := rand.Read(buf[:]); err != nil {
			return 0, fmt.Errorf("rtp: drawing an SSRC: %w", err)
		}
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
	stats := s.stats
	s.statsMu.Unlock()
	stats.LastPacketUnixMs = s.lastPacket.Load()
	if dropper, ok := s.transport.(droppingTransport); ok {
		// Read through rather than mirrored: the drop happens on the transport's reader goroutine.
		stats.TransportDroppedRTP, stats.TransportDroppedRTCP = dropper.Dropped()
	}
	return stats
}

// Remote is the far end: the latched address, or the one seeded from the SDP before the first
// packet, or nil when neither is known.
func (s *Session) Remote() *net.UDPAddr {
	s.remoteMu.RLock()
	defer s.remoteMu.RUnlock()
	return s.remote
}

// SeedRemote pre-fills the far end from the address the negotiated SDP advertised, so a leg that
// must be SENT to before it has spoken — early media, where the caller sends nothing until the 200
// — has somewhere to forward to. Advisory: symmetric-RTP learning still overrides it on the first
// packet, which is the address that works behind NAT. A latched session, a zero address and a
// loopback-of-nothing are all no-ops.
func (s *Session) SeedRemote(addr netip.AddrPort) {
	if !addr.IsValid() || addr.Port() == 0 || addr.Addr().IsUnspecified() {
		return
	}
	s.remoteMu.Lock()
	defer s.remoteMu.Unlock()
	if s.remoteLearned {
		return
	}
	ip := addr.Addr().Unmap()
	s.remote = &net.UDPAddr{IP: net.IP(ip.AsSlice()), Port: int(addr.Port())}
	s.log.Debug("seeded the far end from the negotiated SDP", "remote", s.remote.String())
}

// Idle reports how long since the last received packet. Before the first packet it is measured
// from creation, so a session that never receives anything is still reaped.
func (s *Session) Idle(now time.Time) time.Duration {
	last := s.lastPacket.Load()
	if last == 0 {
		return now.Sub(s.createdAt)
	}
	return now.Sub(time.UnixMilli(last))
}

// Run reads RTP until the context is cancelled or the session is closed. It returns nil on either.
// One goroutine per session, blocking on the read, and the only thing that touches the socket.
func (s *Session) Run(ctx context.Context) error {
	// Closing the socket is the only way to interrupt a blocked ReadFromUDP.
	stop := context.AfterFunc(ctx, func() {
		if s.transport != nil {
			_ = s.transport.Close()
		}
		_ = s.ports.RTP.Close()
	})
	defer stop()

	buf := make([]byte, maxPacketSize)
	for {
		n, from, err := s.readRTP(buf)
		if err != nil {
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
		// Counted, not logged: an open UDP port receives anything, and per-packet logging under a
		// flood would fill a disk.
		s.count(func(st *Stats) { st.Malformed++ })
		return
	}

	if !s.latch(from) {
		s.count(func(st *Stats) { st.ForeignSource++ })
		return
	}

	s.lastPacket.Store(now.UnixMilli())
	s.count(func(st *Stats) {
		st.PacketsReceived++
		st.BytesReceived += uint64(len(raw))
	})

	if !s.accepts(packet.PayloadType) {
		// A payload type this session did not negotiate is dropped: forwarding it would put bytes
		// the far end cannot decode into a live call.
		s.count(func(st *Stats) { st.UnsupportedPT++ })
		return
	}

	// The arrival-jitter estimate is updated for EVERY accepted packet, suppressed or not: it
	// describes the network rather than the call. See rtcp.go.
	s.quality.observeArrival(&packet, now, s.clockRate())

	// A TAP: detection adds an event and never consumes a packet, and it happens outside the relay
	// so a leg with no peer (an IVR collecting a PIN) still has its keypresses noticed.
	//
	// It MUST run before the suppression gate below, or a muted participant could not press the
	// feature code that unmutes them.
	s.tapDtmf(&packet, now)

	if s.receiveSuppressed() {
		// Held or muted inbound: received, counted and measured, but it enters neither the peer's
		// ear, the mix, nor the recording, which follows the conversation rather than the wire.
		s.countSuppression()
		return
	}

	// The recording tap is here rather than in relay because a leg is recorded whether or not it is
	// bridged (voicemail has no peer). Telephone-event packets are excluded: a digit is not audio.
	if recorder := s.recording.Load(); recorder != nil && packet.PayloadType == s.AudioPayloadType() {
		recorder.Received(packet.Payload)
	}

	// A seat in a conference REPLACES the relay: the frame goes into this leg's jitter buffer and
	// the mixer samples it on its own clock.
	if member := s.mixMember.Load(); member != nil {
		member.receive(&packet, now)
		return
	}

	switch s.mode {
	case ModeEcho:
		s.echo(&packet, from)
	case ModeRelay:
		s.relay(&packet)
	}
}

// clockRate is the RTP timestamp rate for this session's negotiated codec: 8000 for every codec
// here INCLUDING G.722, whose registration records the wrong rate (RFC 3551 §4.5.2) and which every
// implementation now depends on. Opus is the exception at 48000.
func (s *Session) clockRate() uint32 {
	if s.Format() == audio.FormatOpus {
		return 48000
	}
	return audio.SampleRate
}

// accepts reports whether a payload type is one this session negotiated.
func (s *Session) accepts(pt uint8) bool {
	if pt == s.AudioPayloadType() {
		return true
	}
	tePT := s.TelephoneEventPayloadType()
	return tePT != 0 && pt == tePT
}

// AudioPayloadType is the audio payload type this session negotiated.
func (s *Session) AudioPayloadType() uint8 { return uint8(s.audioPayloadType.Load()) }

// Format is the codec that payload type carries.
func (s *Session) Format() audio.Format { return audio.Format(s.format.Load()) }

// MixMember is this session's seat in a conference, or nil.
func (s *Session) MixMember() *Member { return s.mixMember.Load() }

// Transcoder is the translation installed towards this leg, or nil when the bridge passes through.
func (s *Session) Transcoder() *Transcoder { return s.transcode.Load() }

// TelephoneEventPayloadType is the RFC 4733 type this session negotiated, or 0.
func (s *Session) TelephoneEventPayloadType() uint8 { return uint8(s.telephoneEventPayloadType.Load()) }

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
// The payload passes through byte for byte; the HEADER is rewritten field by field:
//
//   - SSRC becomes the outgoing session's own, so an endpoint sees one stable synchronisation
//     source for the life of its leg even across a re-bridge.
//   - Sequence numbers become the outgoing session's own, so the far end's loss statistics are its
//     own and a re-bridge does not jump the sequence space.
//   - Timestamp is KEPT: a relay does not resample, so the sampling instant is still true.
//   - Marker is KEPT: on a telephone-event payload it is the start-of-digit flag.
//   - Payload type is TRANSLATED for telephone-event only — its type is dynamic and the two legs
//     routinely land on different numbers, while the payload format is identical.
func (s *Session) relay(packet *pionrtp.Packet) {
	peer := s.Peer()
	if peer == nil {
		// Allocated but not yet bridged: received, counted, discarded.
		return
	}
	peer.forward(packet, s.TelephoneEventPayloadType())
}

// forward writes a packet out of THIS session's socket, to THIS session's latched far end. It is
// called on the receiving session's peer, so every field it touches belongs to the outgoing leg.
func (s *Session) forward(packet *pionrtp.Packet, sourceTelephoneEventPT uint8) {
	if s.transmitSuppressed() {
		// Held or muted outbound. This gate is on the PEER's audio only: a playback still reaches
		// the leg, which is how hold music gets there.
		s.countSuppression()
		return
	}

	if s.dtmfActive() {
		// A digit occupies a SPAN of the outbound timestamp clock — every packet of it carries the
		// timestamp it started at — so an audio frame inside that span breaks the tone.
		s.count(func(st *Stats) { st.SuppressedByDtmf++ })
		return
	}

	if s.playback.Load() != nil {
		// A session has ONE outbound stream, so a prompt REPLACES the peer's frames rather than
		// interleaving two timestamp clocks under one SSRC. See Playback.
		s.count(func(st *Stats) { st.SuppressedByPlayback++ })
		return
	}

	to := s.Remote()
	if to == nil {
		// Symmetric RTP learns the address, and this leg has not spoken yet. Self-corrects on its
		// first packet.
		return
	}

	payloadType := packet.PayloadType
	payload := packet.Payload
	switch {
	case sourceTelephoneEventPT != 0 && payloadType == sourceTelephoneEventPT:
		localTelephoneEventPT := s.TelephoneEventPayloadType()
		if localTelephoneEventPT == 0 {
			// No negotiated telephone-event type: dropped rather than sent as audio, which would
			// render an RFC 4733 payload as a loud click.
			s.count(func(st *Stats) { st.UnsupportedPT++ })
			return
		}
		payloadType = localTelephoneEventPT

	default:
		// NIL IS THE FAST PATH: two legs that agreed on a codec relay byte for byte. Bridge installs
		// a transcoder only when the answers differ. See transcode.go.
		if coder := s.transcode.Load(); coder != nil {
			translated, ok := coder.Translate(payload)
			if !ok {
				s.count(func(st *Stats) { st.UnsupportedPT++ })
				return
			}
			payload = translated
			payloadType = s.AudioPayloadType()
			s.count(func(st *Stats) { st.Transcoded++ })
		}
	}

	// The marker survives the relay and is FORCED on the first packet after a prompt ends, when the
	// outbound stream switches back from the playback clock to the peer's.
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
		Payload: payload,
	}

	encoded, scratch, err := marshalOutbound(&out)
	if err != nil {
		s.log.Debug("cannot marshal a relayed packet", "error", err)
		return
	}
	s.lastTimestamp.Store(packet.Timestamp)
	_, err = s.writeRTP(encoded, to)
	releaseOutbound(scratch)
	if err != nil {
		// Per-packet and self-correcting: a call is not torn down over one undelivered frame.
		s.log.Debug("cannot relay a packet", "error", err, "remote", to.String())
		return
	}
	s.countSent(uint32(len(payload)))

	// The send half of a `both` recording, tapped after the write so the file holds what went out —
	// the TRANSLATED payload on a transcoded bridge. Telephone-event payloads are excluded.
	if recorder := s.recording.Load(); recorder != nil && payloadType == s.AudioPayloadType() {
		recorder.Sent(payload)
	}
}

// latch binds the session to the first source address it hears from, and refuses every other one.
//
// RFC 4961 symmetric RTP: send to the address the packets came FROM, not the one the SDP claimed,
// which behind NAT is the only address that works.
//
// It latches ONCE, and that is a security boundary: re-latching per packet would let anyone who can
// guess the port take over a call in progress by spraying a single packet at it. The cost is that
// an endpoint legitimately changing address mid-call is cut off until an authenticated re-INVITE.
func (s *Session) latch(from *net.UDPAddr) bool {
	s.remoteMu.RLock()
	current, learned := s.remote, s.remoteLearned
	s.remoteMu.RUnlock()

	if current != nil && learned {
		return current.IP.Equal(from.IP) && current.Port == from.Port
	}

	s.remoteMu.Lock()
	defer s.remoteMu.Unlock()
	// Two packets can race the read lock above; the loser must not overwrite the winner's latch.
	if s.remoteLearned {
		return s.remote.IP.Equal(from.IP) && s.remote.Port == from.Port
	}
	s.remoteLearned = true
	s.remote = &net.UDPAddr{IP: append(net.IP(nil), from.IP...), Port: from.Port, Zone: from.Zone}
	s.log.Debug("latched to the far end", "remote", s.remote.String())
	return true
}

// echo reflects a payload back to the latched source, under OUR SSRC and sequence numbers:
// reflecting the sender's is what endpoint loop detection is built to discard. The timestamp is
// kept, since in echo the frame's sampling instant really is the one it arrived with.
func (s *Session) echo(packet *pionrtp.Packet, to *net.UDPAddr) {
	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    packet.PayloadType,
			SequenceNumber: s.nextSequence(),
			Timestamp:      packet.Timestamp,
			SSRC:           s.SSRC,
			// Marker survives: on a telephone-event payload it is the start-of-digit flag.
			Marker: packet.Marker,
		},
		Payload: packet.Payload,
	}

	encoded, scratch, err := marshalOutbound(&out)
	if err != nil {
		s.log.Debug("cannot marshal an echo packet", "error", err)
		return
	}
	_, err = s.writeRTP(encoded, to)
	releaseOutbound(scratch)
	if err != nil {
		// Per-packet and self-correcting.
		s.log.Debug("cannot send an echo packet", "error", err, "remote", to.String())
		return
	}
	s.countSent(uint32(len(packet.Payload)))
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
		if s.transport != nil {
			err = s.transport.Close()
		}
		err = errors.Join(err, s.ports.Close())
		stats := s.Stats()
		s.log.Debug("session closed",
			"packetsReceived", stats.PacketsReceived,
			"packetsSent", stats.PacketsSent,
			"malformed", stats.Malformed,
			"foreignSource", stats.ForeignSource)
	})
	return err
}

// Summary flattens the session's facts for a Lifecycle implementation, which MUST never hold a
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
		Quality:    s.Quality(),
	}
}

// LocalAddrPort is the address a caller should advertise for this session, given the public address
// mediad was configured with. The port is the session's; the address is not, because the socket may
// be bound to 0.0.0.0 or to a private address behind NAT.
func (s *Session) LocalAddrPort(public netip.Addr) netip.AddrPort {
	return netip.AddrPortFrom(public, uint16(s.ports.Port))
}
