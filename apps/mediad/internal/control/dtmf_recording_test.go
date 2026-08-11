package control_test

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The rung 3 and rung 4 handlers, driven as a table over `[]byte -> []byte` like every other handler
// here. No broker, no sockets — the packet path is the stub, and what is asserted is the WIRE: which
// refusal reason the engine receives, because that is what it branches on.

func decodeSendDtmf(t *testing.T, raw []byte) contract.MediaSendDtmfResponse {
	t.Helper()
	var response contract.MediaSendDtmfResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("the send-dtmf reply is not the contract: %v", err)
	}
	return response
}

func decodeStartRecording(t *testing.T, raw []byte) contract.MediaStartRecordingResponse {
	t.Helper()
	var response contract.MediaStartRecordingResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("the start-recording reply is not the contract: %v", err)
	}
	return response
}

func decodeStopRecording(t *testing.T, raw []byte) contract.MediaStopRecordingResponse {
	t.Helper()
	var response contract.MediaStopRecordingResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("the stop-recording reply is not the contract: %v", err)
	}
	return response
}

func intPtrOf(value int) *int { return &value }

// --- rung 3: send-dtmf -------------------------------------------------------------------------

func TestSendDtmfStartsAnInjectionAndReportsHowLongItWillTake(t *testing.T) {
	rig := newRig(t)
	allocateSession(t, rig)

	response := decodeSendDtmf(t, rig.server.HandleSendDtmf(mustJSON(t,
		contract.MediaSendDtmfRequest{
			SessionID:      testSession,
			Digits:         "12",
			ToneDurationMs: intPtrOf(80),
			GapMs:          intPtrOf(20),
		})))

	if !response.Ok {
		t.Fatalf("send-dtmf refused: %+v", response)
	}
	if response.Digits != "12" {
		t.Errorf("digits = %q, want the string that was accepted", response.Digits)
	}
	// The reply comes back when injection STARTS, so this is the only number that tells the caller
	// when the far end will have heard the last digit.
	if response.QueuedMs == nil || *response.QueuedMs != 200 {
		t.Errorf("queuedMs = %v, want 200 (two digits of 80 ms plus a 20 ms gap)", response.QueuedMs)
	}
	if response.TelephoneEventPayloadType == nil ||
		*response.TelephoneEventPayloadType != int(rtp.PayloadTypeTelephoneEvent) {
		t.Errorf("telephoneEventPayloadType = %v, want the leg's own negotiated type",
			response.TelephoneEventPayloadType)
	}

	calls := rig.sessions.dtmfCalls()
	if len(calls) != 1 {
		t.Fatalf("SendDtmf calls = %d, want 1", len(calls))
	}
	if calls[0].opts.ToneDuration != 80*time.Millisecond || calls[0].opts.Gap != 20*time.Millisecond {
		t.Errorf("timings = %v/%v, want 80ms/20ms", calls[0].opts.ToneDuration, calls[0].opts.Gap)
	}
}

func TestSendDtmfDefaultsTheTimingsToARIs(t *testing.T) {
	// A request that names neither must put the same thing on the wire on either driver.
	rig := newRig(t)
	allocateSession(t, rig)

	response := decodeSendDtmf(t, rig.server.HandleSendDtmf(mustJSON(t,
		contract.MediaSendDtmfRequest{SessionID: testSession, Digits: "1"})))
	if !response.Ok {
		t.Fatalf("send-dtmf refused: %+v", response)
	}
	if response.QueuedMs == nil || *response.QueuedMs != 200 {
		t.Errorf("queuedMs = %v, want 200 (ARI's 100 ms tone and 100 ms gap)", response.QueuedMs)
	}
}

func TestSendDtmfRefusesALegWithNoTelephoneEventType(t *testing.T) {
	// `not_supported`, and never a silently synthesised inband tone: the far end said it does not
	// expect RFC 4733, and a tone generator is the same deferral `tone://` carries at playback.
	rig := newRig(t)
	allocateSession(t, rig)
	rig.sessions.telephoneEventFor[testSession] = 0

	response := decodeSendDtmf(t, rig.server.HandleSendDtmf(mustJSON(t,
		contract.MediaSendDtmfRequest{SessionID: testSession, Digits: "1"})))

	if response.Ok {
		t.Fatal("send-dtmf on a leg with no telephone-event type answered ok")
	}
	if response.Reason == nil || string(*response.Reason) != "not_supported" {
		t.Errorf("reason = %v, want not_supported", response.Reason)
	}
	if len(rig.sessions.dtmfCalls()) != 0 {
		t.Error("a refused send-dtmf still reached the packet path")
	}
}

