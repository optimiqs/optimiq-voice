// Package mwi turns the control plane's `voicemail.evt.v1.<orgId>.<mailboxId>.mwi.updated` events
// into the message counts an RFC 3842 NOTIFY carries.
//
// # Why a core subscription and not a durable consumer
//
// The same reason apps/engine takes `media.evt.v1.>` as a core subscription: a lamp is a statement
// about NOW. An MWI event replayed after a restart tells a phone about a count that has since moved,
// and a durable consumer would deliver exactly that backlog at the worst possible moment — every
// phone lighting up on a deploy. Missing an event costs a lamp that is stale until the next change
// or the next `resync`; replaying one costs a lamp that is confidently wrong.
//
// It also means sipd needs no JetStream grant here at all, which keeps the SIP edge's broker
// identity as narrow as it already is: one subscribe on one subject family.
package mwi

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Counts is one mailbox's message counts. Both are absolute, never deltas — see the contract's own
// note: a lamp driven by deltas is one dropped message away from being wrong until somebody reboots
// a phone.
type Counts struct {
	New   int
	Saved int
}

// Waiting reports whether the `Messages-Waiting` line is `yes`.
func (c Counts) Waiting() bool { return c.New > 0 }

// Update is one observed mwi.updated event, resolved to the thing a subscriber can be matched on.
type Update struct {
	OrgID string
	// Mailbox is the dialable mailbox number.
	Mailbox string
	// Extension is the extension whose lamp this lights, when the control plane said so. It is
	// OPTIONAL in the contract and apps/api does not currently set it; see MatchesAccount.
	Extension string
	Counts    Counts
}

// MatchesAccount reports whether this update is about the SIP account named by `user`.
//
// The `extensionNumber` field wins when present. It is absent in practice today — apps/api's
// `VoicemailMwiPublisher` never sets it — so the fallback is the mailbox NUMBER, which in every
// deployment this platform models equals the extension number. That fallback is a deliberate,
// documented approximation rather than an accident: the alternative is an MWI spine that never
// matches anything, and the correct fix is one line in a file this wave does not own.
func (u Update) MatchesAccount(orgID, user string) bool {
	if u.OrgID != orgID {
		return false
	}
	if u.Extension != "" {
		return u.Extension == user
	}
	return u.Mailbox == user
}

// Source delivers MWI updates and remembers the last one per mailbox.
//
// The memory matters: a subscription accepted at 09:00 has to be told the current counts
// immediately (RFC 6665 §4.1.3 — a NOTIFY carrying full state is mandatory on acceptance), and the
// event that established them may have been published at 08:00. Without a cache the immediate
// NOTIFY would say "no messages" to a phone with nine, which is a lamp that goes DARK on
// subscription refresh.
//
// It is instance-local and starts empty, so a restarted sipd reports "no messages" until the next
// event or `resync` for a mailbox it has not seen. That is the known gap of this rung; the fix is a
// count query at subscribe time, which needs a grant and an RPC sipd does not have.
type Source interface {
	// Updates delivers every observed update until ctx is cancelled.
	Updates(ctx context.Context) (<-chan Update, error)
	// Last returns the most recent counts observed for a SIP account, if any.
	Last(orgID, user string) (Counts, bool)
}

// NATSSource is the production Source.
type NATSSource struct {
	conn *nats.Conn
	log  *slog.Logger

	mu     sync.RWMutex
	latest map[string]Update
}

var _ Source = (*NATSSource)(nil)

// NewNATSSource wraps an established connection.
func NewNATSSource(conn *nats.Conn, log *slog.Logger) (*NATSSource, error) {
	if conn == nil {
		return nil, fmt.Errorf("mwi: a NATS connection is required")
	}
	if log == nil {
		log = slog.Default()
	}
	return &NATSSource{conn: conn, log: log, latest: make(map[string]Update)}, nil
}

// Subject is the filter this source subscribes to: every org, every mailbox, one event name.
//
// `mwi.updated` is a DOTTED event name, so the subject has six tokens and the `*` for the mailbox
// cannot be a `>` — `voicemail.evt.v1.*.>` would also match `message.left`, which is the engine's
// event about a recording and says nothing about a count.
const Subject = "voicemail.evt.v1.*.*.mwi.updated"

