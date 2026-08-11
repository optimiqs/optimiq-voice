// Package rtp is mediad's packet path: a port-pair allocator over a configured range, and a
// Session that owns one bound pair for the life of one call leg.
//
// v0 is a WALKING SKELETON. It proves that a port can be allocated, that RTP arrives on it, that
// the far end can be learned from the packets themselves, and that audio can be put back on the
// wire — which together are the whole substrate every later capability sits on (bridging is two
// sessions forwarding to each other; playback is a session sourcing frames from a file; recording
// is a session teeing them to one). What it deliberately does NOT have is in
// plans/mediad-design.md §6: no jitter buffer, no transcoding, no packet loss concealment, no
// SRTP, no RTCP.
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

	// ModeEcho reflects received payloads back to the source. It exists to prove the packet path
	// end to end without a second party, and it is what the v0 control surface allocates.
	//
	// It is a diagnostic, not a product capability. The first real capability (bridged calls,
	// design doc §2) replaces it with forwarding to a peer session.
	ModeEcho Mode = "echo"
)

// ParseMode validates a mode from the wire. Unknown modes are refused rather than defaulted: a
// typo in a control message should be a visible error, not a session that silently does nothing.
func ParseMode(raw string) (Mode, error) {
	switch Mode(raw) {
	case ModeInactive:
		return ModeInactive, nil
	case ModeEcho:
		return ModeEcho, nil
	case "":
		return ModeEcho, nil
	default:
		return "", fmt.Errorf("rtp: unknown media mode %q (want %q or %q)", raw, ModeInactive, ModeEcho)
	}
}

// Payload types mediad handles in v0.
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
	// PayloadTypeTelephoneEvent is RFC 4733 DTMF. Dynamic, but 101 is the de-facto value every
	// endpoint offers, and v0 recognises only that one. Real negotiation reads it from the SDP
	// `a=rtpmap` and arrives with the SDP wave.
	PayloadTypeTelephoneEvent uint8 = 101
)

// SupportedPayloadTypes is what a session accepts, in the order it would be offered.
func SupportedPayloadTypes() []uint8 {
	return []uint8{PayloadTypePCMU, PayloadTypePCMA, PayloadTypeTelephoneEvent}
}

func isSupportedPayloadType(pt uint8) bool {
	return pt == PayloadTypePCMU || pt == PayloadTypePCMA || pt == PayloadTypeTelephoneEvent
}

// maxPacketSize bounds one read. A 20 ms G.711 frame is 160 bytes of payload plus a 12-byte
// header; 1500 is an Ethernet MTU and leaves room for extensions and CSRCs without letting a
// malicious sender size our buffer.
const maxPacketSize = 1500

// Stats is a session's counters, copied out under lock for logging and for the control surface.
type Stats struct {
	PacketsReceived  uint64
	PacketsSent      uint64
	BytesReceived    uint64
	Malformed        uint64
	UnsupportedPT    uint64
	ForeignSource    uint64
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

	mode  Mode
	ports *PortPair
	log   *slog.Logger

	// remote is the far end, LEARNED from the first packet rather than configured. See latch.
	remoteMu sync.RWMutex
	remote   *net.UDPAddr

	// sequence is this session's own outbound counter. Echo does not reuse the sender's numbers:
	// two streams sharing a sequence space is exactly what a jitter buffer cannot untangle.
	sequence uint16

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
	// Mode defaults to ModeEcho.
	Mode Mode
	// Logger defaults to slog.Default().
	Logger *slog.Logger
	// SSRC forces the synchronisation source. Zero means "generate one". Tests set it; nothing
	// else should.
	SSRC uint32
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
		mode = ModeEcho
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

	return &Session{
		ID:        opts.ID,
		SSRC:      ssrc,
		mode:      mode,
		ports:     opts.Ports,
		log:       logger.With("sessionId", opts.ID, "rtpPort", opts.Ports.Port, "ssrc", ssrc),
		done:      make(chan struct{}),
		createdAt: time.Now(),
	}, nil
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

	if !isSupportedPayloadType(packet.PayloadType) {
		// v1 is G.711 passthrough. An unexpected payload type means SDP negotiation let something
		// through it should not have, so it is counted as the negotiation bug it is and dropped
		// rather than reflected.
		s.count(func(st *Stats) { st.UnsupportedPT++ })
		return
	}

	if s.mode == ModeEcho {
		s.echo(&packet, from)
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
	s.sequence++

	out := pionrtp.Packet{
		Header: pionrtp.Header{
			Version:        2,
			PayloadType:    packet.PayloadType,
			SequenceNumber: s.sequence,
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

// LocalAddrPort is the address a caller should advertise for this session, given the public address
// mediad was configured with. The port is the session's; the address is not, because the socket may
// be bound to 0.0.0.0 or to a private address behind NAT.
func (s *Session) LocalAddrPort(public netip.Addr) netip.AddrPort {
	return netip.AddrPortFrom(public, uint16(s.ports.Port))
}
