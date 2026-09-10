package rtp

import (
	"errors"
	"sync"

	"github.com/pion/srtp/v3"
)

// SRTPKeys is one leg's SDES key pair (RFC 4568): the material we generated and put in our own
// SDP, and the material the far end put in theirs. Each is a 16-byte master key followed by a
// 14-byte master salt (RFC 3711 §8.2).
type SRTPKeys struct {
	LocalKeyMaterial  []byte
	RemoteKeyMaterial []byte
}

// srtpMasterLen is the length of one SDES key material blob.
const srtpMasterLen = 30

// ErrBadSRTPKey marks key material of the wrong length, which would derive a session key nobody
// else can reproduce and fail as silence.
var ErrBadSRTPKey = errors.New("rtp: SRTP key material must be 30 bytes (16 key + 14 salt)")

// SRTPContext protects one session's packets: outbound with the local key, inbound with the
// remote one. RFC 3711 keys each direction separately, so the two contexts are independent.
//
// Each direction is guarded by its own mutex because a pion Context carries per-SSRC rollover
// state that several producer goroutines (the peer's read loop, playback, the mixer) would race on.
type SRTPContext struct {
	outMu sync.Mutex
	out   *srtp.Context

	inMu sync.Mutex
	in   *srtp.Context
}

// NewSRTPContext derives the send and receive contexts for one leg.
func NewSRTPContext(keys SRTPKeys) (*SRTPContext, error) {
	if len(keys.LocalKeyMaterial) != srtpMasterLen || len(keys.RemoteKeyMaterial) != srtpMasterLen {
		return nil, ErrBadSRTPKey
	}
	profile := srtp.ProtectionProfileAes128CmHmacSha1_80
	out, err := srtp.CreateContext(keys.LocalKeyMaterial[:16], keys.LocalKeyMaterial[16:], profile)
	if err != nil {
		return nil, err
	}
	// Replay protection on the RECEIVE side only: a replayed packet is an attack, where our own
	// send context is a counter we advance ourselves.
	in, err := srtp.CreateContext(keys.RemoteKeyMaterial[:16], keys.RemoteKeyMaterial[16:], profile,
		srtp.SRTPReplayProtection(64), srtp.SRTCPReplayProtection(64))
	if err != nil {
		return nil, err
	}
	return &SRTPContext{out: out, in: in}, nil
}

// protectRTP encrypts and authenticates one marshalled RTP packet into dst.
func (c *SRTPContext) protectRTP(dst, plaintext []byte) ([]byte, error) {
	c.outMu.Lock()
	defer c.outMu.Unlock()
	return c.out.EncryptRTP(dst, plaintext, nil)
}

// unprotectRTP authenticates and decrypts one SRTP packet IN PLACE, returning the plaintext prefix
// of the same buffer. An unauthenticated packet returns an error and is dropped by the caller.
func (c *SRTPContext) unprotectRTP(packet []byte) ([]byte, error) {
	c.inMu.Lock()
	defer c.inMu.Unlock()
	return c.in.DecryptRTP(packet[:0], packet, nil)
}

// protectRTCP and unprotectRTCP are the RTCP halves, under the same master keys (RFC 3711 §4.3).
func (c *SRTPContext) protectRTCP(dst, plaintext []byte) ([]byte, error) {
	c.outMu.Lock()
	defer c.outMu.Unlock()
	return c.out.EncryptRTCP(dst, plaintext, nil)
}

func (c *SRTPContext) unprotectRTCP(packet []byte) ([]byte, error) {
	c.inMu.Lock()
	defer c.inMu.Unlock()
	return c.in.DecryptRTCP(packet[:0], packet, nil)
}
