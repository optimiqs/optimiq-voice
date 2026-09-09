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
// the message while the dialog identifier must not. It is never a key: `legId` is the key (design
// §3.1) and this triple is only the index onto it, so a phone-chosen string never becomes a NATS
// subject token.
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

// Key renders the triple as one comparable string for the dialog index. The separator is NUL
// because a device-chosen Call-ID may legally contain a semicolon or colon, and an injectable
// separator would let two different dialogs collide on one index entry.
func (i Identity) Key() string {
	return i.SIPCallID + "\x00" + i.LocalTag + "\x00" + i.RemoteTag
}

// Established reports whether both tags are known — that is, whether this triple names a dialog at
// all rather than a request that may yet become one.
func (i Identity) Established() bool {
	return i.SIPCallID != "" && i.LocalTag != "" && i.RemoteTag != ""
}

// EarlyKey renders the triple WITHOUT the remote tag: what a UAC dialog is indexed under before any
// response has arrived, since a CANCEL, a Timer B firing and a 100 must all find it first. RFC 3261
// §12.1.2 — the dialog is not created until a tagged response, but the transaction exists
// throughout.
func (i Identity) EarlyKey() string {
	return i.SIPCallID + "\x00" + i.LocalTag + "\x00"
}

// identityOfIncoming reads the triple off a request that ARRIVED here, in either role: the mapping
// is fixed by direction of travel, not by role — a request sent to us always puts our tag in To and
// its own in From.
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

// identityOfResponse reads the triple off a response to a request WE sent (the UAC side): our tag
// is in From and theirs in To, the mirror of identityOfIncoming.
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

// Target is where mid-dialog requests for this dialog go. Contact is what the far end SAID;
// Observed is where its packets actually came from — behind NAT the first is unroutable and a BYE
// sent to it never ends the call (design §9.9). internal/nat decides which wins.
type Target struct {
	// Contact is the URI from the far end's Contact header, the RFC 3261 §12.1.1 remote target.
	Contact sip.Uri
	// Observed is the transport-level source of the far end's messages, host:port.
	Observed string
	// RouteSet is the Record-Route set, in the order mid-dialog requests must traverse it.
	RouteSet []string
	// Transport is the transport the dialog was established over, lower-cased.
	Transport string
}