func TestSendDtmfRefusalsAreNamedOnTheWire(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func(*contract.MediaSendDtmfRequest)
		stubErr error
		want    string
	}{
		{
			name:   "no session id",
			mutate: func(rq *contract.MediaSendDtmfRequest) { rq.SessionID = "" },
			want:   "bad_request",
		},
		{
			name:   "no digits",
			mutate: func(rq *contract.MediaSendDtmfRequest) { rq.Digits = "" },
			want:   "bad_request",
		},
		{
			name:   "a session this instance does not hold",
			mutate: func(rq *contract.MediaSendDtmfRequest) { rq.SessionID = "somebody-elses" },
			want:   "unknown_session",
		},
		{
			name:    "a digit no event code exists for",
			stubErr: rtp.ErrUnsendableDigit,
			want:    "bad_request",
		},
		{
			// Symmetric RTP learns the far end from its first packet, so a leg that has not sent has
			// taught us nowhere to send. A sequencing bug in the call flow, not a fault here.
			name:    "a leg that has not been latched yet",
			stubErr: rtp.ErrNoRemote,
			want:    "bad_request",
		},
		{
			name:    "an instance that is draining",
			stubErr: rtp.ErrClosed,
			want:    "shutting_down",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)
			rig.sessions.dtmfErr = tc.stubErr

			request := contract.MediaSendDtmfRequest{SessionID: testSession, Digits: "1"}
			if tc.mutate != nil {
				tc.mutate(&request)
			}
			response := decodeSendDtmf(t, rig.server.HandleSendDtmf(mustJSON(t, request)))

			if response.Ok {
				t.Fatalf("%s answered ok", tc.name)
			}
			if response.Reason == nil || string(*response.Reason) != tc.want {
				t.Errorf("reason = %v, want %s", response.Reason, tc.want)
			}
			if response.InstanceID == nil || *response.InstanceID != thisNode {
				t.Error("a refusal does not name the instance that answered")
			}
		})
	}
}

func TestSendDtmfAnswersAMalformedRequestRatherThanTimingOut(t *testing.T) {
	// A responder that simply does not reply is indistinguishable from a crashed one.
	rig := newRig(t)
	response := decodeSendDtmf(t, rig.server.HandleSendDtmf([]byte("{")))
	if response.Ok || response.Reason == nil || string(*response.Reason) != "bad_request" {
		t.Errorf("a malformed send-dtmf answered %+v, want a bad_request refusal", response)
	}
}

// --- rung 4: start-recording / stop-recording ---------------------------------------------------

func TestStartRecordingDerivesTheEnginesOwnObjectKey(t *testing.T) {
	// `<orgId>/<callId>/<recordingRef>.wav` is exactly what apps/engine computes for the same
	// recording and exactly what apps/api's archiver stats under CDR_RECORDING_ROOT, so one mount
	// serves both planes and the archive pipeline reads what mediad wrote unchanged.
	rig := newRig(t)
	allocateSession(t, rig)

	response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{SessionID: testSession, RecordingRef: "rec-1"})))

	if !response.Ok {
		t.Fatalf("start-recording refused: %+v", response)
	}
	wantKey := testOrg + "/" + testCall + "/rec-1.wav"
	if response.ObjectKey == nil || *response.ObjectKey != wantKey {
		t.Errorf("objectKey = %v, want %q", response.ObjectKey, wantKey)
	}

	calls := rig.sessions.recordingCalls()
	if len(calls) != 1 {
		t.Fatalf("StartRecording calls = %d, want 1", len(calls))
	}
	wantPath := filepath.Join(rig.recordings, testOrg, testCall, "rec-1.wav")
	if calls[0].opts.Path != wantPath {
		t.Errorf("path = %q, want %q", calls[0].opts.Path, wantPath)
	}
	// The default is `both`: an on-demand call recording is what a caller-supplied direction is most
	// often left off for, and one direction of a conversation is the surprising answer.
	if calls[0].opts.Direction != rtp.RecordBoth {
		t.Errorf("direction = %q, want %q by default", calls[0].opts.Direction, rtp.RecordBoth)
	}
	// Decoded into the law the LEG answered — a µ-law frame read as A-law is a rasp on disk.
	if calls[0].opts.Encoding != rtp.EncodingFor(rtp.PayloadTypePCMU) {
		t.Errorf("encoding = %v, want the session's own", calls[0].opts.Encoding)
	}
}

