package rtp

import (
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// The media-path suite asserts on the three boundaries a relayed frame crosses — the outgoing
// payload type, the negotiated direction, and the recorder's pause — from inside the package,
// because each of them is a field the exported surface deliberately does not show.

// mediaPathTransport captures the last packet written, standing in for a far end.
type mediaPathTransport struct{ written []byte }

func (*mediaPathTransport) LocalSSRC() uint32           { return 1 }
func (*mediaPathTransport) ReadRTP([]byte) (int, error) { return 0, io.EOF }
func (t *mediaPathTransport) WriteRTP(b []byte) (int, error) {
	t.written = append(t.written[:0], b...)
	return len(b), nil
}
func (*mediaPathTransport) ReadRTCP([]byte) (int, error)    { return 0, io.EOF }
func (*mediaPathTransport) WriteRTCP(b []byte) (int, error) { return len(b), nil }
func (*mediaPathTransport) Close() error                    { return nil }

func mediaPathSession(id string) *Session {
	return &Session{ID: id, done: make(chan struct{}), log: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func TestForwardTranslatesAudioOntoTheDestinationsNegotiatedPayloadType(t *testing.T) {
	transport := &mediaPathTransport{}
	session := mediaPathSession("a")
	session.transport = transport
	session.remote = &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9}
	session.format.Store(uint32(audio.FormatOpus))
	session.audioPayloadType.Store(112)

	// Two legs on the same dynamic codec that answered with different numbers: 111 in, 112 out.
	session.forward(&pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: 111, Timestamp: 960},
		Payload: []byte{1, 2, 3},
	}, PayloadTypeTelephoneEvent)

	var out pionrtp.Packet
	if err := out.Unmarshal(transport.written); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if out.PayloadType != 112 {
		t.Errorf("outbound PayloadType = %d, want the destination's negotiated 112", out.PayloadType)
	}
}

func TestAnInactiveSessionRelaysOnceARenegotiationClearsItsGates(t *testing.T) {
	session := mediaPathSession("a")
	session.mode = ModeInactive
	session.mutedIn.Store(true)
	session.mutedOut.Store(true)
	manager := &Manager{sessions: map[string]*Session{"a": session}, now: time.Now}

	if got := session.Mode(); got != ModeInactive {
		t.Fatalf("Mode() = %s before the renegotiation, want %s", got, ModeInactive)
	}
	if err := manager.ApplyDirection("a", false, false); err != nil {
		t.Fatalf("ApplyDirection: %v", err)
	}
	if got := session.Mode(); got != ModeRelay {
		t.Errorf("Mode() = %s after a sendrecv answer, want %s", got, ModeRelay)
	}
}

func TestAnInactiveSessionStaysInactiveWhileBothGatesAreUp(t *testing.T) {
	session := mediaPathSession("a")
	session.mode = ModeInactive
	session.mutedIn.Store(true)
	session.mutedOut.Store(true)
	manager := &Manager{sessions: map[string]*Session{"a": session}, now: time.Now}

	if err := manager.ApplyDirection("a", true, true); err != nil {
		t.Fatalf("ApplyDirection: %v", err)
	}
	if got := session.Mode(); got != ModeInactive {
		t.Errorf("Mode() = %s after a second inactive answer, want %s", got, ModeInactive)
	}
}

// newPauseRecording is a recorder with no session and no file: mixOneFrame is the whole boundary
// under test, and a real rig would drive it through a socket and a clock instead.
func newPauseRecording(direction RecordingDirection) *Recording {
	return &Recording{
		opts:         RecordingOptions{Encoding: audio.EncodingULaw, Direction: direction},
		received:     make(chan capturedFrame, recordingQueueFrames),
		sent:         make(chan capturedFrame, recordingQueueFrames),
		pauseStartMs: -1,
	}
}

// ulawSilence and ulawFullScale: µ-law silence is 0xff, and 0x00 is the loudest sample there is.
func ulawSilence() []byte   { return payloadOf(0xff) }
func ulawFullScale() []byte { return payloadOf(0x00) }

func payloadOf(value byte) []byte { return payloadOfLength(value, audio.FrameSamples) }

func payloadOfLength(value byte, samples int) []byte {
	payload := make([]byte, samples)
	for index := range payload {
		payload[index] = value
	}
	return payload
}

func TestPausedAudioIsNeverWrittenHoweverFarTheQueueIsBehind(t *testing.T) {
	for _, direction := range []RecordingDirection{RecordReceive, RecordBoth} {
		t.Run(string(direction), func(t *testing.T) {
			recording := newPauseRecording(direction)
			// A backlog the one-frame-per-tick drain could never have caught up with.
			for range 10 {
				recording.Received(ulawSilence())
				recording.Sent(ulawSilence())
			}

			recording.SetPaused(true)
			recording.Received(ulawFullScale())
			recording.Sent(ulawFullScale())
			if frame := recording.mixOneFrame(); !quiet(frame) {
				t.Fatal("the paused tick wrote audio")
			}
			recording.SetPaused(false)

			for tick := range 12 {
				for _, sample := range recording.mixOneFrame() {
					if sample != 0 {
						t.Fatalf("tick %d after the resume wrote audio captured during the pause", tick)
					}
				}
			}
		})
	}
}

func TestPausedAudioIsRefusedAtCaptureRatherThanCounted(t *testing.T) {
	recording := newPauseRecording(RecordReceive)
	recording.SetPaused(true)
	for range recordingQueueFrames * 2 {
		recording.Received(ulawFullScale())
	}
	if dropped := recording.Dropped(); dropped != 0 {
		t.Errorf("Dropped() = %d; audio refused by the pause is not a full queue", dropped)
	}
	if queued := len(recording.received); queued != 0 {
		t.Errorf("%d frames were queued while paused, want 0", queued)
	}
}

func TestARecordingConsumesArrivalsByMediaTimeRatherThanByPacket(t *testing.T) {
	recording := newPauseRecording(RecordReceive)
	// Three 30 ms packets: 720 samples, which is four and a half 20 ms frames of media time.
	for range 3 {
		recording.Received(payloadOfLength(0x00, audio.FrameSamples*3/2))
	}

	loud := 0
	for range 5 {
		if !quiet(recording.mixOneFrame()) {
			loud++
		}
	}
	if loud != 5 {
		t.Errorf("%d of 5 ticks carried audio; 90 ms of arrivals must fill four and a half frames", loud)
	}
	if !quiet(recording.mixOneFrame()) {
		t.Error("a sixth tick carried audio that was never sent")
	}
}
