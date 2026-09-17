package trunk

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Record is the API's generated wire contract for one directory entry. Gateway configuration is
// derived from it here so carrier passwords never enter the shared directory.
type Record contract.TrunkDirectoryEntry

// Config derives the registration configuration this record describes.

func (r Record) Config() Config {
	config := Config{
		TrunkID:        strings.TrimSpace(r.TrunkID),
		OrgID:          strings.TrimSpace(r.OrgID),
		Name:           strings.TrimSpace(r.Name),
		Kind:           string(r.Kind),
		Enabled:        r.Enabled,
		SIPDomain:      strings.TrimSpace(r.SIPDomain),
		SIPProxy:       strings.TrimSpace(r.SIPProxy),
		ExpiresSeconds: r.RegisterExpiresSeconds,
		Transport:      strings.ToLower(string(r.Transport)),
	}
	if r.OutboundProxy != nil {
		config.OutboundProxy = strings.TrimSpace(*r.OutboundProxy)
	}
	if r.AuthUser != nil {
		config.AuthUser = strings.TrimSpace(*r.AuthUser)
	}
	if r.SecretRef != nil {
		config.SecretRef = strings.TrimSpace(*r.SecretRef)
	}
	if r.MaxChannels != nil {
		config.MaxChannels = *r.MaxChannels
	}
	if r.SrtpPolicy != nil {
		config.SRTPPolicy = strings.ToLower(string(*r.SrtpPolicy))
	}
	config.Register = config.Kind == "register"
	config.Registrar = config.SIPProxy
	config.AuthRealm = config.SIPDomain
	if config.ExpiresSeconds <= 0 {
		config.ExpiresSeconds = 300
	}
	return config
}

// Directory is the in-process trunk table, filled from the `trunks` bucket at boot and kept filled
// by a watch. It is read rather than fetched per call because a KV get on the originate path would
// put a broker round trip inside the one-second budget of `rpc.sip.v1.originate`.
//
// Safe for concurrent use: every read and every mutation takes d.mu.
type Directory struct {
	mu      sync.RWMutex
	entries map[string]Config
	log     *slog.Logger
	// onChange is called after every applied update with the lock RELEASED, so a callback that
	// reads Configs sees the new world instead of deadlocking.
	onChange func()
}

// OnChange installs a callback fired after every applied directory update. It is not safe to call
// once Watch is running; install it at boot, which is the only time anything needs to.
func (d *Directory) OnChange(fn func()) { d.onChange = fn }

func (d *Directory) changed() {
	if d.onChange != nil {
		d.onChange()
	}
}

// NewDirectory returns an empty directory. Empty is legitimate: a deployment with no trunks serves
// only registered devices and refuses every trunk originate with `unknown_trunk`.
func NewDirectory(log *slog.Logger) *Directory {
	if log == nil {
		log = slog.Default()
	}
	return &Directory{entries: make(map[string]Config), log: log}
}

// Trunk resolves one trunk. The second result is false when this instance holds no configuration
// for it — `unknown_trunk` on the wire, meaning "the directory has not reached me" rather than "no
// such trunk".
func (d *Directory) Trunk(orgID, trunkID string) (Config, bool) {
	key, err := contract.TrunkKVKey(orgID, trunkID)
	if err != nil {
		return Config{}, false
	}
	d.mu.RLock()
	defer d.mu.RUnlock()
	config, found := d.entries[key]
	return config, found
}

// Len reports how many trunks the directory holds.
func (d *Directory) Len() int {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return len(d.entries)
}

// Configs returns every trunk, sorted by id, so a boot sweep and a test both iterate
// deterministically.
func (d *Directory) Configs() []Config {
	d.mu.RLock()
	defer d.mu.RUnlock()
	return slices.SortedFunc(maps.Values(d.entries), func(a, b Config) int {
		return cmp.Compare(a.TrunkID, b.TrunkID)
	})
}

// Put installs or replaces one trunk. A record that fails Validate is REFUSED and the previous one
// kept, so an operator saving a half-filled form cannot take a working carrier offline.
func (d *Directory) Put(key string, config Config) error {
	if err := config.Validate(); err != nil {
		return err
	}
	expectedKey, err := contract.TrunkKVKey(config.OrgID, config.TrunkID)
	if err != nil || key != expectedKey {
		return errors.New("trunk directory key does not match its organization and trunk")
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.entries[key] = config
	return nil
}

// Remove drops one trunk.
func (d *Directory) Remove(key string) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.entries, key)
}

