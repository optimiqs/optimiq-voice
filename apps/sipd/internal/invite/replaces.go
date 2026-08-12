package invite

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// Replaces is a parsed RFC 3891 Replaces: the dialog an attended transfer completes into.
//
// It is the same shape `internal/transfer` parses off a Refer-To's URI header, and it is parsed
// again here because it arrives differently: on a REFER it is an ESCAPED URI header inside
// `Refer-To`, and on an INVITE it is a HEADER in its own right. Same grammar, two encodings, and a
// parser that assumed one of them would silently fail on the other — which for an attended transfer
// means the consultation call is left up and the transfer target is dialled as a fresh call.
type Replaces struct {
	CallID    string
	ToTag     string
	FromTag   string
	EarlyOnly bool
}

// ErrMalformedReplaces means the header was present and unparsable.
//
// Refused rather than ignored, and that choice is the whole point: ignoring a Replaces turns an
// attended transfer into a NEW call to the transfer target, while the consultation call the user is
// talking on stays up. The user ends up in two calls and the person they were transferring hears
// hold music forever.
var ErrMalformedReplaces = errors.New("invite: the Replaces header is malformed")

// ParseReplacesHeader parses the header form:
//
//	Replaces: <call-id>;to-tag=<tag>;from-tag=<tag>[;early-only]
//
// Both tags are REQUIRED by RFC 3891 §3. A Replaces missing one does not identify a dialog, and
// accepting it would ask this edge to guess which of two half-matches to tear down.
func ParseReplacesHeader(value string) (Replaces, error) {
	// The header form is not percent-encoded, but a phone that copied the value out of a Refer-To
	// without unescaping it is a real bug in the field. Unescaping something that needs none is a
	// no-op, so this is free robustness rather than a guess.
	if unescaped, err := url.QueryUnescape(value); err == nil {
		value = unescaped
	}

	parts := strings.Split(value, ";")
	replaces := Replaces{CallID: strings.TrimSpace(parts[0])}
	if replaces.CallID == "" {
		return Replaces{}, fmt.Errorf("%w: no call-id", ErrMalformedReplaces)
	}
	for _, part := range parts[1:] {
		name, raw, found := strings.Cut(strings.TrimSpace(part), "=")
		name = strings.ToLower(strings.TrimSpace(name))
		raw = strings.Trim(strings.TrimSpace(raw), `"`)
		switch {
		case name == "to-tag" && found:
			replaces.ToTag = raw
		case name == "from-tag" && found:
			replaces.FromTag = raw
		case name == "early-only":
			replaces.EarlyOnly = true
		}
	}
	if replaces.ToTag == "" || replaces.FromTag == "" {
		return Replaces{}, fmt.Errorf("%w: to-tag and from-tag are both required", ErrMalformedReplaces)
	}
	return replaces, nil
}

// replacesOf reads the header off an INVITE, and reports whether there was one.
func replacesOf(req *sip.Request) (Replaces, bool, error) {
	header := req.GetHeader("Replaces")
	if header == nil || strings.TrimSpace(header.Value()) == "" {
		return Replaces{}, false, nil
	}
	replaces, err := ParseReplacesHeader(header.Value())
	if err != nil {
		return Replaces{}, true, err
	}
	return replaces, true, nil
}

// correlateReplaces resolves a Replaces against this instance's dialogs and answers the RFC 3891
// §3 refusals.
//
// # The four answers, each mandated and each meaning something different to the transferring phone
//
//   - 481 Call/Transaction Does Not Exist: no dialog matches. The consultation call ended while the
//     transfer was being set up, which is the ordinary race when somebody hangs up mid-transfer.
//   - 603 Decline / 486 Busy Here: `early-only` was set and the dialog is already answered.
//     RFC 3891 §3 says an early-only Replaces MUST NOT replace a confirmed dialog — it exists so a
//     transfer target can decline to steal a call somebody else has already picked up, and honouring
//     it is the difference between "you were too late" and "you cut into a live conversation".
//   - 501 Not Implemented: the header named a dialog on ANOTHER instance. This edge cannot replace a
//     dialog it does not hold, because replacing it means BYEing it, and the BYE has to come from
//     the process that holds its CSeq (design §6.1). A dialog-affine front end is what stops this
//     from happening; the answer here is what makes it diagnosable when it does.
//   - Accepted: the dialog is ours, alive, and matches.
//
// The AUTHORISATION check — is the party sending this INVITE entitled to replace that dialog — is
// deliberately not here. It is the same boundary the REFER handler already draws: this edge knows
// who authenticated, and the engine knows who is on which call. See the wave report for the engine
// counterpart this needs.
func (h *Handler) correlateReplaces(replaces Replaces) (*dialog.Dialog, Refusal, error) {
	replaced, err := h.dialogs.FindReplaced(
		replaces.CallID, replaces.ToTag, replaces.FromTag, replaces.EarlyOnly)
	switch {
	case errors.Is(err, dialog.ErrUnknownDialog), errors.Is(err, dialog.ErrDialogGone):
		return nil, Refusal{Status: 481, Reason: "Call/Transaction Does Not Exist"}, err
	case errors.Is(err, dialog.ErrInvalidState):
		// early-only against a confirmed dialog. 486 rather than 603: 603 declines the call
		// globally and stops a forking proxy trying the other branches, and this refusal is about
		// this branch only.
		return nil, Refusal{Status: 486, Reason: "Busy Here"}, err
	case err != nil:
		return nil, Refusal{Status: 500, Reason: "Server Internal Error"}, err
	}
	return replaced, Refusal{}, nil
}

// completeReplaces tears the replaced dialog down, once the replacement has been answered.
//
// # When, exactly
//
// RFC 3891 §3: the UA that accepts an INVITE with Replaces terminates the replaced dialog with a
// BYE, and it does so when it ACCEPTS — not when the INVITE arrives. The distinction is not
// pedantry: tearing down on arrival and then failing to answer the replacement would leave the user
// with no call at all, having hung up a conversation that was working.
//
// So this runs off the replacement's own 2xx, from the executor, which is the one place that knows
// the answer is on the socket.
func (h *Handler) completeReplaces(replacedLegID string) {
	if replacedLegID == "" {
		return
	}
	h.withLeg(replacedLegID, func(session *dialog.Session, _ *legState) {
		ctx, cancel := context.WithTimeout(h.baseCtx, 5*time.Second)
		defer cancel()
		_, err := session.Do(ctx, func(d *dialog.Dialog) (dialog.Outcome, error) {
			outcome, err := d.Apply(dialog.Input{
				Trigger: dialog.TriggerLocalHangup,
				Cause:   dialog.CauseNormalClearing,
			})
			if err != nil {
				return outcome, err
			}
			// The termination REASON is `replaced` and not `bye`, because a CDR that cannot tell an
			// attended transfer from a hang-up cannot report transfer rates — and cause 16 alone
			// looks exactly like the caller ending the call.
			for index := range outcome.Effects {
				if outcome.Effects[index].Kind == dialog.EffectPublish &&
					outcome.Effects[index].Event == dialog.EventTerminated {
					outcome.Effects[index].Termination = dialog.ReasonReplaced
				}
			}
			return outcome, nil
		})
		if err != nil {
			h.log.Warn("cannot tear down the replaced dialog",
				"legId", replacedLegID, "error", err)
			return
		}
		h.log.Info("attended transfer completed; the replaced dialog was ended",
			"replacedLegId", replacedLegID)
	})
}
