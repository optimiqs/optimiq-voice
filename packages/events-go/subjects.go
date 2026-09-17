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
// Event names are hierarchical and may contain dots (channel.record.started), so the event occupies
// the subject's TAIL rather than a single token. Every filter that spans events therefore ends in
// ">", and ParseSubject rejoins the trailing tokens.

// SubjectVersion is the MAJOR version token embedded in every subject.
const SubjectVersion = "v1"

// Fixed prefix of each subject family, up to and including the version token.
const (
	SubjectRootCall         = "calls.evt." + SubjectVersion
	SubjectRootRegistration = "sip.reg." + SubjectVersion
	SubjectRootSIPDialog    = "sip.evt." + SubjectVersion
	SubjectRootQueue        = "queue.evt." + SubjectVersion
	SubjectRootVoicemail    = "voicemail.evt." + SubjectVersion
	SubjectRootMedia        = "media.evt." + SubjectVersion
	SubjectRootMessaging    = "messaging.evt." + SubjectVersion
	SubjectRootTrunk        = "trunk.evt." + SubjectVersion
	SubjectRootCDRLeg       = "cdr.leg." + SubjectVersion
	SubjectRootSecurity     = "security.evt." + SubjectVersion
	SubjectRootAudit        = "audit.evt." + SubjectVersion
	SubjectRootProvision    = "provision.evt." + SubjectVersion
)

// QueueScopeAll is the reserved queue-scope token for events that belong to the org rather than to
// one queue — in practice agent.state, since an agent has one status across every tier they sit in.
const QueueScopeAll = "_all"

// SecurityScopeOrg is the reserved security-scope token for a signal that belongs to the
// ORGANIZATION rather than to one extension — a tenant-wide minutes spike with no single account
// behind it. Same idiom as QueueScopeAll: the subject's middle token is the thing the signal is
// ABOUT, and inventing an extension id for a finding that has none would make the subject lie.
const SecurityScopeOrg = "_org"

// EventFamily identifies a family by its SUBJECT. An envelope's `type` is unique within its family
// only: "registered" means nothing without sip.reg.v1.… around it.
type EventFamily string

// Every event family on the backbone.
const (
	FamilyCall         EventFamily = "call"
	FamilyRegistration EventFamily = "registration"
	FamilySIPDialog    EventFamily = "sipDialog"
	FamilyQueue        EventFamily = "queue"
	FamilyVoicemail    EventFamily = "voicemail"
	FamilyMedia        EventFamily = "media"
	FamilyMessaging    EventFamily = "messaging"
	FamilyTrunk        EventFamily = "trunk"
	FamilyCDR          EventFamily = "cdr"
	FamilySecurity     EventFamily = "security"
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
	FamilyMessaging,
	FamilyTrunk,
	FamilyCDR,
	FamilySecurity,
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

// InstanceSubjectToken returns the stable subject token for a service instance id.
//
// The Go mirror of instanceSubjectToken in packages/events/src/subjects.ts, and it MUST agree with
// it byte for byte: the engine builds rpc.sip.v1.{ring,answer,hangup,reinvite}.<tok> from its side
// while apps/sipd subscribes through this function, so a disagreement is a command published where
// nobody is listening.
//
// An id that is already a single token (sipd, sipd-7d9f4c-xk2lp) is returned verbatim, so an
// operator can `nats sub` the exact subject a stuck call is addressed at. Otherwise — an FQDN
// hostname carries dots, and a dot is a separator — it is the first 32 hex characters of its
// SHA-256, the same escape hatch AORSubjectToken uses.
func InstanceSubjectToken(instanceID string) (string, error) {
	normalized := strings.TrimSpace(instanceID)
	if normalized == "" {
		return "", &SubjectTokenError{Role: "instanceId", Value: instanceID}
	}
	if IsSubjectToken(normalized) {
		return normalized, nil
	}
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])[:32], nil
}

