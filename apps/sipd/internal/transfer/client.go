package transfer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// ErrRequestFailed wraps every transport-level failure, so a caller can tell "there was no answer"
// from "the engine said no" (a well-formed response with `ok: false`). Both become 503 in the
// sipfrag; the distinction is for the log.
var ErrRequestFailed = errors.New("transfer: the transfer request failed")

// Requester issues `rpc.sip.v1.transfer`. An interface so the handler is testable without a broker.
type Requester interface {
	Transfer(ctx context.Context, request contract.SipTransferRequest) (contract.SipTransferResponse, error)
}

// NATSRequester is the production Requester: raw NATS core request-reply against apps/engine.
//
// The payload is the bare contract type, NOT Nest framing: the responder
// (`apps/engine/src/nats/sip-transfer.service.ts`) subscribes raw, and a `{"pattern":…,"data":…}`
// wrapper is rejected as `bad_request`.
//
// Core NATS rather than JetStream, and uncached: the answer is about one moment in one call's life,
// and a stream's redelivery would move a call minutes after the caller hung up.
type NATSRequester struct {
	conn    *nats.Conn
	subject string
	timeout time.Duration
}

var _ Requester = (*NATSRequester)(nil)

// NATSOptions configures a NATSRequester. Every field has a working default.
type NATSOptions struct {
	// Subject overrides the contract subject. Only tests should set it.
	Subject string
	// Timeout is the per-request deadline. Defaults to the contract's own TimeoutSipTransferRPC.
	Timeout time.Duration
}

// NewNATSRequester builds the requester. A nil connection is refused here rather than on the first
// REFER, because it is a wiring mistake and not a runtime state.
func NewNATSRequester(conn *nats.Conn, opts NATSOptions) (*NATSRequester, error) {
	if conn == nil {
		return nil, errors.New("transfer: a NATS connection is required for the transfer RPC")
	}
	requester := &NATSRequester{conn: conn, subject: opts.Subject, timeout: opts.Timeout}
	if requester.subject == "" {
		requester.subject = contract.SubjectSipTransferRPC
	}
	if requester.timeout <= 0 {
		requester.timeout = contract.TimeoutSipTransferRPC
	}
	return requester, nil
}

// Subject reports the subject this requester publishes on.
func (r *NATSRequester) Subject() string { return r.subject }

// Transfer implements Requester.
func (r *NATSRequester) Transfer(
	ctx context.Context,
	request contract.SipTransferRequest,
) (contract.SipTransferResponse, error) {
	payload, err := json.Marshal(request)
	if err != nil {
		return contract.SipTransferResponse{}, fmt.Errorf("%w: encoding the request: %w", ErrRequestFailed, err)
	}

	// The deadline is the smaller of the contract's and whatever the caller's context has left, so a
	// shutting-down process does not start a fresh two-second wait it cannot honour.
	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	message, err := r.conn.RequestWithContext(ctx, r.subject, payload)
	if err != nil {
		return contract.SipTransferResponse{}, fmt.Errorf("%w: %s: %w", ErrRequestFailed, r.subject, err)
	}

	var reply contract.SipTransferResponse
	if err := json.Unmarshal(message.Data, &reply); err != nil {
		return contract.SipTransferResponse{}, fmt.Errorf("%w: malformed reply on %s: %w",
			ErrRequestFailed, r.subject, err)
	}

	// A reply for a different call is a responder bug; acting on it would tell one phone about
	// another phone's transfer.
	if reply.SIPCallID != "" && reply.SIPCallID != request.SIPCallID {
		return contract.SipTransferResponse{}, fmt.Errorf("%w: asked about call %q, answered about %q",
			ErrRequestFailed, request.SIPCallID, reply.SIPCallID)
	}
	if reply.Reason != nil && !reply.Reason.Valid() {
		return contract.SipTransferResponse{}, fmt.Errorf("%w: unknown refusal reason %q",
			ErrRequestFailed, *reply.Reason)
	}
	return reply, nil
}