// Updates implements Source.
func (s *NATSSource) Updates(ctx context.Context) (<-chan Update, error) {
	updates := make(chan Update, 64)

	subscription, err := s.conn.Subscribe(Subject, func(msg *nats.Msg) {
		update, ok := s.decode(msg)
		if !ok {
			return
		}
		s.remember(update)
		select {
		case updates <- update:
		default:
			// A full channel means the NOTIFY fan-out is behind. Dropping the OLDEST would be wrong
			// (the newest count is the true one) and blocking here would stall the NATS delivery
			// goroutine for every subject, so the drop is logged and the cache above still holds the
			// current value for the next subscribe or refresh.
			s.log.Warn("dropping an MWI update; the notifier is behind",
				"orgId", update.OrgID, "mailbox", update.Mailbox)
		}
	})
	if err != nil {
		return nil, fmt.Errorf("mwi: subscribing to %s: %w", Subject, err)
	}

	go func() {
		<-ctx.Done()
		if err := subscription.Unsubscribe(); err != nil {
			s.log.Debug("unsubscribing from MWI updates", "error", err)
		}
		close(updates)
	}()
	return updates, nil
}

func (s *NATSSource) decode(msg *nats.Msg) (Update, bool) {
	envelope, err := contract.Unmarshal[contract.VoicemailMWIUpdatedData](msg.Data)
	if err != nil {
		s.log.Warn("dropping an unparsable MWI event", "subject", msg.Subject, "error", err)
		return Update{}, false
	}
	// The same check the publisher side runs before it publishes: an envelope whose orgId is not the
	// org in its subject would let this edge attribute a tenant's message counts to another tenant's
	// phones, which is the one mistake in this file that is not merely a wrong lamp.
	if err := contract.CheckSubject(msg.Subject, envelope); err != nil {
		s.log.Warn("dropping an inconsistent MWI event", "subject", msg.Subject, "error", err)
		return Update{}, false
	}
	if envelope.Type != contract.EventTypeVoicemailMWIUpdated {
		return Update{}, false
	}

	update := Update{
		OrgID:   envelope.OrgID,
		Mailbox: strings.TrimSpace(envelope.Data.MailboxNumber),
		Counts:  Counts{New: envelope.Data.NewCount, Saved: envelope.Data.SavedCount},
	}
	if envelope.Data.ExtensionNumber != nil {
		update.Extension = strings.TrimSpace(*envelope.Data.ExtensionNumber)
	}
	if update.Mailbox == "" && update.Extension == "" {
		return Update{}, false
	}
	return update, true
}

func (s *NATSSource) remember(update Update) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if update.Extension != "" {
		s.latest[cacheKey(update.OrgID, update.Extension)] = update
	}
	if update.Mailbox != "" {
		s.latest[cacheKey(update.OrgID, update.Mailbox)] = update
	}
}

// Last implements Source.
func (s *NATSSource) Last(orgID, user string) (Counts, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	update, found := s.latest[cacheKey(orgID, user)]
	if !found {
		return Counts{}, false
	}
	return update.Counts, true
}

func cacheKey(orgID, user string) string { return orgID + "\x00" + user }

// MemorySource is an in-process Source for the tests and for a deployment with no broker.
type MemorySource struct {
	mu      sync.RWMutex
	latest  map[string]Update
	updates chan Update
}

var _ Source = (*MemorySource)(nil)

// NewMemorySource returns an empty in-process source.
func NewMemorySource() *MemorySource {
	return &MemorySource{latest: make(map[string]Update), updates: make(chan Update, 64)}
}

// Publish records an update and delivers it to whoever is watching.
func (s *MemorySource) Publish(update Update) {
	s.mu.Lock()
	if update.Extension != "" {
		s.latest[cacheKey(update.OrgID, update.Extension)] = update
	}
	if update.Mailbox != "" {
		s.latest[cacheKey(update.OrgID, update.Mailbox)] = update
	}
	s.mu.Unlock()

	select {
	case s.updates <- update:
	default:
	}
}

// Updates implements Source.
func (s *MemorySource) Updates(context.Context) (<-chan Update, error) { return s.updates, nil }

// Last implements Source.
func (s *MemorySource) Last(orgID, user string) (Counts, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	update, found := s.latest[cacheKey(orgID, user)]
	if !found {
		return Counts{}, false
	}
	return update.Counts, true
}
