// Package acl ingests the `sip-acl` KV read model into the in-process evaluator.
//
// # Why there is a read model at all
//
// `sip_acl_entry` in packages/pbx-db already has the right shape — a native PostgreSQL `cidr`, an
// `action`, a `priority` and a `scope` whose comment calls it "the anti-toll-fraud boundary". It is
// ORGANIZATION-SCOPED, and the reader is not: an INVITE from a carrier arrives carrying a source
// address and nothing else. Same problem as `did-index`, same answer — a derived, non-org-scoped
// bucket written by apps/api from the table and rebuildable from it (design §8.1).
//
// # Why it is WATCHED and not read per INVITE
//
// A KV get per INVITE is a broker round trip inside a SIP transaction, on the one code path an
// attacker controls the rate of. So the whole bucket is compiled into a longest-prefix match held in
// memory, and an edit is a pointer swap. That is not an optimisation: an edge whose admission
// decision costs a network round trip is an edge whose admission decision can be made to queue.
//
// # The evaluation rule, stated once
//
// MOST SPECIFIC PREFIX first — a /32 beats a /24 whatever their priorities — then priority (lowest
// `sip_acl_entry.priority` first, which is what the inversion below makes "higher wins"
// downstream), then deny before allow at equal specificity and priority; first match wins. And an
// address matching NOTHING is REFUSED.
//
// Specificity outranking priority is worth stating plainly, because the other reading changes
// answers: `deny 203.0.113.0/24 priority 1` plus `allow 203.0.113.7/32 priority 100` ALLOWS
// 203.0.113.7. The evaluator is profile.ACL.store and it is the authority; this sentence describes
// it rather than the other way round. The last clause is the whole boundary: there is no default
// allow anywhere in this package or in internal/profile, and there is no constructor that could
// introduce one.
//
// The inversion between the column and the evaluator is worth naming because it is the one thing
// here that looks like a bug. `sip_acl_entry.priority` is documented "lower first" and defaults to
// 100; `profile.Entry.Priority` is documented "higher wins". This package is the border, so this
// package inverts — see priorityOf — and the evaluator downstream has one rule instead of two.
package acl

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

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
)

// ScopeTrunk is the only scope this edge's INVITE admission consults.
//
// `sip_acl_entry.scope` has four members — registration, trunk, provisioning, api — and keeping them
// apart IS the anti-toll-fraud boundary, in the column's own words. An entry written to let an
// office's address reach the provisioning endpoint must not also let it send unauthenticated
// INVITEs, and the only thing standing between those two is this filter.
const ScopeTrunk = contract.SIPACLEntryScopeTrunk

// Record is one entry as the `sip-acl` bucket holds it.
//
// It is the GENERATED contract type — packages/events' `sipAclEntrySchema`, emitted into
// packages/events-go as `SIPACLEntry` — aliased so this package can keep calling it what the bucket
// calls it. An alias and not a copy: the writer in apps/api projects the same schema, so the field
// names here are the contract's rather than a convention this reader hopes still holds.
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

// applies reports whether this entry governs unauthenticated INVITE admission.
//
// Two conditions and both are refusals rather than filters: a DISABLED entry is one an operator
// switched off, and an entry in another SCOPE governs a different surface entirely. Treating either
// as an allow here is how an ACL written for the admin API becomes a carrier trunk.
func applies(r Record) bool {
	return r.Enabled && strings.ToLower(strings.TrimSpace(string(r.Scope))) == string(ScopeTrunk)
}

// priorityOf inverts the column's ordering into the evaluator's.
//
// The column says "lower first" and defaults to 100; profile.Entry says "higher wins". Negating is
// the whole transformation and it is exact for every integer the column can hold, which a
// subtraction from a fixed ceiling would not be — a priority above the ceiling would silently
// reorder.
func priorityOf(columnPriority int) int { return -columnPriority }

// Watcher keeps a profile.ACL filled from the bucket.
//
// It holds the accumulated record set so an update can recompile the WHOLE list rather than patch
// it, which is what makes profile.ACL.Replace safe: an ACL applied in pieces has moments where a
// deny has been removed and its replacement has not yet arrived, and on this boundary a moment is
// all an automated scanner needs.
type Watcher struct {
	acl *profile.ACL
	log *slog.Logger

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

// NewWatcher builds a watcher over an ACL.
//
// The overrides are applied on top of every recompilation and are how SIPD_TRUNK_ACL survives as an
// escape hatch: a deployment whose control plane cannot yet write the bucket, or an operator who
// needs one address admitted right now during an incident, sets the variable and gets an entry that
// no bucket update can remove.
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
		overrides: append([]profile.Entry(nil), overrides...),
	}
	watcher.recompile()
	return watcher, nil
}

