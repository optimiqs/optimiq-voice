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
// to a sipevents.Publisher. The seam is the envelope: internal/sipevents is transport and must not
// need to know what a dialog is.
//
// An event with no orgId cannot be published at all — `sip.evt.v1.<orgId>.<legId>.<event>` has no
// `_unknown` token — so one that reaches here is a dialog that published before admission answered.
type PublishingSink struct {
	publisher sipevents.Publisher
	finalizer *sipevents.Finalizer
	instance  string
	log       *slog.Logger
}

var _ EventSink = (*PublishingSink)(nil)

// NewPublishingSink builds the sink. Both arguments are required: an empty instance id would
// produce payloads no engine could address a command back at, so the call could never be answered.
func NewPublishingSink(publisher sipevents.Publisher, instanceID string, log *slog.Logger) (*PublishingSink, error) {
	return NewFinalizingSink(publisher, instanceID, nil, log)
}

// NewFinalizingSink is NewPublishingSink plus the finalizer that holds a leg's `sip-dialogs` claim
// until the stream has acknowledged its `dialog.terminated`. Without one the terminal event is
// fire-and-forget and the claim is released on trust.
func NewFinalizingSink(
	publisher sipevents.Publisher,
	instanceID string,
	finalizer *sipevents.Finalizer,
	log *slog.Logger,
) (*PublishingSink, error) {
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
	return &PublishingSink{
		publisher: publisher,
		finalizer: finalizer,
		instance:  instanceID,
		log:       log,
	}, nil
}

// Publish implements EventSink.
func (s *PublishingSink) Publish(ctx context.Context, event Event) error {
	if event.OrgID == "" {
		// Logged and not returned: the caller is an effect handler on a dialog goroutine
		// mid-teardown, and there is nothing it could usefully do.
		s.log.Warn("cannot publish a dialog event for a leg with no tenant",
			"event", string(event.Kind), "legId", event.LegID, "sipCallId", event.SIPCallID)
		return nil
	}

	// Six branches and no shared helper: the payloads are distinct generated structs with no common
	// interface, and a type-set constraint cannot reach their fields.
	switch event.Kind {
	case dialog.EventProgressed:
		envelope, err := contract.NewSIPDialogProgressedEnvelope(
			contract.EnvelopeInput[contract.SIPDialogProgressedData]{
				OrgID:  event.OrgID,
				Source: eventSource,
				At:     event.At,
				// Subject is deliberately unset: the constructor derives it from Data.LegID, so a
				// payload's leg cannot disagree with its subject.
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
		// The contract's `held` direction is a two-member vocabulary — sendonly or inactive. Anything
		// else means the state machine published a hold for a call that is not held, so it is
		// refused rather than coerced.
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
		if s.finalizer != nil {
			// Off this goroutine and acknowledged: the claim that lets another instance reap this leg
			// is released only once the stream has the termination (see sipevents.Finalizer).
			return s.finalizer.Terminated(envelope)
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
		// A member was added to dialog.DialogEvent without adding it here. Loud, because the
		// alternative is a leg the engine never hears about.
		return fmt.Errorf("invite: %q is not a dialog event this sink can publish (leg %s)",
			event.Kind, event.LegID)
	}
}

// eventSource is the `source` field stamped on every envelope this edge publishes. It must match
// config.EventSource, restated rather than imported so this package stays independent of main's.
const eventSource = "sipd"

// identity is the shape the six generated Identity fragments share. They are distinct named types
// with identical layouts, so this one struct converts to all of them.
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

// initiatorOf maps this package's initiator onto the contract's, defaulting an unset one to `timer`
// rather than `local`: a teardown no code path claimed looks like a deadline, and reporting `local`
// would attribute to the platform a call it did not end.
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
	return new(value)
}

func wrapEnvelope(event Event, err error) error {
	return fmt.Errorf("invite: cannot build the %s envelope for leg %s: %w",
		event.Kind, event.LegID, err)
}
