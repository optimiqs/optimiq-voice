// Package acl ingests the `sip-acl` KV read model into the in-process evaluator.
//
// The bucket is a derived, non-org-scoped projection of `sip_acl_entry` written by apps/api, watched
// rather than read per INVITE so an admission decision never costs a broker round trip on the one
// path an attacker controls the rate of.
//
// Evaluation rule: most specific prefix first (a /32 beats a /24 whatever their priorities), then
// priority, then deny before allow; first match wins, and an address matching nothing is REFUSED.
// There is no default allow here or in internal/profile. `sip_acl_entry.priority` is "lower first"
// while profile.Entry.Priority is "higher wins"; this package is the border and inverts — see
// priorityOf.
package acl

import (
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

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
)

// The two scopes this edge evaluates. Keeping the four scopes apart is the anti-toll-fraud
// boundary: an entry admitting an address to the provisioning endpoint must not also let it send
// unauthenticated INVITEs, or register a phone.
const (
	// ScopeTrunk governs unauthenticated INVITE admission on the external profile.
	ScopeTrunk = contract.SIPACLEntryScopeTrunk
	// ScopeRegistration governs REGISTER admission. See profile.NewWatchedBlocklist for why the
	// two scopes fail in opposite directions when nothing matches.
	ScopeRegistration = contract.SIPACLEntryScopeRegistration
)

// Record is one entry as the `sip-acl` bucket holds it. An alias, not a copy, of the generated
// contract type, so the field names are the writer's rather than a convention this reader hopes
// still holds.
type Record = contract.SIPACLEntry

// compile turns the record into an evaluator entry, or reports why it cannot.
func compile(r Record) (profile.Entry, error) {
	action := profile.Action(strings.ToLower(strings.TrimSpace(string(r.Action))))
	if !action.Valid() {
		return profile.Entry{}, fmt.Errorf("acl: %q is not a valid action", r.Action)
	}
	return profile.ParseEntry(r.Network, action, priorityOf(r.Priority), deref(r.TrunkID), label(r))
}

// label names the entry in a log line and in profile.Entry.Label.
func label(r Record) string {
	if name := deref(r.Name); name != "" {
		return name
	}
	return contract.SIPACLKV.Name
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

// applies reports whether this entry governs the given scope. Both conditions are refusals rather
// than filters: treating a disabled entry or another scope's entry as an allow is how an ACL
// written for the admin API becomes a carrier trunk.
func applies(r Record, scope contract.SIPACLEntryScope) bool {
	return r.Enabled && strings.ToLower(strings.TrimSpace(string(r.Scope))) == string(scope)
}

// priorityOf inverts the column's "lower first" ordering into the evaluator's "higher wins".
// Negation is exact for every integer the column can hold; subtracting from a fixed ceiling would
// silently reorder priorities above it.
func priorityOf(columnPriority int) int { return -columnPriority }

// Watcher keeps a profile.ACL filled from the bucket. It holds the accumulated record set so every
// update recompiles the whole list: an ACL applied in pieces has moments where a deny has been
// removed and its replacement has not yet arrived.
type Watcher struct {
	acl *profile.ACL
	// registration is the REGISTER-admission list, filled from the same bucket and the same replay
	// so the two scopes can never disagree about which records they have seen. Nil when the edge
	// serves no registrations.
	registration *profile.ACL
	log          *slog.Logger

	mu      sync.Mutex
	records map[string]Record
	// overrides are entries from configuration rather than from the bucket. They are recompiled
	// alongside every update so a static entry is not lost the first time the bucket changes.
	overrides []profile.Entry
	// suspended defers recompilation while a batch of records is being applied, and deferred says
	// one was skipped. See Suspend.
	suspended bool
	deferred  bool
}

// NewWatcher builds a watcher over an ACL. The overrides are applied on top of every recompilation,
// so a statically configured entry (SIPD_TRUNK_ACL) cannot be removed by a bucket update.
func NewWatcher(acl *profile.ACL, overrides []profile.Entry, log *slog.Logger) (*Watcher, error) {
	if acl == nil {
		return nil, errors.New("acl: an ACL is required to fill")
	}
	if log == nil {
		log = slog.Default()
	}
	watcher := &Watcher{
		acl:       acl,
		log:       log,
		records:   make(map[string]Record),
		overrides: slices.Clone(overrides),
	}
	watcher.recompile()
	return watcher, nil
}

// WithRegistrationACL attaches the `scope=registration` half of the bucket to acl and recompiles.
// Install it at boot, before Watch; it is not safe to call once the watch is running.
func (w *Watcher) WithRegistrationACL(acl *profile.ACL) *Watcher {
	w.registration = acl
	w.recompile()
	return w
}

// Len reports how many bucket records the watcher holds, excluding overrides.
func (w *Watcher) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.records)
}

