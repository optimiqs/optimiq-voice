// Load harness for the control plane.
//
// Two halves, deliberately separable:
//
//   - The HANDLER benchmarks call the exported handlers directly. No broker, no sockets, so what
//     they measure is exactly the per-RPC decode/encode/allocation cost and nothing else. They run
//     in the normal suite (`go test -bench`) and are the numbers to watch in review.
//   - The WIRE benchmarks put a real nats-server between caller and handler, with the real KV
//     ownership router attached, so a KV round trip per RPC is visible as latency. They need
//     NATS_SERVER_BIN naming a JetStream-capable binary and skip without one — the same contract
//     sipd's integration suite uses, and for the same reason: this machine has no container runtime.
//
// Run:
//
//	go test ./internal/control -run xxx -bench 'BenchmarkHandler' -benchmem -count=5
//	NATS_SERVER_BIN=$(command -v nats-server) go test ./internal/control -run xxx \
//	  -bench 'BenchmarkWire' -benchmem -count=5
//
// and `RUN_MEDIAD_LOAD=1 … -run TestControlPlaneLoad -v` for the p50/p99 sweep at 500–2000 req/s.
package control_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
)

// benchRig is newRigWith without a *testing.T, so a benchmark can build one per iteration set.
func benchRig(tb testing.TB) *rig {
	tb.Helper()
	sessions := newStub()
	dir := directory.NewFakeStore()
	server, err := control.NewServer(control.ServerOptions{
		Sessions:      sessions,
		Directory:     dir,
		Library:       audio.NewLibrary(tb.TempDir()),
		RecordingsDir: tb.TempDir(),
		InstanceID:    thisNode,
		PublicAddr:    netip.MustParseAddr("203.0.113.10"),
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		tb.Fatalf("NewServer: %v", err)
	}
	return &rig{server: server, sessions: sessions, dir: dir}
}

func benchSessionID(index int) string {
	// A valid UUID-shaped id per iteration: the handlers validate the shape, and reusing one id
	// would benchmark the "already allocated" path instead of the allocate path.
	return fmt.Sprintf("0192c7a1-4b8e-7f21-8b3c-%012x", index)
}

// BenchmarkHandlerAllocateSession is the fullest single-RPC path: decode, SDP parse, allocate,
// directory write, encode.
func BenchmarkHandlerAllocateSession(b *testing.B) {
	r := benchRig(b)
	payloads := make([][]byte, 512)
	for i := range payloads {
		request := validAllocate()
		request.SessionID = benchSessionID(i)
		payload, err := json.Marshal(request)
		if err != nil {
			b.Fatal(err)
		}
		payloads[i] = payload
	}
	b.ReportAllocs()
	next := 0
	for b.Loop() {
		if out := r.server.HandleAllocateSession(payloads[next%len(payloads)]); len(out) == 0 {
			b.Fatal("empty reply")
		}
		next++
	}
}

// BenchmarkHandlerBridgeSessions and the two below are the commands with a 500 ms engine budget.
func BenchmarkHandlerBridgeSessions(b *testing.B) {
	r := benchRig(b)
	first, second := benchSessionID(1), benchSessionID(2)
	for _, id := range []string{first, second} {
		request := validAllocate()
		request.SessionID = id
		r.server.HandleAllocateSession(mustMarshal(b, request))
	}
	payload := mustMarshal(b, contract.MediaBridgeSessionsRequest{
		BridgeID: testCall, SessionIDs: []string{first, second},
	})
	b.ReportAllocs()
	for b.Loop() {
		r.server.HandleBridgeSessions(payload)
	}
}

func BenchmarkHandlerHoldSession(b *testing.B) {
	r := benchRig(b)
	id := benchSessionID(3)
	request := validAllocate()
	request.SessionID = id
	r.server.HandleAllocateSession(mustMarshal(b, request))
	hold := mustMarshal(b, map[string]any{"orgId": testOrg, "callId": testCall, "sessionId": id, "held": true})
	unhold := mustMarshal(b, map[string]any{"orgId": testOrg, "callId": testCall, "sessionId": id, "held": false})
	b.ReportAllocs()
	held := false
	for b.Loop() {
		if held {
			r.server.HandleHoldSession(unhold)
		} else {
			r.server.HandleHoldSession(hold)
		}
		held = !held
	}
}

func BenchmarkHandlerReleaseSession(b *testing.B) {
	r := benchRig(b)
	payloads := make([][]byte, 512)
	for i := range payloads {
		payloads[i] = mustMarshal(b, map[string]any{
			"orgId": testOrg, "callId": testCall, "sessionId": benchSessionID(i),
		})
	}
	b.ReportAllocs()
	next := 0
	for b.Loop() {
		r.server.HandleReleaseSession(payloads[next%len(payloads)])
		next++
	}
}

func mustMarshal(tb testing.TB, value any) []byte {
	tb.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		tb.Fatalf("marshalling: %v", err)
	}
	return payload
}

