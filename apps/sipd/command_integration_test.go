//go:build integration

package sipd_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/acl"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/command"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/reaper"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/trunk"
)

// W12.5's NATS surfaces, against a real broker.
//
// Everything below is proved in the unit suite against interfaces. What is proved HERE is the half
// no interface can stand in for: that the subjects a caller publishes on are the subjects this edge
// subscribes to, that a KV watch actually delivers, and that a claim written by one instance is
// visible to another. Every one of those has exactly one failure mode — silence — and silence is
// what a fake cannot reproduce.
//
//	RUN_SIPD_INTEGRATION=1 go test -tags integration -v -timeout 5m ./apps/sipd/...

// commandDialogs answers every command successfully and records the leg it was asked about, which
// is all this test needs: the question is whether the REQUEST arrived, not what the dialog layer
// does with it.
type commandDialogs struct{ legs chan string }

func (c commandDialogs) Ring(_ context.Context, legID string, _ int, _ string) error {
	c.legs <- "ring:" + legID
	return nil
}

func (c commandDialogs) Answer(_ context.Context, legID string, _ string) (time.Time, error) {
	c.legs <- "answer:" + legID
	return time.Now().UTC(), nil
}

func (c commandDialogs) Hangup(
	_ context.Context, legID string, _ int, _ string,
) (contract.SipHangupResponseMethod, error) {
	c.legs <- "hangup:" + legID
	return contract.SipHangupResponseMethodBye, nil
}

func (c commandDialogs) Originate(
	_ context.Context, request contract.SipOriginateRequest,
) (string, string, error) {
	c.legs <- "originate:" + request.LegID
	return "sip:1001@192.0.2.10:5060", "call-id@pc33", nil
}

// The instance-addressed subjects are the whole of design §10.2, and getting them wrong is not a
// cosmetic error: a command published on a subject nobody subscribes to produces no reply, no log
// line and no failed assertion anywhere — just a call that rings for ever.
//
// So this publishes on the subject an ENGINE would build (root plus the instance token) and asserts
// a reply comes back, which is the only test that can catch a token mismatch between the two
// languages.
func TestCommandSubjectsAreReachableOnTheirInstanceToken(t *testing.T) {
	requireIntegration(t)
	url := startNATS(t)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	defer conn.Close()

	const instanceID = "sipd-integration-1"
	dialogs := commandDialogs{legs: make(chan string, 8)}
	server, err := command.NewServer(command.Options{Dialogs: dialogs, InstanceID: instanceID})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	subscriptions, err := server.Subscribe(conn)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer func() {
		for _, subscription := range subscriptions {
			_ = subscription.Unsubscribe()
		}
	}()

	token, err := contract.InstanceSubjectToken(instanceID)
	if err != nil {
		t.Fatalf("InstanceSubjectToken: %v", err)
	}

	for _, row := range []struct {
		subject string
		payload any
		want    string
	}{
		{
			contract.SubjectSipRingRPC + "." + token,
			contract.SipRingRequest{LegID: "leg-ring", Status: 180},
			"ring:leg-ring",
		},
		{
			contract.SubjectSipAnswerRPC + "." + token,
			contract.SipAnswerRequest{LegID: "leg-answer", SDPAnswer: "v=0\r\n"},
			"answer:leg-answer",
		},
		{
			contract.SubjectSipHangupRPC + "." + token,
			contract.SipHangupRequest{LegID: "leg-hangup"},
			"hangup:leg-hangup",
		},
	} {
		t.Run(row.subject, func(t *testing.T) {
			payload, err := json.Marshal(row.payload)
			if err != nil {
				t.Fatalf("encoding: %v", err)
			}
			// RAW request-reply, exactly as apps/engine must issue it. A NestJS ClientProxy would wrap
			// this in `{"pattern":…,"data":…}` and the handler would refuse it as malformed — which is
			// the obligation the contract records and this asserts.
			msg, err := conn.Request(row.subject, payload, 2*time.Second)
			if err != nil {
				t.Fatalf("no reply on %s: %v", row.subject, err)
			}
			var reply struct {
				Ok         bool    `json:"ok"`
				InstanceID *string `json:"instanceId"`
			}
			if err := json.Unmarshal(msg.Data, &reply); err != nil {
				t.Fatalf("decoding the reply: %v", err)
			}
			if !reply.Ok {
				t.Fatalf("command refused: %s", msg.Data)
			}
			if reply.InstanceID == nil || *reply.InstanceID != instanceID {
				t.Fatalf("instanceId = %v, want %q", reply.InstanceID, instanceID)
			}
			select {
			case got := <-dialogs.legs:
				if got != row.want {
					t.Fatalf("the dialog layer saw %q, want %q", got, row.want)
				}
			case <-time.After(time.Second):
				t.Fatal("the command replied without reaching the dialog layer")
			}
		})
	}
}

