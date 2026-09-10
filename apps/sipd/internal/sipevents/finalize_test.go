package sipevents

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

type fakeClaims struct {
	mu      sync.Mutex
	deleted []string
	err     error
}

func (f *fakeClaims) Delete(_ context.Context, legID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.deleted = append(f.deleted, legID)
	return nil
}

func (f *fakeClaims) legs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.deleted...)
}

// refusingPublisher fails the first `fail` acknowledgements and records every attempt, which is how
// a retry can be told from a first attempt.
type refusingPublisher struct {
	RecordingPublisher
	mu       sync.Mutex
	fail     int
	attempts []string
}

func (p *refusingPublisher) TerminatedAck(
	ctx context.Context,
	envelope contract.Envelope[contract.SIPDialogTerminatedData],
) error {
	p.mu.Lock()
	p.attempts = append(p.attempts, envelope.ID)
	refuse := p.fail > 0
	if refuse {
		p.fail--
	}
	p.mu.Unlock()
	if refuse {
		return errors.New("the stream did not acknowledge it")
	}
	return p.Terminated(ctx, envelope)
}

func (p *refusingPublisher) ids() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.attempts...)
}

func terminationEnvelope(t *testing.T, legID string) contract.Envelope[contract.SIPDialogTerminatedData] {
	t.Helper()
	envelope, err := contract.NewSIPDialogTerminatedEnvelope(
		contract.EnvelopeInput[contract.SIPDialogTerminatedData]{
			ID:     contract.DerivedEventID("terminated", legID),
			OrgID:  "018f0000-0000-7000-8000-000000000000",
			Source: "sipd",
			At:     time.Now(),
			Data: contract.SIPDialogTerminatedData{
				LegID:     legID,
				CallID:    "call-" + legID,
				Role:      contract.SIPDialogTerminatedRoleUas,
				Identity:  contract.SIPDialogTerminatedIdentity{SIPCallID: legID + "@pc33"},
				Reason:    contract.SIPDialogTerminatedReasonBye,
				Cause:     16,
				Initiator: contract.SIPDialogTerminatedInitiatorRemote,
			},
		})
	if err != nil {
		t.Fatalf("building the envelope: %v", err)
	}
	return envelope
}

func newTestFinalizer(t *testing.T, publisher Publisher, claims ClaimReleaser) *Finalizer {
	t.Helper()
	finalizer, err := NewFinalizer(FinalizerOptions{
		Publisher: publisher,
		Claims:    claims,
		Timeout:   time.Second,
		Attempts:  3,
		Backoff:   time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewFinalizer: %v", err)
	}
	return finalizer
}

func drain(t *testing.T, finalizer *Finalizer) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !finalizer.Shutdown(ctx) {
		t.Fatalf("the finalizer did not drain; %d pending", finalizer.Pending())
	}
}

// The claim is recovery evidence and outlives the leg: it is deleted once the termination has been
// acknowledged, and not before.
func TestAClaimIsReleasedOnlyAfterTheTerminationIsAcknowledged(t *testing.T) {
	claims := &fakeClaims{}
	publisher := &refusingPublisher{fail: 2}
	finalizer := newTestFinalizer(t, publisher, claims)

	if err := finalizer.Terminated(terminationEnvelope(t, "leg-1")); err != nil {
		t.Fatalf("Terminated: %v", err)
	}
	// Forgetting the leg must not take the claim with it while the publish is still in flight.
	if err := finalizer.Release(context.Background(), "leg-1"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	drain(t, finalizer)

	attempts := publisher.ids()
	if len(attempts) != 3 {
		t.Fatalf("published %d times, want two refusals and one acknowledgement", len(attempts))
	}
	for _, id := range attempts {
		if id != attempts[0] {
			t.Fatalf("a retry changed the event id: %v", attempts)
		}
	}
	if legs := claims.legs(); len(legs) != 1 || legs[0] != "leg-1" {
		t.Errorf("deleted claims = %v, want leg-1 exactly once", legs)
	}
}

// A termination that never gets an acknowledgement leaves the claim behind, so another instance's
// reaper still finds the leg.
func TestAnUnacknowledgedTerminationKeepsTheClaim(t *testing.T) {
	claims := &fakeClaims{}
	publisher := &refusingPublisher{fail: 99}
	finalizer := newTestFinalizer(t, publisher, claims)

	if err := finalizer.Terminated(terminationEnvelope(t, "leg-2")); err != nil {
		t.Fatalf("Terminated: %v", err)
	}
	drain(t, finalizer)

	if legs := claims.legs(); len(legs) != 0 {
		t.Errorf("deleted %v for a termination the stream never took", legs)
	}
}

// A leg forgotten without a termination — an originate that never became a dialog — releases its
// claim immediately: there is nothing to wait for.
func TestReleaseWithoutATerminationDeletesTheClaim(t *testing.T) {
	claims := &fakeClaims{}
	finalizer := newTestFinalizer(t, NewRecordingPublisher(), claims)

	if err := finalizer.Release(context.Background(), "leg-3"); err != nil {
		t.Fatalf("Release: %v", err)
	}
	if legs := claims.legs(); len(legs) != 1 || legs[0] != "leg-3" {
		t.Errorf("deleted claims = %v, want leg-3", legs)
	}
	drain(t, finalizer)
}

// A claim delete that fails is retried with the publish, because the pair is one unit of work.
func TestAFailedClaimDeleteIsRetried(t *testing.T) {
	claims := &fakeClaims{err: errors.New("bucket unavailable")}
	publisher := &refusingPublisher{}
	finalizer := newTestFinalizer(t, publisher, claims)

	if err := finalizer.Terminated(terminationEnvelope(t, "leg-4")); err != nil {
		t.Fatalf("Terminated: %v", err)
	}
	drain(t, finalizer)

	if attempts := publisher.ids(); len(attempts) != 3 {
		t.Errorf("published %d times, want one per delete attempt", len(attempts))
	}
}