// Len reports how many bucket records the watcher holds, excluding overrides.
func (w *Watcher) Len() int {
	w.mu.Lock()
	defer w.mu.Unlock()
	return len(w.records)
}

// Suspend defers recompilation until Resume, for a batch of records that arrives as many updates.
//
// The initial replay is that batch: WatchAll delivers every existing key one at a time, and
// recompiling per key makes loading N entries N recompilations of N entries — O(N² log N) prefix
// parses and sorts before the boundary is usable, which is the window in which carriers are refused.
// The ACL is unchanged while suspended, so it stays EMPTY rather than half-applied, which on this
// boundary is the safe direction and is what it already does before the replay starts.
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

// Put installs or replaces one record and recompiles. Exported so a test and a watch update take
// the same path.
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

// recompile rebuilds the whole entry set and swaps it in.
//
// A record that will not compile is SKIPPED and the rest are applied. That is the right trade on
// this boundary and it is worth saying why, because the opposite is defensible elsewhere: refusing
// the whole set on one bad network would let a single malformed row — written by a control plane
// this process does not control — take every carrier offline at once. Skipping fails closed for one
// entry instead of for all of them, and the log line names the key.
func (w *Watcher) recompile() {
	w.mu.Lock()
	records := make([]Record, 0, len(w.records))
	keys := make([]string, 0, len(w.records))
	for key := range w.records {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		records = append(records, w.records[key])
	}
	overrides := append([]profile.Entry(nil), w.overrides...)
	w.mu.Unlock()

	entries := make([]profile.Entry, 0, len(records)+len(overrides))
	entries = append(entries, overrides...)
	skipped := 0
	for index, record := range records {
		if !applies(record) {
			continue
		}
		entry, err := compile(record)
		if err != nil {
			skipped++
			w.log.Error("ignoring an unusable sip-acl entry", "key", keys[index], "error", err)
			continue
		}
		entries = append(entries, entry)
	}
	w.acl.Replace(entries)
	if skipped > 0 {
		w.log.Warn("some sip-acl entries were skipped",
			"skipped", skipped, "applied", len(entries), "bucket", contract.SIPACLKV.Name)
	}
}

// OpenBucket binds to the `sip-acl` bucket described by packages/events-go.
//
// It does NOT create it, for the same reason internal/trunk does not create the trunk directory: the
// bucket is a derived read model owned by apps/api, and an edge that created its own would bring one
// up EMPTY. On this bucket that failure is the safe direction — an empty ACL refuses every carrier —
// but it would be a silent outage rather than a named one, and a named one is what an operator can
// act on.
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

// Watch fills the ACL from the bucket and keeps it filled until the context is cancelled.
//
// One `WatchAll`, not a load followed by a watch: WatchAll replays every existing key before it
// delivers updates and marks the boundary with a nil entry, so there is no window between the two in
// which an edit could be missed. On a security boundary a missed edit is a deny that never took
// effect.
//
// The returned channel closes once the initial replay is complete, so a caller can wait for the ACL
// to be populated before it starts accepting traffic rather than polling Len.
func Watch(ctx context.Context, bucket jetstream.KeyValue, watcher *Watcher) (<-chan struct{}, error) {
	if bucket == nil {
		return nil, errors.New("acl: a sip-acl bucket is required to watch it")
	}
	updates, err := bucket.WatchAll(ctx)
	if err != nil {
		return nil, fmt.Errorf("acl: watching the %s bucket: %w", contract.SIPACLKV.Name, err)
	}

	// The replay is one batch, not N edits: recompiling per key would be quadratic in the number of
	// entries and every carrier is refused until it finishes.
	watcher.Suspend()

	ready := make(chan struct{})
	go func() {
		defer func() { _ = updates.Stop() }()
		defer watcher.Resume()
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
			case entry, ok := <-updates.Updates():
				if !ok {
					return
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
	}()
	return ready, nil
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
		// The previous record for this key stands. A malformed write must not silently widen or
		// narrow the boundary, and keeping what was last known good is the only behaviour that is
		// neither.
		watcher.log.Error("ignoring an unparseable sip-acl record; the previous entry stands",
			"key", entry.Key(), "error", err)
		return
	}
	watcher.Put(entry.Key(), record)
}
