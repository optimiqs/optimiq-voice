package rtp

// The packet-path benchmark suite. Every benchmark drives the real code path — real loopback UDP,
// the real Session, the real mixer — since the costs measured here are invisible to a mock.

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

var benchLoopback = netip.MustParseAddr("127.0.0.1")

func benchLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// benchAllocator hands out real bound pairs from an ephemeral-ish range chosen per benchmark so two
// benchmarks in one binary never fight over the same ports.
func benchAllocator(tb testing.TB, low, pairs int) *Allocator {
	tb.Helper()
	allocator, err := NewAllocator(benchLoopback, low, low+pairs*2-1)
	if err != nil {
		tb.Fatalf("NewAllocator: %v", err)
	}
	return allocator
}

func benchSession(tb testing.TB, allocator *Allocator, id string, pt uint8) *Session {
	tb.Helper()
	ports, err := allocator.Allocate()
	if err != nil {
		tb.Fatalf("Allocate: %v", err)
	}
	session, err := NewSession(Options{
		ID:                        id,
		Ports:                     ports,
		AudioPayloadType:          pt,
		Logger:                    benchLogger(),
		TelephoneEventPayloadType: PayloadTypeTelephoneEvent,
	})
	if err != nil {
		tb.Fatalf("NewSession: %v", err)
	}
	tb.Cleanup(func() { _ = session.Close() })
	return session
}

// benchSink is a UDP socket that swallows everything sent to it. Its drain goroutine is required:
// without a reader the kernel buffer fills and the benchmark measures the error path.
type benchSink struct {
	conn *net.UDPConn
	addr *net.UDPAddr
	got  atomic.Uint64
}

func newBenchSink(tb testing.TB) *benchSink {
	tb.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		tb.Fatalf("binding a sink: %v", err)
	}
	sink := &benchSink{conn: conn, addr: conn.LocalAddr().(*net.UDPAddr)}
	go func() {
		buf := make([]byte, maxPacketSize)
		for {
			n, _, err := conn.ReadFromUDP(buf)
			if err != nil {
				return
			}
			_ = n
			sink.got.Add(1)
		}
	}()
	tb.Cleanup(func() { _ = conn.Close() })
	return sink
}

// latchTo forces the session's learned far end, which a real call learns from its first packet.
func latchTo(session *Session, addr *net.UDPAddr) {
	session.remoteMu.Lock()
	session.remote = addr
	session.remoteMu.Unlock()
}

func benchPayload(n int) []byte {
	payload := make([]byte, n)
	for index := range payload {
		payload[index] = byte(index)
	}
	return payload
}

func benchPacketBytes(tb testing.TB, pt uint8, seq uint16, ts uint32) []byte {
	tb.Helper()
	packet := pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: pt, SequenceNumber: seq, Timestamp: ts, SSRC: 0xdeadbeef,
		},
		Payload: benchPayload(audio.FrameSamples),
	}
	raw, err := packet.Marshal()
	if err != nil {
		tb.Fatalf("marshalling: %v", err)
	}
	return raw
}

// BenchmarkHandlePacketRelay is the per-packet demux, bridge and write path with the read syscall
// taken out. The write is a real WriteToUDP to a drained socket.
func BenchmarkHandlePacketRelay(b *testing.B) {
	allocator := benchAllocator(b, 41000, 8)
	a := benchSession(b, allocator, "bench-a", PayloadTypePCMU)
	peer := benchSession(b, allocator, "bench-b", PayloadTypePCMU)
	sink := newBenchSink(b)
	latchTo(peer, sink.addr)

	a.SetPeer(peer)
	peer.SetPeer(a)

	from := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 40000}
	latchTo(a, from)
	raw := benchPacketBytes(b, PayloadTypePCMU, 1, 160)

	b.ReportAllocs()
	for b.Loop() {
		a.handlePacket(raw, from)
	}
}

// BenchmarkForward is the send half alone: header build, marshal, WriteToUDP.
func BenchmarkForward(b *testing.B) {
	allocator := benchAllocator(b, 41100, 4)
	peer := benchSession(b, allocator, "bench-fwd", PayloadTypePCMU)
	sink := newBenchSink(b)
	latchTo(peer, sink.addr)

	packet := &pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: PayloadTypePCMU, SSRC: 1, Timestamp: 160},
		Payload: benchPayload(audio.FrameSamples),
	}

	b.ReportAllocs()
	for b.Loop() {
		peer.forward(packet, PayloadTypeTelephoneEvent)
	}
}

