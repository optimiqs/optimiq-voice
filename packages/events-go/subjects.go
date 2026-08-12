package events

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// The versioned NATS subject taxonomy — the Go mirror of packages/events/src/subjects.ts.
//
// Nothing outside this file may concatenate subject tokens. Publishers use the *Subject builders,
// subscribers use the *Filter builders, and consumers reverse a delivered subject with
// ParseSubject.
//
//	calls.evt.v1.<orgId>.<callId>.<event>      event = channel.created … channel.destroyed
//	sip.reg.v1.<orgId>.<aorHash>.<event>       event = registered | unregistered | expired
//	queue.evt.v1.<orgId>.<queueId>.<event>     event = caller.joined | … | agent.state
//	voicemail.evt.v1.<orgId>.<mailboxId>.<event>  event = message.left | mwi.updated
//	media.evt.v1.<orgId>.<sessionId>.<event>   event = session.ended | session.rtp-timeout |
//	                                                   playback.finished | recording.finished
//	trunk.evt.v1.<orgId>.<trunkId>.<event>     event = status.changed
//	cdr.leg.v1.<orgId>                         one subject per org; the type is in the envelope
//	audit.evt.v1.<orgId>
//	provision.evt.v1.<orgId>
//	rpc.routing.v1.resolve                     request-reply, not JetStream (see rpc_gen.go)
//	rpc.authz.v1.check
//
// The version token is a MAJOR version and is part of the subject, not the payload: a breaking
// payload change ships as v2 subjects alongside v1. Additive changes never bump it.
//
// Event names are hierarchical and may contain dots (channel.record.started), so the event occupies
// the subject's TAIL rather than a single token. Every filter that spans events therefore ends in
// ">", and ParseSubject rejoins the trailing tokens.

// SubjectVersion is the MAJOR version token embedded in every subject.
const SubjectVersion = "v1"

// Fixed prefix of each subject family, up to and including the version token.
const (
	SubjectRootCall         = "calls.evt." + SubjectVersion
	SubjectRootRegistration = "sip.reg." + SubjectVersion
	SubjectRootQueue        = "queue.evt." + SubjectVersion
	SubjectRootVoicemail    = "voicemail.evt." + SubjectVersion
	SubjectRootMedia        = "media.evt." + SubjectVersion
	SubjectRootTrunk        = "trunk.evt." + SubjectVersion
	SubjectRootCDRLeg       = "cdr.leg." + SubjectVersion
	SubjectRootAudit        = "audit.evt." + SubjectVersion
	SubjectRootProvision    = "provision.evt." + SubjectVersion
)

// QueueScopeAll is the reserved queue-scope token for events that belong to the org rather than to
// one queue — in practice agent.state, since an agent has one status across every tier they sit in.
const QueueScopeAll = "_all"

// EventFamily identifies a family by its SUBJECT. An envelope's `type` is unique within its family
// only: "registered" means nothing without sip.reg.v1.… around it.
type EventFamily string

// Every event family on the backbone.
const (
	FamilyCall         EventFamily = "call"
	FamilyRegistration EventFamily = "registration"
	FamilyQueue        EventFamily = "queue"
	FamilyVoicemail    EventFamily = "voicemail"
	FamilyMedia        EventFamily = "media"
	FamilyTrunk        EventFamily = "trunk"
	FamilyCDR          EventFamily = "cdr"
	FamilyAudit        EventFamily = "audit"
	FamilyProvision    EventFamily = "provision"
)

// EventFamilies lists every family, in contract order.
var EventFamilies = []EventFamily{
	FamilyCall,
	FamilyRegistration,
	FamilyQueue,
	FamilyVoicemail,
	FamilyMedia,
	FamilyTrunk,
	FamilyCDR,
	FamilyAudit,
	FamilyProvision,
}

// EventTypesOfFamily returns the `type` vocabulary of one family, in contract order. It reads the
// generated registry so the vocabulary cannot disagree with the payload structs.
func EventTypesOfFamily(family EventFamily) []string {
	types := make([]string, 0, 4)
	for _, info := range EventTypes {
		if info.Family == family {
			types = append(types, info.Type)
		}
	}
	return types
}

// IsEventTypeOfFamily reports whether eventType belongs to family in THIS contract version.
//
// A v1.n producer may emit a type a v1.0 consumer has never heard of (envelope.go: additive-only
// evolution), so false means "not known here", never "invalid".
func IsEventTypeOfFamily(family EventFamily, eventType string) bool {
	for _, info := range EventTypes {
		if info.Family == family && info.Type == eventType {
			return true
		}
	}
	return false
}

