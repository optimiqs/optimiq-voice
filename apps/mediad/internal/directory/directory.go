// Package directory maintains the `media-sessions` KV bucket: which mediad instance holds which
// RTP session.
//
// # The problem it solves, in one paragraph
//
// `rpc.media.v1.*` is served by a QUEUE GROUP, so NATS hands each request to whichever mediad
// happens to be free. That is right for `allocate-session` — any instance with a free port will do
// — and wrong for every command after it, because a session lives on exactly ONE instance: its
// sockets are bound there and its relay goroutines run there. Without a directory, an instance
// handed a `bridge-sessions` for somebody else's session cannot tell "this never existed" from
// "this belongs to my neighbour", and those need opposite recoveries: give up, versus re-issue
// against the instance that owns it.
//
// This is plans/mediad-design.md open question 2, answered. The alternative — the allocate reply
// carrying an instance-specific subject the engine uses thereafter — is simpler and needs no
// lookup, but it puts routing state in the engine, where an engine restart loses it and every live
// call becomes uncommandable. It is also the substrate open question 3 (real graceful drain) will
// need, because draining means MOVING sessions and you cannot move what you cannot enumerate.
//
// # What is deliberately NOT here
//
// Drain and migration (design doc open question 3). The directory records where a session is; it
// does not move one, and moving one needs a re-INVITE from the signalling plane to repoint the far
// end. Writing half of that now would be a mechanism nobody can finish a call with.
package directory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Entry is one directory record. It is the contract type, so the shape the engine reads and the
// shape mediad writes cannot drift.
type Entry = contract.MediaSessionDirectoryEntry

// Store is what the control surface needs from the directory.
//
// An interface so the control handlers are testable against an in-memory fake with no broker
// anywhere near them — the same line sipd draws with its credentials.Store, and the reason the unit
// suite runs in milliseconds.
type Store interface {
	// Put records (or overwrites) a session's owner.
	Put(ctx context.Context, entry Entry) error
	// Get returns the entry for a session. The second result is false when there is none.
	Get(ctx context.Context, sessionID string) (Entry, bool, error)
	// Delete removes a session's entry. Deleting an absent key is not an error.
	Delete(ctx context.Context, sessionID string) error
}

// KVStore is the real Store, over a JetStream KV bucket.
type KVStore struct {
	kv  jetstream.KeyValue
	log *slog.Logger
}

var _ Store = (*KVStore)(nil)

// Open binds to the `media-sessions` bucket, creating it if it is absent.
//
// Creating rather than requiring it to exist, unlike sipd's stream publisher: a KV bucket's
// definition is idempotent and comes from the shared contract package, so two processes creating it
// with the same definition is not a race with a wrong outcome. The alternative — refusing to boot
// until the control plane has run — would make the media plane depend on the control plane's
// startup order for no safety in return.
func Open(ctx context.Context, js jetstream.JetStream, log *slog.Logger) (*KVStore, error) {
	definition := contract.MediaSessionsKV
	kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket:       definition.Name,
		Description:  definition.Description,
		TTL:          definition.TTL,
		History:      definition.History,
		Storage:      jetstream.FileStorage,
		MaxValueSize: definition.MaxValueSize,
		MaxBytes:     definition.MaxBytes,
		Replicas:     definition.NumReplicas,
	})
	if err != nil {
		return nil, fmt.Errorf("directory: opening the %s bucket: %w", definition.Name, err)
	}
	if log == nil {
		log = slog.Default()
	}
	return &KVStore{kv: kv, log: log}, nil
}

// Put writes an entry under the session's key.
func (s *KVStore) Put(ctx context.Context, entry Entry) error {
	key, err := contract.MediaSessionKVKey(entry.SessionID)
	if err != nil {
		return fmt.Errorf("directory: %w", err)
	}
	payload, err := json.Marshal(entry)
	if err != nil {
		return fmt.Errorf("directory: encoding the entry for %s: %w", entry.SessionID, err)
	}
	if _, err := s.kv.Put(ctx, key, payload); err != nil {
		return fmt.Errorf("directory: writing %s: %w", key, err)
	}
	return nil
}

// Get reads an entry back.
func (s *KVStore) Get(ctx context.Context, sessionID string) (Entry, bool, error) {
	key, err := contract.MediaSessionKVKey(sessionID)
	if err != nil {
		return Entry{}, false, fmt.Errorf("directory: %w", err)
	}
	revision, err := s.kv.Get(ctx, key)
	if errors.Is(err, jetstream.ErrKeyNotFound) {
		return Entry{}, false, nil
	}
	if err != nil {
		return Entry{}, false, fmt.Errorf("directory: reading %s: %w", key, err)
	}
	var entry Entry
	if err := json.Unmarshal(revision.Value(), &entry); err != nil {
		// A value this process cannot parse is treated as absent rather than as fatal. The bucket
		// is shared and additive-evolution is the rule everywhere else on this backbone; a strict
		// reader here would turn a contract addition into an outage on the OLD instances.
		s.log.Warn("ignoring an unreadable session directory entry", "key", key, "error", err)
		return Entry{}, false, nil
	}
	return entry, true, nil
}

// Delete removes an entry.
//
// An absent key is success. The release handler calls this, release is idempotent, and a retry
// after a lost reply must not look like a failure.
func (s *KVStore) Delete(ctx context.Context, sessionID string) error {
	key, err := contract.MediaSessionKVKey(sessionID)
	if err != nil {
		return fmt.Errorf("directory: %w", err)
	}
	if err := s.kv.Delete(ctx, key); err != nil && !errors.Is(err, jetstream.ErrKeyNotFound) {
		return fmt.Errorf("directory: deleting %s: %w", key, err)
	}
	return nil
}

// Timeout is the deadline every directory operation runs under.
//
// Short, and on the call path for a reason: an allocate that has already bound its ports is not
// going to be abandoned because a KV write is slow, so the caller logs a failed write and carries
// on with a session that works but is invisible to its neighbours. A long deadline here would turn
// a degraded broker into slow call setup, which the caller hears as silence.
const Timeout = 500 * time.Millisecond
