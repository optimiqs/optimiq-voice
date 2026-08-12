package dialog

import (
	"strconv"
	"strings"

	"github.com/emiago/sipgo/sip"
	events "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// The Q.850 causes this edge names. Bare integers at a call site are how a 16 becomes a 17 in
// review, and every one of these ends up on a CDR row that somebody bills from.
//
// # One table, and this is the copy that is no longer one
//
// The VALUES come from packages/events-go/hangup_causes_gen.go, which is generated from
// packages/telephony/src/hangup-causes.ts — the taxonomy's canonical home, pinned by its own spec
// against the frozen reference §6. Until that generator landed this file held a second hand-written
// copy of the same numbers, which is precisely the drift the rest of this repository spends a
// codegen step avoiding: a re-coded cause silently changes outbound failover on the TypeScript side
// and silently changes what this edge reports on the Go side, and nothing would have caught the
// disagreement.
//
// The NAMES stay local, and that is not laziness. `CauseUserBusy` reads correctly beside a 486 in
// the table below, where `events.HangupCodeUserBusy` would read as an import; and the SIP -> Q.850
// mapping itself IS the edge's own knowledge (RFC 3398), which nothing outside the SIP stack has an
// opinion about. What moved is the answer to "what number is USER_BUSY", which two languages were
// answering separately.
const (
	// CauseUnallocatedNumber is Q.850 1. SIP 404.
	CauseUnallocatedNumber = events.HangupCodeUnallocatedNumber
	// CauseNoRouteDestination is Q.850 3. SIP 404 from a proxy that could not route.
	CauseNoRouteDestination = events.HangupCodeNoRouteDestination
	// CauseNormalClearing is Q.850 16: somebody hung up, and nothing went wrong.
	CauseNormalClearing = events.HangupCodeNormalClearing
	// CauseUserBusy is Q.850 17. SIP 486.
	CauseUserBusy = events.HangupCodeUserBusy
	// CauseNoUserResponse is Q.850 18. SIP 408 — the far end never answered anything.
	CauseNoUserResponse = events.HangupCodeNoUserResponse
	// CauseNoAnswer is Q.850 19: it rang and nobody picked up. SIP 480 in the ring-timeout sense.
	CauseNoAnswer = events.HangupCodeNoAnswer
	// CauseSubscriberAbsent is Q.850 20. SIP 480 when the target has no live registration.
	CauseSubscriberAbsent = events.HangupCodeSubscriberAbsent
	// CauseCallRejected is Q.850 21. SIP 403 and 603 — a deliberate refusal.
	CauseCallRejected = events.HangupCodeCallRejected
	// CauseNumberChanged is Q.850 22. SIP 410.
	CauseNumberChanged = events.HangupCodeNumberChanged
	// CauseDestinationOutOfOrder is Q.850 27. SIP 502.
	CauseDestinationOutOfOrder = events.HangupCodeDestinationOutOfOrder
	// CauseInvalidNumberFormat is Q.850 28. SIP 484.
	CauseInvalidNumberFormat = events.HangupCodeInvalidNumberFormat
	// CauseFacilityRejected is Q.850 29. SIP 501 and 503-with-no-better-idea.
	CauseFacilityRejected = events.HangupCodeFacilityRejected
	// CauseNormalUnspecified is Q.850 31: the honest "something ended it and we do not know what".
	CauseNormalUnspecified = events.HangupCodeNormalUnspecified
	// CauseNoCircuitAvailable is Q.850 34. SIP 503 from a trunk at capacity. NORMAL_CIRCUIT_CONGESTION
	// upstream; the local name says what an operator reading a SIP log is looking for.
	CauseNoCircuitAvailable = events.HangupCodeNormalCircuitCongestion
	// CauseNetworkOutOfOrder is Q.850 38. SIP 503 with no route at all.
	CauseNetworkOutOfOrder = events.HangupCodeNetworkOutOfOrder
	// CauseTemporaryFailure is Q.850 41. SIP 503, and the cause a reaped dialog carries when its
	// owning instance died (design §6.2, "instance-lost").
	CauseTemporaryFailure = events.HangupCodeNormalTemporaryFailure
	// CauseSwitchCongestion is Q.850 42. SIP 503 under load shedding.
	CauseSwitchCongestion = events.HangupCodeSwitchCongestion
	// CauseRequestedChanUnavail is Q.850 44. SIP 503.
	CauseRequestedChanUnavail = events.HangupCodeRequestedChanUnavail
	// CauseBearerCapabilityNotAvail is Q.850 58. SIP 488 — the far end and mediad cannot agree.
	CauseBearerCapabilityNotAvail = events.HangupCodeBearercapabilityNotavail
	// CauseIncompatibleDestination is Q.850 88. SIP 488 in the codec sense (design §5.2).
	CauseIncompatibleDestination = events.HangupCodeIncompatibleDestination
	// CauseRecoveryOnTimerExpire is Q.850 102: every timeout, including RFC 4028 session-timer
	// expiry and a 2xx that was never ACKed.
	CauseRecoveryOnTimerExpire = events.HangupCodeRecoveryOnTimerExpire
	// CauseInterworking is Q.850 127: a status we have no better opinion about.
	CauseInterworking = events.HangupCodeInterworking
)

// causeForStatus is the RFC 3398 §7.2.4.1 table, plus the handful of points that table leaves to
// the gateway.
//
// It is a table and not a switch because the design says so and because the reason is real: the
// engine has to agree with it byte for byte or one plane's CDR disposition disagrees with the
// other's for the same call. Design §3.3 puts the canonical copy in packages/events-go so both
// languages read one source; until that lands this is the copy, and moving it is a mechanical
// change with a parity test on the far side.
var causeForStatus = map[int]int{
	400: CauseInterworking,
	401: CauseCallRejected,
	402: CauseCallRejected,
	403: CauseCallRejected,
	404: CauseUnallocatedNumber,
	405: CauseFacilityRejected,
	406: CauseInterworking,
	407: CauseCallRejected,
	408: CauseNoUserResponse,
	409: CauseInterworking,
	410: CauseNumberChanged,
	411: CauseInterworking,
	413: CauseInterworking,
	414: CauseInterworking,
	415: CauseBearerCapabilityNotAvail,
	416: CauseInterworking,
	420: CauseInterworking,
	480: CauseSubscriberAbsent,
	481: CauseInterworking,
	482: CauseInterworking,
	483: CauseInterworking,
	484: CauseInvalidNumberFormat,
	485: CauseUnallocatedNumber,
	486: CauseUserBusy,
	487: CauseNormalClearing,
	488: CauseIncompatibleDestination,
	500: CauseTemporaryFailure,
	501: CauseFacilityRejected,
	502: CauseDestinationOutOfOrder,
	503: CauseTemporaryFailure,
	504: CauseRecoveryOnTimerExpire,
	505: CauseInterworking,
	580: CauseBearerCapabilityNotAvail,
	600: CauseUserBusy,
	603: CauseCallRejected,
	604: CauseUnallocatedNumber,
	606: CauseBearerCapabilityNotAvail,
}

// CauseForStatus maps a SIP status onto a Q.850 cause per RFC 3398.
//
// Unlisted codes fall back by CLASS, which is what RFC 3398 §8.2.6.1 prescribes for exactly this
// case: a 4xx nobody has heard of still means "the request failed", and answering 127 Interworking
// for every one of them would throw away the only thing we did learn. 2xx and 1xx map to normal
// clearing because the only way a success reaches a teardown path is a call that ended normally.
func CauseForStatus(status int) int {
	if cause, found := causeForStatus[status]; found {
		return cause
	}
	switch {
	case status < 200:
		return CauseNormalClearing
	case status < 300:
		return CauseNormalClearing
	case status < 400:
		// 3xx is a redirect we did not follow. "No route to destination" is the honest summary: we
		// were told to look elsewhere and did not.
		return CauseNoRouteDestination
	case status < 500:
		return CauseInterworking
	case status < 600:
		return CauseTemporaryFailure
	default:
		return CauseCallRejected
	}
}

// CauseFromReason reads an RFC 3326 `Reason` header value and returns the Q.850 cause it carries.
//
// # Why this wins over the status code
//
// A Reason header is the far end's own switch telling us what it decided. Re-deriving a cause from
// the status code when the far end has already stated one is discarding better evidence for worse
// (design §3.3) — a carrier that sends `503` with `Reason: Q.850;cause=34` is saying "no circuit",
// not "I am broken", and those bill differently.
//
// Only the `Q.850` protocol is honoured. `Reason: SIP;cause=487` restates the status line and
// re-mapping it would be the same derivation with an extra parse in front; anything else is a
// protocol we hold no table for, and guessing would be worse than the status code we already have.
func CauseFromReason(value string) (int, bool) {
	for _, entry := range splitReasonEntries(value) {
		protocol, params, _ := strings.Cut(entry, ";")
		if !strings.EqualFold(strings.TrimSpace(protocol), "Q.850") {
			continue
		}
		for _, param := range strings.Split(params, ";") {
			name, raw, found := strings.Cut(strings.TrimSpace(param), "=")
			if !found || !strings.EqualFold(strings.TrimSpace(name), "cause") {
				continue
			}
			cause, err := strconv.Atoi(strings.Trim(strings.TrimSpace(raw), `"`))
			if err != nil || cause < 0 || cause > 127 {
				// Q.850 defines nothing above 127 and a negative cause is nonsense. A malformed value
				// is treated as absent rather than as zero: zero is not a Q.850 point, and letting it
				// through would put an unbillable cause on a CDR.
				continue
			}
			return cause, true
		}
	}
	return 0, false
}

// splitReasonEntries splits a comma-separated Reason header value, which RFC 3326 §2 permits: a
// message may carry several reasons in one header, one per protocol.
func splitReasonEntries(value string) []string {
	parts := strings.Split(value, ",")
	entries := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			entries = append(entries, trimmed)
		}
	}
	return entries
}

