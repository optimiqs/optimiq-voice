//go:build e2e

package sipd_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

// TestE2EPhoneToBrowser dials an extension that is registered from a browser softphone, so the media
// path crosses mediad's transcode boundary: G.711 on this side, Opus over SRTP on the other. The
// browser leg is driven separately (see the sip area's browser-softphone script); this side asserts
// what a hardware phone would observe.
func TestE2EPhoneToBrowser(t *testing.T) {
	requireE2E(t)
	target := strings.TrimSpace(os.Getenv("SIPD_E2E_BROWSER_EXTENSION"))
	if target == "" {
		t.Skip("set SIPD_E2E_BROWSER_EXTENSION to the extension a browser softphone is online on")
	}
	password := e2ePassword(t, "1601")

	phone := newPhone(t, "1601", password)
	phone.ua.Timeout = 45 * time.Second

	started := time.Now()
	dialog, err := phone.ua.InviteAsync("sip:"+target+"@"+e2eRealm, phone.media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("INVITE: %v", err)
	}
	final, provisional, err := dialog.AwaitFinal()
	if err != nil {
		t.Fatalf("no final response: %v", err)
	}
	t.Logf("browser answered %d %s after %s (provisional %v)",
		final.StatusCode, final.Reason, time.Since(started).Round(time.Millisecond), provisional)
	if final.StatusCode/100 != 2 {
		t.Fatalf("the browser leg was not answered: %d %s", final.StatusCode, final.Reason)
	}
	if err := dialog.Ack(); err != nil {
		t.Fatalf("ACK: %v", err)
	}

	mediaTarget, ok := sipua.MediaTarget(dialog.RemoteSDP)
	if !ok {
		t.Fatalf("no media target in %q", dialog.RemoteSDP)
	}
	sender, err := phone.media.Sender(mediaTarget)
	if err != nil {
		t.Fatalf("sender: %v", err)
	}
	t.Logf("media target %s; answer SDP:\n%s", mediaTarget, dialog.RemoteSDP)

	if _, err := sender.SendTone(660, 6*time.Second); err != nil {
		t.Fatalf("tone: %v", err)
	}
	stats := phone.media.Stats()
	t.Logf("the phone received %d packets (%d bytes), payload types %v, energy %.0f, lost %d, ssrcs %d",
		stats.Packets, stats.Bytes, stats.ByPayloadType, stats.Energy, stats.Lost, len(stats.SSRCs))
	if stats.Packets == 0 {
		t.Error("the phone received no RTP from the browser leg: mediad did not relay or transcode")
	}
	if _, pcmu := stats.ByPayloadType[sipua.PayloadPCMU]; stats.Packets > 0 && !pcmu {
		t.Errorf("the phone was sent payload types %v, not the G.711 it offered", stats.ByPayloadType)
	}
	if stats.Energy == 0 && stats.Packets > 0 {
		t.Error("the phone received only silence from the browser leg")
	}

	// The far end measures its own counters after this test's tone; give it a moment before the BYE
	// closes the peer connection and getStats stops reporting.
	time.Sleep(3 * time.Second)
	if _, err := dialog.Bye(); err != nil {
		t.Fatalf("BYE: %v", err)
	}
}

// TestE2EBrowserToPhone is the other direction: a browser softphone dials the SIP phone, which
// answers with a G.711 offer and measures what mediad delivers.
func TestE2EBrowserToPhone(t *testing.T) {
	requireE2E(t)
	if os.Getenv("SIPD_E2E_AWAIT_BROWSER_CALL") != "1" {
		t.Skip("set SIPD_E2E_AWAIT_BROWSER_CALL=1 and dial 1601 from a browser softphone")
	}
	password := e2ePassword(t, "1601")
	phone := newPhone(t, "1601", password)
	phone.ua.Timeout = 60 * time.Second

	started := time.Now()
	_, dialog, err := phone.ua.AwaitInvite()
	if err != nil {
		t.Fatalf("no INVITE from the browser: %v", err)
	}
	t.Logf("the browser's INVITE arrived after %s", time.Since(started).Round(time.Millisecond))
	if err := dialog.Respond(180, "Ringing", ""); err != nil {
		t.Fatalf("180: %v", err)
	}
	if err := dialog.Respond(200, "OK", phone.media.OfferSDP("sendrecv")); err != nil {
		t.Fatalf("200: %v", err)
	}

	mediaTarget, ok := sipua.MediaTarget(dialog.RemoteSDP)
	if !ok {
		t.Fatalf("no media target in the browser's offer: %q", dialog.RemoteSDP)
	}
	sender, err := phone.media.Sender(mediaTarget)
	if err != nil {
		t.Fatalf("sender: %v", err)
	}
	if _, err := sender.SendTone(660, 6*time.Second); err != nil {
		t.Fatalf("tone: %v", err)
	}
	stats := phone.media.Stats()
	t.Logf("the phone received %d packets, payload types %v, energy %.0f, lost %d",
		stats.Packets, stats.ByPayloadType, stats.Energy, stats.Lost)
	if stats.Packets == 0 {
		t.Error("no audio arrived from the browser-originated call")
	}
	time.Sleep(2 * time.Second)
}
