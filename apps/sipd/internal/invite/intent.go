// Package invite is sipd's INVITE surface: the half of a call that happens before there is a call.
//
// # Where this stops, and why
//
// It parses an INVITE into a CALL INTENT, decides whether the sender may send it at all, and hands
// the intent to a Port. It does not route, does not attribute a tenant for a trunk call, does not
// pick a codec and does not touch media. Those are the engine's and mediad's, and the split is
// design §4.2's: sipd owns "is this sender allowed to send me an INVITE", the engine owns "whose
// call is it".
//
// The Port is the seam. Its production implementation is a NATS request against
// `rpc.sip.v1.invite`, which does not exist yet — the subject, its schemas and the engine responder
// are all outside this module's boundary. So the interface is here, two fakes are here, and the
// exact contract the engine must serve is written on Admission and in the report that accompanies
// this work. Everything up to the seam is real and tested; nothing pretends the far side is.
package invite

import (
	"errors"
	"strings"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
)

// Authentication says HOW the sender proved it may send this INVITE. It is the field that decides
// which routing context the engine may resolve in, so it is not a log annotation.
type Authentication string

const (
	// AuthenticationDigest means an RFC 7616 answer verified against the realm's credentials. The
	// tenant is known from the credential and travels on the request.
	AuthenticationDigest Authentication = "digest"
	// AuthenticationTrunkACL means the source address matched an allow entry. No tenant is known;
	// the engine resolves it from the did-index, which is exactly why `orgId` is optional on the
	// admission request (design §4.2).
	AuthenticationTrunkACL Authentication = "trunk-acl"
)

// Party is one end of the call as this edge understands it.
type Party struct {
	// Number is what a dial plan consumes: the user part, nothing else. A dial plan takes a
	// destination string, not a URI.
	Number string
	// Name is the display name when the far end supplied one. PII-adjacent and purely for
	// presentation.
	Name string
	// AOR is the canonical address of record. For the caller on a digest-authenticated INVITE it is
	// rebuilt FROM THE CREDENTIAL and never copied from the From header — the rule
	// `transfer/handler.go` states as "mixing those two up is how an authorisation check becomes
	// decorative". For a trunk call there is no credential, so it is absent rather than guessed.
	AOR string
	// URI is the address verbatim, for the log and for the day a call to a foreign domain has to be
	// refused explicitly rather than quietly dialled as a local extension.
	URI string
}

// CallIntent is everything this edge can truthfully say about an arriving INVITE.
//
// The field set is design §10.3's `rpc.sip.v1.invite` request, plus two things that document
// records as needed and does not name: the profile the call arrived on (so a refusal record says
// which boundary admitted it) and the media hint (so mediad can be told to expect a NAT latch).
type CallIntent struct {
	// LegID is minted here for an inbound call. One string names the leg, the mediad session and
	// the dialog (design §3.1), and minting it BEFORE the RPC is what lets the engine hang up a leg
	// whose admission reply it never saw.
	LegID string
	// InstanceID is this sipd's token. Every subsequent command for this leg is addressed at it,
	// because a dialog lives on one process.
	InstanceID string
	// OrgID is present ONLY when a digest resolved a credential. Absent for a trunk.
	OrgID string
	// Authentication is how the sender proved itself.
	Authentication Authentication
	// Profile names the trust boundary this arrived on.
	Profile string
	// RoutingContext is the boundary the engine may resolve in. `internal` for a digest,
	// `inbound-untrusted` for a trunk ACL match — and the engine must refuse an admission whose
	// context is trunk-capable and whose authentication was an ACL match (design §8.3). Sending it
	// from here does not make it true; it makes it CHECKABLE on the side that can enforce it.
	RoutingContext profile.RoutingContext
	// From and To are the two parties.
	From Party
	To   Party
	// SIPCallID and FromTag are the dialog identifiers, recorded verbatim and asserted to be
	// nothing. A lookup key, never an authorisation.
	SIPCallID string
	FromTag   string
	// TrunkID is set when an ACL entry attributed the source to a carrier.
	TrunkID string
	// SourceAddress is the observed transport source, host:port.
	SourceAddress string
	// Transport is the transport the INVITE arrived over, lower-cased.
	Transport string
	// HasOffer reports whether the INVITE carried an SDP body.
	HasOffer bool
	// SDPOffer is the body verbatim. It is on the request rather than fetched later because the
	// engine is the courier for it and a second round trip would sit in the middle of an INVITE for
	// no gain (design §10.3, which flags this as the one field argued both ways).
	SDPOffer string
	// MediaHint tells the media plane that the far end's advertised media address disagrees with
	// where its signalling came from, so a latch is expected rather than a surprise.
	MediaHint nat.MediaHint
	// UserAgent is the far end's User-Agent, for the log and for interop workarounds that have not
	// been needed yet.
	UserAgent string
	// Replaces is the RFC 3891 header when this INVITE completes an attended transfer, and
	// ReplacesLegID is the leg it correlated to on THIS instance.
	//
	// Both travel to the engine because the engine has to do the other half: the dialog is replaced
	// here, and the CALL the replaced leg belonged to has to be re-bridged there. Sending only the
	// SIP identifiers would make the engine re-derive a leg id this edge already holds.
	Replaces      *Replaces
	ReplacesLegID string
}

