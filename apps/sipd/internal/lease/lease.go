// Package lease publishes this sipd process's liveness into the `sip-instances` KV bucket.
//
// One key per PROCESS, renewed every few seconds, so a reader can answer "is that edge still there?"
// without listing every dialog on the fleet. The reader that matters is the ENGINE: internal/reaper
// covers the case where a surviving sipd sweeps a dead peer's dialog claims, and that is exactly the
// case a single-instance edge does not have. When the only sipd dies its calls stay up in the engine
// with audio still flowing and unbillable, and the phone's BYE is answered 481 by the process that
// replaced it. This lease is what lets the engine end those legs itself.
//
// The bucket's TTL is the lease, unlike `sip-dialogs` where it is only a backstop: a record nobody
// renewed IS a dead process, so server-side expiry cannot reap anything live, and a watcher learns
// of a death from the delete the server publishes rather than by polling.
package lease

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// RenewInterval is how often the lease is rewritten: a third of the contract's TTL, so two renewals
// may be lost to a broker hiccup before a reader is entitled to call this instance dead.
var RenewInterval = contract.SIPInstancesKV.TTL / 3

// Store writes and reads instance leases. Restated as an interface so the reaper can take the read
// half without a broker, and so a test can fail exactly one method.
type Store interface {
	Renew(ctx context.Context, lease contract.SIPInstanceLease) error
	Release(ctx context.Context, instanceID string) error
	Live(ctx context.Context, now time.Time) (map[string]struct{}, error)
}

// NATSStore is the production Store, backed by the `sip-instances` bucket.
type NATSStore struct {
	bucket jetstream.KeyValue
}

var _ Store = (*NATSStore)(nil)

// Open binds to (creating if absent) the `sip-instances` bucket described by packages/events-go.
// Idempotent, so every instance may call it at boot; the shape comes from the contract so two
// services cannot disagree about it.
func Open(ctx context.Context, js jetstream.JetStream) (*NATSStore, error) {
	if js == nil {
		return nil, errors.New("lease: a JetStream context is required for the sip-instances bucket")
	}
	definition := contract.SIPInstancesKV
	storage := jetstream.FileStorage
	if definition.Storage == contract.StorageMemory {
		storage = jetstream.MemoryStorage
	}
	bucket, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:       definition.Name,
		Description:  definition.Description,
		TTL:          definition.TTL,
		History:      definition.History,
		Storage:      storage,
		MaxValueSize: definition.MaxValueSize,
		MaxBytes:     definition.MaxBytes,
		Replicas:     definition.NumReplicas,
	})
	if err != nil {
		return nil, fmt.Errorf("lease: opening the %s bucket: %w", definition.Name, err)
	}
	return &NATSStore{bucket: bucket}, nil
}

// Renew implements Store with one unconditional write: each key has exactly one writer, and the
// value carries a fresh expiresAt.
func (s *NATSStore) Renew(ctx context.Context, lease contract.SIPInstanceLease) error {
	key, err := contract.SIPInstanceKVKey(lease.InstanceID)
	if err != nil {
		return err
	}
	value, err := json.Marshal(lease)
	if err != nil {
		return fmt.Errorf("lease: encoding the lease for %s: %w", key, err)
	}
	if _, err := s.bucket.Put(ctx, key, value); err != nil {
		return fmt.Errorf("lease: writing the lease for %s: %w", key, err)
	}
	return nil
}

// Release implements Store. Deleting an absent lease is not an error: a shutdown that races the
// bucket TTL must not log a failure for having been beaten to it.
func (s *NATSStore) Release(ctx context.Context, instanceID string) error {
	key, err := contract.SIPInstanceKVKey(instanceID)
	if err != nil {
		return err
	}
	if err := s.bucket.Delete(ctx, key); err != nil && !errors.Is(err, jetstream.ErrKeyNotFound) {
		return fmt.Errorf("lease: deleting the lease for %s: %w", key, err)
	}
	return nil
}

// Live implements Store, returning the instance ids whose lease has not lapsed at `now`.
//
// A value that will not decode is skipped rather than poisoning the sweep, and an absent key is a
// race with a release rather than an error — both leave the instance OUT of the live set, which is
// the direction that reaps a dead peer's dialogs rather than the one that strands them.
func (s *NATSStore) Live(ctx context.Context, now time.Time) (map[string]struct{}, error) {
	keys, err := s.bucket.Keys(ctx)
	if errors.Is(err, jetstream.ErrNoKeysFound) {
		return map[string]struct{}{}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lease: listing instance leases: %w", err)
	}

	live := make(map[string]struct{}, len(keys))
	for _, key := range keys {
		entry, err := s.bucket.Get(ctx, key)
		if errors.Is(err, jetstream.ErrKeyNotFound) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("lease: reading the lease for %s: %w", key, err)
		}
		var record contract.SIPInstanceLease
		if err := json.Unmarshal(entry.Value(), &record); err != nil {
			continue
		}
		if record.InstanceID == "" || Expired(record, now) {
			continue
		}
		live[record.InstanceID] = struct{}{}
	}
	return live, nil
}

