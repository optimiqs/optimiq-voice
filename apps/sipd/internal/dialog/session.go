package dialog

import (
	"context"
	"errors"
	"log/slog"
	"sync"
)

// ErrSessionClosed means the owning goroutine has stopped. It is distinct from ErrDialogGone: the
// dialog may have ended perfectly normally and this is simply a command that arrived after the
// session was torn down, which happens on every shutdown and is not an error worth alarming on.
var ErrSessionClosed = errors.New("dialog: the session is closed")

// Task is one unit of work against a dialog, run on the dialog's own goroutine.
//
// It returns an Outcome so the caller learns where the dialog moved, and an error so a refusal
// reaches the command layer as one of the package's four errors rather than as a state comparison
// somewhere else.
type Task func(*Dialog) (Outcome, error)

// EffectHandler performs the side effects a task produced.
//
// It runs ON THE DIALOG'S GOROUTINE, in order, before the task's caller is answered. That ordering
// is the guarantee the whole design rests on: a 200 is written to the socket before the `answer`
// command replies, and a CANCEL that arrives in the meantime queues behind it rather than racing
// it (design §4.4).
//
// An error from a handler is logged and does not stop the remaining effects. By the time an effect
// cannot be performed the transaction is usually already lost, and abandoning the rest would skip
// the terminal publish — which is how a call ends with no CDR.
type EffectHandler interface {
	Handle(ctx context.Context, dialog *Dialog, effect Effect) error
}

// EffectHandlerFunc adapts a function to EffectHandler.
type EffectHandlerFunc func(ctx context.Context, dialog *Dialog, effect Effect) error

// Handle implements EffectHandler.
func (f EffectHandlerFunc) Handle(ctx context.Context, dialog *Dialog, effect Effect) error {
	return f(ctx, dialog, effect)
}

// Session is one dialog plus the goroutine that owns it.
//
// # Why a goroutine and a channel rather than a mutex
//
// A mutex would make concurrent access SAFE and would leave the races UNDECIDED: two callers
// holding a mutex in turn still both run, and "the CANCEL wins" versus "the answer wins" would
// depend on scheduler order at two different call sites. A mailbox makes the order the only thing
// that matters, and there is exactly one of it. The loser is then refused BY NAME — `dialog_gone`
// for an answer that lost to a CANCEL — which is a thing the engine can act on.
//
// It is the same shape mediad chose for a media session, for the same reason: one goroutine per
// session, and the kernel does the multiplexing.
type Session struct {
	dialog   *Dialog
	handler  EffectHandler
	log      *slog.Logger
	mailbox  chan envelope
	closed   chan struct{}
	closeOne sync.Once
	wait     sync.WaitGroup
}

type envelope struct {
	ctx   context.Context
	task  Task
	reply chan sessionResult
}

type sessionResult struct {
	outcome Outcome
	err     error
}

// SessionOptions configures a Session.
type SessionOptions struct {
	// Handler performs effects. A nil handler discards them, which is what a test that only cares
	// about state transitions wants.
	Handler EffectHandler
	Logger  *slog.Logger
	// Depth is the mailbox size. It is small on purpose: a dialog with a hundred queued commands is
	// a dialog whose effects are blocking on a socket, and the back-pressure is information.
	Depth int
}

// NewSession starts the owning goroutine. Close stops it.
func NewSession(dialog *Dialog, opts SessionOptions) *Session {
	depth := opts.Depth
	if depth <= 0 {
		depth = 8
	}
	session := &Session{
		dialog:  dialog,
		handler: opts.Handler,
		log:     opts.Logger,
		mailbox: make(chan envelope, depth),
		closed:  make(chan struct{}),
	}
	if session.log == nil {
		session.log = slog.Default()
	}
	session.wait.Add(1)
	go session.run()
	return session
}

// LegID reports the dialog's key without touching the dialog, so a caller can log without a round
// trip through the mailbox.
func (s *Session) LegID() string { return s.dialog.LegID }

func (s *Session) run() {
	defer s.wait.Done()
	for {
		select {
		case <-s.closed:
			// Drain whatever is already queued so a command that arrived a microsecond before the
			// shutdown gets an answer rather than a timeout. Anything still arriving after this is
			// refused by Do.
			for {
				select {
				case message := <-s.mailbox:
					message.reply <- sessionResult{err: ErrSessionClosed}
				default:
					return
				}
			}
		case message := <-s.mailbox:
			outcome, err := message.task(s.dialog)
			// Effects run even when the task returned an error: ErrCancelTooLate produces the 481
			// that answers the losing CANCEL's transaction, and dropping it would leave the far end
			// retransmitting a CANCEL at a live call.
			s.dispatch(message.ctx, outcome.Effects)
			message.reply <- sessionResult{outcome: outcome, err: err}
		}
	}
}

