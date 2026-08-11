// Package control is mediad's NATS command surface: the Go responder for `rpc.media.v1.*`.
//
// # The contract now lives in packages/events, and this is the promotion
//
// v0 defined its subjects and its structs here, deliberately, because the command set bridged-call
// parity actually needs was not knowable until a real capability had been built against it, and
// promoting a guess into the shared contract would have frozen the guess. All four promotion
// criteria in plans/mediad-design.md §4.3 are now met — rung 2 works, SDP is in the payloads, and
// the engine has a real `MediadMediaPort` — so the shapes below are `packages/events-go` types
// generated from the Zod source of truth, and the drift gate keeps the two languages honest.
//
// # Raw NATS, not a Nest @MessagePattern — and the same rule in reverse
//
// The responder here is a raw `conn.Subscribe` + `msg.Respond`, so the bytes on the wire are exactly
// the generated structs. That is mandatory for a subject with a non-TypeScript participant, and
// this family is that case in its purest form: a Go responder answering a NestJS caller.
//
// NestJS's NATS transport frames request-reply as `{"pattern":…,"data":…,"id":…}` /
// `{"response":…,"isDisposed":true,"id":…}`, and a request carrying the bare contract payload is not
// answered at all — it times out. The obligation runs the other way here: the ENGINE's client must
// be a raw `NatsConnection.request()`, NOT a `ClientProxy.send`, because a ClientProxy would wrap
// the payload in that framing and this handler would reject it as malformed. The rule is recorded
// on `mediaAllocateSessionRequestSchema` in packages/events for whoever writes the next client.
//
// # A refusal is a REPLY, never a silence
//
// Every handler answers. A responder that simply does not reply to a request it dislikes is
// indistinguishable from a crashed one, and the caller pays the whole timeout to learn nothing.
// `ok:false` with a machine-readable `reason` costs one round trip and tells the engine whether to
// retry, try another instance, or route the leg to Asterisk.
package control

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The v1 command subjects, taken from the contract package rather than restated.
//
// Re-declared as local names purely so the subscription table below reads as a list of this
// service's own surface; the VALUES come from packages/events-go, so a subject rename in the Zod
// source is a compile error here rather than a silent mismatch at runtime.
const (
	SubjectAllocateSession  = contract.SubjectMediaAllocateSessionRPC
	SubjectBridgeSessions   = contract.SubjectMediaBridgeSessionsRPC
	SubjectUnbridgeSessions = contract.SubjectMediaUnbridgeSessionsRPC
	SubjectReleaseSession   = contract.SubjectMediaReleaseSessionRPC
	SubjectStartPlayback    = contract.SubjectMediaStartPlaybackRPC
	SubjectStopPlayback     = contract.SubjectMediaStopPlaybackRPC
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

// Sessions is what the control surface needs from the packet path.
//
// An interface rather than the concrete *rtp.Manager so the handlers are table-testable against a
// stub with no sockets in it — the same line sipd's registrar draws with credentials.Store.
type Sessions interface {
	Allocate(opts rtp.AllocateOptions) (rtp.Descriptor, error)
	Bridge(bridgeID, first, second string) error
	Unbridge(bridgeID string) ([]string, bool)
	Release(sessionID string) bool
	StartPlayback(sessionID string, opts rtp.PlaybackOptions) error
	StopPlayback(playbackRef string) (string, bool)
	// AudioPayloadType reports the G.711 type a live session answered with, and whether it exists.
	//
	// A VALUE and not the *rtp.Session it came from, deliberately: the control surface needs
	// exactly one fact about the leg — which companding law to decode the clip into, because a
	// µ-law prompt on an A-law leg is a rasp rather than a wrong-sounding voice — and handing it a
	// live session would put the packet path's internals inside a NATS callback.
	AudioPayloadType(sessionID string) (uint8, bool)
}

// Server answers the v1 command subjects.
type Server struct {
	sessions   Sessions
	dir        directory.Store
	library    *audio.Library
	log        *slog.Logger
	instanceID string
	publicAddr netip.Addr
}

// ServerOptions configures a Server.
type ServerOptions struct {
	// Sessions is the packet path. Required.
	Sessions Sessions
	// Directory records session ownership. Required — see the package doc on directory.
	Directory directory.Store
	// Library resolves the prompts `start-playback` names. Nil is an unconfigured library, which
	// REFUSES every playback rather than answering ok and sending nothing.
	Library *audio.Library
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
	return &Server{
		sessions:   opts.Sessions,
		dir:        opts.Directory,
		library:    library,
		log:        log,
		instanceID: opts.InstanceID,
		publicAddr: opts.PublicAddr,
	}, nil
}

// InstanceID names this process. Carried on every reply so a refusal can be attributed.
func (s *Server) InstanceID() string { return s.instanceID }

// Subscribe attaches every handler to a connection and returns the subscriptions.
//
// Raw `conn.Subscribe`, and a queue group so several mediad instances can share the subjects and
// NATS picks one — which is what makes the media plane horizontally scalable without a load
// balancer or a discovery step. Per-instance addressing, which the three commands AFTER allocate
// need, is the `media-sessions` KV directory rather than a per-instance subject; see
// internal/directory.
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
	}

	subscriptions := make([]*nats.Subscription, 0, len(handlers))
	for _, handler := range handlers {
		handle := handler.handle
		subject := handler.subject

		respond := func(msg *nats.Msg) {
			// A request with no reply subject is a fire-and-forget publish onto an RPC subject.
			// Answering it is impossible and it is almost always a client bug, so it is logged
			// rather than silently dropped.
			if msg.Reply == "" {
				s.log.Warn("ignoring a request with no reply subject", "subject", subject)
				return
			}
			if err := msg.Respond(handle(msg.Data)); err != nil {
				s.log.Error("cannot reply", "subject", subject, "error", err)
			}
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
			// Unwind the ones already attached, so a partial failure does not leave mediad
			// answering half its command surface — which would look healthy and half-work.
			for _, attached := range subscriptions {
				_ = attached.Unsubscribe()
			}
			return nil, fmt.Errorf("control: subscribing to %s: %w", subject, err)
		}
		subscriptions = append(subscriptions, subscription)
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

// dirContext bounds a directory operation. See directory.Timeout for why it is short.
func dirContext() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), directory.Timeout)
}

// nowMillis is the clock every timestamp on the wire uses. Epoch milliseconds, matching every other
// KV value on this backbone.
func nowMillis() int64 { return time.Now().UnixMilli() }

// sdpSessionIDs derives the `o=` line's session id and version from a session id and a port.
//
// Deterministic rather than random so that a re-answer of the same session produces the same origin
// — some endpoints treat a changed `o=` session id as a whole new session and renegotiate.
func sdpSessionIDs(port int) (uint64, uint64) {
	return uint64(port), 1
}
