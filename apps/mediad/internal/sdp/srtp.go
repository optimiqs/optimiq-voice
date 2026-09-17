package sdp

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"

	pionsdp "github.com/pion/sdp/v3"
)

// SRTPSuite is the ONE RFC 4568 crypto suite mediad implements. Every other suite in an offer is
// ignored rather than refused, so an offer listing AES_CM_128_HMAC_SHA1_32 alongside this one still
// negotiates.
const SRTPSuite = "AES_CM_128_HMAC_SHA1_80"

// Master key and salt lengths for AES_CM_128_HMAC_SHA1_80 (RFC 3711 §8.2). The inline parameter
// carries their concatenation, base64-encoded (RFC 4568 §6.1).
const (
	SRTPKeyLen      = 16
	SRTPSaltLen     = 14
	SRTPKeyMaterial = SRTPKeyLen + SRTPSaltLen
)

// Media transports mediad negotiates. SAVPF is WebRTC's and is handled elsewhere.
const (
	ProtoAVP  = "RTP/AVP"
	ProtoSAVP = "RTP/SAVP"
)

// ErrBadCryptoKey is returned when an `a=crypto` line for a supported suite carries inline key
// material that is not 30 base64-decoded bytes. Refused rather than ignored: accepting it would
// derive a session key from truncated material and fail as one-way noise.
var ErrBadCryptoKey = errors.New("sdp: a=crypto inline key material must be " +
	strconv.Itoa(SRTPKeyMaterial) + " base64-decoded bytes")

// Crypto is one negotiated RFC 4568 crypto attribute, always of suite [SRTPSuite].
type Crypto struct {
	// Tag is the offer's crypto tag. An answer echoes the tag of the line it selected (RFC 4568 §5.1.2).
	Tag int
	// KeyMaterial is the master key followed by the master salt, [SRTPKeyMaterial] bytes.
	KeyMaterial []byte
}

// IsSet reports whether the crypto attribute carries usable key material.
func (c Crypto) IsSet() bool { return len(c.KeyMaterial) == SRTPKeyMaterial }

// MasterKey and MasterSalt split the key material RFC 3711 §8.2 concatenates.
func (c Crypto) MasterKey() []byte  { return c.KeyMaterial[:SRTPKeyLen] }
func (c Crypto) MasterSalt() []byte { return c.KeyMaterial[SRTPKeyLen:] }

// Inline renders the key material for an `a=crypto` line.
func (c Crypto) Inline() string { return base64.StdEncoding.EncodeToString(c.KeyMaterial) }

// IsSecureProtocol reports whether a media transport carries SRTP keyed by SDES.
func IsSecureProtocol(proto string) bool {
	return proto == ProtoSAVP || proto == "RTP/SAVPF"
}

// parseCrypto reads the first usable `a=crypto` line: the first of suite [SRTPSuite] with an
// inline key parameter. Lines of other suites are skipped, so a zero Crypto with a nil error means
// the offer carried no suite mediad can serve.
//
// Allocation-light on purpose — this runs on the INVITE path — so nothing is allocated until a
// supported suite is found.
func parseCrypto(attributes []pionsdp.Attribute) (Crypto, error) {
	for _, attr := range attributes {
		if attr.Key != "crypto" {
			continue
		}
		tagPart, rest, found := strings.Cut(strings.TrimSpace(attr.Value), " ")
		if !found {
			continue
		}
		suite, params, found := strings.Cut(strings.TrimSpace(rest), " ")
		if !found || !strings.EqualFold(suite, SRTPSuite) {
			continue
		}
		tag, err := strconv.Atoi(tagPart)
		if err != nil || tag <= 0 {
			continue
		}
		for param := range strings.FieldsSeq(params) {
			inline, ok := strings.CutPrefix(param, "inline:")
			if !ok {
				continue
			}
			// RFC 4568 §9.1: the key is followed by an optional `|lifetime|MKI:length`; neither is
			// honoured here, since mediad rekeys by re-INVITE and offers no MKI.
			encoded, _, _ := strings.Cut(inline, "|")
			material, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil || len(material) != SRTPKeyMaterial {
				return Crypto{}, ErrBadCryptoKey
			}
			return Crypto{Tag: tag, KeyMaterial: material}, nil
		}
	}
	return Crypto{}, nil
}

// GenerateKeyMaterial draws fresh master key and salt bytes for a leg mediad is keying. A new pair
// per leg: RFC 3711 §9.1 bounds the packets one key may protect, and sharing one across calls would
// let a peer decrypt another org's media.
func GenerateKeyMaterial() (Crypto, error) {
	material := make([]byte, SRTPKeyMaterial)
	if _, err := rand.Read(material); err != nil {
		return Crypto{}, err
	}
	return Crypto{Tag: 1, KeyMaterial: material}, nil
}
