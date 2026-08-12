package dialog

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/emiago/sipgo/sip"
)

func parseRequest(t *testing.T, wire string) *sip.Request {
	t.Helper()
	parser := sip.NewParser()
	message, err := parser.ParseSIP([]byte(strings.ReplaceAll(wire, "\n", "\r\n")))
	if err != nil {
		t.Fatalf("parsing the request: %v", err)
	}
	req, ok := message.(*sip.Request)
	if !ok {
		t.Fatalf("parsed a %T, want a request", message)
	}
	return req
}

func storeWithDialog(t *testing.T, role Role, identity Identity) (*Store, *Dialog) {
	t.Helper()
	store := NewStore(StoreOptions{
		InstanceID: "sipd-test",
		Lease:      90 * time.Second,
		Now:        func() time.Time { return testClock },
	})
	created, err := New(Options{
		LegID:    "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50",
		OrgID:    "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
		Role:     role,
		Identity: identity,
		Target:   Target{Observed: "203.0.113.7:5060", Transport: "udp"},
		Now:      func() time.Time { return testClock },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := store.Insert(created); err != nil {
		t.Fatalf("Insert: %v", err)
	}
	return store, created
}

// A mid-dialog request arriving here addresses US in To and ITSELF in From, whichever role we are.
// One parser therefore serves both, and this is the assertion that keeps it honest.
func TestMatchRequestUsesTheIncomingOrientation(t *testing.T) {
	identity := Identity{SIPCallID: "call-1", LocalTag: "ours", RemoteTag: "theirs"}
	store, created := storeWithDialog(t, RoleUAS, identity)

	bye := parseRequest(t, `BYE sip:edge@acme.example.com SIP/2.0
Via: SIP/2.0/UDP 203.0.113.7:5060;branch=z9hG4bK1
From: <sip:1001@acme.example.com>;tag=theirs
To: <sip:1002@acme.example.com>;tag=ours
Call-ID: call-1
CSeq: 2 BYE
Content-Length: 0

`)
	got, found := store.MatchRequest(bye)
	if !found || got.LegID != created.LegID {
		t.Fatalf("MatchRequest found=%v, want the dialog we inserted", found)
	}

	// The same Call-ID with the tags the other way round is a DIFFERENT dialog, and matching it
	// would let a stranger who echoed our own tags reach somebody else's call.
	swapped := parseRequest(t, `BYE sip:edge@acme.example.com SIP/2.0
Via: SIP/2.0/UDP 203.0.113.7:5060;branch=z9hG4bK1
From: <sip:1001@acme.example.com>;tag=ours
To: <sip:1002@acme.example.com>;tag=theirs
Call-ID: call-1
CSeq: 2 BYE
Content-Length: 0

`)
	if _, found := store.MatchRequest(swapped); found {
		t.Error("a request whose tags are reversed must not match")
	}
}

// A UAC dialog is incomplete until the far end answers with a tag. Without Rebind, every BYE on
// every outbound call would be answered 481.
func TestRebindIndexesADialogOnceTheRemoteTagIsKnown(t *testing.T) {
	identity := Identity{SIPCallID: "call-2", LocalTag: "ours"}
	store, created := storeWithDialog(t, RoleUAC, identity)

	response := parseRequest(t, `BYE sip:edge@acme.example.com SIP/2.0
Via: SIP/2.0/UDP 203.0.113.9:5060;branch=z9hG4bK2
From: <sip:1002@acme.example.com>;tag=learned
To: <sip:1001@acme.example.com>;tag=ours
Call-ID: call-2
CSeq: 5 BYE
Content-Length: 0

`)
	// Before the tag is known, the early index still finds it — which is what lets a CANCEL and a
	// Timer B reach the dialog in the window before any response.
	if _, found := store.MatchRequest(response); !found {
		t.Fatal("the early index must find a dialog whose remote tag is not yet known")
	}

	learned := Identity{SIPCallID: "call-2", LocalTag: "ours", RemoteTag: "learned"}
	if err := store.Rebind(created.LegID, learned); err != nil {
		t.Fatalf("Rebind: %v", err)
	}
	got, found := store.MatchRequest(response)
	if !found || got.LegID != created.LegID {
		t.Fatal("the full index must find the dialog after a rebind")
	}
	if err := store.Rebind("no-such-leg", learned); !errors.Is(err, ErrUnknownDialog) {
		t.Errorf("Rebind of an unknown leg = %v, want ErrUnknownDialog", err)
	}
}

// RFC 3891 §3: the Replaces tags are written from the SENDER's point of view, so `to-tag` is our
// local tag and `from-tag` is the remote one. Getting it backwards is a transfer that never
// completes.
func TestFindReplaced(t *testing.T) {
	identity := Identity{SIPCallID: "consult-1", LocalTag: "ours", RemoteTag: "theirs"}
	store, created := storeWithDialog(t, RoleUAS, identity)

	found, err := store.FindReplaced("consult-1", "ours", "theirs", false)
	if err != nil || found.LegID != created.LegID {
		t.Fatalf("FindReplaced = %v / %v, want the dialog", found, err)
	}

	if _, err := store.FindReplaced("consult-1", "theirs", "ours", false); !errors.Is(err, ErrUnknownDialog) {
		t.Error("reversed tags must not resolve")
	}
	if _, err := store.FindReplaced("other-call", "ours", "theirs", false); !errors.Is(err, ErrUnknownDialog) {
		t.Error("a different Call-ID must not resolve")
	}
	if _, err := store.FindReplaced("consult-1", "ours", "", false); !errors.Is(err, ErrUnknownDialog) {
		t.Error("an incomplete triple names no dialog")
	}

	// early-only against an answered dialog is refused rather than ignored: it exists so a transfer
	// target can decline to cut into a call somebody else has already picked up.
	apply(t, created, Input{Trigger: TriggerLocalAnswer})
	if _, err := store.FindReplaced("consult-1", "ours", "theirs", true); !errors.Is(err, ErrInvalidState) {
		t.Errorf("early-only against a confirmed dialog = %v, want ErrInvalidState", err)
	}
	if _, err := store.FindReplaced("consult-1", "ours", "theirs", false); err != nil {
		t.Errorf("without early-only an answered dialog is still replaceable: %v", err)
	}

	// And a dialog that has ended is gone rather than merely unknown, which is the distinction the
	// caller turns into 481 versus a retry.
	apply(t, created, Input{Trigger: TriggerRemoteBye})
	if _, err := store.FindReplaced("consult-1", "ours", "theirs", false); !errors.Is(err, ErrDialogGone) {
		t.Errorf("a terminated dialog = %v, want ErrDialogGone", err)
	}
}

func TestInsertRefusesADuplicateLeg(t *testing.T) {
	identity := Identity{SIPCallID: "call-3", LocalTag: "ours", RemoteTag: "theirs"}
	store, created := storeWithDialog(t, RoleUAS, identity)
	if err := store.Insert(created); !errors.Is(err, ErrDuplicateLeg) {
		t.Errorf("a second Insert = %v, want ErrDuplicateLeg", err)
	}
	if store.Len() != 1 {
		t.Errorf("Len = %d, want 1", store.Len())
	}
	store.Remove(created.LegID)
	if store.Len() != 0 {
		t.Errorf("Len after Remove = %d, want 0", store.Len())
	}
	// Removing twice is not an error: teardown paths race and both may reach it.
	store.Remove(created.LegID)
}

func TestClaimCarriesTheRecordTheDesignSpecifies(t *testing.T) {
	identity := Identity{SIPCallID: "a84b4c76e66710@pc33", LocalTag: "ours", RemoteTag: "theirs"}
	store, created := storeWithDialog(t, RoleUAS, identity)
	created.TrunkID = "018f-trunk"
	created.Profile = "external"

	claim := store.ClaimFor(created)
	switch {
	case claim.LegID != created.LegID:
		t.Error("the claim must be keyed by the leg id")
	case claim.InstanceID != "sipd-test":
		t.Errorf("instanceId = %q", claim.InstanceID)
	case claim.Role != "uas":
		t.Errorf("role = %q, want uas", claim.Role)
	case claim.SIPCallID != identity.SIPCallID:
		t.Error("the SIP Call-ID travels in the value, never in the key")
	case claim.State != "init":
		t.Errorf("state = %q", claim.State)
	case claim.RemoteAddress != "203.0.113.7:5060":
		t.Errorf("remoteAddress = %q", claim.RemoteAddress)
	case claim.TrunkID != "018f-trunk" || claim.Profile != "external":
		t.Error("the trunk and profile must travel on the claim")
	case claim.ExpiresAt != testClock.Add(90*time.Second).UnixMilli():
		t.Errorf("expiresAt = %d, want the lease from now", claim.ExpiresAt)
	}
	if claim.Expired(testClock) {
		t.Error("a fresh claim must not be expired")
	}
	if !claim.Expired(testClock.Add(91 * time.Second)) {
		t.Error("a claim past its lease must be expired")
	}
}

// The reaper only takes ANOTHER instance's expired claims. Reaping our own would turn a slow broker
// into dropped calls.
func TestOrphansIgnoresOurOwnAndLiveClaims(t *testing.T) {
	now := testClock
	claims := []Claim{
		{LegID: "b", InstanceID: "sipd-other", ExpiresAt: now.Add(-time.Second).UnixMilli()},
		{LegID: "a", InstanceID: "sipd-other", ExpiresAt: now.Add(-time.Minute).UnixMilli()},
		{LegID: "c", InstanceID: "sipd-other", ExpiresAt: now.Add(time.Minute).UnixMilli()},
		{LegID: "d", InstanceID: "sipd-ours", ExpiresAt: now.Add(-time.Hour).UnixMilli()},
	}
	orphans := Orphans(claims, "sipd-ours", now)
	if len(orphans) != 2 {
		t.Fatalf("orphans = %d, want 2", len(orphans))
	}
	if orphans[0].LegID != "a" || orphans[1].LegID != "b" {
		t.Errorf("orphans must be sorted by leg id, got %s and %s", orphans[0].LegID, orphans[1].LegID)
	}
}

func TestMemoryClaimStoreRoundTrips(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryClaimStore()

	if err := store.Put(ctx, Claim{LegID: "b", InstanceID: "x"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.Put(ctx, Claim{LegID: "a", InstanceID: "x"}); err != nil {
		t.Fatalf("Put: %v", err)
	}
	claims, err := store.All(ctx)
	if err != nil || len(claims) != 2 || claims[0].LegID != "a" {
		t.Fatalf("All = %v / %v, want two claims in leg-id order", claims, err)
	}
	if err := store.Delete(ctx, "a"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	// Deleting an absent claim is not an error: teardown is idempotent.
	if err := store.Delete(ctx, "a"); err != nil {
		t.Fatalf("a second Delete: %v", err)
	}
	claims, _ = store.All(ctx)
	if len(claims) != 1 {
		t.Errorf("All after Delete = %d claims, want 1", len(claims))
	}
}

func TestClaimsAreOrderedAndComplete(t *testing.T) {
	store := NewStore(StoreOptions{InstanceID: "sipd-test", Now: func() time.Time { return testClock }})
	for _, leg := range []string{"leg-c", "leg-a", "leg-b"} {
		created, err := New(Options{
			LegID:    leg,
			Identity: Identity{SIPCallID: leg + "-call", LocalTag: "l", RemoteTag: "r"},
			Now:      func() time.Time { return testClock },
		})
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		if err := store.Insert(created); err != nil {
			t.Fatalf("Insert: %v", err)
		}
	}
	claims := store.Claims()
	if len(claims) != 3 || claims[0].LegID != "leg-a" || claims[2].LegID != "leg-c" {
		t.Fatalf("Claims = %v, want three in leg-id order", claims)
	}
	ids := store.LegIDs()
	if len(ids) != 3 || ids[0] != "leg-a" {
		t.Errorf("LegIDs = %v, want sorted", ids)
	}
}

func TestIdentityKeysAreInjectionProof(t *testing.T) {
	// A Call-ID may legally contain a semicolon or a colon, so the key separator must be something
	// it cannot contain — otherwise two different dialogs can be made to share an index entry.
	left := Identity{SIPCallID: "a;b", LocalTag: "c", RemoteTag: "d"}
	right := Identity{SIPCallID: "a", LocalTag: "b;c", RemoteTag: "d"}
	if left.Key() == right.Key() {
		t.Error("two distinct dialogs must not collide in the index")
	}
	if !left.Established() {
		t.Error("a full triple is established")
	}
	if (Identity{SIPCallID: "a", LocalTag: "b"}).Established() {
		t.Error("a triple with no remote tag is not established")
	}
}
