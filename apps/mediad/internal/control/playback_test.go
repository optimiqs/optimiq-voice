package control_test

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The playback handlers, driven as a table over `[]byte -> []byte` like every other handler here.
// No broker, no sockets — the packet path is the stub, and what is asserted is the WIRE: which
// refusal reason the engine receives, which is what it branches on.

// writeULawPrompt writes a µ-law WAV of `frames` 20 ms frames into the rig's library.
func writeULawPrompt(t *testing.T, rig *rig, name string, frames int) {
	t.Helper()
	writeWAVPrompt(t, rig, name, 7, 8000, frames*audio.FrameSamples)
}

// writeWAVPrompt writes a WAV with the given format tag and rate. `payloadBytes` is the data chunk
// size, so a test can produce a file that is valid apart from the one thing it is testing.
func writeWAVPrompt(t *testing.T, rig *rig, name string, tag uint16, rate uint32, payloadBytes int) {
	t.Helper()

	fmtChunk := make([]byte, 16)
	binary.LittleEndian.PutUint16(fmtChunk[0:2], tag)
	binary.LittleEndian.PutUint16(fmtChunk[2:4], 1)
	binary.LittleEndian.PutUint32(fmtChunk[4:8], rate)
	bits := uint16(8)
	if tag == 1 {
		bits = 16
	}
	binary.LittleEndian.PutUint16(fmtChunk[12:14], bits/8)
	binary.LittleEndian.PutUint16(fmtChunk[14:16], bits)

	data := make([]byte, payloadBytes)
	for index := range data {
		data[index] = 0xFF
	}

	body := append([]byte("fmt "), make([]byte, 4)...)
	binary.LittleEndian.PutUint32(body[4:8], uint32(len(fmtChunk)))
	body = append(body, fmtChunk...)
	dataHeader := append([]byte("data"), make([]byte, 4)...)
	binary.LittleEndian.PutUint32(dataHeader[4:8], uint32(len(data)))
	body = append(body, dataHeader...)
	body = append(body, data...)

	raw := append([]byte("RIFF"), make([]byte, 4)...)
	binary.LittleEndian.PutUint32(raw[4:8], uint32(4+len(body)))
	raw = append(raw, []byte("WAVE")...)
	raw = append(raw, body...)

	path := filepath.Join(rig.prompts, name)
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("creating the prompt directory: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("writing %s: %v", name, err)
	}
}

func decodeStartPlayback(t *testing.T, raw []byte) contract.MediaStartPlaybackResponse {
	t.Helper()
	var response contract.MediaStartPlaybackResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding a start-playback reply: %v\n%s", err, raw)
	}
	return response
}

func decodeStopPlayback(t *testing.T, raw []byte) contract.MediaStopPlaybackResponse {
	t.Helper()
	var response contract.MediaStopPlaybackResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding a stop-playback reply: %v\n%s", err, raw)
	}
	return response
}

// allocateSession puts a live session in the stub, which is what every playback needs first.
func allocateSession(t *testing.T, rig *rig) {
	t.Helper()
	rig.server.HandleAllocateSession(mustJSON(t, validAllocate()))
}

func TestStartPlaybackDecodesAndStarts(t *testing.T) {
	rig := newRig(t)
	allocateSession(t, rig)
	writeULawPrompt(t, rig, "welcome.wav", 3)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID:   testSession,
			PlaybackRef: "pb-1",
			Media:       []string{"sound:welcome"},
		})))

	if !response.Ok {
		t.Fatalf("start-playback refused: %+v", response)
	}
	if response.PlaybackRef != "pb-1" {
		t.Errorf("playbackRef = %q, want pb-1", response.PlaybackRef)
	}
	if response.InstanceID == nil || *response.InstanceID != thisNode {
		t.Error("the reply does not name the instance that answered")
	}

	calls := rig.sessions.playbackCalls()
	if len(calls) != 1 {
		t.Fatalf("StartPlayback calls = %d, want 1", len(calls))
	}
	if len(calls[0].opts.Frames) != 3 {
		t.Errorf("frames = %d, want 3", len(calls[0].opts.Frames))
	}
	// Decoded into the law the LEG answered, which is the one fact the handler asks the packet path
	// for before it reads a file.
	if calls[0].opts.Encoding != audio.EncodingULaw {
		t.Errorf("encoding = %v, want PCMU", calls[0].opts.Encoding)
	}
}

