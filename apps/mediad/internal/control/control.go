// Package control is mediad's NATS command surface.
//
// # Why the subjects live here and not in packages/events
//
// Every other cross-service subject in this platform is defined in `packages/events` (Zod) and
// generated into `packages/events-go`, and that is where `rpc.media.*` will end up. It is NOT
// there yet, on purpose — the head of `packages/events/src/schemas/rpc.ts` already says so:
//
//	`rpc.media.*` (engine → `mediad`) is deliberately absent: it arrives with `apps/mediad`, and
//	inventing its shape before the media plane exists would be fiction.
//
// The command set that bridged-call parity actually needs (design doc §3) is not known until a
// real capability has been built against it. Promoting a guess into the shared contract would
// freeze it: `packages/events` is consumed by apps/api, apps/engine and packages/events-go, and a
// field added there is a field every service compiles against. So v0 lives here, is named `v0`
// rather than `v1` so nothing mistakes it for a stable contract, and moves to `packages/events` as
// `rpc.media.v1.*` when the first capability has proven the shape. Design doc §4 has the promotion
// criteria.
//
// # Raw NATS, not a Nest @MessagePattern — and the same rule in reverse
//
// The responder here is a raw `conn.Subscribe` + `msg.Respond`, so the bytes on the wire are
// exactly the structs below. That is mandatory for a subject with a non-TypeScript participant,
// and mediad is a Go process talking to a NestJS engine, so this subject is that case in its purest
// form. NestJS's NATS transport frames request-reply as `{"pattern":…,"data":…,"id":…}` /
// `{"response":…,"isDisposed":true,"id":…}`, and a request carrying the bare contract payload is
// not answered at all — it times out. `rpc.sip.v1.credential` is served raw by apps/api for exactly
// this reason (see `apps/api/src/pbx/sip-credentials/sip-credentials.responder.ts`).
//
// The obligation runs the other way too: when the engine calls into mediad, its client must be a
// raw NATS request, NOT a Nest `ClientProxy.send`. A `ClientProxy` would wrap the payload in the
// framing above and this handler would reject it as malformed. Design doc §4 states this as a
// requirement on the engine-side client.
package control

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The v0 command subjects.
//
// `v0` is load-bearing. It means "this shape WILL change and nothing outside mediad and the
// engine's mediad client may depend on it". The moment it is promoted to `packages/events` it
// becomes `rpc.media.v1.*` and gains the compatibility obligations every other `.v1` subject has.
const (
	// SubjectAllocate reserves an RTP port pair for a session.
	SubjectAllocate = "rpc.media.v0.allocate"
	// SubjectRelease frees one.
	SubjectRelease = "rpc.media.v0.release"
)

// Suggested client deadlines, in the shape packages/events-go states them (TimeoutXxxRPC).
//
// Both are short because both are on the call path: an allocate sits inside the engine's answer of
// an INVITE, and a caller hears the delay as silence before ringback. Allocate does a bind — a
// syscall, microseconds — so 500 ms is three orders of magnitude of headroom, and a reply slower
// than that means the instance is sick rather than busy.
const (
	TimeoutAllocateRPC = 500 * time.Millisecond
	TimeoutReleaseRPC  = 500 * time.Millisecond
)

// AllocateRequest asks for a port pair.
type AllocateRequest struct {
	// SessionID is assigned by the CALLER, never by mediad.
	//
	// Same reason `OriginateRequest.channelId` is client-assigned at the engine's MediaPort seam:
	// the caller must be able to release a session whose allocate reply it never received. A
	// server-assigned id would mean a timed-out allocate leaves a port held under a name nobody
	// knows, and the only recovery would be the idle reaper. It is also what makes Allocate
	// idempotent — see rtp.Manager.Allocate.
	SessionID string `json:"sessionId"`
	// CallID is the call this leg belongs to. Carried for logs and for the future session
	// directory; mediad does not route on it in v0.
	CallID string `json:"callId,omitempty"`
	// Mode is "echo" (default) or "inactive". See rtp.Mode.
	Mode string `json:"mode,omitempty"`
}