// Suspend defers recompilation until Resume, for a batch of records that arrives as many updates —
// the initial WatchAll replay, where recompiling per key would be quadratic. The ACL is unchanged
// while suspended, so it stays empty rather than half-applied.
func (w *Watcher) Suspend() {
	w.mu.Lock()
	w.suspended = true
	w.mu.Unlock()
}

// Resume ends a Suspend and recompiles once if anything changed in the meantime.
func (w *Watcher) Resume() {
	w.mu.Lock()
	w.suspended = false
	pending := w.deferred
	w.deferred = false
	w.mu.Unlock()
	if pending {
		w.recompile()
	}
}

// Put installs or replaces one record and recompiles.
func (w *Watcher) Put(key string, record Record) {
	w.mu.Lock()
	w.records[key] = record
	held := w.hold()
	w.mu.Unlock()
	if !held {
		w.recompile()
	}
}

// Remove drops one record and recompiles.
func (w *Watcher) Remove(key string) {
	w.mu.Lock()
	delete(w.records, key)
	held := w.hold()
	w.mu.Unlock()
	if !held {
		w.recompile()
	}
}

// hold records that a recompilation is owed and reports whether it was deferred. Called with the
// lock held.
func (w *Watcher) hold() bool {
	if w.suspended {
		w.deferred = true
	}
	return w.suspended
}

// recompile rebuilds the whole entry set and swaps it in. A record that will not compile is skipped
// and the rest are applied: refusing the whole set would let one malformed row from the control
// plane take every carrier offline at once.
func (w *Watcher) recompile() {
	w.mu.Lock()
	keys := slices.Sorted(maps.Keys(w.records))
	records := make([]Record, 0, len(keys))
	for _, key := range keys {
		records = append(records, w.records[key])
	}
	overrides := slices.Clone(w.overrides)
	w.mu.Unlock()

	w.apply(w.acl, ScopeTrunk, keys, records, overrides)
	if w.registration != nil {
		w.apply(w.registration, ScopeRegistration, keys, records, nil)
	}
}

// apply compiles one scope's records and swaps them into its evaluator.
func (w *Watcher) apply(
	acl *profile.ACL,
	scope contract.SIPACLEntryScope,
	keys []string,
	records []Record,
	overrides []profile.Entry,
) {
	entries := make([]profile.Entry, 0, len(records)+len(overrides))
	entries = append(entries, overrides...)
	skipped := 0
	for index, record := range records {
		if !applies(record, scope) {
			continue
		}
		entry, err := compile(record)
		if err != nil {
			skipped++
			w.log.Error("ignoring an unusable sip-acl entry", "key", keys[index], "scope", scope, "error", err)
			continue
		}
		entries = append(entries, entry)
	}
	acl.Replace(entries)
	if skipped > 0 {
		w.log.Warn("some sip-acl entries were skipped",
			"skipped", skipped, "applied", len(entries), "scope", scope, "bucket", contract.SIPACLKV.Name)
	}
}

// OpenBucket binds to the `sip-acl` bucket described by packages/events-go. It does not create it:
// the bucket is owned by apps/api, and an edge that created its own would come up empty — a silent
// outage rather than a named one.
func OpenBucket(ctx context.Context, js jetstream.JetStream) (jetstream.KeyValue, error) {
	if js == nil {
		return nil, errors.New("acl: a JetStream context is required for the sip-acl bucket")
	}
	bucket, err := js.KeyValue(ctx, contract.SIPACLKV.Name)
	if err != nil {
		return nil, fmt.Errorf("acl: opening the %s bucket: %w", contract.SIPACLKV.Name, err)
	}
	return bucket, nil
}

