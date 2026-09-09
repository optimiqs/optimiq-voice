// Package control is mediad's NATS command surface: the Go responder for `rpc.media.v1.*`.
//
// Two invariants hold across every handler. The wire carries the bare packages/events-go structs on
// a raw conn.Subscribe/msg.Respond, so a caller must use a raw NatsConnection.request(), NOT a
// NestJS ClientProxy, whose {"pattern",...,"data"} framing this responder rejects as malformed. And
// every request gets a reply: a refusal is `ok:false` with a machine-readable `reason`, never
// silence, which a caller cannot tell from a crash until its own timeout expires.
package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	secure "github.com/optimiqs/optimiq-voice/apps/mediad/internal/webrtc"
)

// The v1 command subjects. Local names over contract values, so a rename in the Zod source is a
// compile error here rather than a runtime mismatch.
const (
	SubjectAllocateSession  = contract.SubjectMediaAllocateSessionRPC
	SubjectBridgeSessions   = contract.SubjectMediaBridgeSessionsRPC
	SubjectUnbridgeSessions = contract.SubjectMediaUnbridgeSessionsRPC
	SubjectReleaseSession   = contract.SubjectMediaReleaseSessionRPC
	SubjectStartPlayback    = contract.SubjectMediaStartPlaybackRPC
	SubjectStopPlayback     = contract.SubjectMediaStopPlaybackRPC
	SubjectSendDtmf         = contract.SubjectMediaSendDtmfRPC
	SubjectStartRecording   = contract.SubjectMediaStartRecordingRPC
	SubjectStopRecording    = contract.SubjectMediaStopRecordingRPC
	SubjectTapSession       = contract.SubjectMediaTapSessionRPC
	SubjectUntapSession     = contract.SubjectMediaUntapSessionRPC
	// Two subjects, not four: mute and unmute differ in one bit of one payload, where a bridge and
	// an unbridge differ in their whole shape.
	SubjectMuteSession = contract.SubjectMediaMuteSessionRPC
	SubjectHoldSession = contract.SubjectMediaHoldSessionRPC
	// The B-leg pair: a leg the engine originates has no inbound offer, so create-offer writes one
	// and accept-answer settles the callee's reply onto the live session.
	SubjectCreateOffer  = contract.SubjectMediaCreateOfferRPC
	SubjectAcceptAnswer = contract.SubjectMediaAcceptAnswerRPC
)

// Refusal codes. Values come from the contract; these names exist so a handler reads as prose.
const (
	ReasonBadRequest   = "bad_request"
	ReasonCapacity     = "capacity"
	ReasonShuttingDown = "shutting_down"
	ReasonUnknown      = "unknown_session"
	ReasonWrongNode    = "wrong_instance"
	ReasonNotSupported = "not_supported"
	ReasonInternal     = "internal"
)

