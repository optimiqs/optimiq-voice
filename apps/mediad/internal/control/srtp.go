package control

import (
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

// settleOfferedSDES completes a B-leg keyed by offerSDES once the callee's answer supplies the
// remote key. The local key is held between the two commands in pendingSRTP.
func (s *Server) settleOfferedSDES(sessionID string, answered sdp.Crypto) error {
	value, ok := s.pendingSRTP.LoadAndDelete(sessionID)
	if !ok {
		return nil
	}
	local, _ := value.(sdp.Crypto)
	if !answered.IsSet() {
		return errSRTPRequired
	}
	context, err := rtp.NewSRTPContext(rtp.SRTPKeys{
		LocalKeyMaterial:  local.KeyMaterial,
		RemoteKeyMaterial: answered.KeyMaterial,
	})
	if err != nil {
		return err
	}
	return s.sessions.SettleSRTP(sessionID, context)
}
