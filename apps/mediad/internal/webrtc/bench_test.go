package webrtc_test

import (
	"context"
	"fmt"
	"net/netip"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	secure "github.com/optimiqs/optimiq-voice/apps/mediad/internal/webrtc"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

// leg is one connected browser-to-mediad WebRTC pair on loopback.
type leg struct {
	transport *secure.Transport
	browser   *pion.PeerConnection
	track     *pion.TrackLocalStaticRTP
}

func (l *leg) close() {
	_ = l.transport.Close()
	_ = l.browser.Close()
}

// dialLeg negotiates a browser-originated leg against a mediad Transport and waits for media to
// flow, so a caller's timing never includes ICE or DTLS.
func dialLeg(tb testing.TB, ctx context.Context, factory *secure.Factory, id string) *leg {
	tb.Helper()
	transport, err := factory.New(id)
	if err != nil {
		tb.Fatalf("transport: %v", err)
	}
	settings := pion.SettingEngine{}
	settings.SetIncludeLoopbackCandidate(true)
	browser, err := pion.NewAPI(pion.WithSettingEngine(settings)).NewPeerConnection(pion.Configuration{})
	if err != nil {
		_ = transport.Close()
		tb.Fatalf("browser peer: %v", err)
	}
	track, err := pion.NewTrackLocalStaticRTP(
		pion.RTPCodecCapability{MimeType: pion.MimeTypePCMU, ClockRate: 8000}, "microphone", id)
	if err != nil {
		tb.Fatalf("browser track: %v", err)
	}
	sender, err := browser.AddTrack(track)
	if err != nil {
		tb.Fatalf("browser AddTrack: %v", err)
	}
	go func() {
		buf := make([]byte, 1500)
		for {
			if _, _, err := sender.Read(buf); err != nil {
				return
			}
		}
	}()
	browser.OnTrack(func(remote *pion.TrackRemote, _ *pion.RTPReceiver) {
		buf := make([]byte, 1500)
		for {
			if _, _, err := remote.Read(buf); err != nil {
				return
			}
		}
	})

	offer, err := browser.CreateOffer(nil)
	if err != nil {
		tb.Fatalf("offer: %v", err)
	}
	complete := pion.GatheringCompletePromise(browser)
	if err := browser.SetLocalDescription(offer); err != nil {
		tb.Fatalf("SetLocalDescription: %v", err)
	}
	select {
	case <-complete:
	case <-ctx.Done():
		tb.Fatal("browser ICE gathering timed out")
	}
	answer, err := transport.Answer(ctx, browser.LocalDescription().SDP)
	if err != nil {
		tb.Fatalf("answer: %v", err)
	}
	if err := browser.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer}); err != nil {
		tb.Fatalf("SetRemoteDescription: %v", err)
	}
	return &leg{transport: transport, browser: browser, track: track}
}

func benchFactory(tb testing.TB) *secure.Factory {
	tb.Helper()
	loopback := netip.MustParseAddr("127.0.0.1")
	factory, err := secure.NewFactory(secure.Options{BindIP: loopback, PublicIP: loopback})
	if err != nil {
		tb.Fatalf("factory: %v", err)
	}
	return factory
}

func silence(sequence uint16) *rtp.Packet {
	payload := make([]byte, 160)
	for i := range payload {
		payload[i] = 0xFF
	}
	return &rtp.Packet{
		Header:  rtp.Header{Version: 2, PayloadType: 0, SSRC: 0x1234, SequenceNumber: sequence, Timestamp: uint32(sequence) * 160},
		Payload: payload,
	}
}

// BenchmarkTransportInboundRTP measures the cost of one inbound SRTP packet crossing the transport:
// the ICE/DTLS/SRTP read, the interceptor chain, and whatever transport.go does before the media
// pipeline sees the bytes. b.N packets in, b.N packets read back out.
func BenchmarkTransportInboundRTP(b *testing.B) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	l := dialLeg(b, ctx, benchFactory(b), "inbound")
	defer l.close()
	warmUp(b, l)

	read := make([]byte, 1500)
	sequence := uint16(1000)
	b.ReportAllocs()
	for b.Loop() {
		sequence++
		if err := l.track.WriteRTP(silence(sequence)); err != nil {
			b.Fatalf("write: %v", err)
		}
		if _, err := l.transport.ReadRTP(read); err != nil {
			b.Fatalf("read: %v", err)
		}
	}
	b.StopTimer()
	if dropped, _ := l.transport.Dropped(); dropped > 0 {
		b.Logf("dropped %d inbound packets", dropped)
	}
}

