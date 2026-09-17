package dialog

import (
	"sync"
	"testing"

	"github.com/emiago/sipgo/sip"
)

func byeFrom(t *testing.T, callID, fromTag, toTag string) *sip.Request {
	t.Helper()
	return parseRequest(t, `BYE sip:edge@acme.example.com SIP/2.0
Via: SIP/2.0/UDP 203.0.113.7:5060;branch=z9hG4bKbye
From: <sip:1001@acme.example.com>;tag=`+fromTag+`
To: <sip:1002@acme.example.com>;tag=`+toTag+`
Call-ID: `+callID+`
CSeq: 2 BYE
Content-Length: 0

`)
}

// RFC 3261 §12: an established dialog is named by the full triple, so the early index must not be a
// second way in for a request that carries the wrong remote tag.
func TestMatchRequestRefusesAWrongRemoteTagOnAnEstablishedDialog(t *testing.T) {
	store, _ := storeWithDialog(t, RoleUAS, Identity{SIPCallID: "call-9", LocalTag: "ours", RemoteTag: "theirs"})

	if _, ok := store.MatchRequest(byeFrom(t, "call-9", "wrong", "ours")); ok {
		t.Error("a BYE with the wrong remote tag must not match an established dialog")
	}
	if _, ok := store.MatchRequest(byeFrom(t, "call-9", "theirs", "ours")); !ok {
		t.Error("the correct triple must still match")
	}
}

// A UAC dialog has no remote tag until the far end answers, which is the one window the early index
// exists for — and Rebind closes it.
func TestMatchRequestUsesTheEarlyIndexOnlyWhileTheRemoteTagIsUnknown(t *testing.T) {
	store, created := storeWithDialog(t, RoleUAC, Identity{SIPCallID: "call-10", LocalTag: "ours"})

	if _, ok := store.MatchRequest(byeFrom(t, "call-10", "anything", "ours")); !ok {
		t.Fatal("a request for a dialog whose remote tag is unresolved matches early")
	}

	identity := created.Identity
	identity.RemoteTag = "theirs"
	if err := store.Rebind(created.LegID, identity); err != nil {
		t.Fatalf("Rebind: %v", err)
	}
	if _, ok := store.MatchRequest(byeFrom(t, "call-10", "anything", "ours")); ok {
		t.Error("once the remote tag is known the early index must no longer match")
	}
	if _, ok := store.MatchRequest(byeFrom(t, "call-10", "theirs", "ours")); !ok {
		t.Error("the rebound triple must match")
	}
}

// State-dependent lookups read the owner-rendered view, never the *Dialog: the store's mutex and the
// dialog's owning goroutine protect different things, so a read under the wrong one is a data race.
func TestStateDependentLookupsDoNotRaceTheDialogOwner(t *testing.T) {
	store, created := storeWithDialog(t, RoleUAS, Identity{SIPCallID: "call-11", LocalTag: "ours", RemoteTag: "theirs"})
	refer := referTo(t, "call-11", "theirs", "ours")

	var wait sync.WaitGroup
	gate := make(chan struct{})
	wait.Go(func() {
		<-gate
		apply(t, created, Input{Trigger: TriggerLocalTrying})
		store.Touch(created)
	})
	wait.Go(func() {
		<-gate
		for range 1000 {
			store.MatchEstablished(refer)
			_, _ = store.FindReplaced("call-11", "ours", "theirs", false)
		}
	})
	close(gate)
	wait.Wait()
}
