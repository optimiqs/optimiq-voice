package transfer

import (
	"context"
	"fmt"
	"strconv"
	"sync/atomic"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// RFC 3515 §2.4.4: a REFER creates an implicit subscription, and the referee reports progress on it
// with NOTIFY messages whose body is a `message/sipfrag` status line. This is the half that makes a
// transfer key on a handset light up, go out, or turn red — without it a phone has been told 202
// ("I will try") and never told anything else, so it holds the transfer indicator until the dialog
// dies.
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

// The two states a transfer passes through here. A blind transfer has no intermediate progress this
// edge can observe — the engine either moved the call or did not — so there is exactly one `active`
// notification (100 Trying, sent immediately after the 202) and one `terminated`.
var (
	// StateActive is sent with the 100 Trying frag. 60 seconds because the RPC deadline is two, and
	// a subscription that expires before its own final notification would make a correct transfer
	// look abandoned.
	StateActive = SubscriptionState{State: "active", Expires: 60}
	// StateTerminated is sent with the final frag. `noresource` rather than `timeout` or `deactivated`:
	// the subscription ended because the thing it was watching reached a conclusion.
	StateTerminated = SubscriptionState{State: "terminated", Reason: "noresource"}
)

// The three sipfrag status lines this edge sends, and the only three.
//
// 503 covers EVERY refusal the engine can return. That is deliberate: the codes in
// `SIP_TRANSFER_REFUSAL_REASONS` exist so a log and an operator can tell an ended call from a
// forbidden one, but a handset has exactly one behaviour for a failed transfer, and mapping eleven
// reasons onto eleven statuses would produce phones that react differently to the same user-visible
// outcome. The reason travels in the log; the phone gets one honest failure.
const (
	FragTrying = "SIP/2.0 100 Trying"
	FragOK     = "SIP/2.0 200 OK"
	FragFailed = "SIP/2.0 503 Service Unavailable"
)

// Dialog is what this edge kept of the REFER so it can address notifications back at the phone.
//
// It is NOT a dialog in the RFC 3261 sense and does not pretend to be: there is no route set, no
// local CSeq history before this REFER, and nothing here survives a restart. It is the minimum
// needed to put a NOTIFY on the wire that the phone will accept as belonging to the subscription it
// just created.
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

// BuildNotify assembles one NOTIFY carrying a sipfrag body.
//
// A pure function of the dialog and the two strings, so every header this edge puts on the wire is
// asserted in a unit test rather than observed on a capture. Note what it does NOT do: it never
// interpolates a device-supplied string into a header value it has not round-tripped through a
// parser — the Call-ID is the one echo, and it is placed as a typed header rather than concatenated,
// which is the CRLF-injection case sipgo's SECURITY note is about.
func BuildNotify(dialog *Dialog, frag string, state SubscriptionState, contact sip.Uri, server string) *sip.Request {
	req := sip.NewRequest(sip.NOTIFY, dialog.Recipient)

	// The notification travels from us to the phone, so the REFER's To becomes our From and its
	// From becomes our To — tags and all. A phone that cannot match the tags drops the NOTIFY, and
	// the symptom is a transfer that works while the handset says it failed.
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
// a socket, and so a deployment that cannot send them at all (see ClientNotifier) is a construction
// choice rather than a branch inside the handler.
type Notifier interface {
	Notify(ctx context.Context, req *sip.Request) error
}

// ClientNotifier sends notifications through a sipgo client transaction.
//
// A transaction rather than a bare write, because NOTIFY is a non-INVITE request: the transaction
// layer owns the T1 retransmission timer, and a notification lost on UDP is exactly the case that
// leaves a handset waiting. The response is drained and discarded — a phone that answers 481 has
// already forgotten the subscription, which changes nothing this edge can do about it.
type ClientNotifier struct {
	client *sipgo.Client
}

var _ Notifier = (*ClientNotifier)(nil)

// NewClientNotifier wraps a sipgo client. A nil client is a programming error rather than a runtime
// state, so it is refused here instead of on the first transfer.
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

// DiscardNotifier drops every notification.
//
// It is what a deployment with no SIP client wired gets, and what the unit tests that are not about
// notification use. Named rather than a nil check inside the handler so the consequence — phones are
// told 202 and never told the outcome — is a visible construction choice.
type DiscardNotifier struct{}

var _ Notifier = DiscardNotifier{}

// Notify implements Notifier.
func (DiscardNotifier) Notify(context.Context, *sip.Request) error { return nil }