// OpenDirectoryBucket binds to the `trunks` bucket described by packages/events-go. It does NOT
// create it: the bucket is a read model written by apps/api, and an edge that created its own would
// bring up an empty one alongside the real one. A missing bucket is an error for the caller to
// judge.
func OpenDirectoryBucket(ctx context.Context, js jetstream.JetStream) (jetstream.KeyValue, error) {
	if js == nil {
		return nil, errors.New("trunk: a JetStream context is required for the trunks bucket")
	}
	bucket, err := js.KeyValue(ctx, contract.TrunksKV.Name)
	if err != nil {
		return nil, fmt.Errorf("trunk: opening the %s bucket: %w", contract.TrunksKV.Name, err)
	}
	return bucket, nil
}

// Watch fills the directory from the bucket and keeps it filled until the context is cancelled.
//
// One WatchAll rather than a load followed by a watch: it replays every existing key and marks the
// boundary with a nil entry, so there is no window between the two in which an edit is missed.
//
// The returned channel is closed once the initial replay is complete, so a caller can wait for the
// directory to be populated before starting a registration sweep. It is closed exactly once, on the
// FIRST replay boundary; a later re-established replay does not close it again.
//
// The watch RE-ESTABLISHES itself when the update stream ends without the context being cancelled.
// A broker restart ends the ordered consumer ("stream not found: recreating ordered consumer"), and
// a watch that gave up there would leave the edge registering whatever trunks it last held for the
// rest of the process's life — with no error, and with every subsequent carrier edit invisible.
func Watch(ctx context.Context, bucket jetstream.KeyValue, directory *Directory) (<-chan struct{}, error) {
	if bucket == nil {
		return nil, errors.New("trunk: a trunks bucket is required to watch it")
	}
	updates, err := bucket.WatchAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("trunk: watching the %s bucket: %w", contract.TrunksKV.Name, err)
	}

	ready := make(chan struct{})
	closeReady := sync.OnceFunc(func() { close(ready) })

	go func() {
		defer closeReady()
		backoff := watchRetryMin
		for {
			// The directory from the previous stream stands while the replacement replays: the
			// alternative is an edge that answers `unknown_trunk` for the length of a reconnect.
			ended := consume(ctx, updates, directory, closeReady)
			_ = updates.Stop()
			if ctx.Err() != nil || !ended {
				return
			}
			directory.log.Warn("the trunk directory watch ended; re-establishing it",
				"bucket", contract.TrunksKV.Name, "retryIn", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, watchRetryMax)
			next, err := bucket.WatchAll(ctx)
			if err != nil {
				directory.log.Error("cannot re-establish the trunk directory watch",
					"bucket", contract.TrunksKV.Name, "error", err)
				continue
			}
			backoff = watchRetryMin
			updates = next
		}
	}()
	return ready, nil
}

// watchRetryMin and watchRetryMax bound the re-establish backoff. A broker that is down is down for
// everything, so the ceiling is short enough that the directory reloads promptly once it returns.
const (
	watchRetryMin = time.Second
	watchRetryMax = 30 * time.Second
)

// consume drains one update stream. It reports whether the stream ENDED (so a replacement is
// wanted) rather than the context being cancelled.
func consume(ctx context.Context, updates jetstream.KeyWatcher, directory *Directory, closeReady func()) bool {
	for {
		select {
		case <-ctx.Done():
			return false
		case entry, ok := <-updates.Updates():
			if !ok {
				return true
			}
			if entry == nil {
				// The end of the replay. Everything after this is a live edit.
				directory.log.Info("trunk directory loaded",
					"bucket", contract.TrunksKV.Name, "trunks", directory.Len())
				// One reconcile for the whole replay rather than one per key.
				directory.changed()
				closeReady()
				continue
			}
			applyTrunkUpdate(directory, entry)
		}
	}
}

// applyTrunkUpdate turns one KV update into a directory change. A DELETE or PURGE removes the
// trunk; a poisoned value is logged and skipped with the previous configuration left standing, so a
// malformed write cannot take a working carrier offline.
func applyTrunkUpdate(directory *Directory, entry jetstream.KeyValueEntry) {
	switch entry.Operation() {
	case jetstream.KeyValueDelete, jetstream.KeyValuePurge:
		directory.Remove(entry.Key())
		directory.log.Info("a trunk left the directory", "key", entry.Key())
		directory.changed()
		return
	}

	var record Record
	if err := json.Unmarshal(entry.Value(), &record); err != nil {
		directory.log.Error("ignoring an unparseable trunk record; the previous configuration stands",
			"key", entry.Key(), "error", err)
		return
	}
	config := record.Config()
	if err := directory.Put(entry.Key(), config); err != nil {
		directory.log.Error("ignoring an invalid trunk record; the previous configuration stands",
			"key", entry.Key(), "trunk", config.Name, "error", err)
		return
	}
	directory.log.Info("trunk configuration applied",
		"key", entry.Key(),
		"trunkId", config.TrunkID,
		"trunk", config.Name,
		"kind", config.Kind,
		"enabled", config.Enabled,
		"registers", config.Register,
		"proxy", config.SIPProxy)
	directory.changed()
}
