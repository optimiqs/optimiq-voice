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
// Parsed separately from internal/transfer's because the encoding differs: on a REFER it is an
// escaped URI header inside `Refer-To`, on an INVITE a header in its own right.
type Replaces struct {
	CallID    string
	ToTag     string
	FromTag   string
	EarlyOnly bool
}

// ErrMalformedReplaces means the header was present and unparsable. Refused rather than ignored:
// ignoring it turns an attended transfer into a new call while the consultation call stays up.
var ErrMalformedReplaces = errors.New("invite: the Replaces header is malformed")

// ParseReplacesHeader parses the header form:
//
//	Replaces: <call-id>;to-tag=<tag>;from-tag=<tag>[;early-only]
//
// Both tags are REQUIRED by RFC 3891 §3. A Replaces missing one does not identify a dialog, and
// accepting it would ask this edge to guess which of two half-matches to tear down.
func ParseReplacesHeader(value string) (Replaces, error) {
	// The header form is not percent-encoded, but phones that copied the value out of a Refer-To
	// without unescaping it exist. Unescaping something that needs none is a no-op.
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

// correlateReplaces resolves a Replaces against this instance's dialogs and answers the RFC 3891 §3
// refusals: 481 when no dialog matches, 486 when `early-only` was set and the dialog is already
// answered (§3 forbids replacing a confirmed dialog), 500 otherwise.
//
// The authorisation check — whether the sender may replace that dialog — is deliberately elsewhere:
// this edge knows who authenticated, and the engine knows who is on which call.
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

// completeReplaces tears the replaced dialog down once the replacement has been answered.
//
// RFC 3891 §3: the UA that accepts an INVITE with Replaces BYEs the replaced dialog when it accepts,
// not when the INVITE arrives — so this runs off the replacement's own 2xx, from the executor, the
// one place that knows the answer is on the socket.
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
			// The termination reason is `replaced` and not `bye`: cause 16 alone looks exactly like
			// the caller ending the call, and a CDR could not report transfer rates.
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
