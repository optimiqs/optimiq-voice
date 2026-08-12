package invite

import (
	"context"
	"strings"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/sipevents"
)

const (
	testOrg = "018f0000-0000-7000-8000-000000000000"
	testLeg = "018f0000-0000-7000-8000-00000000le61"
)

func testEvent(kind dialog.DialogEvent) Event {
	return Event{
		Kind:      kind,
		LegID:     testLeg,
		OrgID:     testOrg,
		CallID:    "018f0000-0000-7000-8000-00000000ca11",
		SIPCallID: "a84b4c76e66710@pc33",
		LocalTag:  "local-tag",
		RemoteTag: "remote-tag",
		Role:      dialog.RoleUAS,
		At:        time.Date(2026, 8, 12, 12, 0, 0, 0, time.UTC),
	}
}

func newTestSink(t *testing.T) (*PublishingSink, *sipevents.RecordingPublisher) {
	t.Helper()
	publisher := sipevents.NewRecordingPublisher()
	sink, err := NewPublishingSink(publisher, "sipd-7c9f", nil)
	if err != nil {
		t.Fatalf("NewPublishingSink: %v", err)
	}
	return sink, publisher
}

// The subject is derived from the payload's leg id by the contract's own constructor, so a payload
// whose leg disagrees with its subject cannot be built. This asserts the shape a consumer filters
// on — an engine subscribing `sip.evt.v1.>` needs the org and the leg exactly here.
func TestEverySubjectCarriesTheTenantAndTheLeg(t *testing.T) {
	sink, publisher := newTestSink(t)
	ctx := context.Background()

	for _, kind := range []dialog.DialogEvent{
		dialog.EventProgressed,
		dialog.EventAnswered,
		dialog.EventTerminated,
		dialog.EventDTMF,
	} {
		event := testEvent(kind)
		if kind == dialog.EventTerminated {
			event.Termination = dialog.ReasonBye
			event.Initiator = dialog.InitiatorRemote
			event.Cause = 16
		}
		if kind == dialog.EventDTMF {
			event.Digit = "5"
		}
		if err := sink.Publish(ctx, event); err != nil {
			t.Fatalf("Publish(%s): %v", kind, err)
		}
	}

	want := "sip.evt.v1." + testOrg + "." + testLeg + "."
	for _, subject := range []string{
		publisher.ProgressedEvents()[0].Subject,
		publisher.AnsweredEvents()[0].Subject,
		publisher.TerminatedEvents()[0].Subject,
		publisher.DTMFEvents()[0].Subject,
	} {
		if !strings.HasPrefix(subject, want) {
			t.Fatalf("subject %q does not start with %q", subject, want)
		}
	}
}

// Every payload names the instance the engine must address its commands at. A dialog lives on one
// process, so an event without it is a leg nothing can ring, answer or hang up.
func TestEveryPayloadNamesTheOwningInstance(t *testing.T) {
	sink, publisher := newTestSink(t)
	event := testEvent(dialog.EventTerminated)
	event.Termination = dialog.ReasonBye
	event.Initiator = dialog.InitiatorLocal

	if err := sink.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got := publisher.TerminatedEvents()[0].Data.InstanceID; got != "sipd-7c9f" {
		t.Fatalf("instanceId = %q, want sipd-7c9f", got)
	}
}

// An event with no tenant cannot be published at all — the subject has no `_unknown` token — and it
// must not be an error the effect handler has to cope with mid-teardown. It is logged and dropped,
// and this asserts the drop rather than a panic or a malformed subject.
func TestAnEventWithNoTenantIsDroppedRatherThanPublished(t *testing.T) {
	sink, publisher := newTestSink(t)
	event := testEvent(dialog.EventProgressed)
	event.OrgID = ""

	if err := sink.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish returned %v; a tenantless event must not fail the teardown path", err)
	}
	if publisher.Len() != 0 {
		t.Fatalf("published %d events with no tenant, want 0", publisher.Len())
	}
}