func TestStartPlaybackDecodesIntoTheLegsCompandingLaw(t *testing.T) {
	// A µ-law prompt on an A-law leg. Refusing would make a library stored in one law unusable on
	// half the world's trunks; playing it unconverted would be a rasp.
	rig := newRig(t)
	allocateSession(t, rig)
	rig.sessions.codecFor[testSession] = rtp.PayloadTypePCMA
	writeULawPrompt(t, rig, "welcome.wav", 1)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:welcome"},
		})))
	if !response.Ok {
		t.Fatalf("start-playback refused: %+v", response)
	}

	calls := rig.sessions.playbackCalls()
	if calls[0].opts.Encoding != audio.EncodingALaw {
		t.Errorf("encoding = %v, want PCMA: the clip must match the leg", calls[0].opts.Encoding)
	}
}

func TestStartPlaybackConcatenatesAMediaList(t *testing.T) {
	rig := newRig(t)
	allocateSession(t, rig)
	writeULawPrompt(t, rig, "one.wav", 1)
	writeULawPrompt(t, rig, "two.wav", 2)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID: testSession, PlaybackRef: "pb-1",
			Media: []string{"sound:one", "sound:two"},
		})))
	if !response.Ok {
		t.Fatalf("start-playback refused: %+v", response)
	}
	if got := len(rig.sessions.playbackCalls()[0].opts.Frames); got != 3 {
		t.Errorf("frames = %d, want 3: the list plays as one stream", got)
	}
}

func TestStartPlaybackRefusals(t *testing.T) {
	tests := []struct {
		name string
		// setup runs before the request and may write fixtures or change the stub.
		setup func(t *testing.T, rig *rig)
		// noLibrary roots the rig at no prompt directory at all — a deployment that has not
		// mounted a prompt store.
		noLibrary bool
		request   contract.MediaStartPlaybackRequest
		reason    string
	}{
		{
			name:    "no session id",
			request: contract.MediaStartPlaybackRequest{PlaybackRef: "pb-1", Media: []string{"sound:x"}},
			reason:  "bad_request",
		},
		{
			name:    "no playback reference",
			request: contract.MediaStartPlaybackRequest{SessionID: testSession, Media: []string{"sound:x"}},
			reason:  "bad_request",
		},
		{
			// A play of nothing answered `ok` would report a prompt that never happened.
			name:    "no media",
			request: contract.MediaStartPlaybackRequest{SessionID: testSession, PlaybackRef: "pb-1"},
			reason:  "bad_request",
		},
		{
			name: "unknown session",
			request: contract.MediaStartPlaybackRequest{
				SessionID: "nobody", PlaybackRef: "pb-1", Media: []string{"sound:x"},
			},
			reason: "unknown_session",
		},
		{
			name:      "no prompt library configured",
			noLibrary: true,
			request: contract.MediaStartPlaybackRequest{
				SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:welcome"},
			},
			reason: "not_supported",
		},
		{
			name: "a prompt that is not there",
			request: contract.MediaStartPlaybackRequest{
				SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:missing"},
			},
			reason: "bad_request",
		},
		{
			// Asterisk's generator schemes. `not_supported` because the engine's recovery is to route
			// the leg to Asterisk, which DOES have a synthesiser — not to fix the bytes and retry.
			name: "a generator scheme",
			request: contract.MediaStartPlaybackRequest{
				SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"tone://ring"},
			},
			reason: "not_supported",
		},
		{
			name: "traversal out of the library",
			request: contract.MediaStartPlaybackRequest{
				SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:../../etc/passwd"},
			},
			reason: "bad_request",
		},
		{
			// The most likely operator mistake: a prompt exported from a desktop tool. mediad does
			// not resample, Asterisk plays it happily, and that is the per-capability cutover working.
			name: "a 44.1 kHz prompt",
			setup: func(t *testing.T, rig *rig) {
				t.Helper()
				writeWAVPrompt(t, rig, "welcome.wav", 1, 44100, 320)
			},
			request: contract.MediaStartPlaybackRequest{
				SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:welcome"},
			},
			reason: "not_supported",
		},
		{
			name: "a file that is not a WAV",
			setup: func(t *testing.T, rig *rig) {
				t.Helper()
				if err := os.WriteFile(filepath.Join(rig.prompts, "welcome.wav"),
					[]byte("definitely not a wav"), 0o600); err != nil {
					t.Fatalf("writing the fixture: %v", err)
				}
			},
			request: contract.MediaStartPlaybackRequest{
				SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:welcome"},
			},
			reason: "bad_request",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			rig := newRig(t)
			if test.noLibrary {
				rig = newRigWithLibrary(t, "")
			}
			allocateSession(t, rig)
			if test.setup != nil {
				test.setup(t, rig)
			}

			response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t, test.request)))
			if response.Ok {
				t.Fatalf("start-playback succeeded; it must refuse with %s", test.reason)
			}
			if response.Reason == nil || string(*response.Reason) != test.reason {
				t.Fatalf("reason = %v, want %s", response.Reason, test.reason)
			}
			if response.Error == nil || *response.Error == "" {
				t.Error("a refusal carries no human-readable detail")
			}
			if len(rig.sessions.playbackCalls()) != 0 {
				t.Error("the packet path was asked to play despite the refusal")
			}
		})
	}
}