// AllocateResponse is the reply.
//
// Every field is present on success and the error path is a REPLY, never a silence. A responder
// that simply does not answer a request it dislikes is indistinguishable from a crashed one, and
// the caller pays the full timeout to learn nothing. `ok:false` with a reason costs one round trip
// and tells the engine whether to retry, try another instance, or fail the call.
type AllocateResponse struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"sessionId"`
	// Address is the address the far end should send RTP to — MEDIAD_PUBLIC_IP, not the bind
	// address. It is what goes in an SDP `c=` line.
	Address string `json:"address,omitempty"`
	RTPPort int    `json:"rtpPort,omitempty"`
	// RTCPPort is always RTPPort+1 (RFC 3550 §11). Stated explicitly anyway, so a caller never has
	// to re-derive a convention.
	RTCPPort int    `json:"rtcpPort,omitempty"`
	SSRC     uint32 `json:"ssrc,omitempty"`
	Mode     string `json:"mode,omitempty"`
	// PayloadTypes is what this session accepts, most-preferred first. v0 is G.711 passthrough
	// plus RFC 4733, so the answer is always the same; it is on the wire so the SDP wave can start
	// reading it instead of hard-coding the list on the engine side.
	//
	// `[]int`, NOT `[]uint8`, and this is a correctness fix rather than a style choice.
	// `[]uint8` is `[]byte` to Go, and encoding/json marshals `[]byte` as a BASE64 STRING: the
	// reply would carry `"payloadTypes":"AAhl"` instead of `[0,8,101]`, and the TypeScript engine
	// would receive a string where it expects an array. A Go-to-Go round trip decodes that back
	// happily, so only a test that inspects the actual JSON — or a real cross-language call —
	// catches it. See TestPayloadTypesAreAJSONArrayNotBase64.
	PayloadTypes []int `json:"payloadTypes,omitempty"`
	// Error is a human-readable reason when OK is false.
	Error string `json:"error,omitempty"`
	// Reason is a stable machine-readable code. The engine branches on THIS, never on Error.
	Reason string `json:"reason,omitempty"`
}

// ReleaseRequest frees a session.
type ReleaseRequest struct {
	SessionID string `json:"sessionId"`
}

// ReleaseResponse reports what happened.
type ReleaseResponse struct {
	OK        bool   `json:"ok"`
	SessionID string `json:"sessionId"`
	// Released is false when there was no such session. That is a SUCCESS, not a failure: release
	// is idempotent, and a retry after a lost reply must not look like an error.
	Released bool   `json:"released"`
	Error    string `json:"error,omitempty"`
	Reason   string `json:"reason,omitempty"`
}

// Machine-readable refusal codes. The engine branches on these.
const (
	// ReasonBadRequest — the payload was malformed or a required field was missing. Retrying the
	// same bytes will fail the same way.
	ReasonBadRequest = "bad_request"
	// ReasonCapacity — no port pair is free. Retry elsewhere, or fail the call with congestion.
	// This is the one refusal that is about load rather than correctness.
	ReasonCapacity = "capacity"
	// ReasonShuttingDown — this instance is draining. Do not retry HERE.
	ReasonShuttingDown = "shutting_down"
	// ReasonInternal — anything else.
	ReasonInternal = "internal"
)

// Sessions is what the control surface needs from the packet path. An interface rather than the
// concrete *rtp.Manager so the handlers are table-testable against a stub with no sockets in it —
// the same reason sipd's registrar takes a credentials.Store.
type Sessions interface {
	Allocate(sessionID string, mode rtp.Mode) (rtp.Descriptor, error)
	Release(sessionID string) bool
}

// Server answers the v0 command subjects.
type Server struct {
	sessions Sessions
	log      *slog.Logger
}

// NewServer builds a Server.
func NewServer(sessions Sessions, log *slog.Logger) (*Server, error) {
	if sessions == nil {
		return nil, errors.New("control: a session manager is required")
	}
	if log == nil {
		log = slog.Default()
	}
	return &Server{sessions: sessions, log: log}, nil
}

// HandleAllocate turns request bytes into reply bytes.
//
// Bytes in, bytes out, no *nats.Msg: the whole handler is then a pure function of the payload, and
// the unit suite covers it as a table without a broker anywhere near it. sipd draws the same line —
// `credentialFromReply` is tested in-package while the transport is left to the gated integration
// suite. It never returns an error, because there is no caller that could do anything with one: a
// refusal IS the reply.
func (s *Server) HandleAllocate(data []byte) []byte {
	var request AllocateRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return encode(s.log, AllocateResponse{
			OK:     false,
			Error:  fmt.Sprintf("malformed allocate request: %v", err),
			Reason: ReasonBadRequest,
		})
	}

	if request.SessionID == "" {
		return encode(s.log, AllocateResponse{
			OK:     false,
			Error:  "sessionId is required and must be assigned by the caller",
			Reason: ReasonBadRequest,
		})
	}

	mode, err := rtp.ParseMode(request.Mode)
	if err != nil {
		return encode(s.log, AllocateResponse{
			OK:        false,
			SessionID: request.SessionID,
			Error:     err.Error(),
			Reason:    ReasonBadRequest,
		})
	}

	descriptor, err := s.sessions.Allocate(request.SessionID, mode)
	if err != nil {
		reason := ReasonInternal
		switch {
		case errors.Is(err, rtp.ErrPortsExhausted):
			reason = ReasonCapacity
		case errors.Is(err, rtp.ErrClosed):
			reason = ReasonShuttingDown
		}
		// Logged at WARN rather than ERROR: capacity and shutdown are operational states, and a
		// deploy would otherwise page on every drain.
		s.log.Warn("refusing an allocate",
			"sessionId", request.SessionID, "callId", request.CallID,
			"reason", reason, "error", err)
		return encode(s.log, AllocateResponse{
			OK:        false,
			SessionID: request.SessionID,
			Error:     err.Error(),
			Reason:    reason,
		})
	}

	return encode(s.log, AllocateResponse{
		OK:           true,
		SessionID:    descriptor.SessionID,
		Address:      descriptor.Address.String(),
		RTPPort:      descriptor.RTPPort,
		RTCPPort:     descriptor.RTCPPort,
		SSRC:         descriptor.SSRC,
		Mode:         string(descriptor.Mode),
		PayloadTypes: widenPayloadTypes(descriptor.PayloadTypes),
	})
}

// widenPayloadTypes converts the packet path's `[]uint8` to the wire's `[]int`. See
// AllocateResponse.PayloadTypes for why the wire type is not `[]uint8`.
func widenPayloadTypes(payloadTypes []uint8) []int {
	widened := make([]int, len(payloadTypes))
	for i, pt := range payloadTypes {
		widened[i] = int(pt)
	}
	return widened
}

// HandleRelease turns request bytes into reply bytes.
func (s *Server) HandleRelease(data []byte) []byte {
	var request ReleaseRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return encode(s.log, ReleaseResponse{
			OK:     false,
			Error:  fmt.Sprintf("malformed release request: %v", err),
			Reason: ReasonBadRequest,
		})
	}
	if request.SessionID == "" {
		return encode(s.log, ReleaseResponse{
			OK:     false,
			Error:  "sessionId is required",
			Reason: ReasonBadRequest,
		})
	}

	// Releasing an unknown session is OK:true, Released:false. See ReleaseResponse.Released.
	return encode(s.log, ReleaseResponse{
		OK:        true,
		SessionID: request.SessionID,
		Released:  s.sessions.Release(request.SessionID),
	})
}

// Subscribe attaches both handlers to a connection and returns the subscriptions.
//
// Raw `conn.Subscribe`, and a queue group so several mediad instances can share the subject and
// NATS picks one — which is what makes the media plane horizontally scalable without a load
// balancer or a discovery step. Per-instance addressing (the engine talking to the specific
// instance holding a session) is a v1 problem and is design doc open question 2.
func (s *Server) Subscribe(conn *nats.Conn, queueGroup string) ([]*nats.Subscription, error) {
	if conn == nil {
		return nil, errors.New("control: a NATS connection is required")
	}

	handlers := []struct {
		subject string
		handle  func([]byte) []byte
	}{
		{SubjectAllocate, s.HandleAllocate},
		{SubjectRelease, s.HandleRelease},
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

// encode marshals a reply. A reply that cannot be marshalled is a programming error, but the
// caller is mid-call, so it degrades to a hand-written refusal rather than to a timeout.
func encode(log *slog.Logger, reply any) []byte {
	payload, err := json.Marshal(reply)
	if err != nil {
		log.Error("cannot encode a reply", "error", err)
		return []byte(`{"ok":false,"reason":"internal","error":"cannot encode the reply"}`)
	}
	return payload
}
