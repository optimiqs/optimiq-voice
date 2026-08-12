package invite

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
)

// PublishingSink turns this package's Event into one of the contract's six envelopes and hands it
// to a sipevents.Publisher.
//
// # Why the mapping lives here and not in internal/sipevents
//
// internal/sipevents is transport: it takes an envelope somebody else built and puts it on a stream,
// exactly as internal/events does for registrations. If it also built the envelopes it would need
// to know what a dialog is, and the package that publishes bytes would be the package that decides
// what a `dialog.answered` means. The seam is the envelope, and this file is the only thing on
// either side of it that knows both vocabularies.
//
// # The one refusal, and why it is a refusal
//
// An event with no orgId cannot be published at all: `sip.evt.v1.<orgId>.<legId>.<event>` has no
// `_unknown` token and the subject builder refuses an empty one. That is not a defect to work
// around — it is design §4.2's whole reason for making arrival an RPC rather than an event, so that
// every subject on this family carries a real tenant. An event that reaches here without one is a
// dialog that published before admission answered, and the honest response is to say so in the log
// rather than to invent a tenant or to drop it silently.
type PublishingSink struct {
	publisher sipevents.Publisher
	instance  string
	log       *slog.Logger
}

var _ EventSink = (*PublishingSink)(nil)

// NewPublishingSink builds the sink. Both arguments are required: a nil publisher is a wiring
// mistake, and an empty instance id would produce payloads no engine could address a command back
// at — which on this family means a call that rings and can never be answered.
func NewPublishingSink(publisher sipevents.Publisher, instanceID string, log *slog.Logger) (*PublishingSink, error) {
	if publisher == nil {
		return nil, errors.New("invite: a sip.evt.v1 publisher is required")
	}
	if strings.TrimSpace(instanceID) == "" {
		return nil, errors.New("invite: an instance id is required: every dialog event carries the " +
			"instance the engine must address its commands at")
	}
	if log == nil {
		log = slog.Default()
	}
	return &PublishingSink{publisher: publisher, instance: instanceID, log: log}, nil
}

