package invite

import (
	"context"
	"errors"
	"net"
	"slices"
	"strconv"
	"strings"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
)

// Requester sends a request this edge originates inside a dialog it owns. An interface so the
// handler is testable without a socket, and so the test fake speaks sip.Request rather than a
// summary of one.
type Requester interface {
	Send(ctx context.Context, req *sip.Request) error
}

// ClientRequester is the production Requester: sipgo's client, fire-and-forget past the transaction
// layer. A BYE's 200 changes nothing we would act on, and waiting for one would hold a goroutine
// open for 32 seconds. The transaction layer still retransmits, which is the retry that matters.
type ClientRequester struct {
	client *sipgo.Client
}

var _ Requester = (*ClientRequester)(nil)

// NewClientRequester wraps a sipgo client. A nil client is a wiring mistake, refused here rather
// than on the first BYE.
func NewClientRequester(client *sipgo.Client) (*ClientRequester, error) {
	if client == nil {
		return nil, errors.New("invite: a SIP client is required to send in-dialog requests")
	}
	return &ClientRequester{client: client}, nil
}

// Send implements Requester.
func (r *ClientRequester) Send(ctx context.Context, req *sip.Request) error {
	if req.IsAck() {
		return r.client.WriteRequest(req)
	}
	tx, err := r.client.TransactionRequest(ctx, req)
	if err != nil {
		return err
	}
	// Keep the transaction alive until its final response or timeout so UDP retransmissions work.
	go func() {
		defer tx.Terminate()
		for {
			select {
			case <-tx.Done():
				return
			case response, ok := <-tx.Responses():
				if !ok || response.StatusCode >= 200 {
					return
				}
			}
		}
	}()
	return nil
}

// SendAndWait is used for BYE so the dialog can release ownership when teardown finishes.
func (r *ClientRequester) SendAndWait(ctx context.Context, req *sip.Request) error {
	_, err := r.client.Do(ctx, req)
	return err
}

// DiscardRequester drops every request. For tests that assert on state rather than on the wire;
// never wired in production, where a BYE that goes nowhere is a call that never ends.
type DiscardRequester struct{}

var _ Requester = DiscardRequester{}

// Send implements Requester.
func (DiscardRequester) Send(context.Context, *sip.Request) error { return nil }

// buildInDialog assembles a mid-dialog request for a dialog this edge owns. Four invariants:
//
//   - From carries our tag and To carries theirs, swapped relative to the incoming INVITE.
//   - The CSeq is the dialog's own local sequence, incremented per request; a repeat reads as a
//     retransmission and is ignored.
//   - The route set is replayed in order (RFC 3261 §12.2.1.1).
//   - The destination is the NAT decision, not the Request-URI: the URI stays the remote target the
//     far end asked to be addressed as, and the socket is wherever its packets came from.
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
		// No usable Contact, which RFC 3261 §8.1.1.8 forbids but a badly-behaved peer manages. Its
		// address of record is the only other thing we know about where it lives.
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

	routes := make([]sip.Uri, 0, len(dlg.Target.RouteSet))
	for _, route := range dlg.Target.RouteSet {
		var address sip.Uri
		if _, err := sip.ParseAddressValue(route, &address, nil); err == nil {
			routes = append(routes, address)
		}
	}
	if transport := dlg.Target.Transport; transport != "" {
		req.SetTransport(strings.ToUpper(transport))
	}
	if len(routes) > 0 {
		first := routes[0]
		_, loose := first.UriParams.Get("lr")
		if !loose {
			// RFC 3261 §12.2.1.1: a strict router becomes the Request-URI;
			// the remote target moves to the end of the remaining route set.
			req.Recipient = first
			req.Recipient.Headers = nil
			routes = append(routes[1:], target)
			if transport, ok := first.UriParams.Get("transport"); ok {
				req.SetTransport(strings.ToUpper(transport))
			}
			if first.IsEncrypted() {
				req.SetTransport("TLS")
			}
			port := first.Port
			if port == 0 {
				port = int(sip.DefaultPort(req.Transport()))
			}
			// sipgo normally sends to the first Route header, which is the SECOND
			// proxy after strict-route rewriting. Pin the actual first hop here.
			req.SetDestination(net.JoinHostPort(strings.Trim(first.Host, "[]"), strconv.Itoa(port)))
		}
		for _, address := range routes {
			req.AppendHeader(&sip.RouteHeader{Address: address})
		}
		return req
	}
	if decision.Destination != "" {
		// The Contact stays the address and the observed source becomes the destination.
		req.SetDestination(decision.Destination)
	}
	return req
}

// buildBye assembles the BYE, with the RFC 3326 Reason header that tells the far end's switch why.
// Without it the far end records "normal clearing" for a session-timer expiry or a media failure,
// and the two CDRs for one call disagree.
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

// buildCancel assembles the CANCEL for an INVITE this edge sent, per RFC 3261 §9.1: the
// Request-URI, Call-ID, To, From and CSeq number are the INVITE's verbatim, and the CANCEL carries
// exactly one Via — the INVITE's top one, same branch — so the two match at the proxy. Only the
// method differs. Reproduced here because sipgo keeps its own builder unexported.
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

// buildAck assembles the ACK for a 2xx we received: a separate transaction with the INVITE's CSeq
// number, carrying the confirmed dialog's route set rather than the INVITE's — which is why it is
// built from the dialog rather than from the request.
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
// RFC 3261 §12.1: UAS preserves request order; UAC reverses response order.
func routeSetOf(headers []sip.Header, role dialog.Role) []string {
	routes := make([]string, 0, len(headers))
	for _, header := range headers {
		for value := range strings.SplitSeq(header.Value(), ",") {
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				routes = append(routes, trimmed)
			}
		}
	}
	if role == dialog.RoleUAC {
		slices.Reverse(routes)
	}
	return routes
}

// retryAfterHeader renders a Retry-After value in whole seconds, which is the only form RFC 3261
// §20.33 defines for the simple case.
func retryAfterHeader(seconds int) sip.Header {
	return sip.NewHeader("Retry-After", strconv.Itoa(seconds))
}