// BenchmarkRelayRoundTrip is the full path including both read syscalls. One iteration is one
// packet crossing the bridge.
func BenchmarkRelayRoundTrip(b *testing.B) {
	allocator := benchAllocator(b, 41200, 8)
	manager, err := NewManager(ManagerOptions{
		Allocator: allocator, PublicAddr: benchLoopback, Logger: benchLogger(),
	})
	if err != nil {
		b.Fatalf("NewManager: %v", err)
	}
	b.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = manager.Drain(ctx)
	})

	legA, err := manager.Allocate(AllocateOptions{SessionID: "a", AudioPayloadType: PayloadTypePCMU})
	if err != nil {
		b.Fatalf("allocate a: %v", err)
	}
	legB, err := manager.Allocate(AllocateOptions{SessionID: "b", AudioPayloadType: PayloadTypePCMU})
	if err != nil {
		b.Fatalf("allocate b: %v", err)
	}

	phoneA, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		b.Fatalf("phone a: %v", err)
	}
	defer phoneA.Close()
	phoneB, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		b.Fatalf("phone b: %v", err)
	}
	defer phoneB.Close()

	addrA := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: legA.RTPPort}
	addrB := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: legB.RTPPort}

	// Latch both legs the way a call does, then bridge.
	hello := benchPacketBytes(b, PayloadTypePCMU, 0, 0)
	for range 50 {
		_, _ = phoneA.WriteToUDP(hello, addrA)
		_, _ = phoneB.WriteToUDP(hello, addrB)
		sessionA, _ := manager.Get("a")
		sessionB, _ := manager.Get("b")
		if sessionA.Remote() != nil && sessionB.Remote() != nil {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if err := manager.Bridge("bridge", "a", "b"); err != nil {
		b.Fatalf("Bridge: %v", err)
	}

	raw := benchPacketBytes(b, PayloadTypePCMU, 1, 160)
	buf := make([]byte, maxPacketSize)

	b.ReportAllocs()
	for b.Loop() {
		if _, err := phoneA.WriteToUDP(raw, addrA); err != nil {
			b.Fatalf("send: %v", err)
		}
		_ = phoneB.SetReadDeadline(time.Now().Add(2 * time.Second))
		if _, _, err := phoneB.ReadFromUDP(buf); err != nil {
			b.Fatalf("receive: %v", err)
		}
	}
}

// benchConference builds a room with `members` seats, each on its own real port pair and each with
// its jitter buffer primed, so a tick has real audio to mix.
func benchConference(b *testing.B, portBase, members int) *Conference {
	b.Helper()
	allocator := benchAllocator(b, portBase, members+2)
	manager, err := NewManager(ManagerOptions{
		Allocator: allocator, PublicAddr: benchLoopback, Logger: benchLogger(),
	})
	if err != nil {
		b.Fatalf("NewManager: %v", err)
	}
	conference := &Conference{
		ID:      "bench-room",
		manager: manager,
		log:     benchLogger(),
		members: make(map[string]*Member),
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	sink := newBenchSink(b)
	for index := range members {
		session := benchSession(b, allocator, fmt.Sprintf("m%d", index), PayloadTypePCMU)
		latchTo(session, sink.addr)
		member, err := newMember(session, JoinOptions{Hear: Everyone(), SpeakTo: Everyone()})
		if err != nil {
			b.Fatalf("newMember: %v", err)
		}
		conference.seat(member)
		payload := benchPayload(audio.FrameSamples)
		now := time.Now()
		// Fill past the priming target so every tick pops a real frame rather than silence.
		for frame := range jitterMaxFrames*2 - 1 {
			member.jitter.Push(uint16(frame), uint32(frame*audio.FrameTimestampStep), payload, now)
		}
	}
	return conference
}

func BenchmarkMixTick8(b *testing.B)   { benchmarkMixTick(b, 42000, 8) }
func BenchmarkMixTick32(b *testing.B)  { benchmarkMixTick(b, 42100, 32) }
func BenchmarkMixTick128(b *testing.B) { benchmarkMixTick(b, 45000, 128) }

// BenchmarkBridgeLookup is the membership question the control path asks on nearly every command,
// measured against a manager holding `n` unrelated bridges. It is the reverse index's whole point:
// the answer must not depend on how busy the box is.
func BenchmarkBridgeLookup(b *testing.B) {
	for _, n := range []int{100, 1000, 10000} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			manager := &Manager{
				bridges:         make(map[string][2]string, n),
				bridgeBySession: make(map[string]string, 2*n),
			}
			for index := range n {
				first, second := fmt.Sprintf("a%d", index), fmt.Sprintf("b%d", index)
				id := fmt.Sprint(index)
				manager.bridges[id] = [2]string{first, second}
				manager.bridgeBySession[first] = id
				manager.bridgeBySession[second] = id
			}
			b.ReportAllocs()
			for b.Loop() {
				manager.unbridgeSessionLocked("absent")
			}
		})
	}
}

func benchmarkMixTick(b *testing.B, portBase, members int) {
	conference := benchConference(b, portBase, members)
	payload := benchPayload(audio.FrameSamples)
	now := time.Now()
	seq := 0

	b.ReportAllocs()
	for b.Loop() {
		// Keep every buffer fed, so the tick measured is a tick with audio in it.
		conference.mu.Lock()
		for _, id := range conference.order {
			member := conference.members[id]
			member.jitter.Push(uint16(jitterMaxFrames*2+seq), uint32(seq*audio.FrameTimestampStep), payload, now)
		}
		conference.mu.Unlock()
		seq++
		conference.mixOnce()
	}
}

