//go:build e2e

package sipd_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/acl"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/kv"
)

// e2eBindings reads the live registration bucket, which is the only view of what a REGISTER
// actually stored.
func e2eBindings(t *testing.T) []kv.Binding {
	t.Helper()
	url := strings.TrimSpace(os.Getenv("NATS_URL"))
	if url == "" {
		t.Skip("set NATS_URL (and NATS_SIPD_USER/NATS_SIPD_PASS) to read the registration bucket")
	}
	conn, err := nats.Connect(url,
		nats.UserInfo(os.Getenv("NATS_SIPD_USER"), os.Getenv("NATS_SIPD_PASS")),
		nats.CustomInboxPrefix("_INBOX.sipd"),
		nats.Name("sipd-e2e-inspector"))
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	t.Cleanup(conn.Close)
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}
	store, err := kv.Open(t.Context(), js)
	if err != nil {
		t.Fatalf("opening the registrations bucket: %v", err)
	}
	all, err := store.All(t.Context())
	if err != nil {
		t.Fatalf("listing bindings: %v", err)
	}
	return all
}

// TestE2EDumpBindings is a diagnostic, not an assertion.
func TestE2EDumpBindings(t *testing.T) {
	requireE2E(t)
	for _, binding := range e2eBindings(t) {
		encoded, _ := json.Marshal(binding)
		t.Logf("%s", encoded)
	}
}

// TestE2EDumpACL prints the sip-acl read model the edge compiles its trunk admission from.
func TestE2EDumpACL(t *testing.T) {
	requireE2E(t)
	url := strings.TrimSpace(os.Getenv("NATS_URL"))
	if url == "" {
		t.Skip("set NATS_URL to read the sip-acl bucket")
	}
	conn, err := nats.Connect(url,
		nats.UserInfo(os.Getenv("NATS_SIPD_USER"), os.Getenv("NATS_SIPD_PASS")),
		nats.CustomInboxPrefix("_INBOX.sipd"), nats.Name("sipd-e2e-inspector"))
	if err != nil {
		t.Fatalf("connecting to %s: %v", url, err)
	}
	t.Cleanup(conn.Close)
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}
	bucket, err := acl.OpenBucket(t.Context(), js)
	if err != nil {
		t.Fatalf("opening the sip-acl bucket: %v", err)
	}
	keys, err := bucket.Keys(t.Context())
	if err != nil {
		t.Fatalf("listing sip-acl keys: %v", err)
	}
	for _, key := range keys {
		entry, err := bucket.Get(t.Context(), key)
		if err != nil {
			t.Logf("%s: %v", key, err)
			continue
		}
		t.Logf("%s = %s", key, entry.Value())
	}
	if len(keys) == 0 {
		t.Log("the sip-acl bucket is empty")
	}
}
