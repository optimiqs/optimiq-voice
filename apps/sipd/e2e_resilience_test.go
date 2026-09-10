//go:build e2e

// A call held open while something else is killed, so a chaos scenario can be read off the media.
//
//	SIPD_E2E=1 SIPD_E2E_HOLD_SECONDS=60 SIPD_E2E_PASS_1601=... SIPD_E2E_PASS_1602=... \
//	  go test -count=1 -tags e2e -run TestE2EHoldACallOpen -v -timeout 10m .
package sipd_test

import (
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

// TestE2EHoldACallOpen answers a two-party call and prints one line per second of the RTP each side
// has received, for as long as SIPD_E2E_HOLD_SECONDS says.
//
// The per-second DELTA is the measurement: a scenario that kills a service mid-call is judged by
// whether the deltas keep arriving, and the first second in which they resume is the recovery time.
// Cumulative totals cannot answer that, which is why they are printed alongside rather than instead.
func TestE2EHoldACallOpen(t *testing.T) {
	requireE2E(t)
	seconds := strings.TrimSpace(os.Getenv("SIPD_E2E_HOLD_SECONDS"))
	if seconds == "" {
		t.Skip("set SIPD_E2E_HOLD_SECONDS to hold a call open for that long")
	}
	hold, err := strconv.Atoi(seconds)
	if err != nil || hold <= 0 {
		t.Fatalf("SIPD_E2E_HOLD_SECONDS=%q is not a positive number of seconds", seconds)
	}

	callee := newPhone(t, "1602", e2ePassword(t, "1602"))
	caller := newPhone(t, "1601", e2ePassword(t, "1601"))

	inbounds := make(chan *sipua.Dialog, 1)
	go func() {
		_, dialog, err := callee.ua.AwaitInvite()
		if err != nil {
			t.Logf("the callee never saw an INVITE: %v", err)
			close(inbounds)
			return
		}
		inbounds <- dialog
	}()

	started := time.Now()
	callerDialog, err := caller.ua.InviteAsync("sip:1602@"+e2eRealm, caller.media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("INVITE: %v", err)
	}
	calleeDialog, ok := <-inbounds
	if !ok {
		t.Fatal("the INVITE never reached 1602")
	}
	if err := calleeDialog.Respond(180, "Ringing", ""); err != nil {
		t.Fatalf("180: %v", err)
	}
	ringing := time.Since(started)
	if err := calleeDialog.Respond(200, "OK", callee.media.OfferSDP("sendrecv")); err != nil {
		t.Fatalf("200: %v", err)
	}
	final, _, err := callerDialog.AwaitFinal()
	if err != nil || final.StatusCode/100 != 2 {
		t.Fatalf("the caller's INVITE ended %v (%v)", final, err)
	}
	if err := callerDialog.Ack(); err != nil {
		t.Fatalf("ACK: %v", err)
	}
	t.Logf("setup-to-ring %s, ring-to-answer %s", ringing.Round(time.Millisecond),
		(time.Since(started) - ringing).Round(time.Millisecond))

	callerTarget, ok := sipua.MediaTarget(callerDialog.RemoteSDP)
	if !ok {
		t.Fatalf("the caller got no media target from %q", callerDialog.RemoteSDP)
	}
	calleeTarget, ok := sipua.MediaTarget(calleeDialog.RemoteSDP)
	if !ok {
		t.Fatalf("the callee got no media target from %q", calleeDialog.RemoteSDP)
	}
	callerSender, err := caller.media.Sender(callerTarget)
	if err != nil {
		t.Fatalf("caller sender: %v", err)
	}
	calleeSender, err := callee.media.Sender(calleeTarget)
	if err != nil {
		t.Fatalf("callee sender: %v", err)
	}

	// Both directions stream for the whole window. A send that fails is logged rather than fatal:
	// the socket going away IS one of the outcomes a scenario is here to observe.
	stop := make(chan struct{})
	var senders sync.WaitGroup
	send := func(sender *sipua.RTPSender, frequency float64, side string) {
		for {
			select {
			case <-stop:
				return
			default:
			}
			if _, err := sender.SendTone(frequency, time.Second); err != nil {
				t.Logf("%s send failed: %v", side, err)
				return
			}
		}
	}
	senders.Go(func() { send(callerSender, 660, "caller") })
	senders.Go(func() { send(calleeSender, 440, "callee") })

	previousCaller, previousCallee := 0, 0
	for second := range hold {
		time.Sleep(time.Second)
		callerNow := caller.media.Stats()
		calleeNow := callee.media.Stats()
		t.Logf("t+%02ds caller +%d (%d total, lost %d) | callee +%d (%d total, lost %d) | %s",
			second+1,
			callerNow.Packets-previousCaller, callerNow.Packets, callerNow.Lost,
			calleeNow.Packets-previousCallee, calleeNow.Packets, calleeNow.Lost,
			time.Now().UTC().Format(time.RFC3339))
		previousCaller, previousCallee = callerNow.Packets, calleeNow.Packets
	}

	close(stop)
	senders.Wait()

	if bye, err := callerDialog.Bye(); err != nil {
		t.Logf("BYE failed: %v", err)
	} else {
		t.Logf("BYE -> %d %s", bye.StatusCode, bye.Reason)
	}
	t.Logf("caller final: %+v", caller.media.Stats())
	t.Logf("callee final: %+v", callee.media.Stats())
}