// benchCleanup tears the shared broker down. Set by spawnBenchNATS, run by TestMain.
var benchCleanup func()

// TestMain exists only to kill the shared broker. Without it the spawned nats-server outlives the
// test binary, and a `go test` loop leaves one behind per run.
func TestMain(m *testing.M) {
	code := m.Run()
	if benchCleanup != nil {
		benchCleanup()
	}
	os.Exit(code)
}

func natsBinary(tb testing.TB) string {
	binary := strings.TrimSpace(os.Getenv("NATS_SERVER_BIN"))
	if binary == "" {
		tb.Skip("set NATS_SERVER_BIN to a JetStream-capable nats-server to run the wire harness")
	}
	if _, err := exec.LookPath(binary); err != nil {
		tb.Skipf("NATS_SERVER_BIN=%s is not executable", binary)
	}
	return binary
}

func benchFreePort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	return port, listener.Close()
}

// sharedNATS is ONE broker for the whole binary. A server per benchmark function looked tidier and
// was wrong: `-count=5` then spawns fifteen of them, and the loopback sockets they leave in
// TIME_WAIT turn into "no buffer space available" halfway through the run — which reads as a
// mediad failure and is not one.
var sharedNATSURL = sync.OnceValue(spawnBenchNATS)

// startBenchNATS returns the shared JetStream server's URL, starting it on first use.
func startBenchNATS(tb testing.TB) string {
	natsBinary(tb) // skips when NATS_SERVER_BIN is unset, before anything is spawned.
	url := sharedNATSURL()
	if url == "" {
		tb.Fatal("the shared nats-server could not be started; see the log above")
	}
	return url
}