// SubjectTokenError is returned when a caller tries to build a subject from a value that cannot be
// a subject token.
type SubjectTokenError struct {
	// Role is the position the value was going to occupy: "orgId", "callId", "event", …
	Role string
	// Value is the offending input, unmodified.
	Value string
}

func (e *SubjectTokenError) Error() string {
	return fmt.Sprintf(
		"invalid %s subject token %q: expected one or more dot-separated tokens of [A-Za-z0-9_-]",
		e.Role, e.Value,
	)
}

func isTokenByte(c byte) bool {
	return c == '-' || c == '_' ||
		(c >= '0' && c <= '9') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= 'a' && c <= 'z')
}

// IsSubjectToken reports whether value is usable as exactly one subject token: no dots, no
// whitespace, no "*"/">" wildcards, never empty.
func IsSubjectToken(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if !isTokenByte(value[i]) {
			return false
		}
	}
	return true
}

// IsEventName reports whether value is usable as a (possibly dotted) event name.
func IsEventName(value string) bool {
	if value == "" {
		return false
	}
	for _, part := range strings.Split(value, ".") {
		if !IsSubjectToken(part) {
			return false
		}
	}
	return true
}

func token(role, value string) (string, error) {
	if !IsSubjectToken(value) {
		return "", &SubjectTokenError{Role: role, Value: value}
	}
	return value, nil
}

func eventName(value string) (string, error) {
	if !IsEventName(value) {
		return "", &SubjectTokenError{Role: "event", Value: value}
	}
	return value, nil
}

// AORSubjectToken returns the stable subject token for an Address of Record.
//
// An AOR (sip:1001@acme.example.com) contains "@", ":" and dots, none of which survive as a single
// subject token, and it is PII-adjacent. The token is the first 32 hex characters of the SHA-256 of
// the lower-cased AOR — 128 bits, collision-free at any registrar scale, and stable across
// processes and languages so sip.reg.v1.<org>.<aorHash>.> is a usable per-device filter.
//
// The full AOR always travels in the event payload; the hash is addressing only.
//
// Normalisation is trim + lower-case, matching String.prototype.trim/toLowerCase for every input a
// SIP AOR can contain (ASCII plus the Latin-1/Unicode letters a domain or user part may carry). The
// few code points where JavaScript's and Go's case folding disagree (dotted/dotless I, final sigma)
// are not valid in a SIP user or host part.
func AORSubjectToken(aor string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(aor))
	if normalized == "" {
		return "", &SubjectTokenError{Role: "aor", Value: aor}
	}
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])[:32], nil
}

// DIDIndexToken returns the stable key token for a DID, for the did-index KV bucket.
//
// An E.164 number is stored as "+441632960111" and dialled as "441632960111", "+441632960111" or
// (from a carrier that strips it) with punctuation. None of "+", spaces, dashes or parentheses
// survive as a KV key token, and none of them carry meaning, so the token is the DIGITS and nothing
// else. Both writers and readers go through this one function, which is what makes "the DID the
// tenant configured" and "the DID the carrier delivered" the same key.
//
// What it deliberately does NOT do is guess a dial plan: "0044…" and "+44…" are the same number to a
// human and different tokens here, because turning a national prefix into a country code needs to
// know which country the trunk is in. That belongs to the SIP edge, not to the contract package.
func DIDIndexToken(did string) (string, error) {
	digits := make([]byte, 0, len(did))
	for i := 0; i < len(did); i++ {
		if did[i] >= '0' && did[i] <= '9' {
			digits = append(digits, did[i])
		}
	}
	if len(digits) == 0 {
		return "", &SubjectTokenError{Role: "did", Value: did}
	}
	return string(digits), nil
}

// ---------------------------------------------------------------------------------------------
// publish subjects
// ---------------------------------------------------------------------------------------------