// Sessions is what the control surface needs from the packet path. An interface rather than
// *rtp.Manager so the handlers are testable against a stub with no sockets in it.
type Sessions interface {
	Allocate(opts rtp.AllocateOptions) (rtp.Descriptor, error)
	Bridge(bridgeID, first, second string) error
	Unbridge(bridgeID string) ([]string, bool)
	Release(sessionID string) bool
	StartPlayback(sessionID string, opts rtp.PlaybackOptions) error
	StopPlayback(playbackRef string) (string, bool)
	SendDtmf(sessionID string, opts rtp.DtmfOptions) error
	StartRecording(sessionID string, opts rtp.RecordingOptions) error
	StopRecording(recordingRef string) (string, bool)
	// AudioPayloadType reports the G.711 type a live session answered with, and whether it exists.
	// A value rather than the session, so the packet path's internals stay out of a NATS callback.
	AudioPayloadType(sessionID string) (uint8, bool)
	// TelephoneEventPayloadType reports the RFC 4733 type a live session answered with. Zero means
	// the leg negotiated none, which is what `send-dtmf` refuses on rather than synthesising a tone.
	TelephoneEventPayloadType(sessionID string) (uint8, bool)
	// SessionTenancy reports the org and call a session was allocated for; both are needed for a
	// recording's `<root>/<orgId>/<callId>/<recordingRef>.wav` key.
	SessionTenancy(sessionID string) (orgID, callID string, ok bool)

	// ApplyDirection re-points a live session's media direction after a re-negotiation. It arrives
	// as a repeat allocate-session carrying the new direction, so one re-INVITE produces one command.
	ApplyDirection(sessionID string, muteIn, muteOut bool) error

	// SettleAnswer pins the codec and telephone-event type a callee chose onto a live B-leg that
	// create-offer bound on a default. An unknown id is rtp.ErrUnknownSession.
	SettleAnswer(sessionID string, format audio.Format, audioPT, telephoneEventPT uint8) (rtp.Descriptor, error)

	// Tap joins a supervisor to a conversation on asymmetric terms; Untap takes it down.
	Tap(opts rtp.TapOptions) (rtp.TapResult, error)
	Untap(tapID string) (string, bool)

	// Mute gates one direction of one leg; Hold takes a leg out of the conversation both ways. The
	// readers beside them are load-bearing: a mute is additive and a hold stands even when its
	// music could not start, so neither reply is derivable from the command.
	Mute(sessionID string, direction rtp.MediaDirection) error
	Unmute(sessionID string, direction rtp.MediaDirection) error
	MuteState(sessionID string) (in, out, ok bool)
	Hold(sessionID string, opts rtp.HoldOptions) error
	Unhold(sessionID string) (bool, error)
	HoldState(sessionID string) (held bool, musicRef string, ok bool)

	// A conference reached directly rather than as a side effect of a tap.
	JoinConference(conferenceID, sessionID string, opts rtp.JoinOptions) error
	DestroyConference(conferenceID string) ([]string, bool)
}

// Server answers the v1 command subjects.
type Server struct {
	webRTC         *secure.Factory
	webRTCSessions sync.Map
	sessions       Sessions
	dir            directory.Store
	library        *audio.Library
	recordingsDir  string
	log            *slog.Logger
	instanceID     string
	publicAddr     netip.Addr
	ownership      *ownershipRouter
}

// ServerOptions configures a Server.
type ServerOptions struct {
	WebRTC *secure.Factory
	// Sessions is the packet path. Required.
	Sessions Sessions
	// Directory records session ownership. Required — see the package doc on directory.
	Directory directory.Store
	// Owners enables atomic call placement and per-instance routing. Required in production.
	Owners directory.Owners
	// Library resolves the prompts `start-playback` names. Nil is an unconfigured library, which
	// REFUSES every playback rather than answering ok and sending nothing.
	Library *audio.Library
	// RecordingsDir is the root `start-recording` writes under, from MEDIAD_RECORDINGS_DIR. Empty
	// REFUSES every recording by name, for the same reason an unconfigured Library does.
	RecordingsDir string
	// InstanceID names this process on the wire and in the directory. Required.
	InstanceID string
	// PublicAddr is what goes into an SDP answer's `c=` line. Required.
	PublicAddr netip.Addr
	// Logger defaults to slog.Default().
	Logger *slog.Logger
}