func BenchmarkTranscode(b *testing.B) {
	coder, err := NewTranscoder(audio.FormatULaw, audio.FormatALaw)
	if err != nil {
		b.Fatalf("NewTranscoder: %v", err)
	}
	payload := benchPayload(audio.FrameSamples)

	b.ReportAllocs()
	for b.Loop() {
		if _, ok := coder.Translate(payload); !ok {
			b.Fatal("Translate refused a G.711 frame")
		}
	}
}

func BenchmarkJitterPushPop(b *testing.B) {
	buffer := NewJitterBuffer(audio.SampleRate)
	payload := benchPayload(audio.FrameSamples)
	now := time.Now()

	sequence := uint16(0)
	b.ReportAllocs()
	for b.Loop() {
		buffer.Push(sequence, uint32(sequence)*audio.FrameTimestampStep, payload, now)
		buffer.Pop()
		sequence++
	}
}

func BenchmarkSenderReport(b *testing.B) {
	allocator := benchAllocator(b, 43000, 4)
	session := benchSession(b, allocator, "bench-rtcp", PayloadTypePCMU)
	sink := newBenchSink(b)
	// The report goes to remote.Port+1; a write to a closed loopback port costs the same syscall,
	// so the sink's odd companion is deliberately not bound.
	latchTo(session, sink.addr)
	now := time.Now()

	b.ReportAllocs()
	for b.Loop() {
		session.sendSenderReport(now)
	}
}

func BenchmarkDtmfDetect(b *testing.B) {
	allocator := benchAllocator(b, 43100, 4)
	session := benchSession(b, allocator, "bench-dtmf", PayloadTypePCMU)
	packet := &pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: PayloadTypeTelephoneEvent, Timestamp: 160},
		Payload: []byte{0x05, 0x0a, 0x00, 0xa0},
	}
	now := time.Now()

	b.ReportAllocs()
	for b.Loop() {
		session.tapDtmf(packet, now)
	}
}

func BenchmarkPlaybackFrame(b *testing.B) {
	allocator := benchAllocator(b, 43200, 4)
	session := benchSession(b, allocator, "bench-play", PayloadTypePCMU)
	sink := newBenchSink(b)
	latchTo(session, sink.addr)
	payload := benchPayload(audio.FrameSamples)

	b.ReportAllocs()
	for b.Loop() {
		if _, err := session.sendPlaybackFrame(payload, false); err != nil {
			b.Fatalf("sendPlaybackFrame: %v", err)
		}
	}
}

// BenchmarkRecordingEnqueue is the packet path's half of recording: the copy and the non-blocking
// hand-off. The file writer's own cost is not on the packet path and is not measured here.
func BenchmarkRecordingEnqueue(b *testing.B) {
	recording := &Recording{
		received: make(chan capturedFrame, recordingQueueFrames),
		sent:     make(chan capturedFrame, recordingQueueFrames),
	}
	payload := benchPayload(audio.FrameSamples)
	drained := make(chan struct{})
	go func() {
		defer close(drained)
		for range recording.received { //nolint:revive // draining
		}
	}()

	b.ReportAllocs()
	for b.Loop() {
		recording.Received(payload)
	}
	b.StopTimer()
	close(recording.received)
	<-drained
}

// nullTransport stands in for a secure transport that accepts every write and never reads, so a
// benchmark can measure the userspace half of the packet path with the socket write taken out.
type nullTransport struct{ ssrc uint32 }

func (t *nullTransport) LocalSSRC() uint32             { return t.ssrc }
func (t *nullTransport) ReadRTP(b []byte) (int, error) { select {} }
func (t *nullTransport) WriteRTP(b []byte) (int, error) {
	return len(b), nil
}
func (t *nullTransport) ReadRTCP(b []byte) (int, error)  { select {} }
func (t *nullTransport) WriteRTCP(b []byte) (int, error) { return len(b), nil }
func (t *nullTransport) Close() error                    { return nil }

// BenchmarkHandlePacketNoSyscall is BenchmarkHandlePacketRelay with the write syscall removed.
func BenchmarkHandlePacketNoSyscall(b *testing.B) {
	allocator := benchAllocator(b, 44000, 8)
	a := benchSession(b, allocator, "nosys-a", PayloadTypePCMU)

	ports, err := allocator.Allocate()
	if err != nil {
		b.Fatalf("Allocate: %v", err)
	}
	peer, err := NewSession(Options{
		ID: "nosys-b", Ports: ports, AudioPayloadType: PayloadTypePCMU,
		TelephoneEventPayloadType: PayloadTypeTelephoneEvent,
		Transport:                 &nullTransport{ssrc: 4242}, Logger: benchLogger(),
	})
	if err != nil {
		b.Fatalf("NewSession: %v", err)
	}
	b.Cleanup(func() { _ = peer.Close() })

	a.SetPeer(peer)
	from := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 40001}
	latchTo(a, from)
	raw := benchPacketBytes(b, PayloadTypePCMU, 1, 160)

	b.ReportAllocs()
	for b.Loop() {
		a.handlePacket(raw, from)
	}
}
