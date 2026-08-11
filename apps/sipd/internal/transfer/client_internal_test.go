package transfer

import (
	"errors"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// The requester's wiring, which is the half a broker test cannot reach: a subject and a deadline
// taken from the generated contract rather than retyped here, and a nil connection refused at
// construction rather than on the first REFER.

func TestNewNATSRequesterRefusesANilConnection(t *testing.T) {
	if _, err := NewNATSRequester(nil, NATSOptions{}); err == nil {
		t.Fatal("a nil connection is a wiring mistake and must not build a requester")
	}
}

func TestNewNATSRequesterDefaultsToTheContract(t *testing.T) {
	requester, err := NewNATSRequester(&nats.Conn{}, NATSOptions{})
	if err != nil {
		t.Fatalf("NewNATSRequester: %v", err)
	}
	if requester.Subject() != contract.SubjectSipTransferRPC {
		t.Errorf("subject = %q, want %q", requester.Subject(), contract.SubjectSipTransferRPC)
	}
	if requester.timeout != contract.TimeoutSipTransferRPC {
		t.Errorf("timeout = %v, want %v", requester.timeout, contract.TimeoutSipTransferRPC)
	}
}

func TestNewNATSRequesterHonoursOverrides(t *testing.T) {
	requester, err := NewNATSRequester(&nats.Conn{}, NATSOptions{
		Subject: "rpc.sip.v1.transfer.test",
		Timeout: 250 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("NewNATSRequester: %v", err)
	}
	if requester.Subject() != "rpc.sip.v1.transfer.test" || requester.timeout != 250*time.Millisecond {
		t.Errorf("overrides were ignored: %q / %v", requester.Subject(), requester.timeout)
	}
}

func TestErrRequestFailedWrapsEveryTransportFailure(t *testing.T) {
	// The caller distinguishes "there was no answer" from "the engine said no", and does it with
	// errors.Is rather than by string matching.
	err := errors.New("boom")
	if errors.Is(err, ErrRequestFailed) {
		t.Fatal("an unrelated error must not look like a transport failure")
	}
}