// CallSubject builds calls.evt.v1.<orgId>.<callId>.<event>.
func CallSubject(orgID, callID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	call, err := token("callId", callID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootCall + "." + org + "." + call + "." + name, nil
}

// RegistrationSubject builds sip.reg.v1.<orgId>.<aorHash>.<event>. The hash comes from
// AORSubjectToken.
func RegistrationSubject(orgID, aorHash, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	hash, err := token("aorHash", aorHash)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootRegistration + "." + org + "." + hash + "." + name, nil
}

// QueueSubject builds queue.evt.v1.<orgId>.<queueId>.<event>. Pass QueueScopeAll as queueID for an
// org-wide agent.state.
func QueueSubject(orgID, queueID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	queue, err := token("queueId", queueID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootQueue + "." + org + "." + queue + "." + name, nil
}

// VoicemailSubject builds voicemail.evt.v1.<orgId>.<mailboxId>.<event>. mailboxID is the
// voicemail box's row id.
func VoicemailSubject(orgID, mailboxID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	mailbox, err := token("mailboxId", mailboxID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootVoicemail + "." + org + "." + mailbox + "." + name, nil
}

// MediaSubject builds media.evt.v1.<orgId>.<sessionId>.<event>.
//
// Keyed by SESSION and not by call: a call has one id and several media sessions (one per leg), and
// the thing that ends, times out or is reaped is the session. The call travels in the payload.
func MediaSubject(orgID, sessionID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	session, err := token("sessionId", sessionID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootMedia + "." + org + "." + session + "." + name, nil
}

// TrunkSubject builds trunk.evt.v1.<orgId>.<trunkId>.<event>.
//
// trunkID is the trunk ROW id, not the trunk's name: the name is what the media server addresses
// (it is the PJSIP endpoint), but a tenant may rename a trunk while it is down, and a subject that
// moved under a rename would strand a durable consumer's ordering mid-outage. The name travels in
// the payload.
func TrunkSubject(orgID, trunkID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	trunk, err := token("trunkId", trunkID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootTrunk + "." + org + "." + trunk + "." + name, nil
}

// CDRLegSubject builds cdr.leg.v1.<orgId> — a single ordered subject per org.
func CDRLegSubject(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootCDRLeg + "." + org, nil
}

// AuditSubject builds audit.evt.v1.<orgId>.
func AuditSubject(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootAudit + "." + org, nil
}

// ProvisionSubject builds provision.evt.v1.<orgId>.
func ProvisionSubject(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootProvision + "." + org, nil
}

// ---------------------------------------------------------------------------------------------
// subscription filters
// ---------------------------------------------------------------------------------------------

// AllCallsFilter matches every call event of every org — the CALLS stream's own subject list.
func AllCallsFilter() string { return SubjectRootCall + ".>" }

// CallsInOrgFilter matches every call event of one org.
func CallsInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootCall + "." + org + ".>", nil
}

// CallFilter matches every event of one call. JetStream guarantees per-subject ordering within it.
func CallFilter(orgID, callID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	call, err := token("callId", callID)
	if err != nil {
		return "", err
	}
	return SubjectRootCall + "." + org + "." + call + ".>", nil
}

// CallEventInOrgFilter matches one event name across every call of one org.
func CallEventInOrgFilter(orgID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootCall + "." + org + ".*." + name, nil
}

// CallEventFilter matches one event name across every call of every org.
func CallEventFilter(event string) (string, error) {
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootCall + ".*.*." + name, nil
}

// AllRegistrationsFilter matches every registrar transition — the REGISTRATIONS stream's subjects.
func AllRegistrationsFilter() string { return SubjectRootRegistration + ".>" }

// RegistrationsInOrgFilter matches every registrar transition of one org.
func RegistrationsInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootRegistration + "." + org + ".>", nil
}

// RegistrationsForAORFilter matches every transition of one device.
func RegistrationsForAORFilter(orgID, aorHash string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	hash, err := token("aorHash", aorHash)
	if err != nil {
		return "", err
	}
	return SubjectRootRegistration + "." + org + "." + hash + ".>", nil
}

// RegistrationEventInOrgFilter matches one registrar event name across every device of one org.
func RegistrationEventInOrgFilter(orgID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootRegistration + "." + org + ".*." + name, nil
}

// AllQueuesFilter matches every queue event — the QUEUES stream's subjects.
func AllQueuesFilter() string { return SubjectRootQueue + ".>" }

// QueuesInOrgFilter matches every queue event of one org (both queue and org scopes).
func QueuesInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootQueue + "." + org + ".>", nil
}

// QueueFilter matches every event of one queue.
func QueueFilter(orgID, queueID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	queue, err := token("queueId", queueID)
	if err != nil {
		return "", err
	}
	return SubjectRootQueue + "." + org + "." + queue + ".>", nil
}

// QueueEventInOrgFilter matches one queue event name across every queue of one org.
func QueueEventInOrgFilter(orgID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootQueue + "." + org + ".*." + name, nil
}

// AllVoicemailFilter matches every voicemail event — the VOICEMAIL stream's subjects.
func AllVoicemailFilter() string { return SubjectRootVoicemail + ".>" }

// VoicemailInOrgFilter matches every voicemail event of one org.
func VoicemailInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootVoicemail + "." + org + ".>", nil
}

// VoicemailBoxFilter matches every event of one mailbox — what an MWI subscriber watches.
func VoicemailBoxFilter(orgID, mailboxID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	mailbox, err := token("mailboxId", mailboxID)
	if err != nil {
		return "", err
	}
	return SubjectRootVoicemail + "." + org + "." + mailbox + ".>", nil
}

// VoicemailEventInOrgFilter matches one voicemail event name across every mailbox of one org.
func VoicemailEventInOrgFilter(orgID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootVoicemail + "." + org + ".*." + name, nil
}

// AllMediaFilter matches every media-session event — the MEDIA stream's subjects.
func AllMediaFilter() string { return SubjectRootMedia + ".>" }

// MediaInOrgFilter matches every media-session event of one org.
func MediaInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootMedia + "." + org + ".>", nil
}