// Watch fills the ACL from the bucket and keeps it filled until the context is cancelled. One
// WatchAll rather than a load followed by a watch, so there is no window in which an edit — on this
// boundary, a deny — could be missed. The returned channel closes once the initial replay completes.
//
// The watch RE-ESTABLISHES itself when the update stream ends without the context being cancelled.
// A broker restart ends the ordered consumer ("stream not found: recreating ordered consumer"), and
// a watch that gave up there would leave the edge serving whatever ACL it last compiled for the rest
// of the process's life — with no error, and with every subsequent entry an operator writes
// invisible to the security boundary that entry exists to move.
func Watch(ctx context.Context, bucket jetstream.KeyValue, watcher *Watcher) (<-chan struct{}, error) {
	if bucket == nil {
		return nil, errors.New("acl: a sip-acl bucket is required to watch it")
	}
	updates, err := bucket.WatchAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("acl: watching the %s bucket: %w", contract.SIPACLKV.Name, err)
	}

	watcher.Suspend()

	ready := make(chan struct{})
	closeReady := sync.OnceFunc(func() { close(ready) })

	go func() {
		defer closeReady()
		backoff := watchRetryMin
		for {
			// The compiled ACL from the previous stream stands while the replacement replays: the
			// alternative is an edge that refuses every carrier for the length of a reconnect.
			ended := consume(ctx, updates, watcher, closeReady)
			_ = updates.Stop()
			if ctx.Err() != nil || !ended {
				return
			}
			watcher.log.Warn("the sip-acl watch ended; re-establishing it",
				"bucket", contract.SIPACLKV.Name, "retryIn", backoff)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, watchRetryMax)
			next, err := bucket.WatchAll(ctx)
			if err != nil {
				watcher.log.Error("cannot re-establish the sip-acl watch",
					"bucket", contract.SIPACLKV.Name, "error", err)
				continue
			}
			backoff = watchRetryMin
			updates = next
			// Suspended again so the replay recompiles the whole set once rather than once per key.
			watcher.Suspend()
		}
	}()
	return ready, nil
}

// watchRetryMin and watchRetryMax bound the re-establish backoff. A broker that is down is down for
// everything, so the ceiling is short enough that the boundary reloads promptly once it returns.
const (
	watchRetryMin = time.Second
	watchRetryMax = 30 * time.Second
)

// consume drains one update stream. It reports whether the stream ENDED (so a replacement is
// wanted) rather than the context being cancelled.
func consume(ctx context.Context, updates jetstream.KeyWatcher, watcher *Watcher, closeReady func()) bool {
	defer watcher.Resume()
	for {
		select {
		case <-ctx.Done():
			return false
		case entry, ok := <-updates.Updates():
			if !ok {
				return true
			}
			if entry == nil {
				watcher.Resume()
				watcher.log.Info("sip acl loaded",
					"bucket", contract.SIPACLKV.Name,
					"records", watcher.Len(),
					"entries", watcher.acl.Len())
				closeReady()
				continue
			}
			applyUpdate(watcher, entry)
		}
	}
}

func applyUpdate(watcher *Watcher, entry jetstream.KeyValueEntry) {
	switch entry.Operation() {
	case jetstream.KeyValueDelete, jetstream.KeyValuePurge:
		watcher.Remove(entry.Key())
		watcher.log.Info("a sip-acl entry was withdrawn", "key", entry.Key())
		return
	}

	var record Record
	if err := json.Unmarshal(entry.Value(), &record); err != nil {
		// Keeping the last known good record is the only behaviour that neither widens nor narrows
		// the boundary on a malformed write.
		watcher.log.Error("ignoring an unparseable sip-acl record; the previous entry stands",
			"key", entry.Key(), "error", err)
		return
	}
	watcher.Put(entry.Key(), record)
}
