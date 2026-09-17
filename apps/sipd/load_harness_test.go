//go:build load

// The load rig: it drives the real sipd server over loopback sockets against a real JetStream
// broker, so a performance claim about this service is reproducible.
//
// It is build-tagged `load` and environment-gated, so neither `go test ./...` nor the `integration`
// suite ever starts one:
//
//	NATS_SERVER_BIN=/path/to/nats-server RUN_SIPD_LOAD=1 \
//	  go test -tags load -run TestLoad -timeout 20m -v .
//
// Profiles are written when SIPD_LOAD_PROFILE_DIR names a directory: one CPU, heap, mutex and block
// profile per scenario.
//
// The broker bootstrap is duplicated from integration_test.go rather than shared, because this file
// must not carry the `integration` tag: that suite runs in CI and a twenty-minute load rig would
// make it useless.
package sipd_test

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"runtime/pprof"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

const (
	loadRealm = "load.example.com"
	loadOrg   = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	loadPass  = "s3cret"
)

// requireLoad gates the whole file on an explicit opt-in and a local broker binary. No docker
// fallback, unlike the integration suite: a load number measured through a container's NAT measures
// the container runtime.
func requireLoad(t *testing.T) string {
	t.Helper()
	if os.Getenv("RUN_SIPD_LOAD") != "1" {
		t.Skip("set RUN_SIPD_LOAD=1 (and NATS_SERVER_BIN) to run the sipd load suite")
	}
	binary := strings.TrimSpace(os.Getenv("NATS_SERVER_BIN"))
	if binary == "" {
		t.Skip("set NATS_SERVER_BIN to a JetStream-capable nats-server for the load suite")
	}
	if _, err := exec.LookPath(binary); err != nil {
		t.Skipf("NATS_SERVER_BIN=%s is not executable: %v", binary, err)
	}
	return binary
}

// loadPort reserves and releases a TCP port.
func loadPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserving a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		t.Fatalf("releasing the reserved port: %v", err)
	}
	return port
}

func loadUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserving a UDP port: %v", err)
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).Port
}

