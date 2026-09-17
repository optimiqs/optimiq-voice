package sipua

// SDES-SRTP for the test UA (RFC 4568 keying, RFC 3711 AES_CM_128_HMAC_SHA1_80).
//
// Written out rather than pulled in on purpose: apps/sipd carries no SRTP dependency and this
// harness needs exactly one profile. Roughly a hundred lines of stdlib AES-CTR and HMAC-SHA1 is a
// smaller thing to own than a new module requirement in a service that never speaks media.

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1" //nolint:gosec // RFC 3711 names HMAC-SHA1 for this profile; it is not a hash choice
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"strings"
	"time"
)

// SRTPSuite is the one RFC 4568 crypto suite this harness implements.
const SRTPSuite = "AES_CM_128_HMAC_SHA1_80"

// SRTPKeyMaterial is a 16-byte master key followed by a 14-byte master salt (RFC 3711 §8.2), which
// is what the `inline:` parameter of an `a=crypto` line carries, base64-encoded.
const SRTPKeyMaterial = 30

const srtpAuthTagLen = 10

// ErrSRTPAuth is returned when a packet fails its authentication tag: either it was not protected
// under the key we were given, or it was not protected at all.
var ErrSRTPAuth = errors.New("sipua: SRTP authentication tag mismatch")

// NewSRTPKeyMaterial draws fresh master key and salt bytes for one direction.
func NewSRTPKeyMaterial() []byte {
	material := make([]byte, SRTPKeyMaterial)
	if _, err := rand.Read(material); err != nil {
		panic(err)
	}
	return material
}

// SRTPSession protects one direction of one SSRC's traffic.
type SRTPSession struct {
	sessionKey  []byte
	sessionSalt []byte
	authKey     []byte

	roc     uint32
	lastSeq uint16
	started bool
}

// NewSRTPSession derives the session keys from 30 bytes of SDES key material.
func NewSRTPSession(material []byte) (*SRTPSession, error) {
	if len(material) != SRTPKeyMaterial {
		return nil, fmt.Errorf("sipua: SRTP key material must be %d bytes, got %d", SRTPKeyMaterial, len(material))
	}
	masterKey, masterSalt := material[:16], material[16:]
	return &SRTPSession{
		sessionKey:  srtpDerive(masterKey, masterSalt, 0x00, 16),
		authKey:     srtpDerive(masterKey, masterSalt, 0x01, 20),
		sessionSalt: srtpDerive(masterKey, masterSalt, 0x02, 14),
	}, nil
}

// srtpDerive is the RFC 3711 §4.3.1 key derivation function with key_derivation_rate 0, so the
// index term of key_id is always zero and only the label perturbs the salt.
func srtpDerive(masterKey, masterSalt []byte, label byte, length int) []byte {
	iv := make([]byte, 16)
	copy(iv, masterSalt)
	// key_id is right-aligned against the 112-bit master salt, so its label byte lands on byte 7.
	iv[7] ^= label
	block, err := aes.NewCipher(masterKey)
	if err != nil {
		panic(err)
	}
	out := make([]byte, length)
	cipher.NewCTR(block, iv).XORKeyStream(out, out)
	return out
}

// packetIV is the AES-CM initialisation vector for one packet (RFC 3711 §4.1.1).
func (s *SRTPSession) packetIV(ssrc uint32, index uint64) []byte {
	iv := make([]byte, 16)
	copy(iv, s.sessionSalt)
	var scratch [4]byte
	binary.BigEndian.PutUint32(scratch[:], ssrc)
	for i := range 4 {
		iv[4+i] ^= scratch[i]
	}
	for i := range 6 {
		iv[8+i] ^= byte(index >> (8 * (5 - uint(i))))
	}
	return iv
}

func (s *SRTPSession) keystreamXOR(ssrc uint32, index uint64, payload []byte) {
	block, err := aes.NewCipher(s.sessionKey)
	if err != nil {
		panic(err)
	}
	cipher.NewCTR(block, s.packetIV(ssrc, index)).XORKeyStream(payload, payload)
}

func (s *SRTPSession) tag(packet []byte, roc uint32) []byte {
	mac := hmac.New(sha1.New, s.authKey)
	mac.Write(packet)
	var rocBytes [4]byte
	binary.BigEndian.PutUint32(rocBytes[:], roc)
	mac.Write(rocBytes[:])
	return mac.Sum(nil)[:srtpAuthTagLen]
}

// rtpHeaderLen returns the length of the RTP header including CSRC list and any extension.
func rtpHeaderLen(packet []byte) (int, bool) {
	if len(packet) < 12 || packet[0]>>6 != 2 {
		return 0, false
	}
	length := 12 + 4*int(packet[0]&0x0f)
	if packet[0]&0x10 != 0 { // X bit: a header extension follows the CSRC list
		if len(packet) < length+4 {
			return 0, false
		}
		length += 4 + 4*int(binary.BigEndian.Uint16(packet[length+2:length+4]))
	}
	if len(packet) < length {
		return 0, false
	}
	return length, true
}

