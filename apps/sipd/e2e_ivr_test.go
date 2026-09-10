//go:build e2e

package sipd_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

// TestE2EIVRDigitFromASIPPhone drives an IVR menu with an RFC 4733 keypress from a SIP handset —
// the media-plane half of DTMF, which the browser softphone does not exercise (it sends SIP INFO,
// which never reaches `mediad` at all).
//
// The two halves are worth separating because they fail independently: a digit that routes from a
// handset and not from a browser is a signalling bug, and one that routes from a browser and not
// from a handset is `mediad`'s telephone-event detection. The assertion is the ROUTE, not the
// digit: the menu's option is an extension, so the proof is that the extension's phone gets an
// INVITE seconds after the tone — nothing else in the plan sends one.
//
// The menu, its option digit and the extension the option reaches are all read from the
// environment, because they are fixtures of whatever deployment this runs against.
func TestE2EIVRDigitFromASIPPhone(t *testing.T) {
	requireE2E(t)
	menu := e2eValue(t, "SIPD_E2E_IVR_MENU")
	digit := e2eValue(t, "SIPD_E2E_IVR_DIGIT")
	target := e2eValue(t, "SIPD_E2E_IVR_TARGET")
	caller1 := e2eValue(t, "SIPD_E2E_IVR_CALLER")
	callerPassword := e2ePassword(t, caller1)
	targetPassword := e2ePassword(t, target)

	callee := newPhone(t, target, targetPassword)
	caller := newPhone(t, caller1, callerPassword)

	invites := make(chan error, 1)
	go func() {
		_, _, err := callee.ua.AwaitInvite()
		invites <- err
	}()

	started := time.Now()
	dialog, err := caller.ua.InviteAsync("sip:"+menu+"@"+e2eRealm, caller.media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("INVITE to the menu: %v", err)
	}
	response, _, err := dialog.AwaitFinal()
	if err != nil {
		t.Fatalf("no final response from the menu: %v", err)
	}
	if response.StatusCode/100 != 2 {
		t.Fatalf("the menu answered %d %s", response.StatusCode, response.Reason)
	}
	if err := dialog.Ack(); err != nil {
		t.Fatalf("ACK: %v", err)
	}
	t.Logf("the menu answered after %s", time.Since(started).Round(time.Millisecond))

	mediaTarget, ok := sipua.MediaTarget(dialog.RemoteSDP)
	if !ok {
		t.Fatalf("no media target in the menu's answer: %q", dialog.RemoteSDP)
	}
	sender, err := caller.media.Sender(mediaTarget)
	if err != nil {
		t.Fatalf("sender: %v", err)
	}

	// The greeting is playing; a menu collects digits over it, so there is nothing to wait for
	// beyond the RTP being up in both directions.
	if _, err := sender.SendTone(440, 500*time.Millisecond); err != nil {
		t.Fatalf("priming tone: %v", err)
	}
	pressed := time.Now()
	if err := sender.SendDTMF(dtmfEvent(t, digit), 200*time.Millisecond); err != nil {
		t.Fatalf("RFC 4733 %q: %v", digit, err)
	}
	t.Logf("sent RFC 4733 %q; caller RTP so far: %+v", digit, caller.media.Stats())

	select {
	case err := <-invites:
		if err != nil {
			t.Fatalf("extension %s never saw an INVITE: %v", target, err)
		}
		t.Logf("extension %s rang %s after the keypress", target, time.Since(pressed).Round(time.Millisecond))
	case <-time.After(20 * time.Second):
		t.Fatalf("extension %s never rang: the menu did not act on the RFC 4733 digit", target)
	}

	if _, err := dialog.Bye(); err != nil {
		t.Logf("BYE: %v", err)
	}
}

// e2eValue reads a fixture of the deployment under test, skipping when it was not named.
func e2eValue(t *testing.T, name string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		t.Skipf("set %s to run this scenario against the local stack", name)
	}
	return value
}

// dtmfEvent is the RFC 4733 event code for a single keypad character.
func dtmfEvent(t *testing.T, digit string) uint8 {
	t.Helper()
	if len(digit) != 1 || digit[0] < '0' || digit[0] > '9' {
		t.Fatalf("SIPD_E2E_IVR_DIGIT must be one digit 0-9, got %q", digit)
	}
	return digit[0] - '0'
}
