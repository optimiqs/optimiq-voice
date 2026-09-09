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
