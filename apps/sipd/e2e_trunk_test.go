//go:build e2e

package sipd_test

import (
	"os"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

const e2eCarrier = "127.0.0.1:5162"

// TestE2ETrunkInboundDID plays a carrier: an unauthenticated INVITE for a DID arrives on the
// external profile, is admitted by the trunk ACL, and must ring the extension the inbound route
// names.
func TestE2ETrunkInboundDID(t *testing.T) {
	requireE2E(t)
	did := strings.TrimSpace(os.Getenv("SIPD_E2E_DID"))
	if did == "" {
		t.Skip("set SIPD_E2E_DID to the provisioned inbound number")
	}
	extensionPassword := e2ePassword(t, "1601")

	extension := newPhone(t, "1601", extensionPassword)
	inbounds := make(chan *sipua.Dialog, 1)
	go func() {
		if _, dialog, err := extension.ua.AwaitInvite(); err == nil {
			inbounds <- dialog
		} else {
			t.Logf("the extension never saw an INVITE: %v", err)
			close(inbounds)
		}
	}()

	carrier, err := sipua.Dial(sipua.Options{
		Transport: sipua.UDP, Remote: e2eCarrier, Realm: "carrier.sip-e2e.test",
		User: "15551234567", Password: "unused", Timeout: 15 * time.Second,
	})
	if err != nil {
		t.Fatalf("dialing the carrier profile: %v", err)
	}
	t.Cleanup(func() { _ = carrier.Close() })
	media, err := sipua.NewRTPEndpoint()
	if err != nil {
		t.Fatalf("carrier RTP socket: %v", err)
	}
	t.Cleanup(func() { _ = media.Close() })

	started := time.Now()
	dialog := &carrierDialog{}
	_ = dialog
	callDialog, err := carrier.InviteAsyncNoAuth("sip:"+did+"@"+e2eCarrier, media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("carrier INVITE: %v", err)
	}

	select {
	case answered, ok := <-inbounds:
		if !ok {
			t.Fatal("the DID did not reach the extension")
		}
		t.Logf("the DID reached extension 1601 after %s", time.Since(started).Round(time.Millisecond))
		if err := answered.Respond(200, "OK", extension.media.OfferSDP("sendrecv")); err != nil {
			t.Fatalf("answering: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("no INVITE reached the extension within 15s")
	}

	final, provisional, err := callDialog.AwaitFinal()
	if err != nil {
		t.Fatalf("the carrier saw no final response: %v", err)
	}
	t.Logf("carrier final %d %s (provisional %v) after %s", final.StatusCode, final.Reason, provisional, time.Since(started).Round(time.Millisecond))
	if final.StatusCode/100 != 2 {
		t.Fatalf("the inbound DID was answered %d %s", final.StatusCode, final.Reason)
	}
	if err := callDialog.Ack(); err != nil {
		t.Fatalf("carrier ACK: %v", err)
	}
	if _, err := callDialog.Bye(); err != nil {
		t.Fatalf("carrier BYE: %v", err)
	}
}

// TestE2ETrunkACLRefusesUnlistedSource shows the external profile refuses an INVITE with no matching
// ACL entry: the request URI names a DID that no trunk on this source is allowed to send.
func TestE2ETrunkACLRefusesUnknownDID(t *testing.T) {
	requireE2E(t)
	carrier, err := sipua.Dial(sipua.Options{
		Transport: sipua.UDP, Remote: e2eCarrier, Realm: "carrier.sip-e2e.test",
		User: "15551234567", Password: "unused", Timeout: 10 * time.Second,
	})
	if err != nil {
		t.Fatalf("dialing the carrier profile: %v", err)
	}
	t.Cleanup(func() { _ = carrier.Close() })
	media, err := sipua.NewRTPEndpoint()
	if err != nil {
		t.Fatalf("RTP socket: %v", err)
	}
	t.Cleanup(func() { _ = media.Close() })

	dialog, err := carrier.InviteAsyncNoAuth("sip:+15005559999@"+e2eCarrier, media.OfferSDP("sendrecv"))
	if err != nil {
		t.Fatalf("INVITE: %v", err)
	}
	final, provisional, err := dialog.AwaitFinal()
	if err != nil {
		t.Fatalf("no final response: %v", err)
	}
	t.Logf("an unrouted DID on the carrier profile ended %d %s (provisional %v)", final.StatusCode, final.Reason, provisional)
	if final.StatusCode/100 == 2 {
		t.Error("an INVITE for a DID no route claims was answered")
	}
}

type carrierDialog struct{}