// Publish implements EventSink.
func (s *PublishingSink) Publish(ctx context.Context, event Event) error {
	if event.OrgID == "" {
		// Logged at WARN and not returned as an error: the caller is an effect handler on a dialog
		// goroutine mid-teardown, and there is nothing it could usefully do. What matters is that the
		// line names the leg, so an operator can see exactly which call published before admission.
		s.log.Warn("cannot publish a dialog event for a leg with no tenant",
			"event", string(event.Kind), "legId", event.LegID, "sipCallId", event.SIPCallID)
		return nil
	}

	// Six branches and no shared helper, because Go has no way to write one: the six payloads are
	// distinct generated structs with no common interface, and a type-set constraint cannot reach
	// their fields. That is the same argument packages/events-go makes for having six constructors
	// rather than one, and the repetition is the price of the compiler checking every field name.
	switch event.Kind {
	case dialog.EventProgressed:
		envelope, err := contract.NewSIPDialogProgressedEnvelope(
			contract.EnvelopeInput[contract.SIPDialogProgressedData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				// Subject is deliberately left unset: NewSIPDialogProgressedEnvelope derives it from
				// Data.LegID, which is what makes it impossible to publish a payload whose leg
				// disagrees with its subject. An event applied to the wrong leg tears down somebody
				// else's call.
				Data: contract.SIPDialogProgressedData{
					LegID:         event.LegID,
					CallID:        event.CallID,
					InstanceID:    s.instance,
					Role:          contract.SIPDialogProgressedRole(event.Role.String()),
					Identity:      contract.SIPDialogProgressedIdentity(identityOf(event)),
					Status:        event.Status,
					HasEarlyMedia: event.HasEarlyMedia,
					SDPAnswer:     optional(event.SDPAnswer),
				},
			})
		if err != nil {
			return wrapEnvelope(event, err)
		}
		return s.publisher.Progressed(ctx, envelope)

	case dialog.EventAnswered:
		envelope, err := contract.NewSIPDialogAnsweredEnvelope(
			contract.EnvelopeInput[contract.SIPDialogAnsweredData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				Data: contract.SIPDialogAnsweredData{
					LegID:      event.LegID,
					CallID:     event.CallID,
					InstanceID: s.instance,
					Role:       contract.SIPDialogAnsweredRole(event.Role.String()),
					Identity:   contract.SIPDialogAnsweredIdentity(identityOf(event)),
					SDPAnswer:  optional(event.SDPAnswer),
					SetupMs:    positive(event.SetupMs),
				},
			})
		if err != nil {
			return wrapEnvelope(event, err)
		}
		return s.publisher.Answered(ctx, envelope)

	case dialog.EventHeld:
		// The contract's `held` direction is a TWO-member vocabulary — sendonly or inactive — because
		// those are the only two directions that constitute hold (see dialog.Direction.Holds). A
		// direction outside it means the state machine published a hold for a call that is not held,
		// and inventing a value would hide that; the envelope is refused and the log says which.
		direction := contract.SIPDialogHeldDirection(event.Direction)
		if !direction.Valid() {
			return fmt.Errorf("invite: %q is not a direction a dialog.held may carry (leg %s)",
				event.Direction, event.LegID)
		}
		envelope, err := contract.NewSIPDialogHeldEnvelope(
			contract.EnvelopeInput[contract.SIPDialogHeldData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				Data: contract.SIPDialogHeldData{
					LegID:      event.LegID,
					CallID:     event.CallID,
					InstanceID: s.instance,
					Role:       contract.SIPDialogHeldRole(event.Role.String()),
					Identity:   contract.SIPDialogHeldIdentity(identityOf(event)),
					Direction:  direction,
				},
			})
		if err != nil {
			return wrapEnvelope(event, err)
		}
		return s.publisher.Held(ctx, envelope)

	case dialog.EventResumed:
		direction := contract.SIPDialogResumedDirection(event.Direction)
		if !direction.Valid() {
			return fmt.Errorf("invite: %q is not a direction a dialog.resumed may carry (leg %s)",
				event.Direction, event.LegID)
		}
		envelope, err := contract.NewSIPDialogResumedEnvelope(
			contract.EnvelopeInput[contract.SIPDialogResumedData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				Data: contract.SIPDialogResumedData{
					LegID:      event.LegID,
					CallID:     event.CallID,
					InstanceID: s.instance,
					Role:       contract.SIPDialogResumedRole(event.Role.String()),
					Identity:   contract.SIPDialogResumedIdentity(identityOf(event)),
					Direction:  direction,
				},
			})
		if err != nil {
			return wrapEnvelope(event, err)
		}
		return s.publisher.Resumed(ctx, envelope)

	case dialog.EventTerminated:
		envelope, err := contract.NewSIPDialogTerminatedEnvelope(
			contract.EnvelopeInput[contract.SIPDialogTerminatedData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				Data: contract.SIPDialogTerminatedData{
					LegID:                 event.LegID,
					CallID:                event.CallID,
					InstanceID:            s.instance,
					Role:                  contract.SIPDialogTerminatedRole(event.Role.String()),
					Identity:              contract.SIPDialogTerminatedIdentity(identityOf(event)),
					Reason:                contract.SIPDialogTerminatedReason(event.Termination),
					Cause:                 event.Cause,
					Status:                positive(event.Status),
					CauseFromReasonHeader: event.CauseFromReasonHeader,
					Initiator:             initiatorOf(event.Initiator),
					AnsweredForSeconds:    positive(event.AnsweredForSeconds),
				},
			})
		if err != nil {
			return wrapEnvelope(event, err)
		}
		return s.publisher.Terminated(ctx, envelope)

	case dialog.EventDTMF:
		envelope, err := contract.NewSIPDialogDTMFEnvelope(
			contract.EnvelopeInput[contract.SIPDialogDTMFData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				Data: contract.SIPDialogDTMFData{
					LegID:      event.LegID,
					CallID:     event.CallID,
					InstanceID: s.instance,
					Role:       contract.SIPDialogDTMFRole(event.Role.String()),
					Identity:   contract.SIPDialogDTMFIdentity(identityOf(event)),
					Digit:      event.Digit,
					DurationMs: positive(event.DurationMs),
				},
			})
		if err != nil {
			return wrapEnvelope(event, err)
		}
		return s.publisher.DTMF(ctx, envelope)

	default:
		// An event kind this mapping does not know is contract drift in the other direction: somebody
		// added a member to dialog.DialogEvent without adding it here. Loud, because the alternative
		// is an event nobody ever sees and a leg the engine never hears about.
		return fmt.Errorf("invite: %q is not a dialog event this sink can publish (leg %s)",
			event.Kind, event.LegID)
	}
}

// eventSource is the `source` field stamped on every envelope this edge publishes. It matches
// config.EventSource; it is restated rather than imported because internal/config is main's
// vocabulary and this package has never depended on it.
const eventSource = "sipd"

// identity is the shape the six generated Identity fragments all share. They are six distinct named
// types with identical layouts, so one struct converts to all of them — which is why the call sites
// above read `contract.SIPDialogXIdentity(identityOf(event))` rather than repeating three fields six
// times.
type identity struct {
	SIPCallID string  `json:"sipCallId"`
	LocalTag  *string `json:"localTag,omitempty"`
	RemoteTag *string `json:"remoteTag,omitempty"`
}

func identityOf(event Event) identity {
	return identity{
		SIPCallID: event.SIPCallID,
		LocalTag:  optional(event.LocalTag),
		RemoteTag: optional(event.RemoteTag),
	}
}

// initiatorOf maps this package's initiator onto the contract's, defaulting an unset one to `timer`.
//
// `timer` and not `local`, and the choice is the conservative one: an initiator nobody recorded is
// a teardown no code path claimed, which is what a deadline looks like. Reporting it as `local`
// would attribute a call the platform did not end to the platform, and that is the direction of
// error that loses an argument with a customer.
func initiatorOf(initiator dialog.Initiator) contract.SIPDialogTerminatedInitiator {
	if !initiator.Valid() {
		return contract.SIPDialogTerminatedInitiatorTimer
	}
	return contract.SIPDialogTerminatedInitiator(initiator)
}

func positive(value int) *int {
	if value <= 0 {
		return nil
	}
	copied := value
	return &copied
}

func wrapEnvelope(event Event, err error) error {
	return fmt.Errorf("invite: cannot build the %s envelope for leg %s: %w",
		event.Kind, event.LegID, err)
}