// Parse failures, distinguished so the handler can answer the right status and the tests can assert
// a reason rather than a number.
var (
	// ErrNoTo means the INVITE named nobody to call.
	ErrNoTo = errors.New("invite: the INVITE carries no usable To address")
	// ErrNoFrom means it named nobody calling.
	ErrNoFrom = errors.New("invite: the INVITE carries no usable From address")
	// ErrNoContact means the far end gave no Contact, so no mid-dialog request could ever reach it.
	// RFC 3261 §8.1.1.8 makes it mandatory on an INVITE, and sipgo's ReadInvite refuses one without
	// it too — this error exists so the refusal is OURS, with a status we chose.
	ErrNoContact = errors.New("invite: the INVITE carries no Contact header")
	// ErrNoCallID means there is no dialog identifier at all.
	ErrNoCallID = errors.New("invite: the INVITE carries no Call-ID")
)

// Parse turns an INVITE into a call intent.
//
// It is a pure function of the message plus the decisions the caller has already made — which
// profile owns it, which credential (if any) authenticated it — and it reads no state and performs
// no I/O. That is what makes every branch below testable from wire text.
func Parse(req *sip.Request, opts ParseOptions) (CallIntent, error) {
	callID := req.CallID()
	if callID == nil || strings.TrimSpace(callID.Value()) == "" {
		return CallIntent{}, ErrNoCallID
	}
	to := req.To()
	if to == nil || strings.TrimSpace(to.Address.User) == "" {
		return CallIntent{}, ErrNoTo
	}
	from := req.From()
	if from == nil || strings.TrimSpace(from.Address.User) == "" {
		return CallIntent{}, ErrNoFrom
	}
	if req.Contact() == nil {
		return CallIntent{}, ErrNoContact
	}

	fromTag, _ := from.Params.Get("tag")
	body := req.Body()

	intent := CallIntent{
		LegID:          opts.LegID,
		InstanceID:     opts.InstanceID,
		OrgID:          opts.OrgID,
		Authentication: opts.Authentication,
		Profile:        opts.Profile,
		RoutingContext: opts.RoutingContext,
		From: Party{
			Number: from.Address.User,
			Name:   strings.TrimSpace(from.DisplayName),
			AOR:    opts.CallerAOR,
			URI:    canonicalURI(from.Address),
		},
		To: Party{
			Number: to.Address.User,
			Name:   strings.TrimSpace(to.DisplayName),
			URI:    canonicalURI(to.Address),
		},
		SIPCallID:     callID.Value(),
		FromTag:       fromTag,
		TrunkID:       opts.TrunkID,
		SourceAddress: req.Source(),
		Transport:     strings.ToLower(req.Transport()),
		HasOffer:      len(body) > 0,
		SDPOffer:      string(body),
		UserAgent:     headerValue(req, "User-Agent"),
	}
	if intent.HasOffer {
		intent.MediaHint = nat.HintFor(body, intent.SourceAddress)
	}
	return intent, nil
}

// ParseOptions carries what the caller already decided and Parse must not re-derive.
//
// Every field here is a decision made by a check the parser cannot perform: the profile came from
// the listener, the credential from a digest exchange, the trunk from an ACL match. Passing them in
// rather than looking them up is what keeps Parse a pure function and keeps the authorisation
// decisions in the one place that made them.
type ParseOptions struct {
	LegID          string
	InstanceID     string
	OrgID          string
	Authentication Authentication
	Profile        string
	RoutingContext profile.RoutingContext
	TrunkID        string
	// CallerAOR is the caller's canonical address, rebuilt from the credential by the caller. Empty
	// for a trunk INVITE, where there is no credential and therefore no canonical form to rebuild.
	CallerAOR string
}

// canonicalURI renders an address in the one spelling this platform stores: scheme, user, and a
// LOWER-CASED host (RFC 3261 §19.1.4 makes the host case-insensitive). Anything else hashes to a
// different key and would report a registered phone as unregistered — the same rule the registrar
// and the REFER handler already apply.
func canonicalURI(uri sip.Uri) string {
	scheme := uri.Scheme
	if scheme == "" {
		scheme = "sip"
	}
	if uri.User == "" {
		return scheme + ":" + strings.ToLower(uri.Host)
	}
	return scheme + ":" + uri.User + "@" + strings.ToLower(uri.Host)
}

func headerValue(req *sip.Request, name string) string {
	header := req.GetHeader(name)
	if header == nil {
		return ""
	}
	return header.Value()
}
