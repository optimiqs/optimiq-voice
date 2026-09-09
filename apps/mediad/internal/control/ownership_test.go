package control_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
)

// TestRoutingToAHungOwnerRefusesInsideTheEngineBudget pins control.RoutingTimeout to the engine's
// own RPC deadline. An owner that is merely GONE answers instantly (no responders); an owner that is
// subscribed and wedged is the case that used to park a NATS callback goroutine for two seconds,
// long after the caller had abandoned the reply.
func TestRoutingToAHungOwnerRefusesInsideTheEngineBudget(t *testing.T) {
	// The engine's ENGINE_MEDIAD_RPC_TIMEOUT_MS default. Waiting longer than this produces a reply
	// nobody is left to read.
	const engineBudget = 500 * time.Millisecond
	if control.RoutingTimeout > engineBudget {
		t.Fatalf("RoutingTimeout is %s, past the engine's %s budget", control.RoutingTimeout, engineBudget)
	}

	url := startBenchNATS(t)
	newWireRig(t, url, true)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting: %v", err)
	}
	defer conn.Close()
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	owners, err := directory.OpenOwners(t.Context(), js)
	if err != nil {
		t.Fatalf("opening the owners bucket: %v", err)
	}

	const absent = "mediad-that-is-wedged"
	session := benchSessionID(0xbeef)
	claimed, err := owners.Claim(t.Context(), directory.OwnerKey("session", session), absent)
	if err != nil {
		t.Fatalf("claiming for an absent instance: %v", err)
	}
	if claimed != absent {
		t.Fatalf("the session is already owned by %q", claimed)
	}

	token, err := contract.InstanceSubjectToken(absent)
	if err != nil {
		t.Fatalf("instance token: %v", err)
	}
	wedged, err := conn.Subscribe(control.SubjectHoldSession+".instance."+token, func(*nats.Msg) {})
	if err != nil {
		t.Fatalf("subscribing as the wedged owner: %v", err)
	}
	defer func() { _ = wedged.Unsubscribe() }()

	payload := mustMarshal(t, map[string]any{
		"orgId": testOrg, "callId": testCall, "sessionId": session, "held": true,
	})
	issued := time.Now()
	reply, err := conn.Request(control.SubjectHoldSession, payload, 5*time.Second)
	if err != nil {
		t.Fatalf("hold: %v", err)
	}
	elapsed := time.Since(issued)

	var response struct {
		Ok     bool   `json:"ok"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(reply.Data, &response); err != nil {
		t.Fatalf("decoding the refusal: %v\n%s", err, reply.Data)
	}
	if response.Ok || response.Reason != control.ReasonWrongNode {
		t.Fatalf("want a %s refusal, got %s", control.ReasonWrongNode, reply.Data)
	}
	// One RoutingTimeout covers the lookup and the forward together; the slack absorbs scheduling.
	if elapsed < control.RoutingTimeout/2 {
		t.Fatalf("refused after %s: the wedged owner cannot have been waited on", elapsed)
	}
	if budget := control.RoutingTimeout + 250*time.Millisecond; elapsed > budget {
		t.Fatalf("refused after %s, past the %s budget", elapsed, budget)
	}
}

// TestAWedgedOwnerDoesNotStallOtherRequests covers the head-of-line case: a forward waits a whole
// RoutingTimeout, and a NATS subscription dispatches its subject serially, so relaying inline made
// one unreachable neighbour hold up every unrelated request on the same subject.
func TestAWedgedOwnerDoesNotStallOtherRequests(t *testing.T) {
	url := startBenchNATS(t)
	newWireRig(t, url, true)

	conn, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connecting: %v", err)
	}
	defer conn.Close()
	js, err := jetstream.New(conn)
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	owners, err := directory.OpenOwners(t.Context(), js)
	if err != nil {
		t.Fatalf("opening the owners bucket: %v", err)
	}

	const wedgedOwner = "mediad-wedged-neighbour"
	wedgedSession := benchSessionID(0xf00d)
	if _, err := owners.Claim(t.Context(), directory.OwnerKey("session", wedgedSession), wedgedOwner); err != nil {
		t.Fatalf("claiming for the wedged owner: %v", err)
	}
	token, err := contract.InstanceSubjectToken(wedgedOwner)
	if err != nil {
		t.Fatalf("instance token: %v", err)
	}
	wedged, err := conn.Subscribe(control.SubjectHoldSession+".instance."+token, func(*nats.Msg) {})
	if err != nil {
		t.Fatalf("subscribing as the wedged owner: %v", err)
	}
	defer func() { _ = wedged.Unsubscribe() }()

	local := benchSessionID(0xf00e)
	allocate := validAllocate()
	allocate.SessionID = local
	if _, err := conn.Request(control.SubjectAllocateSession, mustMarshal(t, allocate), 5*time.Second); err != nil {
		t.Fatalf("allocating a local session: %v", err)
	}

	const stalls = 4
	toWedged := mustMarshal(t, map[string]any{
		"orgId": testOrg, "callId": testCall, "sessionId": wedgedSession, "held": true,
	})
	for range stalls {
		inbox := nats.NewInbox()
		if _, err := conn.Subscribe(inbox, func(*nats.Msg) {}); err != nil {
			t.Fatalf("inbox: %v", err)
		}
		if err := conn.PublishRequest(control.SubjectHoldSession, inbox, toWedged); err != nil {
			t.Fatalf("publishing to the wedged owner: %v", err)
		}
	}
	if err := conn.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	toLocal := mustMarshal(t, map[string]any{
		"orgId": testOrg, "callId": testCall, "sessionId": local, "held": true,
	})
	issued := time.Now()
	if _, err := conn.Request(control.SubjectHoldSession, toLocal, 10*time.Second); err != nil {
		t.Fatalf("hold on the local session: %v", err)
	}
	if elapsed := time.Since(issued); elapsed > control.RoutingTimeout {
		t.Fatalf("a locally owned hold took %s behind %d stalled forwards", elapsed, stalls)
	}
}
