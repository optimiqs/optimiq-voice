package rtp

import (
	"net"
	"sync"
	"time"

	pionrtp "github.com/pion/rtp"
)

// PacketTransport supplies authenticated RTP/RTCP after a secure transport has decrypted it.
// When present, the session never reads or writes plaintext on its allocated UDP sockets.
type PacketTransport interface {
	LocalSSRC() uint32
	ReadRTP([]byte) (int, error)
	WriteRTP([]byte) (int, error)
	ReadRTCP([]byte) (int, error)
	WriteRTCP([]byte) (int, error)
	Close() error
}

// droppingTransport is an optional interface for transports that can discard an inbound packet
// before the session sees it (WebRTC's bounded reader channel); a plain UDP socket cannot.
type droppingTransport interface {
	Dropped() (rtpDropped, rtcpDropped uint64)
}

var securePacketSource = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9}

func (s *Session) readRTP(buf []byte) (int, *net.UDPAddr, error) {
	if s.transport != nil {
		n, err := s.transport.ReadRTP(buf)
		return n, securePacketSource, err
	}
	n, from, err := s.ports.RTP.ReadFromUDP(buf)
	secure := s.srtp.Load()
	if err != nil || secure == nil {
		return n, from, err
	}
	// A packet that fails the auth tag is indistinguishable from noise on an open UDP port. It is
	// handed back as a zero-length read, which handlePacket counts as malformed; an error here
	// would end the read loop on the first stray datagram.
	plain, decryptErr := secure.unprotectRTP(buf[:n])
	if decryptErr != nil {
		return 0, from, nil
	}
	return len(plain), from, nil
}

func (s *Session) writeRTP(buf []byte, to *net.UDPAddr) (int, error) {
	// The one choke point for every outbound packet, which is why the liveness stamp lives here
	// rather than in each of forward, playback, dtmf and the mixer.
	s.lastWrite.Store(time.Now().UnixMilli())
	if s.transport != nil {
		return s.transport.WriteRTP(buf)
	}
	secure := s.srtp.Load()
	if secure == nil {
		return s.ports.RTP.WriteToUDP(buf, to)
	}
	return s.protectedWrite(s.ports.RTP, secure.protectRTP, buf, to)
}

func (s *Session) readRTCP(buf []byte) (int, *net.UDPAddr, error) {
	if s.transport != nil {
		n, err := s.transport.ReadRTCP(buf)
		return n, securePacketSource, err
	}
	n, from, err := s.ports.RTCP.ReadFromUDP(buf)
	secure := s.srtp.Load()
	if err != nil || secure == nil {
		return n, from, err
	}
	plain, decryptErr := secure.unprotectRTCP(buf[:n])
	if decryptErr != nil {
		return 0, from, nil
	}
	return len(plain), from, nil
}

func (s *Session) writeRTCP(buf []byte, to *net.UDPAddr) (int, error) {
	if s.transport != nil {
		return s.transport.WriteRTCP(buf)
	}
	secure := s.srtp.Load()
	if secure == nil {
		return s.ports.RTCP.WriteToUDP(buf, to)
	}
	return s.protectedWrite(s.ports.RTCP, secure.protectRTCP, buf, to)
}

// protectedWrite encrypts into pooled scratch and writes the result, reporting the PLAINTEXT length
// so callers cannot tell an SRTP leg from a plain one by the byte count.
func (s *Session) protectedWrite(
	socket *net.UDPConn,
	protect func(dst, plaintext []byte) ([]byte, error),
	buf []byte,
	to *net.UDPAddr,
) (int, error) {
	scratch, _ := outboundBuffers.Get().(*[]byte)
	defer outboundBuffers.Put(scratch)
	protected, err := protect((*scratch)[:0], buf)
	if err != nil {
		return 0, err
	}
	if _, err := socket.WriteToUDP(protected, to); err != nil {
		return 0, err
	}
	return len(buf), nil
}

// outboundBuffers is the scratch every send path marshals into before the socket write.
//
// A pool, not a per-session buffer: several goroutines produce a session's outbound frames (the
// peer's read loop, its playback loop, a conference mix loop), so a shared field would race. The
// borrowed bytes live only for one synchronous write; nothing retains the slice afterwards.
var outboundBuffers = sync.Pool{
	New: func() any {
		buf := make([]byte, maxPacketSize)
		return &buf
	},
}

// marshalOutbound encodes a packet into a pooled buffer; the caller MUST hand scratch back with
// releaseOutbound once the write has finished.
//
// A packet too large for the pooled buffer falls back to Packet.Marshal and returns a nil scratch,
// which releaseOutbound accepts.
func marshalOutbound(packet *pionrtp.Packet) (encoded []byte, scratch *[]byte, err error) {
	scratch, _ = outboundBuffers.Get().(*[]byte)
	if packet.MarshalSize() > len(*scratch) {
		outboundBuffers.Put(scratch)
		encoded, err = packet.Marshal()
		return encoded, nil, err
	}
	n, err := packet.MarshalTo(*scratch)
	if err != nil {
		outboundBuffers.Put(scratch)
		return nil, nil, err
	}
	return (*scratch)[:n], scratch, nil
}

// releaseOutbound returns a marshalOutbound buffer to the pool. Safe on the nil fallback.
func releaseOutbound(scratch *[]byte) {
	if scratch != nil {
		outboundBuffers.Put(scratch)
	}
}
