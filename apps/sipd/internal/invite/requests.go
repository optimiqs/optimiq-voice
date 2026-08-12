package invite

import (
	"context"
	"errors"
	"strconv"
	"strings"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
)

// Requester sends a request this edge originates inside a dialog it owns.
//
// An interface so the handler is testable without a socket, and so the fake in the tests is forced
// to speak sip.Request rather than a summary of one — a builder that is only ever checked against
// its own expectations is a builder that agrees with itself.
type Requester interface {
	Send(ctx context.Context, req *sip.Request) error
}

// ClientRequester is the production Requester: sipgo's client, fire-and-forget past the transaction
// layer.
//
// Fire-and-forget is the right shape for a BYE. Its 200 changes nothing we would act on — the
// dialog is already terminating and its terminal event is already published — and waiting for one
// would hold a goroutine open for 32 seconds against a far end that has, by definition, often
// already gone. The transaction layer still retransmits it, which is the retry that matters.
type ClientRequester struct {
	client *sipgo.Client
}

var _ Requester = (*ClientRequester)(nil)

// NewClientRequester wraps a sipgo client. A nil client is refused here rather than on the first
// BYE, because it is a wiring mistake and not a runtime state.
func NewClientRequester(client *sipgo.Client) (*ClientRequester, error) {
	if client == nil {
		return nil, errors.New("invite: a SIP client is required to send in-dialog requests")
	}
	return &ClientRequester{client: client}, nil
}

// Send implements Requester.
func (r *ClientRequester) Send(ctx context.Context, req *sip.Request) error {
	tx, err := r.client.TransactionRequest(ctx, req)
	if err != nil {
		return err
	}
	// Terminating immediately abandons the response, not the retransmissions: the transaction layer
	// owns those and keeps them until its own timer gives up.
	tx.Terminate()
	return nil
}

// DiscardRequester drops every request. It backs the tests that assert on state rather than on the
// wire, and it is never wired in production — a BYE that goes nowhere is a call that never ends at
// the far end.
type DiscardRequester struct{}

var _ Requester = DiscardRequester{}

// Send implements Requester.
func (DiscardRequester) Send(context.Context, *sip.Request) error { return nil }

// buildInDialog assembles a mid-dialog request for a dialog this edge owns.
//
// # What it has to get right, and what each mistake costs
//
//   - The To and From are OURS and THEIRS respectively, with the tags swapped relative to the
//     incoming INVITE. A UAS sending a BYE puts its own tag in From, and getting that backwards
//     produces a request the far end answers 481 while the call stays up on its side.
//   - The CSeq is the dialog's own local sequence, incremented per request. A repeated CSeq is a
//     retransmission as far as the far end is concerned, and it will be ignored.
//   - The Route set is replayed in order (RFC 3261 §12.2.1.1). Dropping it sends the BYE straight
//     at a far end that is only reachable through a proxy that record-routed itself.
//   - The DESTINATION is the NAT decision, not the Request-URI. The URI stays the remote target the
//     far end asked to be addressed as; the socket we write to is wherever its packets came from.
func buildInDialog(
	method sip.RequestMethod,
	dlg *dialog.Dialog,
	local, remote sip.Uri,
	cseq uint32,
	policy nat.Policy,
	contact sip.Uri,
) *sip.Request {
	decision := policy.TargetFor(dlg.Target.Contact, dlg.Target.Observed)
	target := decision.Target
	if target.Host == "" {
		// The far end gave no usable Contact, which RFC 3261 §8.1.1.8 forbids on an INVITE but which
		// a badly-behaved peer manages anyway. Its own address of record is the only other thing we
		// know about where it lives.
		target = remote
	}

	req := sip.NewRequest(method, target)
	fromParams := sip.NewParams()
	fromParams.Add("tag", dlg.Identity.LocalTag)
	toParams := sip.NewParams()
	toParams.Add("tag", dlg.Identity.RemoteTag)
	req.AppendHeader(&sip.FromHeader{Address: local, Params: fromParams})
	req.AppendHeader(&sip.ToHeader{Address: remote, Params: toParams})
	callID := sip.CallIDHeader(dlg.Identity.SIPCallID)
	req.AppendHeader(&callID)
	req.AppendHeader(&sip.CSeqHeader{SeqNo: cseq, MethodName: method})
	req.AppendHeader(&sip.ContactHeader{Address: contact})
	req.AppendHeader(sip.NewHeader("Max-Forwards", "70"))

	for _, route := range dlg.Target.RouteSet {
		req.AppendHeader(sip.NewHeader("Route", route))
	}
	if transport := dlg.Target.Transport; transport != "" {
		req.SetTransport(strings.ToUpper(transport))
	}
	if decision.Destination != "" {
		// The Contact stays the address and the observed source becomes the destination — the same
		// split `transfer/handler.go` already draws for NOTIFY, generalised (design §9.9).
		req.SetDestination(decision.Destination)
	} else if dlg.Target.Observed != "" {
		req.SetDestination(dlg.Target.Observed)
	}
	return req
}