// causeOfResponse is the whole rule in one place: the far end's Reason header if it sent one,
// otherwise RFC 3398 on the status line.
func causeOfResponse(res *sip.Response) int {
	for _, header := range res.GetHeaders("Reason") {
		if cause, found := CauseFromReason(header.Value()); found {
			return cause
		}
	}
	return CauseForStatus(res.StatusCode)
}

// causeOfRequest reads the Reason header off a BYE or a CANCEL, which RFC 3326 §2 explicitly
// allows and which is the only way to learn WHY a far end hung up. A BYE with no Reason is normal
// clearing, because that is what a BYE means when nobody says otherwise.
func causeOfRequest(req *sip.Request) int {
	for _, header := range req.GetHeaders("Reason") {
		if cause, found := CauseFromReason(header.Value()); found {
			return cause
		}
	}
	return CauseNormalClearing
}

// StatusForCause is the reverse direction, for the one place that needs it: `rpc.sip.v1.hangup`
// hands this edge a Q.850 cause for a leg that has NOT been answered, and an unanswered leg is
// ended with a SIP failure response rather than a BYE (design §10.3).
//
// It is deliberately not the inverse of the table above — Q.850 is finer than SIP in some places
// and coarser in others — and it is deliberately conservative: anything without a defensible
// status becomes 480, which is the status a caller can act on ("try again or try elsewhere")
// rather than 500, which tells them we are broken.
func StatusForCause(cause int) (int, string) {
	switch cause {
	case CauseUnallocatedNumber, CauseNumberChanged:
		return 404, "Not Found"
	case CauseNoRouteDestination:
		return 404, "Not Found"
	case CauseNormalClearing:
		return 487, "Request Terminated"
	case CauseUserBusy:
		return 486, "Busy Here"
	case CauseNoUserResponse, CauseNoAnswer, CauseSubscriberAbsent:
		return 480, "Temporarily Unavailable"
	case CauseCallRejected:
		return 403, "Forbidden"
	case CauseDestinationOutOfOrder:
		return 502, "Bad Gateway"
	case CauseInvalidNumberFormat:
		return 484, "Address Incomplete"
	case CauseFacilityRejected:
		return 501, "Not Implemented"
	case CauseNoCircuitAvailable, CauseNetworkOutOfOrder, CauseTemporaryFailure,
		CauseSwitchCongestion, CauseRequestedChanUnavail:
		return 503, "Service Unavailable"
	case CauseBearerCapabilityNotAvail, CauseIncompatibleDestination:
		return 488, "Not Acceptable Here"
	case CauseRecoveryOnTimerExpire:
		return 408, "Request Timeout"
	default:
		return 480, "Temporarily Unavailable"
	}
}

// ReasonHeader renders the RFC 3326 header this edge puts on its own BYEs and CANCELs.
//
// We send one for the same reason we read one: the far end's CDR is as entitled to the real cause
// as ours is, and a BYE with no Reason forces the other switch to guess "normal clearing" for a
// call that was actually torn down by a session-timer expiry.
func ReasonHeader(cause int) string {
	return "Q.850;cause=" + strconv.Itoa(cause)
}