// The terminal event's four independent facts: why (cause), how (reason), who (initiator), and
// whether the why was STATED or derived. A consumer that could not tell the last one apart cannot
// know which of two disagreeing CDRs to believe.
func TestTheTerminalPayloadCarriesAllFourFacts(t *testing.T) {
	sink, publisher := newTestSink(t)
	event := testEvent(dialog.EventTerminated)
	event.Termination = dialog.ReasonBye
	event.Cause = 16
	event.Status = 200
	event.Initiator = dialog.InitiatorRemote
	event.CauseFromReasonHeader = true
	event.AnsweredForSeconds = 42

	if err := sink.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	data := publisher.TerminatedEvents()[0].Data
	if data.Reason != contract.SIPDialogTerminatedReasonBye {
		t.Fatalf("reason = %q, want bye", data.Reason)
	}
	if data.Cause != 16 {
		t.Fatalf("cause = %d, want 16", data.Cause)
	}
	if data.Initiator != contract.SIPDialogTerminatedInitiatorRemote {
		t.Fatalf("initiator = %q, want remote", data.Initiator)
	}
	if !data.CauseFromReasonHeader {
		t.Fatal("causeFromReasonHeader was lost; a stated cause is better evidence than a derived one")
	}
	if data.AnsweredForSeconds == nil || *data.AnsweredForSeconds != 42 {
		t.Fatalf("answeredForSeconds = %v, want 42", data.AnsweredForSeconds)
	}
}

// An unrecorded initiator becomes `timer`, not `local`. A teardown no code path claimed is what a
// deadline looks like, and attributing it to the platform is the direction of error that loses an
// argument with a customer.
func TestAnUnrecordedInitiatorBecomesTimer(t *testing.T) {
	sink, publisher := newTestSink(t)
	event := testEvent(dialog.EventTerminated)
	event.Termination = dialog.ReasonTimeout

	if err := sink.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if got := publisher.TerminatedEvents()[0].Data.Initiator; got != contract.SIPDialogTerminatedInitiatorTimer {
		t.Fatalf("initiator = %q, want timer", got)
	}
}

// `held` carries a two-member vocabulary because those are the only two directions that constitute
// hold. A direction outside it means the state machine published a hold for a call that is not held,
// and inventing a value would hide that.
func TestHoldRefusesADirectionThatIsNotHold(t *testing.T) {
	sink, publisher := newTestSink(t)
	event := testEvent(dialog.EventHeld)
	event.Direction = dialog.DirectionSendRecv

	err := sink.Publish(context.Background(), event)
	if err == nil {
		t.Fatal("a dialog.held with direction sendrecv was published")
	}
	if !strings.Contains(err.Error(), "sendrecv") {
		t.Fatalf("error = %v, want it to name the offending direction", err)
	}
	if publisher.Len() != 0 {
		t.Fatal("an invalid held event reached the stream")
	}

	event.Direction = dialog.DirectionSendOnly
	if err := sink.Publish(context.Background(), event); err != nil {
		t.Fatalf("a legitimate hold was refused: %v", err)
	}
	if got := publisher.HeldEvents()[0].Data.Direction; got != contract.SIPDialogHeldDirectionSendonly {
		t.Fatalf("direction = %q, want sendonly", got)
	}
}

// `answered` means two different moments and the role is what disambiguates them: the ACK for a UAS
// leg and the 2xx for a UAC one. Losing the role would make billsec start in the wrong place for
// half the legs on the platform.
func TestTheRoleTravelsOnEveryPayload(t *testing.T) {
	sink, publisher := newTestSink(t)
	event := testEvent(dialog.EventAnswered)
	event.Role = dialog.RoleUAC
	event.SetupMs = 1234

	if err := sink.Publish(context.Background(), event); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	data := publisher.AnsweredEvents()[0].Data
	if data.Role != contract.SIPDialogAnsweredRoleUac {
		t.Fatalf("role = %q, want uac", data.Role)
	}
	if data.SetupMs == nil || *data.SetupMs != 1234 {
		t.Fatalf("setupMs = %v, want 1234", data.SetupMs)
	}
}

// An event kind this mapping does not know is contract drift, and it must be loud: the alternative
// is an event nobody sees and a leg the engine never hears about.
func TestAnUnknownEventKindIsLoud(t *testing.T) {
	sink, _ := newTestSink(t)
	event := testEvent("dialog.invented")

	if err := sink.Publish(context.Background(), event); err == nil {
		t.Fatal("an unknown event kind was silently accepted")
	}
}

// An empty instance id would produce payloads no engine could address a command back at, which on
// this family means a call that rings and can never be answered.
func TestTheSinkRefusesAnEmptyInstanceID(t *testing.T) {
	if _, err := NewPublishingSink(sipevents.NewRecordingPublisher(), "  ", nil); err == nil {
		t.Fatal("NewPublishingSink accepted an empty instance id")
	}
	if _, err := NewPublishingSink(nil, "sipd", nil); err == nil {
		t.Fatal("NewPublishingSink accepted a nil publisher")
	}
}
