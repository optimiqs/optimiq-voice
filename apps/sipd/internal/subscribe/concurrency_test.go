package subscribe_test

import (
	"fmt"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/presence"
)

// watch subscribes `count` distinct dialogs to the watched extension.
func watch(t *testing.T, h *harness, count int) {
	t.Helper()
	for index := range count {
		res := h.subscribe(subscribeOptions{callID: fmt.Sprintf("blf-%d@phone.invalid", index)})
		if res.StatusCode != 200 {
			t.Fatalf("SUBSCRIBE %d = %d", index, res.StatusCode)
		}
	}
	if held := h.handler.Subscriptions(); held != count {
		t.Fatalf("the table holds %d subscriptions, want %d", held, count)
	}
	h.drain()
	h.notifier.reset()
}

func activeChange() presence.Change {
	return presence.Change{
		OrgID:           testOrg,
		ExtensionNumber: watchedExt,
		State: presence.State{
			OrgID:           testOrg,
			ExtensionNumber: watchedExt,
			State:           contract.PresenceDeviceStateActive,
			ChannelCount:    1,
		},
	}
}

// A busy-lamp wall is many watchers on ONE extension, so a single change costs one NOTIFY per
// watcher. The bound has to be sized for that, not for the change rate.
func TestOneChangeReachesEveryWatcherWhenTheBoundAllowsIt(t *testing.T) {
	const watchers = 64
	h := newHarness(t, harnessOptions{concurrency: watchers})
	watch(t, h, watchers)

	h.handler.OnPresence(activeChange())
	h.drain()

	if sent := len(h.notifier.all()); sent != watchers {
		t.Errorf("one change produced %d notifications for %d watchers, want %d",
			sent, watchers, watchers)
	}
	if dropped := h.handler.Dropped(); dropped != 0 {
		t.Errorf("the fan-out shed %d notifications with a bound of %d", dropped, watchers)
	}
}

// When the bound is not sized for it, the excess is SHED rather than queued.
func TestASaturatedFanOutShedsAndCountsWhatItShed(t *testing.T) {
	const watchers = 8
	h := newHarness(t, harnessOptions{concurrency: 1})
	watch(t, h, watchers)

	started, release := h.notifier.hold(1)
	h.handler.OnPresence(activeChange())
	<-started
	// The one slot is occupied, so every other watcher's notification for this change is shed.
	if dropped := h.handler.Dropped(); dropped != watchers-1 {
		t.Errorf("the fan-out shed %d of %d notifications, want %d", dropped, watchers, watchers-1)
	}
	release()
	h.drain()

	if sent := len(h.notifier.all()); sent != 1 {
		t.Errorf("a bound of one delivered %d notifications, want 1", sent)
	}
}