// BenchmarkTransportOutboundRTP measures the write side: RTP parse, payload-type gate, SSRC rewrite,
// SRTP protect and the UDP send.
func BenchmarkTransportOutboundRTP(b *testing.B) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	l := dialLeg(b, ctx, benchFactory(b), "outbound")
	defer l.close()
	warmUp(b, l)

	raw, err := silence(1).Marshal()
	if err != nil {
		b.Fatal(err)
	}
	b.ReportAllocs()
	for b.Loop() {
		if _, err := l.transport.WriteRTP(raw); err != nil {
			b.Fatalf("write: %v", err)
		}
	}
}

// warmUp blocks until media actually flows. ICE and DTLS complete asynchronously and a benchmark
// that starts before they do measures the handshake.
func warmUp(tb testing.TB, l *leg) {
	tb.Helper()
	read := make([]byte, 1500)
	arrived := make(chan struct{})
	go func() {
		if _, err := l.transport.ReadRTP(read); err == nil {
			close(arrived)
		}
	}()
	deadline := time.After(20 * time.Second)
	for sequence := uint16(1); ; sequence++ {
		if err := l.track.WriteRTP(silence(sequence)); err != nil {
			tb.Fatalf("warm-up write: %v", err)
		}
		select {
		case <-arrived:
			return
		case <-deadline:
			tb.Fatal("no media crossed the WebRTC transport during warm-up")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// TestWebRTCLegLoad runs concurrent legs at telephony packet rate and reports drops, goroutines and
// heap. Gated: it is a load test, and 300 legs is 600 Pion peer connections on one host.
func TestWebRTCLegLoad(t *testing.T) {
	if os.Getenv("RUN_MEDIAD_LOAD") != "1" {
		t.Skip("set RUN_MEDIAD_LOAD=1 to run the WebRTC leg-load sweep")
	}
	for _, legs := range []int{100, 300} {
		t.Run(fmt.Sprintf("legs=%d", legs), func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 4*time.Minute)
			defer cancel()
			factory := benchFactory(t)

			dialled := make([]*leg, 0, legs)
			for i := range legs {
				dialled = append(dialled, dialLeg(t, ctx, factory, fmt.Sprintf("leg-%d", i)))
			}
			defer func() {
				for _, l := range dialled {
					l.close()
				}
			}()

			const (
				seconds = 10
				pps     = 50
			)
			var received atomic.Int64
			var wg sync.WaitGroup
			stop := make(chan struct{})
			for _, l := range dialled {
				wg.Go(func() {
					read := make([]byte, 1500)
					for {
						if _, err := l.transport.ReadRTP(read); err != nil {
							return
						}
						received.Add(1)
					}
				})
				wg.Go(func() {
					ticker := time.NewTicker(time.Second / pps)
					defer ticker.Stop()
					for sequence := uint16(1); ; sequence++ {
						select {
						case <-stop:
							return
						case <-ticker.C:
						}
						if err := l.track.WriteRTP(silence(sequence)); err != nil {
							return
						}
					}
				})
			}

			var before, after runtime.MemStats
			runtime.ReadMemStats(&before)
			start := time.Now()
			time.Sleep(seconds * time.Second)
			goroutines := runtime.NumGoroutine()
			runtime.ReadMemStats(&after)
			close(stop)
			for _, l := range dialled {
				_ = l.transport.Close()
			}
			wg.Wait()

			var droppedRTP, droppedRTCP uint64
			for _, l := range dialled {
				r, c := l.transport.Dropped()
				droppedRTP += r
				droppedRTCP += c
			}
			elapsed := time.Since(start)
			t.Logf("legs=%d offered=%d/s received=%d (%.0f pps) droppedRTP=%d droppedRTCP=%d "+
				"goroutines=%d goroutines/leg=%.1f allocMiB=%.0f allocs/packet=%.1f",
				legs, legs*pps, received.Load(), float64(received.Load())/elapsed.Seconds(),
				droppedRTP, droppedRTCP, goroutines, float64(goroutines)/float64(legs),
				float64(after.TotalAlloc-before.TotalAlloc)/(1<<20),
				float64(after.Mallocs-before.Mallocs)/float64(max(received.Load(), 1)))
		})
	}
}