// Expired reports whether a lease has lapsed at `now`, the Go mirror of isSipInstanceLeaseExpired.
// Exactly at the expiry the instance is gone: treating the boundary as live would keep a stranded
// call up for one more sweep, which is the failure this bucket exists to end.
func Expired(record contract.SIPInstanceLease, now time.Time) bool {
	return !now.Before(time.UnixMilli(int64(record.ExpiresAt)))
}

// Options configures a Renewer. Every dependency is an interface, so the unit suite needs no broker.
type Options struct {
	// Store is the bucket. Required.
	Store Store
	// InstanceID is this process's token. Required: it is the key.
	InstanceID string
	// Dialogs reports the live dialog count stamped on each renewal, for operators. Optional.
	Dialogs func() int
	// Interval is how often the lease is rewritten. Zero means RenewInterval.
	Interval time.Duration
	// TTL is the horizon written into expiresAt. Zero means the contract's bucket TTL, which is
	// what the server enforces; setting anything longer would promise a liveness the bucket deletes.
	TTL time.Duration
	// Timeout bounds one renewal's I/O. Zero means the interval, so a stalled write cannot outlive
	// the tick that would replace it.
	Timeout time.Duration
	Logger  *slog.Logger
	Now     func() time.Time
}

// Renewer keeps this instance's lease fresh for as long as the process is serving.
type Renewer struct {
	store     Store
	instance  string
	dialogs   func() int
	interval  time.Duration
	ttl       time.Duration
	timeout   time.Duration
	log       *slog.Logger
	now       func() time.Time
	startedAt time.Time
	// failures counts consecutive failed renewals, so the log says "still failing" once rather than
	// every few seconds while a broker is down.
	failures int
}

// New validates the options and builds a Renewer.
func New(opts Options) (*Renewer, error) {
	switch {
	case opts.Store == nil:
		return nil, errors.New("lease: a store is required")
	case strings.TrimSpace(opts.InstanceID) == "":
		return nil, errors.New("lease: an instance id is required: it is the key this process " +
			"renews, and without one the engine cannot tell which legs died with this process")
	}
	renewer := &Renewer{
		store:    opts.Store,
		instance: opts.InstanceID,
		dialogs:  opts.Dialogs,
		interval: opts.Interval,
		ttl:      opts.TTL,
		timeout:  opts.Timeout,
		log:      opts.Logger,
		now:      opts.Now,
	}
	if renewer.interval <= 0 {
		renewer.interval = RenewInterval
	}
	if renewer.ttl <= 0 {
		renewer.ttl = contract.SIPInstancesKV.TTL
	}
	if renewer.timeout <= 0 {
		renewer.timeout = renewer.interval
	}
	if renewer.log == nil {
		renewer.log = slog.Default()
	}
	if renewer.now == nil {
		renewer.now = time.Now
	}
	renewer.startedAt = renewer.now()
	return renewer, nil
}

// Run renews until the context is cancelled, then releases the lease.
//
// The first renewal is immediate and its failure is returned: a process that cannot claim its own
// liveness would be reaped by the engine while serving calls, and failing at boot is far better
// than discovering it on the first crash. Later failures are logged — the bucket TTL is what
// decides the outcome, and one lost write is not yet a dead instance.
func (r *Renewer) Run(ctx context.Context) error {
	if err := r.Renew(ctx); err != nil {
		return fmt.Errorf("lease: claiming the first instance lease: %w", err)
	}
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			r.release()
			return ctx.Err()
		case <-ticker.C:
			if err := r.Renew(ctx); err != nil {
				r.failures++
				if r.failures == 1 {
					r.log.Warn("cannot renew this instance's liveness lease; the engine may end its calls",
						"instanceId", r.instance, "ttl", r.ttl, "error", err)
				}
				continue
			}
			if r.failures > 0 {
				r.log.Info("the instance liveness lease is being renewed again",
					"instanceId", r.instance, "missedRenewals", r.failures)
				r.failures = 0
			}
		}
	}
}

// Renew writes one lease, exported so a test can drive it without a ticker.
func (r *Renewer) Renew(ctx context.Context) error {
	renewCtx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	now := r.now()
	record := contract.SIPInstanceLease{
		InstanceID: r.instance,
		StartedAt:  float64(r.startedAt.UnixMilli()),
		RenewedAt:  float64(now.UnixMilli()),
		ExpiresAt:  float64(now.Add(r.ttl).UnixMilli()),
	}
	if r.dialogs != nil {
		record.Dialogs = new(r.dialogs())
	}
	return r.store.Renew(renewCtx, record)
}

// release drops the lease on a graceful shutdown, so the engine ends this instance's legs at once
// instead of waiting out a TTL for a process that told nobody it was leaving.
//
// Its own context: the one that ended Run is already cancelled, and a delete that cannot be issued
// is exactly the case the TTL covers.
func (r *Renewer) release() {
	releaseCtx, cancel := context.WithTimeout(context.Background(), r.timeout)
	defer cancel()
	if err := r.store.Release(releaseCtx, r.instance); err != nil {
		r.log.Warn("cannot release this instance's liveness lease; its TTL will expire it",
			"instanceId", r.instance, "error", err)
		return
	}
	r.log.Info("released this instance's liveness lease", "instanceId", r.instance)
}
