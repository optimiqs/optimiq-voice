// Package command is sipd's NATS command surface: the Go responder for `rpc.sip.v1.*`, and the
// first business subject family this process has ever subscribed to rather than called.
//
// The responder is a raw `conn.Subscribe` + `msg.Respond`, so the bytes on the wire are exactly the
// generated structs. NestJS's NATS transport frames request-reply as `{"pattern":…,"data":…,"id":…}`
// and would reject a bare contract payload, so the obligation runs the other way here: the ENGINE's
// client must use a raw `NatsConnection.request()` and not a `ClientProxy.send`, or these handlers
// would reject the wrapped payload as malformed.
//
// `ring`, `answer`, `hangup` and `reinvite` act on a dialog that already exists, and a dialog lives
// on exactly ONE process (design §6.1), so those are subscribed PER INSTANCE at
// `rpc.sip.v1.<command>.<instanceToken>` with no queue group. `originate` and `resolve-target` have
// no owner to find, so they are also served flat and queue-grouped; an originate reply carries the
// instanceId that took it, which the engine addresses every subsequent command for that leg at.
//
// Every handler answers. A responder that stays silent on a request it dislikes is indistinguishable
// from a crashed one: an unanswered `answer` makes the engine believe a call it has already
// allocated media for did not connect, and it hangs up a leg whose 200 OK is on the wire.
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

// Server answers the command subjects.
type Server struct {
	dialogs  Dialogs
	instance string
	token    string
	log      *slog.Logger
	// commands runs handlers off the subscription dispatcher, ordered per leg. See keyedRunner.
	commands *keyedRunner
}

// Options configures a Server. Every dependency is an interface, so the unit suite drives every
// handler as a table of payload bytes with no broker and no socket.
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
	// The engine builds its published subject from contract.InstanceSubjectToken; subscribing on the
	// same token from the same function is what stops the two drifting.
	token, err := contract.InstanceSubjectToken(opts.InstanceID)
	if err != nil {
		return nil, err
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Server{
		commands: newKeyedRunner(maxConcurrentCommands),
		dialogs:  opts.Dialogs,
		instance: strings.TrimSpace(opts.InstanceID),
		token:    token,
		log:      log,
	}, nil
}

// InstanceID names this process. Carried on every reply, refusal included, because the caller's next
// move on a `wrong_instance` is to work out who did answer.
func (s *Server) InstanceID() string { return s.instance }

// Token reports the subject token this server subscribes under, so the boot log can be compared
// against the subject the engine published on.
func (s *Server) Token() string { return s.token }

// Subjects reports every subject this server attaches to, in subscription order — the thing to
// check a NATS permissions error against.
func (s *Server) Subjects() []string {
	return []string{
		s.subject(contract.SubjectSipRingRPC),
		s.subject(contract.SubjectSipAnswerRPC),
		s.subject(contract.SubjectSipHangupRPC),
		s.subject(contract.SubjectSipReinviteRPC),
		contract.SubjectSipOriginateRPC,
		s.subject(contract.SubjectSipOriginateRPC),
		contract.SubjectSipResolveTargetRPC,
	}
}

func (s *Server) subject(root string) string { return root + "." + s.token }

// OriginateQueueGroup is the queue group the flat subjects are subscribed under. It must be the SAME
// string on every replica: a typo would give one instance a group of its own, and NATS would deliver
// every originate to it AND to a member of the real group, placing those calls twice.
const OriginateQueueGroup = "sipd-originate"

// Subscribe attaches every handler to a connection and returns the subscriptions.
//
// The per-instance subjects must NOT be queue-grouped even though they carry a unique token: a
// one-member queue group silently becomes a load balancer the day two pods are misconfigured with
// the same instance id, sending half of one call's commands to a process that does not hold it.
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
		{s.subject(contract.SubjectSipOriginateRPC), "", s.HandleOriginate},
		{contract.SubjectSipResolveTargetRPC, OriginateQueueGroup, s.HandleResolveTarget},
	}

	subscriptions := make([]*nats.Subscription, 0, len(handlers))
	for _, handler := range handlers {
		handle, subject := handler.handle, handler.subject

		respond := func(msg *nats.Msg) {
			// A request with no reply subject cannot be answered and is almost always a client bug,
			// so it is logged rather than silently dropped.
			if msg.Reply == "" {
				s.log.Warn("ignoring a command with no reply subject", "subject", subject)
				return
			}
			data := msg.Data
			s.commands.Submit(orderingKey(data), func() {
				if err := msg.Respond(handle(data)); err != nil {
					s.log.Error("cannot reply to a command", "subject", subject, "error", err)
				}
			})
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
			// Unwind the ones already attached: answering half the command surface looks healthy
			// and half-works — calls would ring and never answer.
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
	return new(value)
}