// AORSubjectToken returns the stable subject token for an Address of Record.
//
// An AOR (sip:1001@acme.example.com) contains "@", ":" and dots, none of which survive as a single
// subject token, and it is PII-adjacent. The token is the first 32 hex characters of the SHA-256 of
// the trimmed, lower-cased AOR, stable across processes and languages so sip.reg.v1.<org>.<hash>.>
// is a usable per-device filter. The full AOR travels in the payload; the hash is addressing only.
//
// The few code points where JavaScript's and Go's case folding disagree (dotted/dotless I, final
// sigma) are not valid in a SIP user or host part, so the two sides always agree.
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
// None of "+", spaces, dashes or parentheses survive as a KV key token, and none carry meaning, so
// the token is the digits and nothing else. Both writers and readers go through this function,
// which is what makes "the DID the tenant configured" and "the DID the carrier delivered" one key.
//
// It deliberately does not guess a dial plan: "0044…" and "+44…" are the same number to a human and
// different tokens here, because a national prefix needs the trunk's country. That belongs to the
// SIP edge, not to the contract package.
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

// SIPDialogSubject builds sip.evt.v1.<orgId>.<legId>.<event>.
//
// The middle token is the leg id: one string names the leg, the mediad session and sipd's dialog.
// The SIP dialog identifier (Call-ID plus tags) stays on the payload, because a Call-ID is
// phone-chosen and full of characters IsSubjectToken rejects.
func SIPDialogSubject(orgID, legID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	leg, err := token("legId", legID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootSIPDialog + "." + org + "." + leg + "." + name, nil
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
// Keyed by session and not by call: a call has several media sessions (one per leg), and the thing
// that ends, times out or is reaped is the session. The call id travels in the payload.
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
// trunkID is the trunk row id, not its name: a tenant may rename a trunk while it is down, and a
// subject that moved under a rename would strand a durable consumer's ordering mid-outage. The name
// travels in the payload.
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

// MessagingSubject builds messaging.evt.v1.<orgId>.<conversationId>.<event>. The middle token is
// the conversation, not the message: a thread is the unit an inbox subscribes to.
func MessagingSubject(orgID, conversationID, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	conversation, err := token("conversationId", conversationID)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootMessaging + "." + org + "." + conversation + "." + name, nil
}

// SecuritySubject builds security.evt.v1.<orgId>.<subjectRef>.<event>, where subjectRef is
// SecurityScopeOrg or the extension id the signal is about.
func SecuritySubject(orgID, subjectRef, event string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	ref, err := token("subjectRef", subjectRef)
	if err != nil {
		return "", err
	}
	name, err := eventName(event)
	if err != nil {
		return "", err
	}
	return SubjectRootSecurity + "." + org + "." + ref + "." + name, nil
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

// AllSIPDialogsFilter matches every SIP dialog event — the SIP stream's subjects, and the filter
// the engine subscribes with.
func AllSIPDialogsFilter() string { return SubjectRootSIPDialog + ".>" }

// SIPDialogsInOrgFilter matches every dialog event of one org.
func SIPDialogsInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootSIPDialog + "." + org + ".>", nil
}

// SIPDialogFilter matches every event of ONE dialog.
func SIPDialogFilter(orgID, legID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	leg, err := token("legId", legID)
	if err != nil {
		return "", err
	}
	return SubjectRootSIPDialog + "." + org + "." + leg + ".>", nil
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

// AllMessagingFilter matches every org's messaging events — the MESSAGING stream's subject list.
func AllMessagingFilter() string { return SubjectRootMessaging + ".>" }

// MessagingInOrgFilter matches one org's messaging events.
func MessagingInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootMessaging + "." + org + ".>", nil
}

// MessagingConversationFilter matches one thread's events.
func MessagingConversationFilter(orgID, conversationID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	conversation, err := token("conversationId", conversationID)
	if err != nil {
		return "", err
	}
	return SubjectRootMessaging + "." + org + "." + conversation + ".>", nil
}

// AllSecurityFilter matches every org's security signals.
func AllSecurityFilter() string { return SubjectRootSecurity + ".>" }

// SecurityInOrgFilter matches one org's security signals.
func SecurityInOrgFilter(orgID string) (string, error) {
	org, err := token("orgId", orgID)
	if err != nil {
		return "", err
	}
	return SubjectRootSecurity + "." + org + ".>", nil
}

// AllAuditFilter matches every org's audit subject.
func AllAuditFilter() string { return SubjectRootAudit + ".*" }

// AuditInOrgFilter matches one org's audit subject.
func AuditInOrgFilter(orgID string) (string, error) { return AuditSubject(orgID) }

// AllProvisionFilter matches every org's provisioning subject.
func AllProvisionFilter() string { return SubjectRootProvision + ".*" }

// ProvisionInOrgFilter matches one org's provisioning subject.
func ProvisionInOrgFilter(orgID string) (string, error) { return ProvisionSubject(orgID) }

// SubjectKind names the shape a parsed subject has, including the non-event rpc shape.
type SubjectKind string

// Every subject shape in the taxonomy.
const (
	KindCall         SubjectKind = "call"
	KindRegistration SubjectKind = "registration"
	KindSIPDialog    SubjectKind = "sip-dialog"
	KindQueue        SubjectKind = "queue"
	KindVoicemail    SubjectKind = "voicemail"
	KindMedia        SubjectKind = "media"
	KindMessaging    SubjectKind = "messaging"
	KindTrunk        SubjectKind = "trunk"
	KindCDRLeg       SubjectKind = "cdr-leg"
	KindSecurity     SubjectKind = "security"
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
	// LegID is set for KindSIPDialog.
	LegID string
	// QueueID is set for KindQueue.
	QueueID string
	// MailboxID is set for KindVoicemail.
	MailboxID string
	// SessionID is set for KindMedia.
	SessionID string
	// TrunkID is set for KindTrunk.
	TrunkID string
	// ConversationID is set for KindMessaging.
	ConversationID string
	// SubjectRef is set for KindSecurity: SecurityScopeOrg, or the extension id the signal is about.
	SubjectRef string
	// Event is the (possibly dotted) event name, for the four per-entity families.
	//
	// A plain string, not a checked vocabulary member: a v1.n producer may emit an event name a
	// v1.0 consumer has never heard of, and rejecting it at parse time would break additive
	// evolution. Narrow with IsEventTypeOfFamily when the code needs to branch.
	Event string
	// Service and Method are set for KindRPC.
	Service string
	Method  string
	// Target is the variable tail an instance-addressed RPC subject carries — the <instanceToken>
	// of rpc.sip.v1.ring.<tok>, or the <orgId>.<appToken> of rpc.session.v1.announce. Empty on the
	// flat, queue-grouped subjects.
	Target string
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
	case prefix == "sip.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindSIPDialog, Family: string(FamilySIPDialog), Version: version,
			OrgID: rest[0], LegID: rest[1], Event: strings.Join(rest[2:], "."),
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
	case prefix == "messaging.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindMessaging, Family: string(FamilyMessaging), Version: version,
			OrgID: rest[0], ConversationID: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "security.evt" && len(rest) >= 3:
		return ParsedSubject{
			Kind: KindSecurity, Family: string(FamilySecurity), Version: version,
			OrgID: rest[0], SubjectRef: rest[1], Event: strings.Join(rest[2:], "."),
		}, true
	case prefix == "audit.evt" && len(rest) == 1:
		return ParsedSubject{
			Kind: KindAudit, Family: string(FamilyAudit), Version: version, OrgID: rest[0],
		}, true
	case prefix == "provision.evt" && len(rest) == 1:
		return ParsedSubject{
			Kind: KindProvision, Family: string(FamilyProvision), Version: version, OrgID: rest[0],
		}, true
	case first == "rpc" && len(rest) >= 1:
		return ParsedSubject{
			Kind: KindRPC, Family: "rpc", Version: version, Service: second, Method: rest[0],
			Target: strings.Join(rest[1:], "."),
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
// Reimplemented rather than taken from a client so filters can be unit-tested without a broker, and
// so a fake in-process bus routes exactly like the server does.
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
