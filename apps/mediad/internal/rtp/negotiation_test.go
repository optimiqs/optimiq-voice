package rtp_test

import (
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

func negotiateAllocate(
	t *testing.T,
	manager *rtp.Manager,
	sessionID, request string,
	body string,
	secure *rtp.SRTPContext,
) (rtp.Negotiation, bool) {
	t.Helper()
	replayed := false
	negotiation, err := manager.Negotiate(sessionID, request,
		func(_ rtp.Negotiation, replay bool) (*rtp.Negotiation, *rtp.SRTPContext, error) {
			if _, err := manager.Allocate(rtp.AllocateOptions{
				SessionID: sessionID,
				OrgID:     testOrg,
				CallID:    testCall,
				SRTP:      secure,
			}); err != nil {
				return nil, nil, err
			}
			if replay {
				replayed = true
				return nil, nil, nil
			}
			return &rtp.Negotiation{SDP: body}, secure, nil
		})
	if err != nil {
		t.Fatalf("Negotiate: %v", err)
	}
	return negotiation, replayed
}

func TestNegotiateReplaysAnIdenticalRequest(t *testing.T) {
	manager := newManager(t, 41000, 41020, time.Minute, nil)

	first, replayed := negotiateAllocate(t, manager, "s-1", "req-a", "answer-one", nil)
	if replayed || first.Generation != 1 || first.SDP != "answer-one" {
		t.Fatalf("first negotiation: %+v replayed=%v", first, replayed)
	}

	second, replayed := negotiateAllocate(t, manager, "s-1", "req-a", "answer-two", nil)
	if !replayed {
		t.Fatal("an identical request was negotiated again instead of replayed")
	}
	if second.Generation != 1 || second.SDP != "answer-one" {
		t.Fatalf("the replay did not return the committed result: %+v", second)
	}
}

func TestNegotiateCommitsANewGenerationForANewRequest(t *testing.T) {
	manager := newManager(t, 41020, 41040, time.Minute, nil)

	negotiateAllocate(t, manager, "s-2", "req-a", "answer-one", nil)
	second, replayed := negotiateAllocate(t, manager, "s-2", "req-b", "answer-two", nil)
	if replayed {
		t.Fatal("a different request was treated as a retry")
	}
	if second.Generation != 2 || second.SDP != "answer-two" {
		t.Fatalf("the renegotiation did not commit: %+v", second)
	}
}

// The crypto context and the SDP that advertises it are committed together, so a session keyed by a
// renegotiation encrypts with the key its newest body names.
func TestNegotiateInstallsTheContextItCommits(t *testing.T) {
	manager := newManager(t, 41040, 41060, time.Minute, nil)

	secure, err := rtp.NewSRTPContext(rtp.SRTPKeys{
		LocalKeyMaterial:  srtpMaterial(1),
		RemoteKeyMaterial: srtpMaterial(2),
	})
	if err != nil {
		t.Fatalf("NewSRTPContext: %v", err)
	}
	negotiation, _ := negotiateAllocate(t, manager, "s-3", "req-a", "answer-one", secure)
	if negotiation.Generation != 1 {
		t.Fatalf("negotiation: %+v", negotiation)
	}

	rekeyed, err := rtp.NewSRTPContext(rtp.SRTPKeys{
		LocalKeyMaterial:  srtpMaterial(3),
		RemoteKeyMaterial: srtpMaterial(4),
	})
	if err != nil {
		t.Fatalf("NewSRTPContext: %v", err)
	}
	if _, replayed := negotiateAllocate(t, manager, "s-3", "req-b", "answer-two", rekeyed); replayed {
		t.Fatal("a rekey was treated as a retry")
	}
	if !manager.Release("s-3") {
		t.Fatal("the session was not live")
	}
}

// A released session's negotiation goes with it: the id must not inherit a retired key.
func TestNegotiationIsForgottenWithItsSession(t *testing.T) {
	manager := newManager(t, 41060, 41080, time.Minute, nil)

	negotiateAllocate(t, manager, "s-4", "req-a", "answer-one", nil)
	if !manager.Release("s-4") {
		t.Fatal("the session was not live")
	}
	again, replayed := negotiateAllocate(t, manager, "s-4", "req-a", "answer-two", nil)
	if replayed {
		t.Fatal("a reused session id replayed the previous call's negotiation")
	}
	if again.Generation != 1 || again.SDP != "answer-two" {
		t.Fatalf("the fresh negotiation did not start over: %+v", again)
	}
}

// A pending offer is settled against the generation that made it.
func TestPendingNegotiationSettlesOnItsOwnGeneration(t *testing.T) {
	manager := newManager(t, 41080, 41100, time.Minute, nil)

	offered, _ := manager.Negotiate("s-5", "offer", func(
		_ rtp.Negotiation, _ bool,
	) (*rtp.Negotiation, *rtp.SRTPContext, error) {
		if _, err := manager.Allocate(rtp.AllocateOptions{
			SessionID: "s-5", OrgID: testOrg, CallID: testCall,
		}); err != nil {
			return nil, nil, err
		}
		return &rtp.Negotiation{
			SDP:     "offer-body",
			Local:   sdp.Crypto{Tag: 1, KeyMaterial: make([]byte, sdp.SRTPKeyMaterial)},
			Pending: true,
		}, nil, nil
	})
	if !offered.Pending || offered.Generation != 1 {
		t.Fatalf("the offer did not commit as pending: %+v", offered)
	}

	settled, err := manager.Negotiate("s-5", "", func(
		prior rtp.Negotiation, _ bool,
	) (*rtp.Negotiation, *rtp.SRTPContext, error) {
		if !prior.Pending {
			return nil, nil, nil
		}
		done := prior
		done.Pending = false
		return &done, nil, nil
	})
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	if settled.Pending || settled.Generation != 2 || settled.Request != "offer" {
		t.Fatalf("the settle did not carry the offer's identity forward: %+v", settled)
	}
	if !manager.Release("s-5") {
		t.Fatal("the session was not live")
	}
}
