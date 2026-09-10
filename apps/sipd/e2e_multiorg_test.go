//go:build e2e

package sipd_test

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/testutil/sipua"
)

// Two tenants, two DIDs, one carrier.
//
// `e2e_trunk_test.go` proves a DID reaches an extension. What it cannot say is whether the EDGE
// keeps two tenants apart when the same unauthenticated carrier source sends both calls: the ACL
// entry that admits the INVITE belongs to one organization, and the `did-index` is what decides
// whose call it is. If the ACL's owner leaked into that decision, a carrier peer belonging to one
// customer could ring another customer's phones, which is the worst failure this product has.
//
// So both DIDs are dialled from the SAME carrier socket, in one test, and each is asserted to reach
// its own tenant's registered extension and NOT the other's.
//
//	SIPD_E2E=1 RT2_REALM=… RT2_EXT=… RT2_PASS=… RT2_DID=… \
//	TENB_REALM=… TENB_EXT=… TENB_PASS=… TENB_DID=… \
//	go test -tags e2e -run TestE2EMultiOrg -v .
type tenantPhone struct {
	label string
	realm string
	ext   string
	did   string
	ua    *sipua.UA
	media *sipua.RTPEndpoint
	// Every INVITE this extension received, whichever DID caused it.
	invites chan *sipua.Dialog
}

func envOrSkip(t *testing.T, name string) string {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		t.Skipf("set %s", name)
	}
	return value
}

func registerTenant(t *testing.T, label, realm, ext, password, did string) *tenantPhone {
	t.Helper()
	ua, err := sipua.Dial(sipua.Options{
		Transport: sipua.UDP, Remote: e2eUDP, Realm: realm,
		User: ext, Password: password, Timeout: 20 * time.Second,
	})
	if err != nil {
		t.Fatalf("%s: dialling the edge: %v", label, err)
	}
	t.Cleanup(func() { _ = ua.Close() })
	response, err := ua.Register(sipua.RegisterOptions{Expires: 300})
	if err != nil || response.StatusCode != 200 {
		t.Fatalf("%s: REGISTER %s@%s: %v / %v", label, ext, realm, response, err)
	}
	media, err := sipua.NewRTPEndpoint()
	if err != nil {
		t.Fatalf("%s: RTP socket: %v", label, err)
	}
	t.Cleanup(func() { _ = media.Close() })

	phone := &tenantPhone{
		label: label, realm: realm, ext: ext, did: did,
		ua: ua, media: media, invites: make(chan *sipua.Dialog, 4),
	}
	go func() {
		for {
			_, dialog, err := ua.AwaitInvite()
			if err != nil {
				return
			}
			phone.invites <- dialog
		}
	}()
	return phone
}

// waitForInvite returns the dialog, or nil when nothing arrived inside the budget.
func (p *tenantPhone) waitForInvite(d time.Duration) *sipua.Dialog {
	select {
	case dialog := <-p.invites:
		return dialog
	case <-time.After(d):
		return nil
	}
}

func TestE2EMultiOrgInboundDIDs(t *testing.T) {
	requireE2E(t)
	rt2 := registerTenant(t, "rt2",
		envOrSkip(t, "RT2_REALM"), envOrSkip(t, "RT2_EXT"), envOrSkip(t, "RT2_PASS"),
		envOrSkip(t, "RT2_DID"))
	tenb := registerTenant(t, "tenant-b",
		envOrSkip(t, "TENB_REALM"), envOrSkip(t, "TENB_EXT"), envOrSkip(t, "TENB_PASS"),
		envOrSkip(t, "TENB_DID"))

	carrier, err := sipua.Dial(sipua.Options{
		Transport: sipua.UDP, Remote: e2eCarrier, Realm: "carrier.rt2.test",
		User: "15559990000", Password: "unused", Timeout: 20 * time.Second,
	})
	if err != nil {
		t.Fatalf("dialling the carrier profile: %v", err)
	}
	t.Cleanup(func() { _ = carrier.Close() })

	for _, target := range []*tenantPhone{rt2, tenb} {
		other := tenb
		if target == tenb {
			other = rt2
		}
		t.Run(target.label, func(t *testing.T) {
			media, err := sipua.NewRTPEndpoint()
			if err != nil {
				t.Fatalf("carrier RTP socket: %v", err)
			}
			t.Cleanup(func() { _ = media.Close() })

			// A fresh Call-ID per leg: one UA carries both calls, which is the point — the same
			// carrier source must be sorted into two tenants by the DID and nothing else.
			carrier.SetCallID(fmt.Sprintf("rt2-%s-%d", target.label, time.Now().UnixNano()))
			started := time.Now()
			dialog, err := carrier.InviteAsyncNoAuth(
				"sip:"+target.did+"@"+e2eCarrier, media.OfferSDP("sendrecv"))
			if err != nil {
				t.Fatalf("carrier INVITE for %s: %v", target.did, err)
			}

			// The carrier's own final response is read concurrently: when the edge refuses the
			// INVITE outright the extension simply never rings, and "nothing arrived" is a much
			// worse diagnosis than "403 Forbidden".
			finals := make(chan string, 1)
			go func() {
				final, provisional, err := dialog.AwaitFinal()
				if err != nil {
					finals <- "no final: " + err.Error()
					return
				}
				finals <- fmt.Sprintf("%d %s (provisional %v)", final.StatusCode, final.Reason, provisional)
			}()

			inbound := target.waitForInvite(20 * time.Second)
			if inbound == nil {
				select {
				case carrierSaw := <-finals:
					t.Fatalf("%s did not reach extension %s@%s; the carrier saw %s",
						target.did, target.ext, target.realm, carrierSaw)
				case <-time.After(3 * time.Second):
					t.Fatalf("%s did not reach extension %s@%s, and the carrier saw no response at all",
						target.did, target.ext, target.realm)
				}
			}
			t.Logf("%s reached %s@%s after %s",
				target.did, target.ext, target.realm, time.Since(started).Round(time.Millisecond))

			if err := inbound.Respond(200, "OK", target.media.OfferSDP("sendrecv")); err != nil {
				t.Fatalf("answering: %v", err)
			}
			carrierSaw := <-finals
			t.Logf("carrier final %s", carrierSaw)
			if !strings.HasPrefix(carrierSaw, "2") {
				t.Fatalf("the DID was answered %s", carrierSaw)
			}
			_ = dialog.Ack()

			// Audio, so "it rang" is not the whole claim.
			if peer, ok := sipua.MediaTarget(dialog.RemoteSDP); ok {
				if sender, err := media.Sender(peer); err == nil {
					_, _ = sender.SendTone(440, 500*time.Millisecond)
				}
			}
			time.Sleep(500 * time.Millisecond)
			t.Logf("%s RTP at the extension: %+v", target.label, target.media.Stats())

			// The isolation assertion: the OTHER tenant's phone saw nothing at all.
			if leaked := other.waitForInvite(1500 * time.Millisecond); leaked != nil {
				t.Errorf("%s reached %s's extension %s@%s as well — cross-tenant leakage",
					target.did, other.label, other.ext, other.realm)
			}
			_, _ = dialog.Bye()
			time.Sleep(700 * time.Millisecond)
		})
	}
}