func TestStartPlaybackRefusesMalformedJSON(t *testing.T) {
	rig := newRig(t)
	response := decodeStartPlayback(t, rig.server.HandleStartPlayback([]byte("{not json")))
	if response.Ok || response.Reason == nil || string(*response.Reason) != "bad_request" {
		t.Fatalf("malformed request answered %+v, want a bad_request refusal", response)
	}
}

func TestStartPlaybackNamesTheMissingCapabilityInItsRefusal(t *testing.T) {
	// The refusal message is what an operator reads out of a failed call, and the two failures that
	// look identical from outside — "the prompt is missing" and "this build cannot play it" — need
	// to be told apart without reading source.
	rig := newRigWithLibrary(t, "")
	allocateSession(t, rig)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:welcome"},
		})))
	if response.Error == nil || !strings.Contains(*response.Error, "MEDIAD_SOUNDS_DIR") {
		t.Errorf("refusal %v does not name the setting that would fix it", response.Error)
	}
}

func TestStopPlayback(t *testing.T) {
	rig := newRig(t)
	allocateSession(t, rig)
	writeULawPrompt(t, rig, "welcome.wav", 1)
	rig.server.HandleStartPlayback(mustJSON(t, contract.MediaStartPlaybackRequest{
		SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"sound:welcome"},
	}))

	response := decodeStopPlayback(t, rig.server.HandleStopPlayback(mustJSON(t,
		contract.MediaStopPlaybackRequest{PlaybackRef: "pb-1"})))

	if !response.Ok || !response.Stopped {
		t.Fatalf("stop-playback answered %+v, want ok and stopped", response)
	}
	if response.SessionID == nil || *response.SessionID != testSession {
		t.Errorf("sessionId = %v, want %s", response.SessionID, testSession)
	}
}

func TestStopPlaybackOfAFinishedPromptIsASuccess(t *testing.T) {
	// The COMMON case. Every `gather` stops its prompt whatever ended the collection, so a caller
	// who listens to the whole menu and then presses a digit produces this on every single call.
	// `MediaPort` states the rule: stopping an already-finished playback is a no-op.
	rig := newRig(t)

	response := decodeStopPlayback(t, rig.server.HandleStopPlayback(mustJSON(t,
		contract.MediaStopPlaybackRequest{PlaybackRef: "never-started"})))

	if !response.Ok {
		t.Fatalf("stop-playback refused a finished playback: %+v", response)
	}
	if response.Stopped {
		t.Error("stopped = true for a reference nothing is playing")
	}
}

func TestStopPlaybackRefusesAnEmptyReference(t *testing.T) {
	rig := newRig(t)
	response := decodeStopPlayback(t, rig.server.HandleStopPlayback(mustJSON(t,
		contract.MediaStopPlaybackRequest{})))
	if response.Ok || response.Reason == nil || string(*response.Reason) != "bad_request" {
		t.Fatalf("stop-playback answered %+v, want a bad_request refusal", response)
	}
}