// MediaSessionFilter matches every event of one media session.
func MediaSessionFilter(orgID, sessionID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	session, err := token("sessionId", sessionID)
	if err != nil {
		return "", err
	}
	return SubjectRootMedia + "." + org + "." + session + ".>", nil
}

// MediaEventInOrgFilter matches one media event name across every session of one org.
func MediaEventInOrgFilter(orgID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootMedia + "." + org + ".*." + name, nil
}

// AllTrunksFilter matches every trunk event — the TRUNKS stream's subjects.
func AllTrunksFilter() string { return SubjectRootTrunk + ".>" }

// TrunksInOrgFilter matches every trunk event of one org.
func TrunksInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootTrunk + "." + org + ".>", nil
}

// TrunkStatusInOrgFilter matches status.changed across every trunk of one org.
//
// The event name is DOTTED, so the tail is two tokens and the trunk wildcard cannot be a ">":
// trunk.evt.v1.<org>.> would be the whole family, and a trailing ".*.*" would match nothing.
func TrunkStatusInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootTrunk + "." + org + ".*.status.changed", nil
}

// AllCDRLegsFilter matches every org's CDR subject. One token, so "*" not ">".
func AllCDRLegsFilter() string { return SubjectRootCDRLeg + ".*" }

// CDRLegsInOrgFilter matches one org's CDR subject.
func CDRLegsInOrgFilter(orgID string) (string, error) { return CDRLegSubject(orgID) }

// AllAuditFilter matches every org's audit subject.
func AllAuditFilter() string { return SubjectRootAudit + ".*" }

// AuditInOrgFilter matches one org's audit subject.
func AuditInOrgFilter(orgID string) (string, error) { return AuditSubject(orgID) }

// AllProvisionFilter matches every org's provisioning subject.
func AllProvisionFilter() string { return SubjectRootProvision + ".*" }

// ProvisionInOrgFilter matches one org's provisioning subject.
func ProvisionInOrgFilter(orgID string) (string, error) { return ProvisionSubject(orgID) }

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

// SubjectKind names the shape a parsed subject has, including the non-event rpc shape.
type SubjectKind string

// Every subject shape in the taxonomy.
const (
	KindCall         SubjectKind = "call"
	KindRegistration SubjectKind = "registration"
	KindQueue        SubjectKind = "queue"
	KindVoicemail    SubjectKind = "voicemail"
	KindMedia        SubjectKind = "media"
	KindTrunk        SubjectKind = "trunk"
	KindCDRLeg       SubjectKind = "cdr-leg"
	KindAudit        SubjectKind = "audit"
	KindProvision    SubjectKind = "provision"
	KindRPC          SubjectKind = "rpc"
)

// ParsedSubject is the reverse of the *Subject builders: a delivered subject decomposed.
//
// Fields that do not apply to the Kind are empty. Family is a plain string rather than EventFamily
// because an rpc subject reports "rpc", which is not an event family; use EventFamilyForSubject
// when you need the narrowed value.
type ParsedSubject struct {
	Kind    SubjectKind
	Family  string
	Version string
	OrgID   string
	// CallID is set for KindCall.
	CallID string
	// AORHash is set for KindRegistration.
	AORHash string
	// QueueID is set for KindQueue.
	QueueID string
	// MailboxID is set for KindVoicemail.
	MailboxID string
	// SessionID is set for KindMedia.
	SessionID string
	// TrunkID is set for KindTrunk.
	TrunkID string
	// Event is the (possibly dotted) event name, for the four per-entity families.
	//
	// It is returned as a plain string, not a checked vocabulary member: a v1.n producer may emit
	// an event name a v1.0 consumer has never heard of, and dropping that message at parse time
	// would break the additive-evolution guarantee. Narrow with IsEventTypeOfFamily when the code
	// actually needs to branch.
	Event string
	// Service and Method are set for KindRPC.
	Service string
	Method  string
}