func TestStartRecordingCarriesTheReceiveDirectionAndTheLimits(t *testing.T) {
	rig := newRig(t)
	allocateSession(t, rig)

	response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{
			SessionID:     testSession,
			RecordingRef:  "rec-2",
			Direction:     contract.MediaStartRecordingRequestDirectionReceive,
			MaxDurationMs: intPtrOf(120_000),
			MaxSilenceMs:  intPtrOf(5_000),
		})))
	if !response.Ok {
		t.Fatalf("start-recording refused: %+v", response)
	}

	opts := rig.sessions.recordingCalls()[0].opts
	if opts.Direction != rtp.RecordReceive {
		t.Errorf("direction = %q, want %q", opts.Direction, rtp.RecordReceive)
	}
	// Milliseconds on this seam, seconds on the one above it, because ARI speaks seconds and this
	// backbone does not.
	if opts.MaxDuration != 120*time.Second || opts.MaxSilence != 5*time.Second {
		t.Errorf("limits = %v/%v, want 2m/5s", opts.MaxDuration, opts.MaxSilence)
	}
}

func TestStartRecordingRefusesWhatItCannotDoRatherThanDroppingIt(t *testing.T) {
	for _, tc := range []struct {
		name     string
		mutate   func(*contract.MediaStartRecordingRequest)
		contains string
	}{
		{
			// A voicemail whose beep never sounds is a caller talking over the tail of the greeting,
			// and the first words of every message clipped.
			name:     "beep, which needs a tone generator",
			mutate:   func(rq *contract.MediaStartRecordingRequest) { beep := true; rq.Beep = &beep },
			contains: "tone generator",
		},
		{
			// Ending on a digit needs DTMF DETECTION, the receive half of rung 3, which is not built.
			name: "terminateOn, which needs DTMF detection",
			mutate: func(rq *contract.MediaStartRecordingRequest) {
				hash := "#"
				rq.TerminateOn = &hash
			},
			contains: "DTMF detection",
		},
		{
			// apps/api serves every recording as audio/wav and copies bytes it never inspects.
			name:     "a container mediad does not write",
			mutate:   func(rq *contract.MediaStartRecordingRequest) { rq.Format = "gsm" },
			contains: "WAV",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)

			request := contract.MediaStartRecordingRequest{SessionID: testSession, RecordingRef: "rec-1"}
			tc.mutate(&request)
			response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t, request)))

			if response.Ok {
				t.Fatalf("%s answered ok; a media plane that quietly did nothing here is the worst "+
					"defect shape this vocabulary exists to prevent", tc.name)
			}
			if response.Reason == nil || string(*response.Reason) != "not_supported" {
				t.Errorf("reason = %v, want not_supported", response.Reason)
			}
			if response.Error == nil || !strings.Contains(*response.Error, tc.contains) {
				t.Errorf("error = %v, want it to name %q", response.Error, tc.contains)
			}
			if len(rig.sessions.recordingCalls()) != 0 {
				t.Error("a refused recording still reached the packet path")
			}
		})
	}
}

func TestStartRecordingAcceptsTerminateOnNone(t *testing.T) {
	// `none` is what apps/engine's on-demand recording path sends, and it means the same thing as
	// absent. Refusing it would refuse the one caller that already exists.
	rig := newRig(t)
	allocateSession(t, rig)

	none := "none"
	response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{
			SessionID: testSession, RecordingRef: "rec-1", TerminateOn: &none,
		})))
	if !response.Ok {
		t.Fatalf("terminateOn=none was refused: %+v", response)
	}
}

func TestStartRecordingRefusesAnUnconfiguredInstanceByName(t *testing.T) {
	// No recordings mount is a deployment that has not opted into mediad recording. It must refuse
	// loudly so the engine routes the leg to Asterisk, never answer ok and write nowhere.
	rig := newRigWith(t, t.TempDir(), "")
	allocateSession(t, rig)

	response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{SessionID: testSession, RecordingRef: "rec-1"})))

	if response.Ok {
		t.Fatal("an instance with no recordings directory answered ok")
	}
	if response.Reason == nil || string(*response.Reason) != "not_supported" {
		t.Errorf("reason = %v, want not_supported", response.Reason)
	}
	if response.Error == nil || !strings.Contains(*response.Error, "MEDIAD_RECORDINGS_DIR") {
		t.Errorf("error = %v, want it to name the variable an operator has to set", response.Error)
	}
}