// `originate` is FLAT and queue-grouped: any instance may place an outbound call, and the reply
// names the one that took it. Published on the bare subject with no token, which is the difference
// this asserts.
func TestOriginateIsReachableOnTheFlatSubject(t *testing.T) {
	requireIntegration(t)
	url := startNATS(t)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	defer conn.Close()

	dialogs := commandDialogs{legs: make(chan string, 4)}
	server, err := command.NewServer(command.Options{Dialogs: dialogs, InstanceID: "sipd-integration-2"})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	subscriptions, err := server.Subscribe(conn)
	if err != nil {
		t.Fatalf("Subscribe: %v", err)
	}
	defer func() {
		for _, subscription := range subscriptions {
			_ = subscription.Unsubscribe()
		}
	}()

	aorTarget := itAOR
	payload, err := json.Marshal(contract.SipOriginateRequest{
		LegID:    "leg-originate",
		OrgID:    itOrg,
		CallID:   "call-1",
		SDPOffer: "v=0\r\n",
		Target: contract.SipOriginateRequestTarget{
			Kind: contract.SipOriginateRequestTargetKindAOR, AOR: &aorTarget,
		},
	})
	if err != nil {
		t.Fatalf("encoding: %v", err)
	}

	msg, err := conn.Request(contract.SubjectSipOriginateRPC, payload, 2*time.Second)
	if err != nil {
		t.Fatalf("no reply on the flat originate subject: %v", err)
	}
	var reply contract.SipOriginateResponse
	if err := json.Unmarshal(msg.Data, &reply); err != nil {
		t.Fatalf("decoding: %v", err)
	}
	if !reply.Ok {
		t.Fatalf("originate refused: %s", msg.Data)
	}
	// The engine addresses every subsequent command for this leg at exactly this instance, so a
	// reply without it is a leg nothing can ever hang up.
	if reply.InstanceID == nil || *reply.InstanceID != "sipd-integration-2" {
		t.Fatalf("instanceId = %v, want the instance that took it", reply.InstanceID)
	}
}

// A claim written by one instance must be VISIBLE to another, and an expired one must be reaped
// into a `dialog.terminated` the engine can write a CDR from. That crossing is the entire reason the
// bucket exists and it cannot be tested in one process with a memory store.
func TestAnOrphanedClaimIsReapedAcrossInstances(t *testing.T) {
	requireIntegration(t)
	url := startNATS(t)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	defer conn.Close()
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	claims, err := dialog.OpenClaims(ctx, js)
	if err != nil {
		t.Fatalf("OpenClaims: %v", err)
	}

	// A claim from an instance that is gone, whose lease lapsed a minute ago.
	dead := dialog.Claim{
		LegID:      "leg-orphan",
		InstanceID: "sipd-that-died",
		OrgID:      itOrg,
		CallID:     "call-orphan",
		Role:       "uas",
		SIPCallID:  "orphan@pc33",
		State:      "confirmed",
		CreatedAt:  time.Now().Add(-time.Hour).UnixMilli(),
		ExpiresAt:  time.Now().Add(-time.Minute).UnixMilli(),
	}
	if err := claims.Put(ctx, dead); err != nil {
		t.Fatalf("writing the orphaned claim: %v", err)
	}

	// A second, LIVE claim from the same dead instance. It must survive: only a lapsed lease is an
	// orphan, and reaping a live one would end a call that is still up.
	live := dead
	live.LegID = "leg-live"
	live.ExpiresAt = time.Now().Add(time.Hour).UnixMilli()
	if err := claims.Put(ctx, live); err != nil {
		t.Fatalf("writing the live claim: %v", err)
	}

	events := sipevents.NewRecordingPublisher()
	sweeper, err := reaper.New(reaper.Options{
		Store:      claims,
		Dialogs:    emptyDialogs{},
		Events:     events,
		InstanceID: "sipd-survivor",
	})
	if err != nil {
		t.Fatalf("reaper.New: %v", err)
	}
	sweeper.Sweep(ctx)

	terminated := events.TerminatedEvents()
	if len(terminated) != 1 {
		t.Fatalf("published %d terminations, want exactly 1 (the lapsed claim only)", len(terminated))
	}
	if terminated[0].Data.LegID != "leg-orphan" {
		t.Fatalf("reaped %q, want leg-orphan", terminated[0].Data.LegID)
	}
	if terminated[0].Data.Reason != contract.SIPDialogTerminatedReasonInstanceLost {
		t.Fatalf("reason = %q, want instance-lost", terminated[0].Data.Reason)
	}

	// The orphan's claim is gone and the live one is untouched.
	remaining, err := claims.All(ctx)
	if err != nil {
		t.Fatalf("listing claims: %v", err)
	}
	if len(remaining) != 1 || remaining[0].LegID != "leg-live" {
		t.Fatalf("remaining claims = %+v, want only leg-live", remaining)
	}
}

type emptyDialogs struct{}