func (s *Session) dispatch(ctx context.Context, effects []Effect) {
	if s.handler == nil || len(effects) == 0 {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	for _, effect := range effects {
		if err := s.handler.Handle(ctx, s.dialog, effect); err != nil {
			s.log.Error("cannot perform a dialog effect",
				"legId", s.dialog.LegID, "effect", effect.Kind.String(), "error", err)
		}
	}
}

// Do runs a task on the dialog's goroutine and waits for it.
//
// The context bounds the WAIT and not the task: a task that has started runs to completion on the
// owning goroutine, because abandoning it half way would leave the dialog in a state nobody chose.
// A caller whose context expires learns that its command did not get an answer in time, which is
// exactly what a timed-out RPC means and is why commands are idempotent on legId.
func (s *Session) Do(ctx context.Context, task Task) (Outcome, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	// Closed is checked FIRST and on its own, not as one arm of the send's select. A select with a
	// ready send and a ready close picks between them at random, so a command posted to a closed
	// session would half the time land in a mailbox nobody is reading and wait for a reply that
	// cannot come. Asked once, before anything is enqueued, the answer is unambiguous.
	select {
	case <-s.closed:
		return Outcome{}, ErrSessionClosed
	default:
	}

	reply := make(chan sessionResult, 1)
	select {
	case s.mailbox <- envelope{ctx: ctx, task: task, reply: reply}:
	case <-s.closed:
		return Outcome{}, ErrSessionClosed
	case <-ctx.Done():
		return Outcome{}, ctx.Err()
	}
	select {
	case result := <-reply:
		return result.outcome, result.err
	case <-ctx.Done():
		return Outcome{}, ctx.Err()
	case <-s.closed:
		// The session closed while this command was queued. The drain in run() answers everything
		// it can reach, and this arm covers the one message that raced past it — without it, a
		// command enqueued a microsecond after the drain finished would block for ever.
		select {
		case result := <-reply:
			return result.outcome, result.err
		default:
			return Outcome{}, ErrSessionClosed
		}
	}
}

// Apply is the common case: feed one trigger to the machine.
func (s *Session) Apply(ctx context.Context, in Input) (Outcome, error) {
	return s.Do(ctx, func(dialog *Dialog) (Outcome, error) { return dialog.Apply(in) })
}

// Inspect runs a read-only function on the dialog's goroutine and returns what it read.
//
// It exists so a caller can look at a dialog without racing its owner. Reading a field directly off
// the *Dialog would be a data race the moment a command is in flight, and `go test -race` would
// find it — which is the point of having exactly one owner.
func (s *Session) Inspect(ctx context.Context, read func(*Dialog)) error {
	_, err := s.Do(ctx, func(dialog *Dialog) (Outcome, error) {
		read(dialog)
		return Outcome{}, nil
	})
	return err
}

// Close stops the owning goroutine and waits for it. It is idempotent, because both a normal
// teardown and a shutdown sweep may reach it.
func (s *Session) Close() {
	s.closeOne.Do(func() { close(s.closed) })
	s.wait.Wait()
}

// RecordingHandler collects effects instead of performing them. It backs the unit tests.
type RecordingHandler struct {
	mu      sync.Mutex
	effects []Effect
	// Err, when set, is returned for every effect, so a test can prove that a failing effect does
	// not stop the ones behind it.
	Err error
}

var _ EffectHandler = (*RecordingHandler)(nil)

// Handle implements EffectHandler.
func (r *RecordingHandler) Handle(_ context.Context, _ *Dialog, effect Effect) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.effects = append(r.effects, effect)
	return r.Err
}

// Effects returns a copy of everything recorded.
func (r *RecordingHandler) Effects() []Effect {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]Effect(nil), r.effects...)
}

// Kinds returns just the kinds, in order, which is what most assertions actually compare.
func (r *RecordingHandler) Kinds() []EffectKind {
	r.mu.Lock()
	defer r.mu.Unlock()
	kinds := make([]EffectKind, 0, len(r.effects))
	for _, effect := range r.effects {
		kinds = append(kinds, effect.Kind)
	}
	return kinds
}

// Reset drops everything recorded so far.
func (r *RecordingHandler) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.effects = nil
}
