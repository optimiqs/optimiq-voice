package control

import (
	"cmp"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// errSRTPRequired is the refusal MEDIAD_SRTP_POLICY=require produces. `not_supported` on the wire:
// the offer is well-formed, so the engine's recovery is to route the leg elsewhere, not to retry.
var errSRTPRequired = errors.New(
	"this media plane requires SDES-SRTP (RFC 4568) and the offer carried no usable " +
		sdp.SRTPSuite + " crypto line under RTP/SAVP")

// MediaEncryption is what a leg's audio is actually protected by, for a caller that wants to show
// it. Derived from the SRTP context the packet path holds, never from the configured policy: a
// `require` deployment whose key exchange has not settled yet is still carrying plaintext.
type MediaEncryption string

const (
	// MediaEncrypted means an SRTPContext is installed on the session and the packets are protected.
	MediaEncrypted MediaEncryption = "encrypted"
	// MediaPlaintext means the leg answered plain RTP, or its key exchange has not settled.
	MediaPlaintext MediaEncryption = "plaintext"
)

// legPolicy is the SDES policy in force for one leg: the `srtpPolicy` its command carried, or the
// server-wide fallback when it carried none.
//
// Generic over the requested type because allocate-session, create-offer and accept-answer each
// generate their own vocabulary type for the same three values. A value outside them is an error
// rather than a silent fallback: ignoring a misspelt `require` would downgrade a leg the caller
// asked to protect.
func legPolicy[T ~string](fallback config.SRTPPolicy, requested *T) (config.SRTPPolicy, error) {
	if requested == nil {
		return fallback, nil
	}
	switch policy := config.SRTPPolicy(*requested); policy {
	case "", config.SRTPPrefer, config.SRTPRequire, config.SRTPDisable:
		return cmp.Or(policy, fallback), nil
	default:
		return "", fmt.Errorf("srtpPolicy must be one of prefer/require/disable, got %q", policy)
	}
}

// acceptsProtocol is the audio transports a SIP allocate may carry, under the policy in force for
// this leg. RTP/SAVP is absent under `disable` and plain RTP/AVP under `require`, so an offer this
// instance would have to answer in a transport it will not speak is refused by the existing
// transport check rather than answered with a mismatched `m=` line.
func acceptsProtocol(policy config.SRTPPolicy, proto string) bool {
	switch proto {
	case sdp.ProtoAVP, "RTP/AVPF":
		return policy != config.SRTPRequire
	case sdp.ProtoSAVP:
		return policy != config.SRTPDisable
	default:
		return false
	}
}

// negotiateSDES answers an offer's crypto attribute: our own fresh key under the tag the offer
// used (RFC 4568 §5.1.2), plus the context that protects the packets.
//
// A zero Crypto and a nil context is the plain-RTP outcome, which renders exactly the body an
// unencrypted leg has always been answered with.
func negotiateSDES(policy config.SRTPPolicy, offered sdp.Crypto) (sdp.Crypto, *rtp.SRTPContext, error) {
	if policy == config.SRTPDisable || !offered.IsSet() {
		if policy == config.SRTPRequire {
			return sdp.Crypto{}, nil, errSRTPRequired
		}
		return sdp.Crypto{}, nil, nil
	}

	local, err := sdp.GenerateKeyMaterial()
	if err != nil {
		return sdp.Crypto{}, nil, err
	}
	local.Tag = offered.Tag
	context, err := rtp.NewSRTPContext(rtp.SRTPKeys{
		LocalKeyMaterial:  local.KeyMaterial,
		RemoteKeyMaterial: offered.KeyMaterial,
	})
	if err != nil {
		return sdp.Crypto{}, nil, err
	}
	return local, context, nil
}

// offerSDES draws the key a leg mediad ORIGINATES offers, or a zero Crypto when the policy does not
// ask for one.
//
// Only `require` offers SDES. An offer names one transport, so offering RTP/SAVP forecloses the
// fallback to plain RTP that `prefer` exists to keep for phones that speak no SRTP.
func offerSDES(policy config.SRTPPolicy) (sdp.Crypto, error) {
	if policy != config.SRTPRequire {
		return sdp.Crypto{}, nil
	}
	return sdp.GenerateKeyMaterial()
}

// negotiationRequest identifies a command for retry detection: the exact bytes the caller sent. A
// retry is byte-identical, so it replays the committed answer; a renegotiation differs somewhere —
// a new direction, a new offer, a rekey — and draws a new generation.
func negotiationRequest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// settleOfferedSDES completes a B-leg keyed by offerSDES once the callee's answer supplies the
// remote key.
//
// The answer settles the PENDING generation — the one create-offer committed — so an answer that
// arrives after a newer offer has been made cannot key the session with a retired local key.
func (s *Server) settleOfferedSDES(sessionID string, answered sdp.Crypto) (rtp.Negotiation, error) {
	return s.sessions.Negotiate(sessionID, "",
		func(prior rtp.Negotiation, _ bool) (*rtp.Negotiation, *rtp.SRTPContext, error) {
			if !prior.Pending {
				return nil, nil, nil
			}
			if !answered.IsSet() {
				return nil, nil, errSRTPRequired
			}
			context, err := rtp.NewSRTPContext(rtp.SRTPKeys{
				LocalKeyMaterial:  prior.Local.KeyMaterial,
				RemoteKeyMaterial: answered.KeyMaterial,
			})
			if err != nil {
				return nil, nil, err
			}
			settled := prior
			settled.Pending = false
			return &settled, context, nil
		})
}

// encryptionOf reads a committed negotiation as the leg's media state. A pending generation is the
// B-leg between create-offer and accept-answer: a local key is advertised but no context is
// installed, so the wire is still plaintext.
func encryptionOf(negotiation rtp.Negotiation) MediaEncryption {
	if negotiation.Local.IsSet() && !negotiation.Pending {
		return MediaEncrypted
	}
	return MediaPlaintext
}