// index advances the rollover counter from a sequence number, RFC 3711 §3.3.1 in its simple form:
// the harness sends and receives in order over loopback, so a wrap is the only case to handle.
func (s *SRTPSession) index(sequence uint16) uint64 {
	if !s.started {
		s.started, s.lastSeq = true, sequence
	} else if sequence < 0x4000 && s.lastSeq > 0xc000 {
		s.roc++
	}
	s.lastSeq = sequence
	return uint64(s.roc)<<16 | uint64(sequence)
}

// Protect turns one plain RTP packet into an SRTP packet: payload encrypted, 10-byte tag appended.
func (s *SRTPSession) Protect(packet []byte) ([]byte, error) {
	headerLen, ok := rtpHeaderLen(packet)
	if !ok {
		return nil, errors.New("sipua: not an RTP packet")
	}
	sequence := binary.BigEndian.Uint16(packet[2:4])
	ssrc := binary.BigEndian.Uint32(packet[8:12])
	out := make([]byte, len(packet), len(packet)+srtpAuthTagLen)
	copy(out, packet)
	index := s.index(sequence)
	s.keystreamXOR(ssrc, index, out[headerLen:])
	return append(out, s.tag(out, uint32(index>>16))...), nil
}

// Unprotect verifies and decrypts one SRTP packet, returning the plain RTP packet.
func (s *SRTPSession) Unprotect(packet []byte) ([]byte, error) {
	if len(packet) < 12+srtpAuthTagLen {
		return nil, ErrSRTPAuth
	}
	body := packet[:len(packet)-srtpAuthTagLen]
	headerLen, ok := rtpHeaderLen(body)
	if !ok {
		return nil, errors.New("sipua: not an RTP packet")
	}
	sequence := binary.BigEndian.Uint16(body[2:4])
	ssrc := binary.BigEndian.Uint32(body[8:12])
	index := s.index(sequence)
	if !hmac.Equal(s.tag(body, uint32(index>>16)), packet[len(packet)-srtpAuthTagLen:]) {
		return nil, ErrSRTPAuth
	}
	out := make([]byte, len(body))
	copy(out, body)
	s.keystreamXOR(ssrc, index, out[headerLen:])
	return out, nil
}

// CryptoInline renders key material for an `a=crypto` line.
func CryptoInline(material []byte) string { return base64.StdEncoding.EncodeToString(material) }

// OfferSDPSDES is [RTPEndpoint.OfferSDP] under RTP/SAVP with one RFC 4568 crypto attribute.
func (e *RTPEndpoint) OfferSDPSDES(direction string, tag int, material []byte) string {
	return fmt.Sprintf("v=0\r\no=- %d 1 IN IP4 127.0.0.1\r\ns=-\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n"+
		"m=audio %d RTP/SAVP %d %d\r\na=rtpmap:%d PCMU/8000\r\na=rtpmap:%d telephone-event/8000\r\n"+
		"a=fmtp:%d 0-16\r\na=crypto:%d %s inline:%s\r\na=%s\r\n",
		time.Now().Unix(), e.Port(), PayloadPCMU, PayloadTelephoneEvent,
		PayloadPCMU, PayloadTelephoneEvent, PayloadTelephoneEvent,
		tag, SRTPSuite, CryptoInline(material), direction)
}

// CryptoAttribute returns the tag and decoded key material of the first `a=crypto` line of an SDP
// body carrying [SRTPSuite], and whether one was found.
func CryptoAttribute(sdp string) (int, []byte, bool) {
	for line := range strings.SplitSeq(sdp, "\n") {
		value, found := strings.CutPrefix(strings.TrimSpace(line), "a=crypto:")
		if !found {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) < 3 || !strings.EqualFold(fields[1], SRTPSuite) {
			continue
		}
		var tag int
		if _, err := fmt.Sscanf(fields[0], "%d", &tag); err != nil {
			continue
		}
		for _, param := range fields[2:] {
			inline, ok := strings.CutPrefix(param, "inline:")
			if !ok {
				continue
			}
			encoded, _, _ := strings.Cut(inline, "|")
			material, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || len(material) != SRTPKeyMaterial {
				return 0, nil, false
			}
			return tag, material, true
		}
	}
	return 0, nil, false
}

// MediaProto is the transport token of the `m=audio` line — RTP/AVP or RTP/SAVP.
func MediaProto(sdp string) string {
	for line := range strings.SplitSeq(sdp, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) >= 3 && fields[0] == "m=audio" {
			return fields[2]
		}
	}
	return ""
}

// DerivedKey exposes one of the three session keys by name, so a test can pin the derivation
// against the RFC 3711 §B.3 vector before trusting it as evidence.
func (s *SRTPSession) DerivedKey(which string) []byte {
	switch which {
	case "cipher key":
		return s.sessionKey
	case "auth key":
		return s.authKey
	case "cipher salt":
		return s.sessionSalt
	}
	return nil
}

// ULawDecode exposes the harness's G.711 µ-law decoder, so a caller can read a payload as audio
// and see for itself whether it is a tone or ciphertext.
func ULawDecode(encoded byte) int16 { return ulawDecode(encoded) }
