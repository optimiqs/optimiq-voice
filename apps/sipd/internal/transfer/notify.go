package transfer

import (
	"context"
	"fmt"
	"strconv"
	"sync/atomic"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// RFC 3515 §2.4.4: a REFER creates an implicit subscription, and progress is reported on it with
// NOTIFYs whose body is a `message/sipfrag` status line. Without them a phone is told 202 and
// nothing else, and holds its transfer indicator until the dialog dies.
const (
	// sipfragContentType is the body type. The `version` parameter is not optional in practice:
	// several handsets discard a sipfrag body that does not carry it.
	sipfragContentType = "message/sipfrag;version=2.0"
	// notifyEvent is the event package. The `id` parameter is appended per notification and equals
	// the CSeq of the REFER that created the subscription.
	notifyEvent = "refer"
)

// SubscriptionState is the `Subscription-State` header of one NOTIFY.
type SubscriptionState struct {
	// State is `active` for progress and `terminated` for the final notification.
	State string
	// Expires is the remaining subscription lifetime, seconds. Only meaningful while active.
	Expires int
	// Reason accompanies `terminated`. `noresource` is the RFC 3515 §2.4.5 value for "the transfer
	// reached a final state, there is nothing further to report".
	Reason string
}

func (s SubscriptionState) String() string {
	value := s.State
	if s.State == "active" && s.Expires > 0 {
		value += ";expires=" + strconv.Itoa(s.Expires)
	}
	if s.Reason != "" {
		value += ";reason=" + s.Reason
	}
	return value
}

// The two states a transfer passes through here: this edge can observe no intermediate progress, so
// there is exactly one `active` notification and one `terminated`.
var (
	// StateActive is sent with the 100 Trying frag. Its expiry comfortably outlives the RPC
	// deadline: a subscription expiring before its final notification looks like an abandoned
	// transfer.
	StateActive = SubscriptionState{State: "active", Expires: 60}
	// StateTerminated is sent with the final frag. `noresource` rather than `timeout` or
	// `deactivated`: what it was watching reached a conclusion.
	StateTerminated = SubscriptionState{State: "terminated", Reason: "noresource"}
)

// The three sipfrag status lines this edge sends, and the only three. 503 covers EVERY refusal the
// engine can return: a handset has one behaviour for a failed transfer, so mapping every refusal
// reason onto its own status would make phones react differently to the same outcome. The reason
// travels in the log.
const (
	FragTrying = "SIP/2.0 100 Trying"
	FragOK     = "SIP/2.0 200 OK"
	FragFailed = "SIP/2.0 503 Service Unavailable"
)

// Dialog is what this edge kept of the REFER so it can address notifications back at the phone. NOT
// a dialog in the RFC 3261 sense: no route set, no CSeq history, and nothing survives a restart.
type Dialog struct {
	// Recipient is the request-URI: the referrer's Contact, or its observed source address when the
	// REFER carried no Contact.
	Recipient sip.Uri
	// Local is this edge's identity in the dialog — the REFER's To address — and the tag it answered
	// the 202 with. They become the NOTIFY's From, because a notification travels the other way.
	Local     sip.Uri
	LocalTag  string
	Remote    sip.Uri
	RemoteTag string
	CallID    string
	// ReferCSeq is the REFER's own sequence number, which becomes `Event: refer;id=<n>`.
	ReferCSeq uint32
	// Transport and Source pin the notification to the socket the REFER arrived on. A phone behind
	// NAT is reachable at the address we OBSERVED and generally at no other.
	Transport string
	Source    string

	// cseq is this side's sequence counter for the notifications.
	cseq atomic.Uint32
}

// NextCSeq returns the sequence number for the next NOTIFY in this subscription. NOTIFYs within one
// subscription must increment (RFC 3261 §12.2.1.1), or the phone treats the second as a retransmit
// of the first and never sees the outcome.
func (d *Dialog) NextCSeq() uint32 { return d.cseq.Add(1) }

// BuildNotify assembles one NOTIFY carrying a sipfrag body. A pure function of its arguments.
//
// It never interpolates a device-supplied string into a header value: the Call-ID is the one echo,
// and it is placed as a TYPED header rather than concatenated, which is the CRLF-injection case.
func BuildNotify(dialog *Dialog, frag string, state SubscriptionState, contact sip.Uri, server string) *sip.Request {
	req := sip.NewRequest(sip.NOTIFY, dialog.Recipient)

	// The notification travels the other way, so the REFER's To becomes our From and its From our
	// To, tags and all. A phone that cannot match the tags drops the NOTIFY silently.
	from := &sip.FromHeader{Address: dialog.Local, Params: sip.NewParams()}
	if dialog.LocalTag != "" {
		from.Params.Add("tag", dialog.LocalTag)
	}
	to := &sip.ToHeader{Address: dialog.Remote, Params: sip.NewParams()}
	if dialog.RemoteTag != "" {
		to.Params.Add("tag", dialog.RemoteTag)
	}
	callID := sip.CallIDHeader(dialog.CallID)
	cseq := &sip.CSeqHeader{SeqNo: dialog.NextCSeq(), MethodName: sip.NOTIFY}

	req.AppendHeader(from)
	req.AppendHeader(to)
	req.AppendHeader(&callID)
	req.AppendHeader(cseq)
	req.AppendHeader(sip.NewHeader("Event", notifyEvent+";id="+strconv.FormatUint(uint64(dialog.ReferCSeq), 10)))
	req.AppendHeader(sip.NewHeader("Subscription-State", state.String()))
	req.AppendHeader(&sip.ContactHeader{Address: contact})
	if server != "" {
		req.AppendHeader(sip.NewHeader("User-Agent", server))
	}
	req.AppendHeader(sip.NewHeader("Content-Type", sipfragContentType))

	// The frag is a status line and RFC 3515 §2.4.5 requires the trailing CRLF; several handsets
	// reject a body without it.
	req.SetBody([]byte(frag + "\r\n"))

	if dialog.Transport != "" {
		req.SetTransport(dialog.Transport)
	}
	if dialog.Source != "" {
		// Destination, not Source: this is where the notification is going.
		req.SetDestination(dialog.Source)
	}
	return req
}

// Notifier sends one NOTIFY. An interface so the handler's reporting path is unit-testable without
// a socket, and so a deployment that cannot send them is a construction choice rather than a branch
// inside the handler.
type Notifier interface {
	Notify(ctx context.Context, req *sip.Request) error
}

// ClientNotifier sends notifications through a sipgo client transaction rather than a bare write,
// so the transaction layer owns the T1 retransmission timer for a NOTIFY lost on UDP. The response
// is drained and discarded: a phone that answers 481 has already forgotten the subscription.
type ClientNotifier struct {
	client *sipgo.Client
}

var _ Notifier = (*ClientNotifier)(nil)

// NewClientNotifier wraps a sipgo client. A nil client is refused here rather than on the first
// transfer.
func NewClientNotifier(client *sipgo.Client) (*ClientNotifier, error) {
	if client == nil {
		return nil, fmt.Errorf("transfer: a SIP client is required to send REFER notifications")
	}
	return &ClientNotifier{client: client}, nil
}

// Notify implements Notifier.
func (n *ClientNotifier) Notify(ctx context.Context, req *sip.Request) error {
	tx, err := n.client.TransactionRequest(ctx, req)
	if err != nil {
		return fmt.Errorf("transfer: sending a NOTIFY: %w", err)
	}
	defer tx.Terminate()

	select {
	case <-tx.Responses():
		return nil
	case <-tx.Done():
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// DiscardNotifier drops every notification. Named rather than a nil check inside the handler so the
// consequence — phones are told 202 and never told the outcome — is a visible construction choice.
type DiscardNotifier struct{}

var _ Notifier = DiscardNotifier{}

// Notify implements Notifier.
func (DiscardNotifier) Notify(context.Context, *sip.Request) error { return nil }
