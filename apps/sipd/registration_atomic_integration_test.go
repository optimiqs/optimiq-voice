//go:build integration

package sipd_test

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/aor"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

func TestConcurrentRegistrationUpdatesAgainstProductionNATS(t *testing.T) {
	requireIntegration(t)
	url := startNATSWithPlatformConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now()
	hash, _ := contract.AORSubjectToken("sip:1001@acme.example.com")
	stores := make([]*kv.NATSStore, 2)
	for i := range stores {
		conn, err := nats.Connect(url, nats.UserInfo(itSipdUser, itNATSPass), nats.CustomInboxPrefix("_INBOX.sipd"))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(conn.Close)
		js, err := jetstream.New(conn)
		if err != nil {
			t.Fatal(err)
		}
		stores[i], err = kv.Open(ctx, js)
		if err != nil {
			t.Fatal(err)
		}
	}
	var workers sync.WaitGroup
	for i := range 10 {
		workers.Go(func() {
			_, _, err := stores[i%2].Update(ctx, itOrg, hash, func(previous *kv.Binding) (*kv.Binding, error) {
				binding := kv.Binding{OrgID: itOrg, AORHash: hash, AOR: "sip:1001@acme.example.com", ExpiresAt: contract.NewEventTime(now.Add(time.Hour))}
				if previous != nil {
					binding = *previous
				}
				set := aor.FromBinding(binding).Bind(aor.Contact{URI: "sip:device" + strconv.Itoa(i) + "@example.test", Transport: "wss", SIPDInstanceID: "edge-" + strconv.Itoa(i%2), Q: 1, RegisteredAt: now, ExpiresAt: now.Add(time.Hour)}, 20, now).Set
				next := aor.ApplyToBinding(binding, set)
				return &next, nil
			})
			if err != nil {
				t.Errorf("concurrent contact update: %v", err)
			}
		})
	}
	workers.Wait()
	binding, found, err := stores[0].Get(ctx, itOrg, hash)
	if err != nil || !found || len(binding.Contacts) != 10 {
		t.Fatalf("lost contact updates: found=%v contacts=%d error=%v", found, len(binding.Contacts), err)
	}
	if _, _, err := stores[1].Update(ctx, itOrg, hash, func(*kv.Binding) (*kv.Binding, error) { return nil, nil }); err != nil {
		t.Fatal(err)
	}
	if _, found, err := stores[0].Get(ctx, itOrg, hash); err != nil || found {
		t.Fatalf("atomic deletion did not remove binding: found=%v error=%v", found, err)
	}
}

// staleHint is a kv.Hint that always answers with the binding it was given, whatever the bucket
// says. It is how the two hint failure modes are provoked deterministically.
type staleHint struct {
	binding kv.Binding
	present bool
}

func (h staleHint) LastKnown(_, _ string) (kv.Binding, bool) { return h.binding, h.present }