// NewServer builds a Server.
func NewServer(opts ServerOptions) (*Server, error) {
	switch {
	case opts.Sessions == nil:
		return nil, errors.New("control: a session manager is required")
	case opts.Directory == nil:
		return nil, errors.New("control: a session directory is required")
	case opts.InstanceID == "":
		return nil, errors.New("control: an instance id is required")
	case !opts.PublicAddr.IsValid():
		return nil, errors.New("control: a public address is required")
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	library := opts.Library
	if library == nil {
		library = audio.NewLibrary("")
	}
	var ownership *ownershipRouter
	if opts.Owners != nil {
		ownership = &ownershipRouter{
			store:    opts.Owners,
			tracked:  make(map[string]map[string]struct{}),
			forwards: make(chan struct{}, maxConcurrentForwards),
		}
	}
	return &Server{
		webRTC:        opts.WebRTC,
		ownership:     ownership,
		sessions:      opts.Sessions,
		dir:           opts.Directory,
		library:       library,
		recordingsDir: strings.TrimSpace(opts.RecordingsDir),
		log:           log,
		instanceID:    opts.InstanceID,
		publicAddr:    opts.PublicAddr,
	}, nil
}

// InstanceID names this process. Carried on every reply so a refusal can be attributed.
func (s *Server) InstanceID() string { return s.instanceID }

// Subscribe attaches every handler to a connection and returns the subscriptions.
//
// The queue group lets several mediad instances share the subjects without a load balancer;
// per-instance addressing after allocate comes from the media-sessions KV directory.
func (s *Server) Subscribe(conn *nats.Conn, queueGroup string) ([]*nats.Subscription, error) {
	if conn == nil {
		return nil, errors.New("control: a NATS connection is required")
	}

	handlers := []struct {
		subject string
		handle  func([]byte) []byte
	}{
		{SubjectAllocateSession, s.HandleAllocateSession},
		{SubjectBridgeSessions, s.HandleBridgeSessions},
		{SubjectUnbridgeSessions, s.HandleUnbridgeSessions},
		{SubjectReleaseSession, s.HandleReleaseSession},
		{SubjectStartPlayback, s.HandleStartPlayback},
		{SubjectStopPlayback, s.HandleStopPlayback},
		{SubjectSendDtmf, s.HandleSendDtmf},
		{SubjectStartRecording, s.HandleStartRecording},
		{SubjectStopRecording, s.HandleStopRecording},
		{SubjectTapSession, s.HandleTapSession},
		{SubjectUntapSession, s.HandleUntapSession},
		{SubjectMuteSession, s.HandleMuteSession},
		{SubjectHoldSession, s.HandleHoldSession},
		{SubjectCreateOffer, s.HandleCreateOffer},
		{SubjectAcceptAnswer, s.HandleAcceptAnswer},
	}

	subscriptions := make([]*nats.Subscription, 0, len(handlers))
	for _, handler := range handlers {
		handle := handler.handle
		subject := handler.subject

		respond := func(msg *nats.Msg) {
			// Unanswerable, and almost always a client bug, so log rather than drop silently.
			if msg.Reply == "" {
				s.log.Warn("ignoring a request with no reply subject", "subject", subject)
				return
			}
			addressed := msg.Subject != subject
			answer := func(reply []byte) {
				if err := msg.Respond(reply); err != nil {
					s.log.Error("cannot reply", "subject", subject, "error", err)
				}
			}
			reply, forward := s.routeRequest(conn, subject, msg.Data, handle, addressed)
			if forward == nil {
				answer(reply)
				return
			}
			// Off the dispatcher: see routeRequest.
			go func() { answer(forward()) }()
		}

		var (
			subscription *nats.Subscription
			err          error
		)
		if queueGroup != "" {
			subscription, err = conn.QueueSubscribe(subject, queueGroup, respond)
		} else {
			subscription, err = conn.Subscribe(subject, respond)
		}
		if err != nil {
			// Unwind, so a partial failure cannot leave mediad answering half its command surface.
			for _, attached := range subscriptions {
				_ = attached.Unsubscribe()
			}
			return nil, fmt.Errorf("control: subscribing to %s: %w", subject, err)
		}
		subscriptions = append(subscriptions, subscription)
		addressed, err := conn.Subscribe(mediaInstanceSubject(subject, s.instanceID), respond)
		if err != nil {
			for _, attached := range subscriptions {
				_ = attached.Unsubscribe()
			}
			return nil, fmt.Errorf("control: subscribing to addressed %s: %w", subject, err)
		}
		subscriptions = append(subscriptions, addressed)
	}
	return subscriptions, nil
}

// encode marshals a reply. A reply that cannot be marshalled is a programming error, but the caller
// is mid-call, so it degrades to a hand-written refusal rather than to a timeout.
func encode(log *slog.Logger, reply any) []byte {
	payload, err := json.Marshal(reply)
	if err != nil {
		log.Error("cannot encode a reply", "error", err)
		return []byte(`{"ok":false,"reason":"internal","error":"cannot encode the reply"}`)
	}
	return payload
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func intPtr(value int) *int { return &value }

// dirContext bounds a directory operation.
func dirContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), directory.Timeout)
}

// nowMillis is epoch milliseconds, the clock every timestamp on this backbone uses.
func nowMillis() int64 { return time.Now().UnixMilli() }

// sdpSessionIDs derives the `o=` line's session id and version. Deterministic, so a re-answer keeps
// the same origin: some endpoints renegotiate when the `o=` session id changes.
func sdpSessionIDs(port int) (uint64, uint64) {
	return uint64(port), 1
}
