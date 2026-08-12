// Package command is sipd's NATS command surface: the Go responder for `rpc.sip.v1.*`.
//
// # The inversion, and the obligation it carries
//
// Every other NATS subject this process touches, it CALLS: `rpc.sip.v1.credential`,
// `rpc.sip.v1.transfer`, `rpc.sip.v1.invite`. These five it ANSWERS, and that makes this the first
// business subject sipd has ever subscribed to — the sentence in config/nats.conf calling the `sipd`
// user "a pure producer plus two requesters: it subscribes to no business subject at all" stops
// being true here.
//
// The responder is a raw `conn.Subscribe` + `msg.Respond`, so the bytes on the wire are exactly the
// generated structs. That is mandatory for a subject with a non-TypeScript participant, and this
// family is that case in its purest form: a Go responder answering a NestJS caller. NestJS's NATS
// transport frames request-reply as `{"pattern":…,"data":…,"id":…}`, and a request carrying the bare
// contract payload is not answered at all — it times out. The obligation therefore runs the other
// way here: the ENGINE's client must be a raw `NatsConnection.request()` and NOT a
// `ClientProxy.send`, because a ClientProxy would wrap the payload in that framing and these
// handlers would reject it as malformed. The rule is written on
// `mediaAllocateSessionRequestSchema`, and apps/mediad's internal/control is the shape this file
// follows.
//
// # Four per-instance subjects and one flat one
//
// `ring`, `answer`, `hangup` and `reinvite` act on a dialog that already exists, and a dialog lives
// on exactly ONE process: its transaction state, its retransmission timers, its CSeq and its socket
// are all local, and no other instance can answer, retransmit or BYE it (design §6.1). So those four
// are subscribed PER INSTANCE, at `rpc.sip.v1.<command>.<instanceToken>`, with no queue group — the
// same argument `rpc.engine.v1.park-handoff` makes: a queue group delivers to one member the server
// chooses, "and seven times out of eight that member is not the one holding the call".
//
// `originate` CREATES the dialog and has no owner to find, so it is flat and queue-grouped, and the
// reply carries the instanceId that took it — which the engine then addresses every subsequent
// command for that leg at. That is the pattern `allocate-session` established for a media session.
//
// # A refusal is a REPLY, never a silence
//
// Every handler answers. A responder that simply does not reply to a request it dislikes is
// indistinguishable from a crashed one, and the caller pays the whole timeout to learn nothing. On
// this family the cost is sharper than usual: an unanswered `answer` makes the engine believe a call
// it has already allocated media for did not connect, and it will hang up a leg whose 200 OK is on
// the wire.
package command

import (
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Refusal codes. The values come from the contract; these names exist so a handler reads as prose.
const (
	ReasonBadRequest         = "bad_request"
	ReasonUnknownDialog      = "unknown_dialog"
	ReasonWrongInstance      = "wrong_instance"
	ReasonDialogGone         = "dialog_gone"
	ReasonInvalidState       = "invalid_state"
	ReasonUnregisteredTarget = "unregistered_target"
	ReasonUnknownTrunk       = "unknown_trunk"
	ReasonNoRoute            = "no_route"
	ReasonCapacity           = "capacity"
	ReasonShuttingDown       = "shutting_down"
	ReasonNotSupported       = "not_supported"
	ReasonInternal           = "internal"
)

// Server answers the five command subjects.
type Server struct {
	dialogs  Dialogs
	instance string
	token    string
	log      *slog.Logger
}

// Options configures a Server. Every dependency is an interface, so the unit suite drives every
// handler as a table of payload bytes with no broker and no socket — the line apps/mediad's
// internal/control draws, and the reason its handlers are all `[]byte -> []byte`.
type Options struct {
	// Dialogs is the dialog surface these commands act on. Required.
	Dialogs Dialogs
	// InstanceID is this process's identity. Required: it is the token three of the five subjects
	// carry, and it is echoed on every reply so a `wrong_instance` tells the caller who DID answer.
	InstanceID string
	Logger     *slog.Logger
}

// NewServer validates the options and builds a Server.
func NewServer(opts Options) (*Server, error) {
	if opts.Dialogs == nil {
		return nil, errors.New("command: a dialog surface is required")
	}
	// contract.InstanceSubjectToken is the canonical, parity-pinned implementation the engine builds
	// its published subject from; this edge subscribes on the same token from the same function, so
	// the two cannot drift. It replaces the local duplicate this package used to carry.
	token, err := contract.InstanceSubjectToken(opts.InstanceID)
	if err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		dialogs:  opts.Dialogs,
		instance: strings.TrimSpace(opts.InstanceID),
		token:    token,
		log:      log,
	}, nil
}

