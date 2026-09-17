package credentials

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// OrgEvictor is a credential cache that can drop everything it holds for one tenant. NATSStore
// implements it; a store that does not cache implements nothing and needs no invalidation.
type OrgEvictor interface {
	EvictOrg(orgID string) int
}

// InvalidationFilter is the subject sipd watches for `credential.invalidated`.
//
// The provisioning family puts the org in the subject and the discriminator in the envelope, so
// this filter also delivers device.requested/rendered/rejected; they are ignored here. Core, not a
// durable consumer: a replayed provisioning backlog at every restart would evict a warm cache for
// changes that were applied hours ago, and the grant sipd holds is a subscribe grant only.
var InvalidationFilter = contract.AllProvisionFilter()

// invalidationRetryMin and invalidationRetryMax bound the re-subscribe backoff, matching the KV
// watches: a broker that is down is down for everything, and the ceiling is short enough that the
// channel is back promptly once it returns.
const (
	invalidationRetryMin = time.Second
	invalidationRetryMax = 30 * time.Second
)

// invalidationStream is one live subscription: the messages it delivers, a channel closed when the
// server ends it, and the way to stop it.
type invalidationStream struct {
	messages <-chan *nats.Msg
	ended    <-chan struct{}
	stop     func()
}

// subscribeInvalidations opens one stream. It exists so the watch loop can be exercised without a
// broker.
type subscribeInvalidations func() (*invalidationStream, error)

// WatchInvalidations evicts cache from `credential.invalidated` until ctx is cancelled.
//
// The subscription RE-ESTABLISHES itself when the server ends it without the context being
// cancelled — a permission reload or a broker restart. A watch that gave up there would leave this
// edge authenticating against ha1s the control plane has already replaced, silently, for the rest
// of the process's life; the positive TTL and the one-shot Refresh on a failed digest are the
// backstops, not the mechanism.
func WatchInvalidations(ctx context.Context, conn *nats.Conn, cache OrgEvictor, log *slog.Logger) error {
	if conn == nil {
		return errors.New("credentials: a NATS connection is required to watch credential invalidations")
	}
	if cache == nil {
		return errors.New("credentials: a cache is required to watch credential invalidations")
	}
	if log == nil {
		log = slog.Default()
	}
	return watchInvalidations(ctx, natsInvalidations(conn), cache, log)
}

func natsInvalidations(conn *nats.Conn) subscribeInvalidations {
	return func() (*invalidationStream, error) {
		messages := make(chan *nats.Msg, 64)
		ended := make(chan struct{})
		subscription, err := conn.ChanSubscribe(InvalidationFilter, messages)
		if err != nil {
			return nil, err
		}
		subscription.SetClosedHandler(func(string) { close(ended) })
		if err := conn.FlushTimeout(2 * time.Second); err != nil {
			_ = subscription.Unsubscribe()
			return nil, fmt.Errorf("confirming the subscription: %w", err)
		}
		return &invalidationStream{
			messages: messages,
			ended:    ended,
			stop:     func() { _ = subscription.Unsubscribe() },
		}, nil
	}
}

func watchInvalidations(
	ctx context.Context,
	subscribe subscribeInvalidations,
	cache OrgEvictor,
	log *slog.Logger,
) error {
	stream, err := subscribe()
	if err != nil {
		return fmt.Errorf("credentials: subscribing to %s: %w", InvalidationFilter, err)
	}

	go func() {
		backoff := invalidationRetryMin
		for {
			ended := consumeInvalidations(ctx, stream, cache, log)
			stream.stop()
			if ctx.Err() != nil || !ended {
				return
			}
			log.Warn("the credential invalidation subscription ended; re-establishing it",
				"subject", InvalidationFilter, "retryIn", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, invalidationRetryMax)
			next, err := subscribe()
			if err != nil {
				log.Error("cannot re-establish the credential invalidation subscription",
					"subject", InvalidationFilter, "error", err)
				continue
			}
			backoff = invalidationRetryMin
			stream = next
		}
	}()
	return nil
}

// consumeInvalidations drains one stream. It reports whether the stream ENDED, rather than the
// context being cancelled.
func consumeInvalidations(
	ctx context.Context,
	stream *invalidationStream,
	cache OrgEvictor,
	log *slog.Logger,
) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case <-stream.ended:
			return true
		case msg, ok := <-stream.messages:
			if !ok {
				return true
			}
			applyInvalidation(msg, cache, log)
		}
	}
}

// applyInvalidation evicts the tenant named by one provisioning message, if it is an invalidation.
//
// The payload carries a reason and a count, never a username, realm or digest, so the eviction is
// whole-organization: a subscriber learns that something changed, never what it changed to.
func applyInvalidation(msg *nats.Msg, cache OrgEvictor, log *slog.Logger) {
	envelope, err := contract.UnmarshalRaw(msg.Data)
	if err != nil {
		log.Warn("dropping an unparsable provisioning event",
			"subject", msg.Subject, "error", err)
		return
	}
	if envelope.Type != contract.EventTypeProvisionCredentialInvalidated {
		return
	}
	// An envelope whose orgId disagrees with the org in its subject would evict another tenant's
	// cache on one tenant's write.
	if err := contract.CheckSubject(msg.Subject, envelope); err != nil {
		log.Warn("dropping an inconsistent credential invalidation",
			"subject", msg.Subject, "error", err)
		return
	}

	dropped := cache.EvictOrg(envelope.OrgID)
	log.Info("credential cache invalidated",
		"orgId", envelope.OrgID, "dropped", dropped, "subject", msg.Subject)
}
