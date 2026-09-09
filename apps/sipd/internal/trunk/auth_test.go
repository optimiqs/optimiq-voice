package trunk

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	"github.com/nats-io/nats.go"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

type credentialRequestFunc func(context.Context, string, []byte) (*nats.Msg, error)

func (f credentialRequestFunc) RequestWithContext(ctx context.Context, subject string, data []byte) (*nats.Msg, error) {
	return f(ctx, subject, data)
}

func testAuthorizer(t *testing.T) *NATSAuthorizer {
	t.Helper()
	return &NATSAuthorizer{conn: credentialRequestFunc(func(_ context.Context, subject string, data []byte) (*nats.Msg, error) {
		if subject != contract.SubjectSipTrunkCredentialRPC {
			t.Errorf("wrong credential subject: %s", subject)
		}
		var request contract.SipTrunkCredentialRequest
		if err := json.Unmarshal(data, &request); err != nil {
			return nil, err
		}
		hash := md5.Sum([]byte(request.Username + ":" + request.Realm + ":synthetic-password"))
		algorithm := contract.SipTrunkCredentialResponseAlgorithm(request.Algorithm)
		reply, err := json.Marshal(contract.SipTrunkCredentialResponse{
			Ok: true, OrgID: &request.OrgID, TrunkID: &request.TrunkID,
			Username: &request.Username, Realm: &request.Realm, Algorithm: &algorithm,
			Ha1: new(hex.EncodeToString(hash[:])),
		})
		return &nats.Msg{Data: reply}, err
	})}
}

func TestCarrierRegistrationAnswersDigestChallenge(t *testing.T) {
	for _, status := range []int{401, 407} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			ua, err := sipgo.NewUA()
			if err != nil {
				t.Fatal(err)
			}
			defer ua.Close()
			server, err := sipgo.NewServer(ua)
			if err != nil {
				t.Fatal(err)
			}
			socket, err := net.ListenPacket("udp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer socket.Close()
			challenge := &digest.Challenge{Realm: "carrier.example", Nonce: "test-nonce", Algorithm: "MD5", QOP: []string{"auth"}}
			challengeName, credentialName := "WWW-Authenticate", "Authorization"
			if status == 407 {
				challengeName, credentialName = "Proxy-Authenticate", "Proxy-Authorization"
			}
			var requests atomic.Int32
			server.OnRegister(func(req *sip.Request, tx sip.ServerTransaction) {
				requests.Add(1)
				header := req.GetHeader(credentialName)
				if header == nil {
					res := sip.NewResponseFromRequest(req, status, "Authentication Required", nil)
					res.AppendHeader(sip.NewHeader(challengeName, challenge.String()))
					_ = tx.Respond(res)
					return
				}
				credential, err := digest.ParseCredentials(header.Value())
				if err != nil {
					t.Error(err)
					return
				}
				expected, err := digest.Digest(challenge, digest.Options{
					Username: "acme", Password: "synthetic-password", Method: "REGISTER",
					URI: req.Recipient.Addr(), Cnonce: credential.Cnonce, Count: credential.Nc,
				})
				if err != nil || expected.Response != credential.Response {
					t.Error("REGISTER digest did not authenticate")
					_ = tx.Respond(sip.NewResponseFromRequest(req, 403, "Forbidden", nil))
					return
				}
				if req.Contact().Address.User != "acme" {
					t.Error("contact did not identify carrier account")
				}
				_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
			})
			go func() { _ = server.ServeUDP(socket) }()
			client, err := sipgo.NewClient(ua, sipgo.WithClientHostname("127.0.0.1"))
			if err != nil {
				t.Fatal(err)
			}
			registrar, err := NewClientRegistrar(client, RegistrarOptions{
				Contact: sip.Uri{Scheme: "sip", User: "edge", Host: "127.0.0.1"},
				Auth:    testAuthorizer(t), Timeout: 2 * time.Second,
			})
			if err != nil {
				t.Fatal(err)
			}
			config := testRecord().Config()
			config.SecretRef = "secret://synthetic"
			result := registrar.Register(t.Context(), config, socket.LocalAddr().String(), time.Minute)
			if result.Trigger != TriggerAccepted || requests.Load() != 2 {
				t.Fatalf("registration result = %+v, requests = %d", result, requests.Load())
			}
		})
	}
}

func TestCarrierCredentialReplyCannotChangeTenant(t *testing.T) {
	a := &NATSAuthorizer{conn: credentialRequestFunc(func(context.Context, string, []byte) (*nats.Msg, error) {
		return &nats.Msg{Data: []byte(`{"ok":true,"orgId":"another-org","ha1":"00000000000000000000000000000000"}`)}, nil
	})}
	request := sip.NewRequest(sip.INVITE, sip.Uri{Scheme: "sip", Host: "carrier.example"})
	request.AppendHeader(&sip.CSeqHeader{SeqNo: 1, MethodName: sip.INVITE})
	response := sip.NewResponseFromRequest(request, 407, "Authentication Required", nil)
	response.AppendHeader(sip.NewHeader("Proxy-Authenticate", `Digest realm="carrier.example", nonce="nonce", algorithm=MD5`))
	config := testRecord().Config()
	config.SecretRef = "secret://synthetic"
	if _, err := a.Authorize(t.Context(), config, request, response); err == nil {
		t.Fatal("accepted a credential from another organization")
	}
	if request.CSeq().SeqNo != 1 || request.GetHeader("Proxy-Authorization") != nil {
		t.Fatal("failed authentication mutated the original request")
	}
}