// spawnBenchNATS starts the broker. It reports failure by returning "" and logging, rather than
// through a *testing.TB: it runs once, under whichever benchmark happened to be first, and that
// benchmark may well have finished by the time a later one asks for the URL.
func spawnBenchNATS() string {
	port, err := benchFreePort()
	if err != nil {
		log.Printf("mediad bench: reserving a port: %v", err)
		return ""
	}
	store, err := os.MkdirTemp("", "mediad-bench-js")
	if err != nil {
		log.Printf("mediad bench: jetstream store: %v", err)
		return ""
	}
	binary := strings.TrimSpace(os.Getenv("NATS_SERVER_BIN"))
	cmd := exec.Command(binary, "-a", "127.0.0.1", "-p", strconv.Itoa(port), "-js", "-sd", store)
	var output strings.Builder
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		log.Printf("mediad bench: starting nats-server: %v", err)
		return ""
	}
	benchCleanup = func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		_ = os.RemoveAll(store)
	}
	url := "nats://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := nats.Connect(url)
		if err == nil {
			js, jsErr := jetstream.New(conn)
			if jsErr == nil {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				_, jsErr = js.AccountInfo(ctx)
				cancel()
			}
			conn.Close()
			if jsErr == nil {
				return url
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	log.Printf("mediad bench: nats-server never became JetStream-ready:\n%s", output.String())
	return ""
}

// countingOwners wraps the real KV owner store and counts round trips, so a benchmark can report
// "KV operations per RPC" as a number rather than as a reading of ownership.go.
type countingOwners struct {
	inner                directory.Owners
	gets, claims, renews atomic.Int64
}

func (c *countingOwners) Get(ctx context.Context, key string) (string, error) {
	c.gets.Add(1)
	return c.inner.Get(ctx, key)
}

func (c *countingOwners) Claim(ctx context.Context, key, instance string) (string, error) {
	c.claims.Add(1)
	return c.inner.Claim(ctx, key, instance)
}

func (c *countingOwners) Refresh(ctx context.Context, key, instance string) error {
	c.renews.Add(1)
	return c.inner.Refresh(ctx, key, instance)
}

func (c *countingOwners) total() int64 { return c.gets.Load() + c.claims.Load() + c.renews.Load() }

// wireRig is a Server subscribed on a real connection, optionally with the real KV owner router.
type wireRig struct {
	*rig
	conn   *nats.Conn
	owners *countingOwners
}

func newWireRig(tb testing.TB, url string, withOwners bool) *wireRig {
	tb.Helper()
	sessions := newStub()
	dir := directory.NewFakeStore()
	conn, err := nats.Connect(url)
	if err != nil {
		tb.Fatalf("connecting: %v", err)
	}
	tb.Cleanup(conn.Close)

	opts := control.ServerOptions{
		Sessions:      sessions,
		Directory:     dir,
		Library:       audio.NewLibrary(tb.TempDir()),
		RecordingsDir: tb.TempDir(),
		InstanceID:    thisNode,
		PublicAddr:    netip.MustParseAddr("203.0.113.10"),
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	var counted *countingOwners
	if withOwners {
		js, err := jetstream.New(conn)
		if err != nil {
			tb.Fatalf("jetstream: %v", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		owners, err := directory.OpenOwners(ctx, js)
		if err != nil {
			tb.Fatalf("opening the owners bucket: %v", err)
		}
		counting := &countingOwners{inner: owners}
		opts.Owners = counting
		counted = counting
	}
	server, err := control.NewServer(opts)
	if err != nil {
		tb.Fatalf("NewServer: %v", err)
	}
	subs, err := server.Subscribe(conn, "mediad-bench")
	if err != nil {
		tb.Fatalf("Subscribe: %v", err)
	}
	tb.Cleanup(func() {
		for _, sub := range subs {
			_ = sub.Unsubscribe()
		}
	})
	return &wireRig{rig: &rig{server: server, sessions: sessions, dir: dir}, conn: conn, owners: counted}
}

// BenchmarkWireAllocateSession is one RPC end to end over a real broker, no ownership KV.
func BenchmarkWireAllocateSession(b *testing.B) { benchWire(b, false) }

// BenchmarkWireAllocateSessionOwned is the same with the KV ownership router in the path, so the
// difference between the two is the routing cost the brief asks about.
func BenchmarkWireAllocateSessionOwned(b *testing.B) { benchWire(b, true) }

func benchWire(b *testing.B, withOwners bool) {
	url := startBenchNATS(b)
	rig := newWireRig(b, url, withOwners)
	client, err := nats.Connect(url)
	if err != nil {
		b.Fatalf("client: %v", err)
	}
	defer client.Close()

	// Serial, one request in flight: this is a LATENCY number, comparable with the hold benchmarks
	// below. Throughput under concurrency is what TestControlPlaneLoad measures.
	var counter atomic.Int64
	var done int64
	b.ReportAllocs()
	for b.Loop() {
		request := validAllocate()
		request.SessionID = benchSessionID(int(counter.Add(1)))
		payload, _ := json.Marshal(request)
		if _, err := client.Request(control.SubjectAllocateSession, payload, 5*time.Second); err != nil {
			b.Fatalf("request: %v", err)
		}
		done++
	}
	reportKVPerRPC(b, rig, done)
}

// reportKVPerRPC turns the counting store's tally into a custom benchmark metric.
func reportKVPerRPC(b *testing.B, rig *wireRig, requests int64) {
	b.Helper()
	if rig.owners == nil || requests == 0 {
		return
	}
	b.ReportMetric(float64(rig.owners.total())/float64(requests), "kvops/op")
}

// BenchmarkWireHoldSessionOwned is a POST-allocate command on a session this node owns, which is
// the case the tracked-owner memo exists to answer without touching the KV. The gap between it and
// BenchmarkWireAllocateSessionOwned is how much of the routing cost is claim, not lookup.
func BenchmarkWireHoldSessionOwned(b *testing.B) { benchWireHold(b, true) }

// BenchmarkWireHoldSession is the same command with no ownership router at all: the floor.
func BenchmarkWireHoldSession(b *testing.B) { benchWireHold(b, false) }

func benchWireHold(b *testing.B, withOwners bool) {
	url := startBenchNATS(b)
	rig := newWireRig(b, url, withOwners)
	client, err := nats.Connect(url)
	if err != nil {
		b.Fatalf("client: %v", err)
	}
	defer client.Close()

	id := benchSessionID(7)
	request := validAllocate()
	request.SessionID = id
	if _, err := client.Request(control.SubjectAllocateSession, mustMarshal(b, request), 5*time.Second); err != nil {
		b.Fatalf("seeding the session: %v", err)
	}
	hold := mustMarshal(b, map[string]any{"orgId": testOrg, "callId": testCall, "sessionId": id, "held": true})
	unhold := mustMarshal(b, map[string]any{"orgId": testOrg, "callId": testCall, "sessionId": id, "held": false})

	var done int64
	b.ReportAllocs()
	held := false
	for b.Loop() {
		payload := hold
		if held {
			payload = unhold
		}
		held = !held
		if _, err := client.Request(control.SubjectHoldSession, payload, 5*time.Second); err != nil {
			b.Fatalf("request: %v", err)
		}
		done++
	}
	reportKVPerRPC(b, rig, done)
}

// TestControlPlaneLoad drives the real wire path at a fixed offered rate and reports p50/p99 and
// steady-state goroutines. Gated: it is a load test, not an assertion about behaviour.
func TestControlPlaneLoad(t *testing.T) {
	if os.Getenv("RUN_MEDIAD_LOAD") != "1" {
		t.Skip("set RUN_MEDIAD_LOAD=1 to run the control-plane load sweep")
	}
	url := startBenchNATS(t)
	for _, withOwners := range []bool{false, true} {
		for _, rate := range []int{500, 1000, 2000} {
			name := fmt.Sprintf("rate=%d owners=%v", rate, withOwners)
			t.Run(name, func(t *testing.T) {
				rig := newWireRig(t, url, withOwners)
				client, err := nats.Connect(url)
				if err != nil {
					t.Fatalf("client: %v", err)
				}
				defer client.Close()

				const seconds = 5
				total := rate * seconds
				latencies := make([]time.Duration, total)
				// Each goroutine owns one slot, so plain writes need no synchronisation; wg.Wait
				// is the happens-before edge before anything reads them back.
				failures := make([]bool, total)
				interval := time.Second / time.Duration(rate)
				var wg sync.WaitGroup
				var counter atomic.Int64
				start := time.Now()
				for slot := range total {
					if wait := time.Until(start.Add(time.Duration(slot) * interval)); wait > 0 {
						time.Sleep(wait)
					}
					wg.Go(func() {
						request := validAllocate()
						request.SessionID = benchSessionID(int(counter.Add(1)))
						payload, _ := json.Marshal(request)
						issued := time.Now()
						if _, err := client.Request(control.SubjectAllocateSession, payload, 5*time.Second); err != nil {
							failures[slot] = true
						}
						latencies[slot] = time.Since(issued)
					})
				}
				wg.Wait()
				elapsed := time.Since(start)
				goroutines := runtime.NumGoroutine()

				failed := 0
				for _, f := range failures {
					if f {
						failed++
					}
				}
				slices.Sort(latencies)
				p := func(q float64) time.Duration { return latencies[int(float64(len(latencies)-1)*q)] }
				t.Logf("offered=%d/s achieved=%.0f/s failures=%d p50=%s p90=%s p99=%s max=%s goroutines=%d",
					rate, float64(total)/elapsed.Seconds(), failed, p(0.5), p(0.9), p(0.99), p(1), goroutines)
				_ = rig
			})
		}
	}
}
