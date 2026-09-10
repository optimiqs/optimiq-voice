package control

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// errSRTPRequired is the refusal MEDIAD_SRTP_POLICY=require produces. `not_supported` on the wire:
// the offer is well-formed, so the engine's recovery is to route the leg elsewhere, not to retry.
var errSRTPRequired = errors.New(
	"this media plane requires SDES-SRTP (RFC 4568) and the offer carried no usable " +
		sdp.SRTPSuite + " crypto line under RTP/SAVP")

// acceptedProtocols is the audio transports a SIP allocate may carry, under the configured policy.
// RTP/SAVP is absent under `disable` and plain RTP/AVP under `require`, so an offer this instance
// would have to answer in a transport it will not speak is refused by the existing transport check
// rather than answered with a mismatched `m=` line.
func (s *Server) acceptsProtocol(proto string) bool {
	switch proto {
	case sdp.ProtoAVP, "RTP/AVPF":
		return s.srtpPolicy != config.SRTPRequire
	case sdp.ProtoSAVP:
		return s.srtpPolicy != config.SRTPDisable
	default:
		return false
	}
}

// negotiateSDES answers an offer's crypto attribute: our own fresh key under the tag the offer
// used (RFC 4568 §5.1.2), plus the context that protects the packets.
//
// A zero Crypto and a nil context is the plain-RTP outcome, which renders exactly the body an
// unencrypted leg has always been answered with.
func (s *Server) negotiateSDES(offered sdp.Crypto) (sdp.Crypto, *rtp.SRTPContext, error) {
	if s.srtpPolicy == config.SRTPDisable || !offered.IsSet() {
		if s.srtpPolicy == config.SRTPRequire {
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
func (s *Server) offerSDES() (sdp.Crypto, error) {
	if s.srtpPolicy != config.SRTPRequire {
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
func (s *Server) settleOfferedSDES(sessionID string, answered sdp.Crypto) error {
	_, err := s.sessions.Negotiate(sessionID, "",
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
	return err
}
