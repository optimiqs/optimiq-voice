//go:build loadtest

package rtp_test

// A gated load harness: N bridged session pairs, real loopback UDP, synthetic G.711 at 50 pps per
// leg, through the real Manager, Session and Bridge.
//
//	go test -tags loadtest -run TestLoad -v ./internal/rtp/
//	MEDIAD_LOAD_PAIRS=500 MEDIAD_LOAD_SECONDS=20 go test -tags loadtest -run TestLoad -v ./internal/rtp/
//
// It reports delivered/sent frames, goroutines and heap at steady state, and both again after every
// session is released, which is where a leaked goroutine or a retained buffer shows up.

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"runtime"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

const loadFrameInterval = audio.FrameDurationMs * time.Millisecond

// loadPhone is one endpoint of one leg: it paces frames at 50 pps and counts what comes back.
type loadPhone struct {
	conn     *net.UDPConn
	session  *net.UDPAddr
	sent     atomic.Uint64
	received atomic.Uint64
}

func TestLoadBridgedPairs(t *testing.T) {
	pairs := envInt(t, "MEDIAD_LOAD_PAIRS", 200)
	seconds := envInt(t, "MEDIAD_LOAD_SECONDS", 10)
	bufferBytes := envInt(t, "MEDIAD_LOAD_SOCKET_BUFFER", 1<<19)

	allocator, err := rtp.NewAllocator(loopback, 46000, 46000+pairs*4+511)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	allocator.SocketBufferBytes = bufferBytes
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError})),
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}

	baselineGoroutines, baselineHeap := steadyState()

	phones := make([]*loadPhone, 0, pairs*2)
	for index := range pairs {
		aID := fmt.Sprintf("load-a-%d", index)
		bID := fmt.Sprintf("load-b-%d", index)
		a, err := manager.Allocate(rtp.AllocateOptions{SessionID: aID, AudioPayloadType: rtp.PayloadTypePCMU})
		if err != nil {
			t.Fatalf("allocating %s: %v", aID, err)
		}
		b, err := manager.Allocate(rtp.AllocateOptions{SessionID: bID, AudioPayloadType: rtp.PayloadTypePCMU})
		if err != nil {
			t.Fatalf("allocating %s: %v", bID, err)
		}
		phoneA := newLoadPhone(t, a.RTPPort)
		phoneB := newLoadPhone(t, b.RTPPort)
		phones = append(phones, phoneA, phoneB)

		// Both legs must latch before the bridge, exactly as a real call does.
		hello := loadFrame(t, 0, 0)
		_, _ = phoneA.conn.WriteToUDP(hello, phoneA.session)
		_, _ = phoneB.conn.WriteToUDP(hello, phoneB.session)
		if err := manager.Bridge(fmt.Sprintf("load-bridge-%d", index), aID, bID); err != nil {
			t.Fatalf("bridging pair %d: %v", index, err)
		}
	}

	ctx, cancel := context.WithTimeout(t.Context(), time.Duration(seconds)*time.Second)
	defer cancel()

	var group sync.WaitGroup
	for _, phone := range phones {
		group.Go(func() { phone.receiveUntil(ctx) })
		group.Go(func() { phone.sendUntil(ctx) })
	}

	time.Sleep(time.Duration(seconds) * time.Second / 2)
	loadedGoroutines, loadedHeap := steadyState()
	group.Wait()

	var sent, received uint64
	for _, phone := range phones {
		sent += phone.sent.Load()
		received += phone.received.Load()
		_ = phone.conn.Close()
	}

	// mediad's own view, which separates a service drop from the harness failing to read in time.
	var serviceReceived, serviceSent uint64
	for index := range pairs {
		for _, id := range [...]string{fmt.Sprintf("load-a-%d", index), fmt.Sprintf("load-b-%d", index)} {
			session, ok := manager.Get(id)
			if !ok {
				continue
			}
			stats := session.Stats()
			serviceReceived += stats.PacketsReceived
			serviceSent += stats.PacketsSent
		}
	}

	drainCtx, cancelDrain := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancelDrain()
	if err := manager.Drain(drainCtx); err != nil {
		t.Errorf("Drain: %v", err)
	}
	// A released session's goroutines unwind on their own schedule; without this pause the leak
	// reading measures the teardown rather than what survived it.
	time.Sleep(500 * time.Millisecond)
	afterGoroutines, afterHeap := steadyState()

	t.Logf("pairs=%d seconds=%d socketBuffer=%d", pairs, seconds, bufferBytes)
	t.Logf("frames sent=%d delivered=%d loss=%.3f%%",
		sent, received, 100*(1-float64(received)/float64(max(sent, 1))))
	t.Logf("mediad received=%d sent=%d ingress loss=%.3f%% relay loss=%.3f%%",
		serviceReceived, serviceSent,
		100*(1-float64(serviceReceived)/float64(max(sent, 1))),
		100*(1-float64(serviceSent)/float64(max(serviceReceived, 1))))
	t.Logf("goroutines baseline=%d loaded=%d after-release=%d",
		baselineGoroutines, loadedGoroutines, afterGoroutines)
	t.Logf("heap bytes baseline=%d loaded=%d after-release=%d",
		baselineHeap, loadedHeap, afterHeap)
	t.Logf("heap per session under load = %d bytes", (loadedHeap-baselineHeap)/uint64(max(pairs*2, 1)))

	if received == 0 {
		t.Fatal("no frame crossed any bridge")
	}
	if leaked := afterGoroutines - baselineGoroutines; leaked > pairs/10+16 {
		t.Errorf("%d goroutines survived releasing every session", leaked)
	}
}

func newLoadPhone(t *testing.T, sessionPort int) *loadPhone {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("binding a load phone: %v", err)
	}
	return &loadPhone{conn: conn, session: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: sessionPort}}
}

func (p *loadPhone) sendUntil(ctx context.Context) {
	ticker := time.NewTicker(loadFrameInterval)
	defer ticker.Stop()
	packet := pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 0x1234},
		Payload: make([]byte, audio.FrameSamples),
	}
	buf := make([]byte, 1500)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		packet.SequenceNumber++
		packet.Timestamp += audio.FrameTimestampStep
		n, err := packet.MarshalTo(buf)
		if err != nil {
			return
		}
		if _, err := p.conn.WriteToUDP(buf[:n], p.session); err != nil {
			return
		}
		p.sent.Add(1)
	}
}

func (p *loadPhone) receiveUntil(ctx context.Context) {
	buf := make([]byte, 1500)
	for ctx.Err() == nil {
		if err := p.conn.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
			return
		}
		if _, _, err := p.conn.ReadFromUDP(buf); err != nil {
			continue
		}
		p.received.Add(1)
	}
}

func loadFrame(t *testing.T, sequence uint16, timestamp uint32) []byte {
	t.Helper()
	packet := pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: rtp.PayloadTypePCMU,
			SequenceNumber: sequence, Timestamp: timestamp, SSRC: 0x1234,
		},
		Payload: make([]byte, audio.FrameSamples),
	}
	raw, err := packet.Marshal()
	if err != nil {
		t.Fatalf("marshalling a load frame: %v", err)
	}
	return raw
}

// steadyState settles the collector and reads the two numbers a leak shows up in.
func steadyState() (goroutines int, heapBytes uint64) {
	runtime.GC()
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	return runtime.NumGoroutine(), stats.HeapAlloc
}

func envInt(t *testing.T, name string, fallback int) int {
	t.Helper()
	raw := os.Getenv(name)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value <= 0 {
		t.Fatalf("%s=%q is not a positive integer", name, raw)
	}
	return value
}