// InstanceID names this process. Carried on every reply, refusal included, because the caller's next
// move on a `wrong_instance` is to work out who did answer.
func (s *Server) InstanceID() string { return s.instance }

// Token reports the subject token this server subscribes under, for the boot log. An operator
// staring at a call that never rings wants to compare this against the subject the engine published
// on, and printing it is the cheapest way to make that comparison possible.
func (s *Server) Token() string { return s.token }

// Subjects reports every subject this server attaches to, in subscription order. Diagnostics, the
// boot log, and the one thing a NATS permissions error should be checked against.
func (s *Server) Subjects() []string {
	return []string{
		s.subject(contract.SubjectSipRingRPC),
		s.subject(contract.SubjectSipAnswerRPC),
		s.subject(contract.SubjectSipHangupRPC),
		s.subject(contract.SubjectSipReinviteRPC),
		contract.SubjectSipOriginateRPC,
	}
}

func (s *Server) subject(root string) string { return root + "." + s.token }

// OriginateQueueGroup is the queue group the flat `originate` subject is subscribed under.
//
// Named rather than inlined because it is the one string that must be the SAME on every replica: a
// typo would give one instance a queue group of its own, and NATS would then deliver every originate
// to that instance AND to one member of the real group — so half the fleet's outbound calls would be
// placed twice.
const OriginateQueueGroup = "sipd-originate"

// Subscribe attaches every handler to a connection and returns the subscriptions.
//
// # Why the four are plain subscriptions and originate is queued
//
// See the package comment. The consequence worth restating at the call site: the four per-instance
// subjects must NOT be queue-grouped even though they carry a unique token, because a queue group
// with one member is a queue group that silently becomes a load balancer the day somebody
// misconfigures two pods with the same instance id — and the symptom would be half of one call's
// commands going to a process that does not hold it.
func (s *Server) Subscribe(conn *nats.Conn) ([]*nats.Subscription, error) {
	if conn == nil {
		return nil, errors.New("command: a NATS connection is required")
	}

	handlers := []struct {
		subject string
		queue   string
		handle  func([]byte) []byte
	}{
		{s.subject(contract.SubjectSipRingRPC), "", s.HandleRing},
		{s.subject(contract.SubjectSipAnswerRPC), "", s.HandleAnswer},
		{s.subject(contract.SubjectSipHangupRPC), "", s.HandleHangup},
		{s.subject(contract.SubjectSipReinviteRPC), "", s.HandleReinvite},
		{contract.SubjectSipOriginateRPC, OriginateQueueGroup, s.HandleOriginate},
	}

	subscriptions := make([]*nats.Subscription, 0, len(handlers))
	for _, handler := range handlers {
		handle, subject := handler.handle, handler.subject

		respond := func(msg *nats.Msg) {
			// A request with no reply subject is a fire-and-forget publish onto an RPC subject.
			// Answering it is impossible and it is almost always a client bug, so it is logged rather
			// than silently dropped.
			if msg.Reply == "" {
				s.log.Warn("ignoring a command with no reply subject", "subject", subject)
				return
			}
			if err := msg.Respond(handle(msg.Data)); err != nil {
				s.log.Error("cannot reply to a command", "subject", subject, "error", err)
			}
		}

		var (
			subscription *nats.Subscription
			err          error
		)
		if handler.queue != "" {
			subscription, err = conn.QueueSubscribe(subject, handler.queue, respond)
		} else {
			subscription, err = conn.Subscribe(subject, respond)
		}
		if err != nil {
			// Unwind the ones already attached. A partial failure would leave sipd answering half its
			// command surface, which looks healthy and half-works: calls would ring and never answer.
			for _, attached := range subscriptions {
				_ = attached.Unsubscribe()
			}
			return nil, fmt.Errorf("command: subscribing to %s: %w", subject, err)
		}
		subscriptions = append(subscriptions, subscription)
	}
	return subscriptions, nil
}

// encode marshals a reply. A reply that cannot be marshalled is a programming error, but the caller
// is mid-call, so it degrades to a hand-written refusal rather than to a timeout.
func encode(log *slog.Logger, reply any) []byte {
	payload, err := marshal(reply)
	if err != nil {
		log.Error("cannot encode a command reply", "error", err)
		return []byte(`{"ok":false,"reason":"internal","error":"cannot encode the reply"}`)
	}
	return payload
}

func stringPtr(value string) *string {
	if value == "" {
		return nil
	}
	copied := value
	return &copied
}