// UnknownSubjectError is returned by ParseSubjectOrError for a subject outside the taxonomy.
type UnknownSubjectError struct {
	Subject string
}

func (e *UnknownSubjectError) Error() string {
	return fmt.Sprintf("subject %q is not part of the Optimiq Voice taxonomy", e.Subject)
}

// ParseSubject decomposes a concrete (wildcard-free) subject. The second result is false for
// anything outside the taxonomy, including subjects of a different MAJOR version.
func ParseSubject(subject string) (ParsedSubject, bool) {
	if strings.ContainsAny(subject, "*>") {
		return ParsedSubject{}, false
	}
	tokens := strings.Split(subject, ".")
	if len(tokens) < 4 {
		return ParsedSubject{}, false
	}
	first, second, version, rest := tokens[0], tokens[1], tokens[2], tokens[3:]
	if version != SubjectVersion {
		return ParsedSubject{}, false
	}
	prefix := first + "." + second

	switch {
	case prefix == "calls.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindCall, Family: string(FamilyCall), Version: version,
			OrgID: rest[0], CallID: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "sip.reg" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindRegistration, Family: string(FamilyRegistration), Version: version,
			OrgID: rest[0], AORHash: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "queue.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindQueue, Family: string(FamilyQueue), Version: version,
			OrgID: rest[0], QueueID: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "voicemail.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindVoicemail, Family: string(FamilyVoicemail), Version: version,
			OrgID: rest[0], MailboxID: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "media.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindMedia, Family: string(FamilyMedia), Version: version,
			OrgID: rest[0], SessionID: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "trunk.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindTrunk, Family: string(FamilyTrunk), Version: version,
			OrgID: rest[0], TrunkID: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "cdr.leg" && len(rest) == 1:
		return ParsedSubject{
			Kind: KindCDRLeg, Family: string(FamilyCDR), Version: version, OrgID: rest[0],
		}, true
	case prefix == "audit.evt" && len(rest) == 1:
		return ParsedSubject{
			Kind: KindAudit, Family: string(FamilyAudit), Version: version, OrgID: rest[0],
		}, true
	case prefix == "provision.evt" && len(rest) == 1:
		return ParsedSubject{
			Kind: KindProvision, Family: string(FamilyProvision), Version: version, OrgID: rest[0],
		}, true
	case first == "rpc" && len(rest) == 1:
		return ParsedSubject{
			Kind: KindRPC, Family: "rpc", Version: version, Service: second, Method: rest[0],
		}, true
	}
	return ParsedSubject{}, false
}

// ParseSubjectOrError is ParseSubject with an error instead of a boolean.
func ParseSubjectOrError(subject string) (ParsedSubject, error) {
	parsed, ok := ParseSubject(subject)
	if !ok {
		return ParsedSubject{}, &UnknownSubjectError{Subject: subject}
	}
	return parsed, nil
}

// EventFamilyForSubject returns the event family a subject belongs to. The second result is false
// when the subject is outside the taxonomy or is an rpc subject.
func EventFamilyForSubject(subject string) (EventFamily, bool) {
	parsed, ok := ParseSubject(subject)
	if !ok || parsed.Kind == KindRPC {
		return "", false
	}
	return EventFamily(parsed.Family), true
}

// MatchesSubject implements NATS subject matching: "*" matches exactly one token, ">" matches one
// or more trailing tokens and is only meaningful as the final token.
//
// Reimplemented here rather than taken from a client so filters can be unit-tested without a
// broker, and so a fake in-process bus routes exactly like the server does.
func MatchesSubject(filter, subject string) bool {
	filterTokens := strings.Split(filter, ".")
	subjectTokens := strings.Split(subject, ".")

	for index, tok := range filterTokens {
		if tok == ">" {
			return index == len(filterTokens)-1 && len(subjectTokens) > index
		}
		if index >= len(subjectTokens) {
			return false
		}
		if tok == "*" {
			continue
		}
		if tok != subjectTokens[index] {
			return false
		}
	}
	return len(filterTokens) == len(subjectTokens)
}
