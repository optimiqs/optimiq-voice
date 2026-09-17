package invite

import (
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// The answer on a `progressed` event is a UAC fact, which is what the contract says
// (`sipDialogProgressedDataSchema.sdpAnswer`: "Present only on a UAC leg").
//
// The engine feeds a `progressed` `sdpAnswer` straight into `mediad.acceptAnswer` for the leg the
// event names. On a leg we DIALLED that is right — the body is the carrier's answer to the offer
// `mediad` wrote. On one we ANSWERED it is the answer this platform wrote itself, so echoing it back
// would settle the caller's own session against its own answer. The FLAG travels either way: the leg
// genuinely is in early media, and that is the fact a consumer needs.
func TestTheProgressedAnswerIsReportedOnlyOnALegWeDialled(t *testing.T) {
	body := []byte("v=0\r\no=- 1 1 IN IP4 198.51.100.1\r\nm=audio 40000 RTP/AVP 0\r\n")
	effect := dialog.Effect{
		Kind:   dialog.EffectPublish,
		Event:  dialog.EventProgressed,
		Status: 183,
		Body:   body,
	}

	for _, testCase := range []struct {
		name       string
		role       dialog.Role
		wantAnswer string
	}{
		{"a leg we dialled carries the carrier's answer", dialog.RoleUAC, string(body)},
		{"a leg we answered carries the flag and not our own body", dialog.RoleUAS, ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			d := newExecutorTestDialog(t, testCase.role)
			exec := &executor{handler: &Handler{now: func() time.Time { return time.Unix(0, 0) }}}

			event := exec.eventFor(d, effect)

			if !event.HasEarlyMedia {
				t.Fatalf("hasEarlyMedia = false, want true on a 183 that committed an answer")
			}
			if event.Status != 183 {
				t.Fatalf("status = %d, want 183", event.Status)
			}
			if event.SDPAnswer != testCase.wantAnswer {
				t.Fatalf("sdpAnswer = %q, want %q", event.SDPAnswer, testCase.wantAnswer)
			}
		})
	}
}

func newExecutorTestDialog(t *testing.T, role dialog.Role) *dialog.Dialog {
	t.Helper()
	created, err := dialog.New(dialog.Options{
		LegID:    testLeg,
		OrgID:    testOrg,
		CallID:   "018f0000-0000-7000-8000-00000000ca11",
		Role:     role,
		Identity: dialog.Identity{SIPCallID: "a84b4c76e66710@pc33", LocalTag: "local-tag"},
		Now:      func() time.Time { return time.Unix(0, 0) },
	})
	if err != nil {
		t.Fatalf("dialog.New: %v", err)
	}
	return created
}