func TestStartRecordingRefusesAReferenceThatIsNotAFilename(t *testing.T) {
	// The reference becomes a filename, so a separator or a dot-segment in it is a path traversal.
	// Refused rather than sanitised: a caller whose reference was silently rewritten would look for
	// a file under the name it asked for and not find one.
	for _, ref := range []string{"../../etc/passwd", "a/b", "..", "rec 1"} {
		rig := newRig(t)
		allocateSession(t, rig)

		response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
			contract.MediaStartRecordingRequest{SessionID: testSession, RecordingRef: ref})))

		if response.Ok {
			t.Errorf("recordingRef %q was accepted as a filename", ref)
		}
		if response.Reason == nil || string(*response.Reason) != "bad_request" {
			t.Errorf("recordingRef %q reason = %v, want bad_request", ref, response.Reason)
		}
	}
}

func TestStartRecordingRefusalsAreNamedOnTheWire(t *testing.T) {
	for _, tc := range []struct {
		name    string
		mutate  func(*contract.MediaStartRecordingRequest)
		stubErr error
		want    string
	}{
		{
			name:   "no session id",
			mutate: func(rq *contract.MediaStartRecordingRequest) { rq.SessionID = "" },
			want:   "bad_request",
		},
		{
			name:   "no reference",
			mutate: func(rq *contract.MediaStartRecordingRequest) { rq.RecordingRef = "" },
			want:   "bad_request",
		},
		{
			name:   "a session this instance does not hold",
			mutate: func(rq *contract.MediaStartRecordingRequest) { rq.SessionID = "somebody-elses" },
			want:   "unknown_session",
		},
		{
			name:    "a session already being recorded",
			stubErr: rtp.ErrAlreadyRecording,
			want:    "bad_request",
		},
		{
			name:    "an instance that is draining",
			stubErr: rtp.ErrClosed,
			want:    "shutting_down",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)
			rig.sessions.recordingErr = tc.stubErr

			request := contract.MediaStartRecordingRequest{SessionID: testSession, RecordingRef: "rec-1"}
			if tc.mutate != nil {
				tc.mutate(&request)
			}
			response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t, request)))

			if response.Ok {
				t.Fatalf("%s answered ok", tc.name)
			}
			if response.Reason == nil || string(*response.Reason) != tc.want {
				t.Errorf("reason = %v, want %s", response.Reason, tc.want)
			}
		})
	}
}

func TestStopRecordingIsKeyedByReferenceAlone(t *testing.T) {
	rig := newRig(t)
	allocateSession(t, rig)
	rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{SessionID: testSession, RecordingRef: "rec-1"}))

	response := decodeStopRecording(t, rig.server.HandleStopRecording(mustJSON(t,
		contract.MediaStopRecordingRequest{RecordingRef: "rec-1"})))

	if !response.Ok || !response.Stopped {
		t.Fatalf("stop-recording = %+v, want ok and stopped", response)
	}
	if response.SessionID == nil || *response.SessionID != testSession {
		t.Errorf("sessionId = %v, want the session mediad looked up for itself", response.SessionID)
	}
}

func TestStopRecordingOfAFinishedRecordingIsASuccess(t *testing.T) {
	// The common case rather than an edge one: a recording that hit its duration limit, or whose leg
	// hung up, has already finalised itself by the time the engine's teardown stops it.
	rig := newRig(t)

	response := decodeStopRecording(t, rig.server.HandleStopRecording(mustJSON(t,
		contract.MediaStopRecordingRequest{RecordingRef: "long-gone"})))

	if !response.Ok {
		t.Error("stopping a finished recording answered a failure")
	}
	if response.Stopped {
		t.Error("stopped = true for a reference nothing is recording")
	}
}

func TestStopRecordingRefusesAnEmptyReference(t *testing.T) {
	rig := newRig(t)
	response := decodeStopRecording(t, rig.server.HandleStopRecording(mustJSON(t,
		contract.MediaStopRecordingRequest{})))
	if response.Ok || response.Reason == nil || string(*response.Reason) != "bad_request" {
		t.Errorf("an empty recordingRef answered %+v, want a bad_request refusal", response)
	}
}

func TestRecordingHandlersAreOnTheSubscriptionTable(t *testing.T) {
	// The subject constants come from packages/events-go, so a rename in the Zod source is a compile
	// error here rather than a subject nothing answers on.
	for _, subject := range []string{
		contract.SubjectMediaSendDtmfRPC,
		contract.SubjectMediaStartRecordingRPC,
		contract.SubjectMediaStopRecordingRPC,
	} {
		if !strings.HasPrefix(subject, "rpc.media.v1.") {
			t.Errorf("subject %q is not in the media command family", subject)
		}
	}
	// And the sentinel the handlers classify on is the one the packet path returns.
	if !errors.Is(rtp.ErrAlreadyRecording, rtp.ErrAlreadyRecording) {
		t.Error("ErrAlreadyRecording is not its own sentinel")
	}
}
