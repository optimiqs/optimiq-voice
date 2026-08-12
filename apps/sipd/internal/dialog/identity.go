package dialog

import (
	"errors"
	"strings"

	"github.com/emiago/sipgo/sip"
)

// ErrNoIdentity means a message carried no usable dialog triple: no Call-ID, or no tag on the side
// that must have one. It is a 400, not a 481 — the request is malformed rather than orphaned.
var ErrNoIdentity = errors.New("dialog: the message carries no usable dialog identifier")

// Identity is the RFC 3261 §12 dialog triple, from THIS process's point of view.
//
// Local and Remote rather than To and From, because which header a tag lives in depends on who sent
// the message and the whole point of a dialog identifier is that it does not. For a UAS the local
// tag is the one we minted for the To header of our first response; for a UAC it is the one we put
// in the From of the INVITE. In both roles, a mid-dialog request ARRIVING here addresses us in To
// and itself in From, which is why one parser serves both roles (identityOfIncoming).
//
// It is never a key. `legId` is the key — one string names the leg, the mediad session and this
// dialog (design §3.1) — and this triple is the INDEX that turns a Call-ID off the wire into that
// key. Keeping the two apart is what stops a phone-chosen string becoming a NATS subject token.
type Identity struct {
	// SIPCallID is the Call-ID verbatim. Phone-chosen, arbitrary length, and full of characters no
	// subject or KV key token accepts — which is the argument in design §3.1 for not keying on it.
	SIPCallID string
	// LocalTag is our tag. Absent only on a UAS dialog before its first response, which cannot
	// happen here because ReadInvite mints the tag up front.
	LocalTag string
	// RemoteTag is the far end's tag. Empty on a UAC dialog until the first response with a tag
	// arrives, which is exactly the window in which an early dialog does not yet exist.
	RemoteTag string
}

// Key renders the triple as one comparable string for the dialog index.
//
// The separator is a NUL byte and not a semicolon or a colon, because a Call-ID is device-chosen
// and may legally contain both. A separator a caller can inject is a way to make two different
// dialogs share an index entry, and the cheapest fix is a byte that cannot appear in a SIP token.
func (i Identity) Key() string {
	return i.SIPCallID + "\x00" + i.LocalTag + "\x00" + i.RemoteTag
}

// Established reports whether both tags are known — that is, whether this triple names a dialog at
// all rather than a request that may yet become one.
func (i Identity) Established() bool {
	return i.SIPCallID != "" && i.LocalTag != "" && i.RemoteTag != ""
}

// EarlyKey renders the triple WITHOUT the remote tag.
//
// It is what a UAC dialog is indexed under before any response has arrived: a CANCEL we send, a
// Timer B that fires and a 100 that comes back all have to find the dialog when nobody has told us
// the far end's tag yet. RFC 3261 §12.1.2 has the same shape from the other side — a UAC's dialog
// is not created until a response with a tag arrives, but its INVITE transaction exists throughout.
func (i Identity) EarlyKey() string {
	return i.SIPCallID + "\x00" + i.LocalTag + "\x00"
}

// identityOfIncoming reads the triple off a request that ARRIVED here, in either role.
//
// The mapping is fixed by the direction of travel and not by the role: a request sent to us puts
// our tag in To and its own in From, always. That is why a BYE from a phone we called and a BYE
// from a phone that called us parse identically, and why there is one function rather than two that
// could disagree.
func identityOfIncoming(req *sip.Request) (Identity, error) {
	callID := req.CallID()
	if callID == nil || strings.TrimSpace(callID.Value()) == "" {
		return Identity{}, ErrNoIdentity
	}
	identity := Identity{SIPCallID: callID.Value()}
	if to := req.To(); to != nil {
		identity.LocalTag, _ = to.Params.Get("tag")
	}
	if from := req.From(); from != nil {
		identity.RemoteTag, _ = from.Params.Get("tag")
	}
	if identity.RemoteTag == "" {
		// A request from a far end with no From tag is not addressable as a dialog. RFC 3261 §8.1.1.3
		// makes the From tag mandatory on every request; a peer that omits it gets 400 rather than a
		// dialog match that could collide with another call from the same handset.
		return Identity{}, ErrNoIdentity
	}
	return identity, nil
}

// identityOfResponse reads the triple off a response to a request WE sent (the UAC side).
//
// Our tag is in From here and theirs is in To — the mirror of identityOfIncoming, and the reason
// the two exist separately rather than as one function with a boolean.
func identityOfResponse(res *sip.Response) (Identity, error) {
	callID := res.CallID()
	if callID == nil || strings.TrimSpace(callID.Value()) == "" {
		return Identity{}, ErrNoIdentity
	}
	identity := Identity{SIPCallID: callID.Value()}
	if from := res.From(); from != nil {
		identity.LocalTag, _ = from.Params.Get("tag")
	}
	if to := res.To(); to != nil {
		identity.RemoteTag, _ = to.Params.Get("tag")
	}
	if identity.LocalTag == "" {
		return Identity{}, ErrNoIdentity
	}
	return identity, nil
}

// Target is where mid-dialog requests for this dialog go.
//
// Two addresses, and the difference between them is the entire NAT problem (design §9.9). Contact
// is what the far end SAID; Observed is where its packets actually came from. A phone behind NAT
// gives us a private address in the first and a working one in the second, and a BYE sent to the
// first is a call that never ends. internal/nat decides which one wins and why.
type Target struct {
	// Contact is the URI from the far end's Contact header, the RFC 3261 §12.1.1 remote target.
	Contact sip.Uri
	// Observed is the transport-level source of the far end's messages, host:port.
	Observed string
	// RouteSet is the Record-Route set, in the order mid-dialog requests must traverse it. sipgo
	// copies these on both roles already (`dialog_server.go:144-160`), so this field is what lets us
	// hand them back rather than re-derive them.
	RouteSet []string
	// Transport is the transport the dialog was established over, lower-cased.
	Transport string
}
