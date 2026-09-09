package webrtc_test

import (
	"context"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	media "github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
	secure "github.com/optimiqs/optimiq-voice/apps/mediad/internal/webrtc"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

func TestWebRTCBridgesBothDirectionsWithoutPlaintextIngress(t *testing.T) {
	for _, offerer := range []bool{false, true} {
		name := "browser-originated"
		if offerer {
			name = "server-originated"
		}
		t.Run(name, func(t *testing.T) { testBridge(t, offerer) })
	}
}

func testBridge(t *testing.T, serverOffers bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	loopback := netip.MustParseAddr("127.0.0.1")
	factory, err := secure.NewFactory(secure.Options{BindIP: loopback, PublicIP: loopback})
	if err != nil {
		t.Fatal(err)
	}
	transport, err := factory.New("browser")
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	browserSettings := pion.SettingEngine{}
	browserSettings.SetIncludeLoopbackCandidate(true)
	browser, err := pion.NewAPI(pion.WithSettingEngine(browserSettings)).NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	local, err := pion.NewTrackLocalStaticRTP(pion.RTPCodecCapability{MimeType: pion.MimeTypePCMU, ClockRate: 8000}, "microphone", "test")
	if err != nil {
		t.Fatal(err)
	}
	sender, err := browser.AddTrack(local)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		buf := make([]byte, 8192)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	arrivals := make(chan *rtp.Packet, 64)
	browser.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			select {
			case arrivals <- packet:
			case <-ctx.Done():
				return
			}
		}
	})
	gather := func(description pion.SessionDescription) string {
		complete := pion.GatheringCompletePromise(browser)
		if err := browser.SetLocalDescription(description); err != nil {
			t.Fatal(err)
		}
		select {
		case <-complete:
			return browser.LocalDescription().SDP
		case <-ctx.Done():
			t.Fatal("browser ICE gathering timed out")
		}
		return ""
	}
	if serverOffers {
		offer, err := transport.Offer(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if err := browser.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeOffer, SDP: offer}); err != nil {
			t.Fatal(err)
		}
		answer, err := browser.CreateAnswer(nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := transport.AcceptAnswer(gather(answer)); err != nil {
			t.Fatal(err)
		}
	} else {
		offer, err := browser.CreateOffer(nil)
		if err != nil {
			t.Fatal(err)
		}
		answer, err := transport.Answer(ctx, gather(offer))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(answer, "UDP/TLS/RTP/SAVPF") || !strings.Contains(answer, "a=fingerprint:sha-256") || !strings.Contains(answer, "a=candidate:") {
			t.Fatal("answer omitted WebRTC transport negotiation")
		}
		if err := browser.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer}); err != nil {
			t.Fatal(err)
		}
	}
	allocator, err := media.NewAllocator(loopback, 37000, 37199)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := media.NewManager(media.ManagerOptions{Allocator: allocator, PublicAddr: loopback})
	if err != nil {
		t.Fatal(err)
	}
	defer manager.Drain(context.Background())
	web, err := manager.Allocate(media.AllocateOptions{SessionID: "web", OrgID: "org", CallID: "call", Transport: transport, TelephoneEventPayloadType: 101})
	if err != nil {
		t.Fatal(err)
	}
	phone, err := manager.Allocate(media.AllocateOptions{SessionID: "phone", OrgID: "org", CallID: "call"})
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.Bridge("bridge", "web", "phone"); err != nil {
		t.Fatal(err)
	}
	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer socket.Close()
	plainArrivals := make(chan *rtp.Packet, 64)
	go func() {
		buf := make([]byte, 2048)
		for {
			n, _, err := socket.ReadFromUDP(buf)
			if err != nil {
				return
			}
			packet := &rtp.Packet{}
			if packet.Unmarshal(buf[:n]) == nil {
				select {
				case plainArrivals <- packet:
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	packet := func(marker byte, seq uint16) *rtp.Packet {
		payload := make([]byte, 160)
		for i := range payload {
			payload[i] = marker
		}
		return &rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: 0, SSRC: 321, SequenceNumber: seq, Timestamp: uint32(seq) * 160}, Payload: payload}
	}
	var heardBrowser, heardPhone bool
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for seq := uint16(0); !heardBrowser || !heardPhone; seq++ {
		select {
		case <-ctx.Done():
			t.Fatalf("audio did not bridge: browser=%v phone=%v", heardBrowser, heardPhone)
		case <-ticker.C:
		}
		if err := local.WriteRTP(packet(0x55, seq)); err != nil {
			t.Fatal(err)
		}
		raw, _ := packet(0x66, seq).Marshal()
		if _, err := socket.WriteToUDP(raw, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: phone.RTPPort}); err != nil {
			t.Fatal(err)
		}
		// A forged plaintext packet sent to the secure session's reserved UDP port must never enter it.
		forged, _ := packet(0x77, seq).Marshal()
		_, _ = socket.WriteToUDP(forged, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: web.RTPPort})
		select {
		case packet := <-arrivals:
			heardPhone = len(packet.Payload) > 0 && packet.Payload[0] == 0x66
		default:
		}
		select {
		case packet := <-plainArrivals:
			if len(packet.Payload) > 0 && packet.Payload[0] == 0x77 {
				t.Fatal("plaintext packet entered the encrypted session")
			}
			heardBrowser = len(packet.Payload) > 0 && packet.Payload[0] == 0x55
		default:
		}
	}
	if !manager.Release("web") {
		t.Fatal("secure session was not released")
	}
	select {
	case <-transport.Done():
	case <-ctx.Done():
		t.Fatal("release left the WebRTC transport open")
	}
}