// TestUpdateWithAStaleHintStillCommitsAgainstTheRealRevision proves the hint cannot turn a lost CAS
// race into a won one.
//
// The hint carries a revision the bucket has moved past. The first attempt must therefore be
// REFUSED by the server, and the retry must read the real value and commit on top of it — so the
// write another writer landed in between survives, exactly as it would with no hint at all.
func TestUpdateWithAStaleHintStillCommitsAgainstTheRealRevision(t *testing.T) {
	requireIntegration(t)
	url := startNATSWithPlatformConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()

	conn, err := nats.Connect(url, nats.UserInfo(itSipdUser, itNATSPass), nats.CustomInboxPrefix("_INBOX.sipd"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(conn.Close)
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatal(err)
	}
	store, err := kv.Open(ctx, js)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	hash, err := contract.AORSubjectToken("sip:1002@acme.example.com")
	if err != nil {
		t.Fatal(err)
	}
	base := kv.Binding{
		OrgID: itOrg, AOR: "sip:1002@acme.example.com", AORHash: hash,
		Contact: "sip:1002@203.0.113.9:5060", Transport: contract.SIPTransportUDP,
		RegisteredAt: contract.NewEventTime(now), ExpiresAt: contract.NewEventTime(now.Add(time.Hour)),
		ExpiresInSeconds: 3600,
	}

	// Two writes, so the hint below names revision 1 while the bucket is at revision 2.
	if _, _, err := store.Update(ctx, itOrg, hash, func(*kv.Binding) (*kv.Binding, error) {
		return &base, nil
	}); err != nil {
		t.Fatalf("seeding the binding: %v", err)
	}
	seeded, found, err := store.Get(ctx, itOrg, hash)
	if err != nil || !found {
		t.Fatalf("reading the seeded binding: found=%v err=%v", found, err)
	}
	second := seeded
	second.UserAgent = "written-by-somebody-else"
	if _, _, err := store.Update(ctx, itOrg, hash, func(*kv.Binding) (*kv.Binding, error) {
		return &second, nil
	}); err != nil {
		t.Fatalf("the second write: %v", err)
	}

	store.SetHint(staleHint{binding: seeded, present: true})

	var sawUserAgent string
	_, after, err := store.Update(ctx, itOrg, hash, func(previous *kv.Binding) (*kv.Binding, error) {
		if previous == nil {
			t.Fatal("the retry must see the stored binding")
		}
		sawUserAgent = previous.UserAgent
		next := *previous
		next.ExpiresInSeconds = 1800
		return &next, nil
	})
	if err != nil {
		t.Fatalf("updating behind a stale hint: %v", err)
	}
	// The callback ran at least twice: once on the stale hint, then again on the value the retry
	// read. What matters is that the COMMITTED value was built from the real one.
	if sawUserAgent != "written-by-somebody-else" {
		t.Fatalf("the committed update was built from %q, not from the other writer's value", sawUserAgent)
	}
	if after == nil || after.ExpiresInSeconds != 1800 || after.UserAgent != "written-by-somebody-else" {
		t.Fatalf("the stale hint lost another writer's field: %+v", after)
	}
}

// TestUpdateWithAFreshHintSkipsTheRead is the win the hint exists for: one broker round trip for a
// refresh instead of two.
func TestUpdateWithAFreshHintSkipsTheRead(t *testing.T) {
	requireIntegration(t)
	url := startNATSWithPlatformConfig(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()

	conn, err := nats.Connect(url, nats.UserInfo(itSipdUser, itNATSPass), nats.CustomInboxPrefix("_INBOX.sipd"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(conn.Close)
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatal(err)
	}
	store, err := kv.Open(ctx, js)
	if err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	hash, err := contract.AORSubjectToken("sip:1003@acme.example.com")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.Update(ctx, itOrg, hash, func(*kv.Binding) (*kv.Binding, error) {
		return &kv.Binding{
			OrgID: itOrg, AOR: "sip:1003@acme.example.com", AORHash: hash,
			Contact: "sip:1003@203.0.113.9:5060", Transport: contract.SIPTransportUDP,
			RegisteredAt: contract.NewEventTime(now), ExpiresAt: contract.NewEventTime(now.Add(time.Hour)),
			ExpiresInSeconds: 3600,
		}, nil
	}); err != nil {
		t.Fatalf("seeding the binding: %v", err)
	}
	seeded, found, err := store.Get(ctx, itOrg, hash)
	if err != nil || !found {
		t.Fatalf("reading the seeded binding: found=%v err=%v", found, err)
	}

	store.SetHint(staleHint{binding: seeded, present: true})
	before := conn.Stats().OutMsgs
	if _, _, err := store.Update(ctx, itOrg, hash, func(previous *kv.Binding) (*kv.Binding, error) {
		if previous == nil || previous.Revision != seeded.Revision {
			t.Fatalf("the hinted attempt did not see the hint: %+v", previous)
		}
		next := *previous
		next.ExpiresInSeconds = 1800
		return &next, nil
	}); err != nil {
		t.Fatalf("updating behind a fresh hint: %v", err)
	}
	if spent := conn.Stats().OutMsgs - before; spent != 1 {
		t.Fatalf("a hinted refresh spent %d broker round trips, want 1", spent)
	}
}
