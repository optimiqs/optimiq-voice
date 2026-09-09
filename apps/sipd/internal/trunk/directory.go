package trunk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Record uses the API's generated wire contract. Gateway configuration is derived here
// so carrier passwords never enter the shared directory.
type Record contract.TrunkDirectoryEntry

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
	config.Register = config.Kind == "register"
	config.Registrar = config.SIPProxy
	config.AuthRealm = config.SIPDomain
	if config.ExpiresSeconds <= 0 {
		config.ExpiresSeconds = 300
	}
	return config
}

// Directory is the in-process trunk table, filled from the bucket and swapped on every update.
//
// # Read at boot and WATCHED, never a get per call
//
// `TrunksKV`'s own note says why: a trunk edited in the admin UI must reach the registration state
// machine without a restart, and that is what replaces SIPD_TRUNK_ACL. The originate path reads this
// map, and a KV get there would put a broker round trip inside the one-second budget of
// `rpc.sip.v1.originate`.
//
// Safe for concurrent use. The map is replaced wholesale under a write lock rather than mutated,
// because a reader mid-originate must see a consistent directory and not a half-applied edit.
type Directory struct {
	mu      sync.RWMutex
	entries map[string]Config
	log     *slog.Logger
	// onChange is called after every applied update, with the lock RELEASED. It is how the watcher
	// reaches the registration supervisor without internal/trunk's read model depending on its own
	// state machine's lifecycle — and it is called after the swap rather than during it so a callback
	// that reads Configs sees the new world rather than deadlocking on the old one.
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

// NewDirectory returns an empty directory. Empty is a legitimate state and not an error: a
// deployment with no trunks configured is a deployment that serves only registered devices, and
// every originate to `{kind:"trunk"}` is refused `unknown_trunk` — which is the truth.
func NewDirectory(log *slog.Logger) *Directory {
	if log == nil {
		log = slog.Default()
	}
	return &Directory{entries: make(map[string]Config), log: log}
}

// Trunk resolves one trunk. The second result is false when this instance holds no configuration
// for it, which is `unknown_trunk` on the wire and means "the directory has not reached me" rather
// than "no such trunk".
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

// Len reports how many trunks the directory holds. Diagnostics and the boot log.
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
	configs := make([]Config, 0, len(d.entries))
	for _, config := range d.entries {
		configs = append(configs, config)
	}
	sort.Slice(configs, func(i, j int) bool { return configs[i].TrunkID < configs[j].TrunkID })
	return configs
}

// Put installs or replaces one trunk. Exported so a test and a watch update take the same path.
//
// A record that fails Validate is REFUSED and the previous one is kept. That is the important half:
// an operator who saves a half-filled trunk form must not take a working carrier offline, and the
// log line is what tells them the edit did not apply.
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

// OpenDirectoryBucket binds to the `trunks` bucket described by packages/events-go.
//
// It does NOT create it. The bucket is a derived read model written by apps/api from the trunk
// table, and a data-plane edge that created its own would bring one up empty — so every outbound
// call would be refused `unknown_trunk` while the control plane wrote into a bucket with the same
// name and different limits. A missing bucket is therefore an error the boot log names, and the
// caller decides whether that is fatal.
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
// # One watch, not a load followed by a watch
//
// `WatchAll` replays every existing key before it starts delivering updates and marks the boundary
// with a nil entry. So one call does the boot load and the live updates, and there is no window
// between them in which an edit could be missed — which a load-then-watch has, and which would leave
// a trunk permanently stale for however long the process ran.
//
// The returned channel is closed once the initial replay is complete, so a caller can wait for the
// directory to be populated before it starts a registration sweep without polling Len.
func Watch(ctx context.Context, bucket jetstream.KeyValue, directory *Directory) (<-chan struct{}, error) {
	if bucket == nil {
		return nil, errors.New("trunk: a trunks bucket is required to watch it")
	}
	watcher, err := bucket.WatchAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("trunk: watching the %s bucket: %w", contract.TrunksKV.Name, err)
	}

	ready := make(chan struct{})
	go func() {
		defer func() { _ = watcher.Stop() }()
		settled := false
		closeReady := func() {
			if !settled {
				settled = true
				close(ready)
			}
		}
		defer closeReady()

		for {
			select {
			case <-ctx.Done():
				return
			case entry, ok := <-watcher.Updates():
				if !ok {
					return
				}
				if entry == nil {
					// The end of the initial replay. Everything after this is a live edit.
					directory.log.Info("trunk directory loaded",
						"bucket", contract.TrunksKV.Name, "trunks", directory.Len())
					// One reconcile for the whole replay rather than one per key, so a boot with two
					// hundred trunks starts two hundred gateways once instead of two hundred times.
					directory.changed()
					closeReady()
					continue
				}
				applyTrunkUpdate(directory, entry)
			}
		}
	}()
	return ready, nil
}

// applyTrunkUpdate turns one KV update into a directory change.
//
// A DELETE or a PURGE removes the trunk. A poisoned value is skipped and the previous configuration
// is kept, for the same reason Directory.Put refuses an invalid one: a malformed write must not take
// a working carrier offline, and the operator needs a log line naming the key rather than an
// outbound outage with no cause.
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
