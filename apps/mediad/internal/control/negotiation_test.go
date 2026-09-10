package control_test

import (
	"strings"
	"sync"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
)

// A retried allocate must answer with the key the session is actually encrypting with. Generating a
// second one and advertising it leaves the far end decrypting with a key nobody is using.
func TestARetriedSecureAllocateReplaysItsAnswer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)
	request := mustJSON(t, allocateWith(savpOffer()))

	first := decodeAllocate(t, r.server.HandleAllocateSession(request))
	second := decodeAllocate(t, r.server.HandleAllocateSession(request))
	if !first.Ok || !second.Ok {
		t.Fatalf("allocate refused: %+v %+v", first, second)
	}
	if *first.SDPAnswer != *second.SDPAnswer {
		t.Fatalf("the retry answered a different body:\n%s\n%s", *first.SDPAnswer, *second.SDPAnswer)
	}
}

// Concurrent duplicates are the same fact arriving twice, and must produce one negotiation.
func TestConcurrentDuplicateAllocatesAgreeOnOneAnswer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)
	request := mustJSON(t, allocateWith(savpOffer()))

	var wg sync.WaitGroup
	answers := make([]string, 8)
	for i := range answers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := decodeAllocate(t, r.server.HandleAllocateSession(request))
			if response.Ok {
				answers[i] = *response.SDPAnswer
			}
		}()
	}
	wg.Wait()
	for i, answer := range answers {
		if answer == "" {
			t.Fatalf("allocate %d was refused", i)
		}
		if answer != answers[0] {
			t.Fatalf("duplicate allocates answered different bodies:\n%s\n%s", answers[0], answer)
		}
	}
}

// A DIFFERENT allocate on the same session is a renegotiation, not a retry: hold arrives this way.
func TestARenegotiatedAllocateCommitsANewAnswer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)
	first := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, allocateWith(savpOffer()))))
	if !first.Ok {
		t.Fatalf("allocate refused: %+v", first)
	}

	held := allocateWith(savpOffer())
	held.Direction = "sendonly"
	second := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, held)))
	if !second.Ok {
		t.Fatalf("the renegotiation was refused: %+v", second)
	}
	if *first.SDPAnswer == *second.SDPAnswer {
		t.Fatal("a renegotiation replayed the previous answer")
	}
	if !strings.Contains(*second.SDPAnswer, "a=sendonly") {
		t.Fatalf("the renegotiated answer did not move the direction:\n%s", *second.SDPAnswer)
	}
}

// The same for the B-leg: a retried create-offer must not replace the local key the callee is in
// the middle of answering.
func TestARetriedCreateOfferReplaysItsOffer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)
	request := mustJSON(t, validCreateOffer())

	first := decodeCreateOffer(t, r.server.HandleCreateOffer(request))
	second := decodeCreateOffer(t, r.server.HandleCreateOffer(request))
	if !first.Ok || !second.Ok {
		t.Fatalf("create-offer refused: %+v %+v", first, second)
	}
	if *first.SDPOffer != *second.SDPOffer {
		t.Fatalf("the retry offered a different body:\n%s\n%s", *first.SDPOffer, *second.SDPOffer)
	}
}
