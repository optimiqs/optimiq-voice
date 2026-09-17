// Load harness for the lifecycle publisher. Needs NATS_SERVER_BIN naming a JetStream-capable
// nats-server and skips without one:
//
//	NATS_SERVER_BIN=$(command -v nats-server) go test ./internal/events -run xxx -bench . -benchmem
package events_test

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	mediaevents "github.com/optimiqs/optimiq-voice/apps/mediad/internal/events"
)

func benchJetStream(tb testing.TB) jetstream.JetStream {
	tb.Helper()
	binary := strings.TrimSpace(os.Getenv("NATS_SERVER_BIN"))
	if binary == "" {
		tb.Skip("set NATS_SERVER_BIN to a JetStream-capable nats-server")
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatalf("reserving a port: %v", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	if err := listener.Close(); err != nil {
		tb.Fatalf("releasing the port: %v", err)
	}
	cmd := exec.Command(binary, "-a", "127.0.0.1", "-p", strconv.Itoa(port), "-js", "-sd", tb.TempDir())
	var output strings.Builder
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		tb.Fatalf("starting nats-server: %v", err)
	}
	tb.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
	})

	url := "nats://127.0.0.1:" + strconv.Itoa(port)
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := nats.Connect(url)
		if err != nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		js, err := jetstream.New(conn)
		if err == nil {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, err = js.AccountInfo(ctx)
			cancel()
		}
		if err != nil {
			conn.Close()
			time.Sleep(50 * time.Millisecond)
			continue
		}
		tb.Cleanup(conn.Close)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		definition := contract.MediaStream
		if _, err := js.CreateOrUpdateStream(ctx, jetstream.StreamConfig{
			Name: definition.Name, Subjects: definition.Subjects, Storage: jetstream.FileStorage,
		}); err != nil {
			tb.Fatalf("creating the MEDIA stream: %v", err)
		}
		return js
	}
	tb.Fatalf("nats-server never became JetStream-ready:\n%s", output.String())
	return nil
}

const benchOrg = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"

func endedEnvelope(tb testing.TB, index int) contract.Envelope[contract.MediaSessionEndedData] {
	tb.Helper()
	session := fmt.Sprintf("0192c7a1-4b8e-7f21-8b3c-%012x", index)
	subject, err := contract.MediaSubject(benchOrg, session, contract.EventTypeMediaSessionEnded)
	if err != nil {
		tb.Fatalf("subject: %v", err)
	}
	return contract.Envelope[contract.MediaSessionEndedData]{
		ID:      contract.NewEventID(),
		At:      contract.NewEventTime(time.Now()),
		OrgID:   benchOrg,
		Subject: subject,
		Type:    contract.EventTypeMediaSessionEnded,
		Source:  mediaevents.Source,
		Data: contract.MediaSessionEndedData{
			SessionID:  session,
			InstanceID: "mediad-bench",
			RtpPort:    30000,
			Reason:     contract.MediaSessionEndedReason("released"),
			DurationMs: 1000,
		},
	}
}

// BenchmarkPublishSessionEndedSerial is one awaited JetStream publish: envelope check, encode, and
// the round trip to the stream's ack.
func BenchmarkPublishSessionEndedSerial(b *testing.B) {
	publisher := mediaevents.NewJetStreamPublisher(benchJetStream(b))
	ctx := b.Context()
	index := 0
	b.ReportAllocs()
	for b.Loop() {
		index++
		if err := publisher.SessionEnded(ctx, endedEnvelope(b, index)); err != nil {
			b.Fatalf("publish: %v", err)
		}
	}
}

// BenchmarkPublishSessionEndedConcurrent runs the publishes at the announcer's own concurrency
// ceiling, which is what a mass reap or a drain actually offers the broker.
func BenchmarkPublishSessionEndedConcurrent(b *testing.B) {
	publisher := mediaevents.NewJetStreamPublisher(benchJetStream(b))
	ctx := b.Context()
	const slots = 8
	var index int
	b.ReportAllocs()
	for b.Loop() {
		var wg sync.WaitGroup
		for range slots {
			index++
			envelope := endedEnvelope(b, index)
			wg.Go(func() {
				if err := publisher.SessionEnded(ctx, envelope); err != nil {
					b.Errorf("publish: %v", err)
				}
			})
		}
		wg.Wait()
	}
	b.ReportMetric(slots, "events/op")
}