// buildBye assembles the BYE, with the RFC 3326 Reason header that tells the far end's switch why.
//
// The Reason is not decoration. Without it the far end records "normal clearing" for a call that
// was actually torn down by a session-timer expiry or a media failure, and the two CDRs for one
// call disagree in exactly the way that makes a billing dispute unresolvable.
func buildBye(
	dlg *dialog.Dialog,
	local, remote sip.Uri,
	cseq uint32,
	cause int,
	policy nat.Policy,
	contact sip.Uri,
) *sip.Request {
	req := buildInDialog(sip.BYE, dlg, local, remote, cseq, policy, contact)
	if cause > 0 {
		req.AppendHeader(sip.NewHeader("Reason", dialog.ReasonHeader(cause)))
	}
	return req
}

// buildCancel assembles the CANCEL for an INVITE this edge sent.
//
// RFC 3261 §9.1 is unusually strict about it, and every rule below is one a far end matches on:
// the Request-URI, Call-ID, To, From and CSeq NUMBER are the INVITE's verbatim; the CANCEL carries
// exactly ONE Via, the INVITE's top one, with the SAME branch — that is what makes the two requests
// match at the proxy; the method is the only thing that differs. sipgo has this builder and keeps
// it unexported (`newCancelRequest`, dialog_client.go:599), so it is reproduced here rather than
// approximated: an approximation is a CANCEL the far end answers 481 while the phone keeps ringing.
func buildCancel(invite *sip.Request) *sip.Request {
	cancel := sip.NewRequest(sip.CANCEL, invite.Recipient)
	cancel.SipVersion = invite.SipVersion
	if via := invite.Via(); via != nil {
		cancel.AppendHeader(via.Clone())
	}
	sip.CopyHeaders("Route", invite, cancel)
	maxForwards := sip.MaxForwardsHeader(70)
	cancel.AppendHeader(&maxForwards)
	for _, name := range []string{"From", "To", "Call-ID"} {
		sip.CopyHeaders(name, invite, cancel)
	}
	if cseq := invite.CSeq(); cseq != nil {
		copied := *cseq
		copied.MethodName = sip.CANCEL
		cancel.AppendHeader(&copied)
	}
	cancel.SetTransport(invite.Transport())
	cancel.SetSource(invite.Source())
	cancel.SetDestination(invite.Destination())
	return cancel
}

// buildAck assembles the ACK for a 2xx we received.
//
// It is a separate transaction with the INVITE's CSeq number and the method ACK, and it carries the
// route set of the CONFIRMED dialog rather than the INVITE's — which is why it is built here from
// the dialog rather than from the request.
func buildAck(
	dlg *dialog.Dialog,
	local, remote sip.Uri,
	cseq uint32,
	body []byte,
	policy nat.Policy,
	contact sip.Uri,
) *sip.Request {
	req := buildInDialog(sip.ACK, dlg, local, remote, cseq, policy, contact)
	if len(body) > 0 {
		req.SetBody(body)
		req.AppendHeader(sip.NewHeader("Content-Type", "application/sdp"))
	}
	return req
}

// routeSetOf extracts the Record-Route headers from a message, in the order mid-dialog requests
// must traverse them.
//
// For a UAS the order is the Record-Route order reversed — the first proxy to record-route is the
// one closest to the CALLER, and our requests travel away from us — and getting it backwards routes
// every BYE through the proxies in the wrong order, which most of them simply drop.
func routeSetOf(headers []sip.Header, role dialog.Role) []string {
	routes := make([]string, 0, len(headers))
	for _, header := range headers {
		for _, value := range strings.Split(header.Value(), ",") {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				routes = append(routes, trimmed)
			}
		}
	}
	if role == dialog.RoleUAS {
		for left, right := 0, len(routes)-1; left < right; left, right = left+1, right-1 {
			routes[left], routes[right] = routes[right], routes[left]
		}
	}
	return routes
}

// retryAfterHeader renders a Retry-After value in whole seconds, which is the only form RFC 3261
// §20.33 defines for the simple case.
func retryAfterHeader(seconds int) sip.Header {
	return sip.NewHeader("Retry-After", strconv.Itoa(seconds))
}