func (emptyDialogs) Claims() []dialog.Claim { return nil }

// The ACL is WATCHED, not read per INVITE, and a watch that does not deliver is a security boundary
// that never updates. This writes an entry into a real bucket and waits for the in-process
// evaluator to admit an address it refused a moment earlier.
func TestTheSIPACLWatchDeliversAnEntry(t *testing.T) {
	requireIntegration(t)
	url := startNATS(t)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	defer conn.Close()
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// The control plane owns this bucket; the test stands in for apps/api.
	definition := contract.SIPACLKV
	bucket, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket: definition.Name, Description: definition.Description, History: definition.History,
	})
	if err != nil {
		t.Fatalf("creating the sip-acl bucket: %v", err)
	}

	evaluator := profile.NewWatchedACL(nil)
	watcher, err := acl.NewWatcher(evaluator, nil, nil)
	if err != nil {
		t.Fatalf("acl.NewWatcher: %v", err)
	}
	ready, err := acl.Watch(ctx, bucket, watcher)
	if err != nil {
		t.Fatalf("acl.Watch: %v", err)
	}
	<-ready

	// Before anything is written, an address matching nothing is REFUSED. That is the boundary.
	if _, allowed := evaluator.Match("203.0.113.7:5060"); allowed {
		t.Fatal("an empty ACL admitted an address")
	}

	key, err := contract.SIPACLKVKey("203.0.113.0/24")
	if err != nil {
		t.Fatalf("SIPACLKVKey: %v", err)
	}
	entry, err := json.Marshal(acl.Record{
		ID: "entry-1", OrganizationID: itOrg, Network: "203.0.113.0/24",
		Action: "allow", Scope: acl.ScopeTrunk, Priority: 100, TrunkID: "trunk-a", Enabled: true,
	})
	if err != nil {
		t.Fatalf("encoding the entry: %v", err)
	}
	if _, err := bucket.Put(ctx, key, entry); err != nil {
		t.Fatalf("writing the entry: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		if matched, allowed := evaluator.Match("203.0.113.7:5060"); allowed {
			if matched.TrunkID != "trunk-a" {
				t.Fatalf("trunkId = %q, want trunk-a", matched.TrunkID)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the sip-acl watch never delivered the entry; the boundary would never update")
		}
		time.Sleep(50 * time.Millisecond)
	}

	// And a withdrawal takes effect, which is the path a revoked carrier takes.
	if err := bucket.Delete(ctx, key); err != nil {
		t.Fatalf("deleting the entry: %v", err)
	}
	deadline = time.Now().Add(10 * time.Second)
	for {
		if _, allowed := evaluator.Match("203.0.113.7:5060"); !allowed {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a withdrawn ACL entry still admits; a revocation would never take effect")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// The trunk directory is watched for the same reason and with the same failure mode: a trunk edited
// in the admin UI must reach the registration machine without a restart.
func TestTheTrunkDirectoryWatchDeliversARecord(t *testing.T) {
	requireIntegration(t)
	url := startNATS(t)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting to NATS: %v", err)
	}
	defer conn.Close()
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("opening JetStream: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	definition := contract.TrunksKV
	bucket, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket: definition.Name, Description: definition.Description, History: definition.History,
	})
	if err != nil {
		t.Fatalf("creating the trunks bucket: %v", err)
	}

	directory := trunk.NewDirectory(nil)
	ready, err := trunk.Watch(ctx, bucket, directory)
	if err != nil {
		t.Fatalf("trunk.Watch: %v", err)
	}
	<-ready

	const trunkID = "018f0000-0000-7000-8000-0000000000t1"
	if _, found := directory.Trunk(itOrg, trunkID); found {
		t.Fatal("an empty directory resolved a trunk")
	}

	key, err := contract.TrunkKVKey(itOrg, trunkID)
	if err != nil {
		t.Fatalf("TrunkKVKey: %v", err)
	}
	record, err := json.Marshal(trunk.Record{
		ID: trunkID, OrganizationID: itOrg, Name: "Telnyx", Kind: "ip-auth",
		SIPDomain: "sip.telnyx.example", SIPProxy: "sip.telnyx.example:5060",
		Transport: "udp", Enabled: true,
	})
	if err != nil {
		t.Fatalf("encoding the record: %v", err)
	}
	if _, err := bucket.Put(ctx, key, record); err != nil {
		t.Fatalf("writing the record: %v", err)
	}

	deadline := time.Now().Add(10 * time.Second)
	for {
		if config, found := directory.Trunk(itOrg, trunkID); found {
			if config.SIPProxy != "sip.telnyx.example:5060" {
				t.Fatalf("sipProxy = %q, want the record's", config.SIPProxy)
			}
			if config.Register {
				t.Fatal("an ip-auth trunk was marked as registering")
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the trunk directory watch never delivered the record")
		}
		time.Sleep(50 * time.Millisecond)
	}
}
