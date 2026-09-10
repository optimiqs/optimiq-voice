//go:build e2e

package sipd_test

import (
	"strings"

	"github.com/emiago/sipgo/sip"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

// phone is a registered SIP endpoint with its own RTP socket.
type phoneE2E struct {
	ua    *sipua.UA
	media *sipua.RTPEndpoint
}

func newPhone(t *testing.T, extension, password string) *phoneE2E {
	t.Helper()
	ua := dial(t, sipua.UDP, e2eUDP, extension, password)
	ua.Timeout = 20 * time.Second
	response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("%s REGISTER: %v / %v", extension, response, err)
	}
	media, err := sipua.NewRTPEndpoint()
	if err != nil {
		t.Fatalf("binding an RTP socket: %v", err)
	}
	t.Cleanup(func() { _ = media.Close() })
	return &phoneE2E{ua: ua, media: media}
}

// TestE2EPhoneToPhoneCall drives INVITE → ring → answer → two-way G.711 → hold → resume → DTMF →
// BYE between two SIP phones, through the real sipd, engine and mediad.
func TestE2EPhoneToPhoneCall(t *testing.T) {
	requireE2E(t)
	callerPassword := e2ePassword(t, "1601")
	calleePassword := e2ePassword(t, "1602")

	callee := newPhone(t, "1602", calleePassword)
	caller := newPhone(t, "1601", callerPassword)

	type inbound struct {
		dialog *sipua.Dialog
		err    error
	}
	inbounds := make(chan inbound, 1)
	go func() {
		_, dialog, err := callee.ua.AwaitInvite()
		inbounds <- inbound{dialog, err}
	}()

	started := time.Now()
	target := "sip:1602@" + e2eRealm
	callerDialog, err := caller.ua.InviteAsync(target, caller.media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("INVITE: %v", err)
	}

	arrival := <-inbounds
	if arrival.err != nil {
		t.Fatalf("the callee never saw an INVITE: %v", arrival.err)
	}
	calleeDialog := arrival.dialog
	t.Logf("callee saw the INVITE after %s", time.Since(started).Round(time.Millisecond))

	if err := calleeDialog.Respond(180, "Ringing", ""); err != nil {
		t.Fatalf("180: %v", err)
	}
	if err := calleeDialog.Respond(200, "OK", callee.media.OfferSDP("sendrecv")); err != nil {
		t.Fatalf("200: %v", err)
	}
	response, provisional, err := callerDialog.AwaitFinal()
	if err != nil {
		t.Fatalf("no final response for the caller: %v", err)
	}
	t.Logf("caller final response %d %s after %s (provisional %v)",
		response.StatusCode, response.Reason, time.Since(started).Round(time.Millisecond), provisional)
	if response.StatusCode/100 != 2 {
		t.Fatalf("the caller's INVITE was answered %d %s", response.StatusCode, response.Reason)
	}
	if err := callerDialog.Ack(); err != nil {
		t.Fatalf("ACK: %v", err)
	}
	answered := time.Since(started)
	t.Logf("answered after %s; caller sees remote SDP:\n%s", answered.Round(time.Millisecond), callerDialog.RemoteSDP)

	callerTarget, ok := sipua.MediaTarget(callerDialog.RemoteSDP)
	if !ok {
		t.Fatalf("the caller got no media target from %q", callerDialog.RemoteSDP)
	}
	calleeTarget, ok := sipua.MediaTarget(calleeDialog.RemoteSDP)
	if !ok {
		t.Fatalf("the callee got no media target from %q", calleeDialog.RemoteSDP)
	}
	t.Logf("media targets: caller -> %s, callee -> %s", callerTarget, calleeTarget)

	callerSender, err := caller.media.Sender(callerTarget)
	if err != nil {
		t.Fatalf("caller sender: %v", err)
	}
	calleeSender, err := callee.media.Sender(calleeTarget)
	if err != nil {
		t.Fatalf("callee sender: %v", err)
	}

	done := make(chan struct{})
	go func() { _, _ = calleeSender.SendTone(440, 2*time.Second); close(done) }()
	if _, err := callerSender.SendTone(660, 2*time.Second); err != nil {
		t.Fatalf("caller tone: %v", err)
	}
	<-done

	callerStats := caller.media.Stats()
	calleeStats := callee.media.Stats()
	t.Logf("caller received: %+v", callerStats)
	t.Logf("callee received: %+v", calleeStats)
	if callerStats.Packets == 0 {
		t.Error("the caller received no RTP at all")
	}
	if calleeStats.Packets == 0 {
		t.Error("the callee received no RTP at all")
	}
	if callerStats.Energy == 0 && callerStats.Packets > 0 {
		t.Error("the caller received only silence")
	}
	if callerStats.Lost > 5 {
		t.Errorf("the caller lost %d packets in two seconds", callerStats.Lost)
	}

	// DTMF from the caller, RFC 4733.
	if err := callerSender.SendDTMF(5, 200*time.Millisecond); err != nil {
		t.Fatalf("DTMF: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	if events := callee.media.Stats().DTMFEvents; len(events) == 0 {
		t.Logf("FINDING: no RFC 4733 event reached the far end (payload types seen: %v)", callee.media.Stats().ByPayloadType)
	} else {
		t.Logf("DTMF events reaching the callee: %v", events)
	}

	// Hold, then resume, from the caller — a re-INVITE with a changed direction attribute.
	held, err := callerDialog.ReInvite(caller.media.OfferSDP("sendonly"))
	if err != nil {
		t.Fatalf("hold re-INVITE: %v", err)
	}
	t.Logf("hold re-INVITE -> %d %s; answer direction: %s", held.StatusCode, held.Reason, directionOf(callerDialog.RemoteSDP))
	if held.StatusCode/100 != 2 {
		t.Errorf("hold was refused with %d %s", held.StatusCode, held.Reason)
	}
	resumed, err := callerDialog.ReInvite(caller.media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("resume re-INVITE: %v", err)
	}
	t.Logf("resume re-INVITE -> %d %s; answer direction: %s", resumed.StatusCode, resumed.Reason, directionOf(callerDialog.RemoteSDP))

	// Audio must flow again after resume, measured on the caller while the CALLEE sends.
	beforeResume := caller.media.Stats().Packets
	if _, err := calleeSender.SendTone(440, 1*time.Second); err != nil {
		t.Fatalf("post-resume tone: %v", err)
	}
	afterResume := caller.media.Stats()
	t.Logf("caller RTP after resume: %d packets (was %d), energy %.0f",
		afterResume.Packets, beforeResume, afterResume.Energy)
	if afterResume.Packets <= beforeResume {
		t.Error("no audio reached the caller after resume")
	}

	bye, err := callerDialog.Bye()
	if err != nil {
		t.Fatalf("BYE: %v", err)
	}
	t.Logf("BYE -> %d %s", bye.StatusCode, bye.Reason)
	if bye.StatusCode/100 != 2 {
		t.Errorf("BYE was answered %d %s", bye.StatusCode, bye.Reason)
	}
}

// TestE2ECancelRace cancels an INVITE while it is still ringing.
func TestE2ECancelRace(t *testing.T) {
	requireE2E(t)
	callerPassword := e2ePassword(t, "1601")
	calleePassword := e2ePassword(t, "1603")

	callee := newPhone(t, "1603", calleePassword)
	caller := newPhone(t, "1601", callerPassword)

	// The callee rings but never answers, so the CANCEL lands mid-transaction.
	go func() {
		if _, dialog, err := callee.ua.AwaitInvite(); err == nil {
			_ = dialog.Respond(180, "Ringing", "")
		}
	}()

	caller.ua.Timeout = 3 * time.Second
	target := "sip:1603@" + e2eRealm
	response, dialog, err := caller.ua.Invite(target, caller.media.OfferSDP("sendrecv"))
	switch {
	case err == nil && response.StatusCode/100 == 2:
		t.Fatalf("the call was answered although nobody answered it: %d", response.StatusCode)
	case err == nil:
		t.Logf("the INVITE reached a final %d %s before the CANCEL", response.StatusCode, response.Reason)
		return
	}

	if err := dialog.Cancel(); err != nil {
		t.Fatalf("CANCEL: %v", err)
	}
	// The CANCEL gets its own 200; the INVITE transaction is the one that must end 487, so read on
	// until a response whose CSeq names INVITE arrives.
	caller.ua.Timeout = 10 * time.Second
	var final *sip.Response
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		response, _, err := dialog.AwaitFinal()
		if err != nil {
			t.Fatalf("no final response after CANCEL: %v", err)
		}
		if cseq := response.GetHeader("CSeq"); cseq != nil && strings.HasSuffix(cseq.Value(), "INVITE") {
			final = response
			break
		}
		t.Logf("after CANCEL: %d %s for %v", response.StatusCode, response.Reason, response.GetHeader("CSeq"))
	}
	if final == nil {
		t.Fatal("the INVITE transaction never reached a final response after CANCEL")
	}
	t.Logf("after CANCEL the INVITE ended %d %s", final.StatusCode, final.Reason)
	if final.StatusCode != 487 {
		t.Errorf("a cancelled INVITE must end 487 Request Terminated, got %d %s", final.StatusCode, final.Reason)
	}
}

func directionOf(sdp string) string {
	for _, direction := range []string{"sendrecv", "sendonly", "recvonly", "inactive"} {
		if strings.Contains(sdp, "a="+direction) {
			return direction
		}
	}
	return "(none)"
}
