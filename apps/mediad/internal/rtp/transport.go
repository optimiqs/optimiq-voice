package rtp

import "net"

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

var securePacketSource = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9}

func (s *Session) readRTP(buf []byte) (int, *net.UDPAddr, error) {
	if s.transport != nil {
		n, err := s.transport.ReadRTP(buf)
		return n, securePacketSource, err
	}
	return s.ports.RTP.ReadFromUDP(buf)
}

func (s *Session) writeRTP(buf []byte, to *net.UDPAddr) (int, error) {
	if s.transport != nil {
		return s.transport.WriteRTP(buf)
	}
	return s.ports.RTP.WriteToUDP(buf, to)
}

func (s *Session) readRTCP(buf []byte) (int, *net.UDPAddr, error) {
	if s.transport != nil {
		n, err := s.transport.ReadRTCP(buf)
		return n, securePacketSource, err
	}
	return s.ports.RTCP.ReadFromUDP(buf)
}

func (s *Session) writeRTCP(buf []byte, to *net.UDPAddr) (int, error) {
	if s.transport != nil {
		return s.transport.WriteRTCP(buf)
	}
	return s.ports.RTCP.WriteToUDP(buf, to)
}
