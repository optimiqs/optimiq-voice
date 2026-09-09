//go:build integration

package sipd_test

import (
	"strings"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

func TestCarrierCredentialRepliesStayWithinSIPService(t *testing.T) {
	requireIntegration(t)
	url := startNATSWithPlatformConfig(t)
	api, err := nats.Connect(url, nats.UserInfo("api-it", itNATSPass), nats.CustomInboxPrefix("_INBOX.api"))
	if err != nil {
		t.Fatal(err)
	}
	defer api.Close()
	_, err = api.Subscribe(contract.SubjectSipTrunkCredentialRPC, func(message *nats.Msg) {
		_ = message.Respond([]byte("synthetic-private-reply"))
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := api.Flush(); err != nil {
		t.Fatal(err)
	}

	sipd, err := nats.Connect(url, nats.UserInfo(itSipdUser, itNATSPass), nats.CustomInboxPrefix("_INBOX.sipd"))
	if err != nil {
		t.Fatal(err)
	}
	defer sipd.Close()
	reply, err := sipd.Request(contract.SubjectSipTrunkCredentialRPC, []byte("{}"), time.Second)
	if err != nil || string(reply.Data) != "synthetic-private-reply" {
		t.Fatalf("SIP service could not receive its own credential reply: %v", err)
	}

	denied := make(chan error, 4)
	media, err := nats.Connect(url, nats.UserInfo("mediad-it", itNATSPass),
		nats.CustomInboxPrefix("_INBOX.mediad"), nats.ErrorHandler(func(_ *nats.Conn, _ *nats.Subscription, err error) {
			denied <- err
		}))
	if err != nil {
		t.Fatal(err)
	}
	defer media.Close()
	for _, subject := range []string{"_INBOX.sipd.>", contract.SubjectSipTrunkCredentialRPC} {
		if _, err := media.SubscribeSync(subject); err != nil {
			t.Fatal(err)
		}
		if err := media.Flush(); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-denied:
			if !strings.Contains(err.Error(), subject) {
				t.Fatalf("wrong subscription rejected: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatalf("media could observe protected subject %s", subject)
		}
	}
	if err := media.Publish(contract.SubjectSipTrunkCredentialRPC, []byte("{}")); err != nil {
		t.Fatal(err)
	}
	if err := media.Flush(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-denied:
		if !strings.Contains(err.Error(), contract.SubjectSipTrunkCredentialRPC) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("media could request carrier credentials")
	}
}
