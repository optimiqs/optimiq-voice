package control

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
	secure "github.com/optimiqs/optimiq-voice/apps/mediad/internal/webrtc"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

type webRTCSession struct {
	mu            sync.Mutex
	orgID, callID string
	transport     *secure.Transport
	descriptor    rtp.Descriptor
}

func (s *Server) secureSession(sessionID, orgID, callID, legID string) (*webRTCSession, bool, error) {
	value, _ := s.webRTCSessions.LoadOrStore(sessionID, &webRTCSession{orgID: orgID, callID: callID})
	entry := value.(*webRTCSession)
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.orgID != orgID || entry.callID != callID {
		return nil, false, errors.New("session belongs to another call")
	}
	if entry.transport != nil {
		select {
		case <-entry.transport.Done():
			return nil, false, errors.New("WebRTC session has ended")
		default:
		}
		return entry, false, nil
	}
	transport, err := s.webRTC.New(sessionID)
	if err != nil {
		s.webRTCSessions.CompareAndDelete(sessionID, entry)
		return nil, false, err
	}
	descriptor, err := s.sessions.Allocate(rtp.AllocateOptions{
		SessionID: sessionID, OrgID: orgID, CallID: callID, LegID: legID,
		AudioPayloadType: 0, Format: audio.FormatULaw, TelephoneEventPayloadType: 101, Transport: transport,
	})
	if err != nil {
		_ = transport.Close()
		s.webRTCSessions.CompareAndDelete(sessionID, entry)
		return nil, false, err
	}
	entry.transport, entry.descriptor = transport, descriptor
	go func() { <-transport.Done(); s.webRTCSessions.CompareAndDelete(sessionID, entry) }()
	return entry, true, nil
}

func (s *Server) allocateWebRTC(request contract.MediaAllocateSessionRequest) []byte {
	if request.Direction != "" && request.Direction != "sendrecv" {
		return s.refuseAllocate(request.SessionID, ReasonNotSupported, "WebRTC direction must be negotiated in the peer's SDP offer")
	}
	if s.webRTC == nil {
		return s.refuseAllocate(request.SessionID, ReasonNotSupported, "WebRTC media is not enabled on this instance")
	}
	entry, created, err := s.secureSession(request.SessionID, request.OrgID, request.CallID, derefString(request.LegID))
	if err != nil {
		return s.refuseAllocate(request.SessionID, ReasonInternal, err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	answer, err := entry.transport.Answer(ctx, request.SDPOffer)
	if err != nil {
		if created {
			s.sessions.Release(request.SessionID)
		}
		return s.refuseAllocate(request.SessionID, ReasonNotSupported, err.Error())
	}
	negotiated, err := sdp.ParseOffer(answer)
	if err != nil {
		return s.refuseAllocate(request.SessionID, ReasonInternal, err.Error())
	}
	descriptor, err := s.sessions.SettleAnswer(request.SessionID, negotiated.Codec.Format(), negotiated.AudioPayloadType, negotiated.TelephoneEventPayloadType)
	if err != nil {
		return s.refuseAllocate(request.SessionID, ReasonInternal, err.Error())
	}
	muteIn, muteOut := directionToMutes(negotiated.Direction)
	if err := s.sessions.ApplyDirection(request.SessionID, muteIn, muteOut); err != nil {
		return s.refuseAllocate(request.SessionID, ReasonInternal, err.Error())
	}
	s.recordSession(request, descriptor)
	codec := contract.MediaAllocateSessionResponseCodec(negotiated.Codec)
	return encode(s.log, contract.MediaAllocateSessionResponse{
		Ok: true, SessionID: request.SessionID, SDPAnswer: stringPtr(answer), InstanceID: stringPtr(s.instanceID),
		Address: stringPtr(descriptor.Address.String()), RtpPort: intPtr(descriptor.RTPPort), RtcpPort: intPtr(descriptor.RTCPPort),
		Ssrc: intPtr(int(descriptor.SSRC)), Codec: &codec, TelephoneEventPayloadType: intPtr(int(negotiated.TelephoneEventPayloadType)),
	})
}

func (s *Server) createWebRTCOffer(request contract.MediaCreateOfferRequest) []byte {
	if s.webRTC == nil {
		return s.refuseCreateOffer(request.SessionID, ReasonNotSupported, "WebRTC media is not enabled on this instance")
	}
	if request.Direction != "" && request.Direction != "sendrecv" {
		return s.refuseCreateOffer(request.SessionID, ReasonNotSupported, "WebRTC offers currently require sendrecv")
	}
	entry, created, err := s.secureSession(request.SessionID, request.OrgID, request.CallID, derefString(request.LegID))
	if err != nil {
		return s.refuseCreateOffer(request.SessionID, ReasonInternal, err.Error())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	offer, err := entry.transport.Offer(ctx)
	if err != nil {
		if created {
			s.sessions.Release(request.SessionID)
		}
		return s.refuseCreateOffer(request.SessionID, ReasonInternal, err.Error())
	}
	descriptor := entry.descriptor
	s.recordSessionEntry(request.OrgID, request.CallID, derefString(request.LegID), descriptor)
	return encode(s.log, contract.MediaCreateOfferResponse{
		Ok: true, SessionID: request.SessionID, SDPOffer: stringPtr(offer), InstanceID: stringPtr(s.instanceID),
		Address: stringPtr(descriptor.Address.String()), RtpPort: intPtr(descriptor.RTPPort), RtcpPort: intPtr(descriptor.RTCPPort),
		Ssrc: intPtr(int(descriptor.SSRC)), TelephoneEventPayloadType: intPtr(101),
	})
}
