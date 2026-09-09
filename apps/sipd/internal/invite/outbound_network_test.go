package invite

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"testing"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/nat"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/profile"
	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/trunk"
)

type outboundDirectory struct{ config trunk.Config }

func (d outboundDirectory) Trunk(orgID, trunkID string) (trunk.Config, bool) {
	return d.config, orgID == d.config.OrgID && trunkID == d.config.TrunkID
}

type outboundAuthFunc func(context.Context, trunk.Config, *sip.Request, *sip.Response) (*sip.Request, error)

func (f outboundAuthFunc) Authorize(ctx context.Context, cfg trunk.Config, req *sip.Request, res *sip.Response) (*sip.Request, error) {
	return f(ctx, cfg, req, res)
}

func TestOutboundCarrierCallAuthenticatesAcknowledgesAndReleases(t *testing.T) {
	serverUA, err := sipgo.NewUA()
	if err != nil {
		t.Fatal(err)
	}
	defer serverUA.Close()
	server, err := sipgo.NewServer(serverUA)
	if err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()

	// The response changes the remote target. ACK and BYE must use this Contact, not the dialed URI.
	remoteSocket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer remoteSocket.Close()
	contact := sip.Uri{Scheme: "sip", User: "remote-dialog", Host: "127.0.0.1",
		Port: remoteSocket.LocalAddr().(*net.UDPAddr).Port}
	challenge := &digest.Challenge{Realm: "carrier.example", Nonce: "nonce-1", Algorithm: "MD5", QOP: []string{"auth"}}
	acks := make(chan *sip.Request, 4)
	byes := make(chan *sip.Request, 4)
	var inviteCount atomic.Int32
	server.OnInvite(func(req *sip.Request, tx sip.ServerTransaction) {
		inviteCount.Add(1)
		header := req.GetHeader("Proxy-Authorization")
		if header == nil {
			_ = tx.Respond(sip.NewResponseFromRequest(req, 100, "Trying", nil))
			res := sip.NewResponseFromRequest(req, 407, "Proxy Authentication Required", nil)
			res.AppendHeader(sip.NewHeader("Proxy-Authenticate", challenge.String()))
			_ = tx.Respond(res)
			return
		}
		credential, err := digest.ParseCredentials(header.Value())
		if err != nil {
			t.Error(err)
			return
		}
		expected, err := digest.Digest(challenge, digest.Options{
			Username: "carrier-account", Password: "synthetic-password", Method: "INVITE",
			URI: req.Recipient.Addr(), Cnonce: credential.Cnonce, Count: credential.Nc,
		})
		if err != nil || expected.Response != credential.Response {
			t.Error("outbound INVITE did not authenticate")
			_ = tx.Respond(sip.NewResponseFromRequest(req, 403, "Forbidden", nil))
			return
		}
		if req.Contact().Address.User != "carrier-account" {
			t.Error("carrier Contact username is wrong")
		}
		res := sip.NewResponseFromRequest(req, 200, "OK", []byte("v=0\r\n"))
		res.AppendHeader(&sip.ContactHeader{Address: contact})
		_ = tx.Respond(res)
		// Simulate a repeated final answer after the first ACK was lost.
		_ = server.WriteResponse(res.Clone())
	})
	server.OnAck(func(req *sip.Request, _ sip.ServerTransaction) { acks <- req.Clone() })
	server.OnBye(func(req *sip.Request, tx sip.ServerTransaction) {
		_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
		byes <- req.Clone()
	})

	go func() { _ = server.ServeUDP(socket) }()
	go func() { _ = server.ServeUDP(remoteSocket) }()

	clientUA, err := sipgo.NewUA()
	if err != nil {
		t.Fatal(err)
	}
	defer clientUA.Close()
	client, err := sipgo.NewClient(clientUA, sipgo.WithClientHostname("127.0.0.1"))
	if err != nil {
		t.Fatal(err)
	}
	caller, err := NewClientCaller(client)
	if err != nil {
		t.Fatal(err)
	}
	requester, err := NewClientRequester(client)
	if err != nil {
		t.Fatal(err)
	}
	cfg := trunk.Config{OrgID: "org-a", TrunkID: "trunk-a", Enabled: true, AuthUser: "carrier-account",
		SIPDomain: "carrier.example", SIPProxy: socket.LocalAddr().String(), Transport: "udp"}
	p := profile.Internal("outbound", profile.Listener{Network: "udp", Addr: "127.0.0.1:5060"})
	p.NAT.ContactRewrite = nat.ModeNever
	profiles, err := profile.NewSet(p)
	if err != nil {
		t.Fatal(err)
	}
	baseCtx, cancel := context.WithCancel(t.Context())
	defer cancel()
	h := originateTestHandler()
	h.baseCtx, h.now, h.ringTimeout = baseCtx, time.Now, 10*time.Second
	h.caller, h.requester, h.profiles = caller, requester, profiles
	h.dialogs = dialog.NewStore(dialog.StoreOptions{InstanceID: "test-edge"})
	h.legs = make(map[string]*leg)
	h.trunks, h.events = outboundDirectory{config: cfg}, LogEventSink{Log: h.log}
	h.trunkAuth = outboundAuthFunc(func(_ context.Context, cfg trunk.Config, req *sip.Request, res *sip.Response) (*sip.Request, error) {
		if res.StatusCode != 407 {
			return nil, errors.New("unexpected challenge")
		}
		credential, err := digest.Digest(challenge, digest.Options{Username: cfg.AuthUser,
			Password: "synthetic-password", Method: "INVITE", URI: req.Recipient.Addr(), Count: 1})
		if err != nil {
			return nil, err
		}
		authorized := req.Clone()
		authorized.CSeq().SeqNo++
		authorized.RemoveHeader("Via")
		authorized.AppendHeader(sip.NewHeader("Proxy-Authorization", credential.String()))
		return authorized, nil
	})
	defer func() {
		h.mu.Lock()
		left := make([]*leg, 0, len(h.legs))
		for _, item := range h.legs {
			left = append(left, item)
		}
		h.mu.Unlock()
		for _, item := range left {
			_, _ = item.session.Do(context.Background(), func(*dialog.Dialog) (dialog.Outcome, error) {
				if item.state.ringTimer != nil {
					item.state.ringTimer.Stop()
				}
				return dialog.Outcome{}, nil
			})
			item.session.Close()
		}
	}()
	_, _, err = h.Originate(t.Context(), contract.SipOriginateRequest{
		OrgID: cfg.OrgID, CallID: "call-a", LegID: "leg-a", SDPOffer: "v=0\r\n", RingTimeoutMs: new(500),
		Target: contract.SipOriginateRequestTarget{Kind: contract.SipOriginateRequestTargetKindTrunk,
			TrunkID: &cfg.TrunkID, Number: new("+12025550123")},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case ack := <-acks:
		if ack.CSeq().SeqNo != 2 || ack.Recipient.User != "remote-dialog" ||
			ack.Recipient.Port != contact.Port {
			t.Fatalf("ACK did not use the authenticated INVITE and response Contact: %s", ack.StartLine())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("answered call was never ACKed")
	}
	select {
	case ack := <-acks:
		if ack.CSeq().SeqNo != 2 {
			t.Fatal("retransmitted answer used a different ACK sequence")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("retransmitted answer was not ACKed")
	}
	select {
	case <-byes:
		t.Fatal("ring timeout ended an answered call")
	case <-time.After(650 * time.Millisecond):
	}
	if _, err := h.Hangup(t.Context(), "leg-a", 16, "test complete"); err != nil {
		t.Fatal(err)
	}
	select {
	case bye := <-byes:
		if bye.CSeq().SeqNo != 3 || bye.Recipient.User != "remote-dialog" {
			t.Fatal("incorrect BYE identity/sequence")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("BYE was not sent")
	}
	if !h.Wait(3 * time.Second) {
		t.Fatal("call workers did not finish")
	}
	if _, found := h.session("leg-a"); found {
		t.Fatal("completed call retained its dialog")
	}
	if inviteCount.Load() != 2 {
		t.Fatalf("unexpected INVITE attempts: %d", inviteCount.Load())
	}
}

func TestRouteSetFollowsSIPDialogRole(t *testing.T) {
	headers := []sip.Header{
		sip.NewHeader("Record-Route", "<sip:near-callee.example;lr>"),
		sip.NewHeader("Record-Route", "<sip:near-caller.example;lr>"),
	}
	if got := routeSetOf(headers, dialog.RoleUAC); got[0] != "<sip:near-caller.example;lr>" {
		t.Fatalf("UAC route order: %v", got)
	}
	if got := routeSetOf(headers, dialog.RoleUAS); got[0] != "<sip:near-callee.example;lr>" {
		t.Fatalf("UAS route order: %v", got)
	}
}

// A real carrier transaction must remain bounded even when the peer keeps challenging or the
// caller leaves while the control plane is resolving its credential.
func TestOutboundAuthenticationStopsOnRepeatedChallengesAndCancellation(t *testing.T) {
	for _, scenario := range []string{"same-nonce", "changing-nonce", "caller-cancel", "ring-timeout"} {
		t.Run(scenario, func(t *testing.T) {
			serverUA, err := sipgo.NewUA()
			if err != nil {
				t.Fatal(err)
			}
			defer serverUA.Close()
			server, err := sipgo.NewServer(serverUA)
			if err != nil {
				t.Fatal(err)
			}
			socket, err := net.ListenPacket("udp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer socket.Close()
			var attempts atomic.Int32
			server.OnInvite(func(req *sip.Request, tx sip.ServerTransaction) {
				count := attempts.Add(1)
				_ = tx.Respond(sip.NewResponseFromRequest(req, 100, "Trying", nil))
				if scenario == "ring-timeout" {
					return
				}
				nonce := "same-nonce"
				if scenario == "changing-nonce" {
					nonce = fmt.Sprintf("nonce-%d", count)
				}
				response := sip.NewResponseFromRequest(req, 407, "Proxy Authentication Required", nil)
				response.AppendHeader(sip.NewHeader("Proxy-Authenticate", (&digest.Challenge{Realm: "carrier.example", Nonce: nonce, Algorithm: "MD5"}).String()))
				_ = tx.Respond(response)
			})
			go func() { _ = server.ServeUDP(socket) }()
			clientUA, err := sipgo.NewUA()
			if err != nil {
				t.Fatal(err)
			}
			defer clientUA.Close()
			client, err := sipgo.NewClient(clientUA, sipgo.WithClientHostname("127.0.0.1"))
			if err != nil {
				t.Fatal(err)
			}
			caller, _ := NewClientCaller(client)
			requester, _ := NewClientRequester(client)
			cfg := trunk.Config{OrgID: "org-a", TrunkID: "trunk-a", Enabled: true, AuthUser: "account", SIPDomain: "carrier.example", SIPProxy: socket.LocalAddr().String(), Transport: "udp"}
			p := profile.Internal("test", profile.Listener{Network: "udp", Addr: "127.0.0.1:5060"})
			p.NAT.ContactRewrite = nat.ModeNever
			profiles, _ := profile.NewSet(p)
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			h := originateTestHandler()
			h.baseCtx, h.now, h.ringTimeout = ctx, time.Now, 2*time.Second
			if scenario == "ring-timeout" {
				h.ringTimeout = 100 * time.Millisecond
			}
			h.caller, h.requester, h.profiles = caller, requester, profiles
			h.dialogs = dialog.NewStore(dialog.StoreOptions{InstanceID: "test-edge"})
			h.legs = make(map[string]*leg)
			h.trunks, h.events = outboundDirectory{config: cfg}, LogEventSink{Log: h.log}
			authStarted := make(chan struct{}, 1)
			authStopped := make(chan struct{}, 1)
			h.trunkAuth = outboundAuthFunc(func(ctx context.Context, _ trunk.Config, req *sip.Request, _ *sip.Response) (*sip.Request, error) {
				if scenario == "caller-cancel" {
					authStarted <- struct{}{}
					<-ctx.Done()
					authStopped <- struct{}{}
					return nil, ctx.Err()
				}
				authorized := req.Clone()
				authorized.CSeq().SeqNo++
				authorized.RemoveHeader("Via")
				return authorized, nil
			})
			_, _, err = h.Originate(t.Context(), contract.SipOriginateRequest{OrgID: cfg.OrgID, CallID: "call", LegID: "leg", SDPOffer: "v=0\r\n",
				Target: contract.SipOriginateRequestTarget{Kind: contract.SipOriginateRequestTargetKindTrunk, TrunkID: &cfg.TrunkID, Number: new("+12025550123")}})
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "caller-cancel" {
				select {
				case <-authStarted:
				case <-time.After(time.Second):
					t.Fatal("authentication did not start")
				}
				if _, err := h.Hangup(t.Context(), "leg", 16, "caller cancelled"); err != nil {
					t.Fatal(err)
				}
				select {
				case <-authStopped:
				case <-time.After(time.Second):
					t.Fatal("credential request survived caller cancellation")
				}
			}
			if !h.Wait(3 * time.Second) {
				t.Fatal("outbound transaction workers leaked")
			}
			if _, found := h.session("leg"); found {
				t.Fatal("failed call retained its dialog")
			}
			want := int32(1)
			if scenario == "same-nonce" {
				want = 2
			}
			if scenario == "changing-nonce" {
				want = 4
			}
			if attempts.Load() != want {
				t.Fatalf("INVITE count = %d, want %d", attempts.Load(), want)
			}
		})
	}
}