// startLoadNATS spawns the broker with JetStream on a private store and kills it on the way out.
func startLoadNATS(t *testing.T, binary string) string {
	t.Helper()
	port := loadPort(t)
	cmd := exec.Command(binary,
		"-a", "127.0.0.1", "-p", strconv.Itoa(port),
		"-js", "-sd", t.TempDir(),
		// Nothing else is overridden: the rig measures sipd against a stock broker.
	)
	var output strings.Builder
	cmd.Stdout = &output
	cmd.Stderr = &output
	if err := cmd.Start(); err != nil {
		t.Fatalf("starting %s: %v", binary, err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		if t.Failed() {
			t.Logf("nats-server output:\n%s", output.String())
		}
	})

	url := "nats://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(30 * time.Second)
	for {
		conn, err := nats.Connect(url, nats.Timeout(2*time.Second))
		if err == nil {
			js, jsErr := jetstream.New(conn)
			if jsErr == nil {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				_, jsErr = js.AccountInfo(ctx)
				cancel()
			}
			conn.Close()
			if jsErr == nil {
				return url
			}
			err = jsErr
		}
		if time.Now().After(deadline) {
			t.Fatalf("NATS did not become ready at %s: %v", url, err)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// ensureLoadStreams provisions the two streams sipd publishes onto. sipd does not create its own
// streams (see events.NewJetStreamPublisher), so the rig plays the control plane.
func ensureLoadStreams(t *testing.T, ctx context.Context, js jetstream.JetStream) {
	t.Helper()
	for _, definition := range []contract.StreamDefinition{contract.RegistrationsStream, contract.SIPStream} {
		if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
			Name:              definition.Name,
			Description:       definition.Description,
			Subjects:          definition.Subjects,
			Retention:         jetstream.LimitsPolicy,
			Storage:           jetstream.MemoryStorage, // the rig measures sipd, not the disk under it
			Discard:           jetstream.DiscardOld,
			MaxAge:            definition.MaxAge,
			MaxMsgs:           definition.MaxMsgs,
			MaxBytes:          definition.MaxBytes,
			MaxMsgsPerSubject: definition.MaxMsgsPerSubject,
			Duplicates:        definition.DuplicateWindow,
			Replicas:          1,
		}); err != nil {
			t.Fatalf("creating the %s stream: %v", definition.Name, err)
		}
	}
}

// credentialResponderLoad answers the credential RPC for a fleet of synthetic accounts. It counts
// the requests that reached it, which is what the credential cache exists to reduce.
type credentialResponderLoad struct {
	subscription *nats.Subscription
	requests     atomic.Int64
	delay        time.Duration
}

// startCredentialResponderLoad answers for every `NNNN@loadRealm` with a derived HA1.
//
// It gets a connection of its own and a pool of goroutines fed by a channel subscription: sharing
// sipd's connection would compete for the dispatcher its replies arrive on, and a callback
// subscription answers one request at a time, so a cold storm would time out against the rig.
func startCredentialResponderLoad(t *testing.T, url string, delay time.Duration) *credentialResponderLoad {
	t.Helper()
	conn, err := nats.Connect(url, nats.Name("sipd-load-credentials"))
	if err != nil {
		t.Fatalf("connecting the credential responder: %v", err)
	}
	t.Cleanup(conn.Close)

	responder := &credentialResponderLoad{delay: delay}
	// A deep channel rather than raised pending limits: SetPendingLimits is refused on a channel
	// subscription, and the channel itself is the buffer.
	requests := make(chan *nats.Msg, 16384)
	subscription, err := conn.ChanSubscribe(contract.SubjectSipCredentialRPC, requests)
	if err != nil {
		t.Fatalf("subscribing to %s: %v", contract.SubjectSipCredentialRPC, err)
	}
	t.Cleanup(func() { _ = subscription.Unsubscribe() })
	responder.subscription = subscription

	for range 16 {
		go func() {
			for msg := range requests {
				responder.answer(msg)
			}
		}()
	}
	return responder
}

func (r *credentialResponderLoad) answer(msg *nats.Msg) {
	r.requests.Add(1)
	if r.delay > 0 {
		time.Sleep(r.delay)
	}
	var request contract.SipCredentialRequest
	if err := json.Unmarshal(msg.Data, &request); err != nil {
		_ = msg.Respond([]byte(`{"found":false,"enabled":false}`))
		return
	}
	ha1 := loadHA1(request.Username, request.Realm)
	org, realm, username := loadOrg, request.Realm, request.Username
	reply, _ := json.Marshal(contract.SipCredentialResponse{
		Found: true, Enabled: true,
		OrgID: &org, Realm: &realm, Username: &username, Ha1: &ha1,
	})
	_ = msg.Respond(reply)
}

// ---------------------------------------------------------------------------------------------
// measurement
// ---------------------------------------------------------------------------------------------

// sample is one timed operation.
type sample time.Duration

// stats is the reported shape of a run: throughput plus the tail, since a mean latency hides the
// phones that fail to register.
type stats struct {
	name     string
	ops      int
	failures int
	wall     time.Duration
	p50      time.Duration
	p90      time.Duration
	p99      time.Duration
	maximum  time.Duration
	// allocsPerOp and bytesPerOp come from a MemStats delta across the run; wall-clock on a shared
	// machine is noise, an allocation count is not.
	allocsPerOp float64
	bytesPerOp  float64
	// natsOutPerOp / natsInPerOp are broker round trips per operation, from nats.Conn.Stats(),
	// measuring KV round trips per REGISTER without instrumenting the KV client.
	natsOutPerOp float64
	natsInPerOp  float64
	goroutines   int
}

func (s stats) String() string {
	return fmt.Sprintf(
		"%s: %d ops (%d failed) in %s = %.0f ops/s | p50 %s p90 %s p99 %s max %s | "+
			"%.1f allocs/op %.0f B/op | nats %.2f out/op %.2f in/op | goroutines %d",
		s.name, s.ops, s.failures, s.wall.Round(time.Millisecond),
		float64(s.ops)/s.wall.Seconds(),
		s.p50.Round(time.Microsecond), s.p90.Round(time.Microsecond),
		s.p99.Round(time.Microsecond), s.maximum.Round(time.Microsecond),
		s.allocsPerOp, s.bytesPerOp, s.natsOutPerOp, s.natsInPerOp, s.goroutines)
}

// summarize turns raw samples plus the runtime/broker deltas into a reportable stats value.
func summarize(name string, samples []sample, failures int, wall time.Duration,
	before, after runtime.MemStats, natsBefore, natsAfter nats.Statistics) stats {
	sorted := slices.Clone(samples)
	slices.Sort(sorted)
	quantile := func(q float64) time.Duration {
		if len(sorted) == 0 {
			return 0
		}
		index := int(q * float64(len(sorted)-1))
		return time.Duration(sorted[index])
	}
	ops := len(samples)
	divisor := float64(max(ops, 1))
	return stats{
		name: name, ops: ops, failures: failures, wall: wall,
		p50: quantile(0.50), p90: quantile(0.90), p99: quantile(0.99),
		maximum: quantile(1.0),
		// Mallocs is cumulative and monotonic, so the delta is exact even across GCs.
		allocsPerOp:  float64(after.Mallocs-before.Mallocs) / divisor,
		bytesPerOp:   float64(after.TotalAlloc-before.TotalAlloc) / divisor,
		natsOutPerOp: float64(natsAfter.OutMsgs-natsBefore.OutMsgs) / divisor,
		natsInPerOp:  float64(natsAfter.InMsgs-natsBefore.InMsgs) / divisor,
		goroutines:   runtime.NumGoroutine(),
	}
}

// profileRun wraps a scenario body in the CPU, heap, mutex and block profiles. Heap is written
// after a GC at the end, so it shows what the run retained rather than what it churned. Nothing is
// written unless SIPD_LOAD_PROFILE_DIR names a directory.
func profileRun(t *testing.T, name string, body func()) {
	t.Helper()
	dir := strings.TrimSpace(os.Getenv("SIPD_LOAD_PROFILE_DIR"))
	if dir == "" {
		body()
		return
	}
	if err := os.MkdirAll(dir, 0o750); err != nil {
		t.Fatalf("creating the profile directory: %v", err)
	}
	create := func(kind string) *os.File {
		file, err := os.Create(filepath.Join(dir, name+"."+kind+".pprof"))
		if err != nil {
			t.Fatalf("creating the %s profile: %v", kind, err)
		}
		return file
	}

	cpu := create("cpu")
	// A rate of 1 catches every block/mutex event: a sampled mutex profile on a lock held for
	// microseconds shows nothing.
	runtime.SetBlockProfileRate(1)
	runtime.SetMutexProfileFraction(1)
	if err := pprof.StartCPUProfile(cpu); err != nil {
		t.Fatalf("starting the CPU profile: %v", err)
	}

	body()

	pprof.StopCPUProfile()
	_ = cpu.Close()
	runtime.SetBlockProfileRate(0)
	runtime.SetMutexProfileFraction(0)

	for _, kind := range []string{"block", "mutex", "goroutine"} {
		file := create(kind)
		if err := pprof.Lookup(kind).WriteTo(file, 0); err != nil {
			t.Fatalf("writing the %s profile: %v", kind, err)
		}
		_ = file.Close()
	}
	runtime.GC()
	heap := create("heap")
	if err := pprof.WriteHeapProfile(heap); err != nil {
		t.Fatalf("writing the heap profile: %v", err)
	}
	_ = heap.Close()
	t.Logf("profiles written to %s/%s.*.pprof", dir, name)
}

// envInt reads an integer knob, falling back when it is unset or unusable.
func envInt(name string, fallback int) int {
	if raw := strings.TrimSpace(os.Getenv(name)); raw != "" {
		if value, err := strconv.Atoi(raw); err == nil {
			return value
		}
	}
	return fallback
}

// loadLogger is the logger every rig component gets: errors only, because debug logging in a
// thousand-registration storm benchmarks slog's JSON handler rather than sipd. SIPD_LOAD_LOG_LEVEL
// lowers it when a scenario is being debugged rather than measured.
func loadLogger() *slog.Logger {
	level := slog.LevelError
	if raw := strings.TrimSpace(os.Getenv("SIPD_LOAD_LOG_LEVEL")); raw != "" {
		_ = level.UnmarshalText([]byte(raw))
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
}
