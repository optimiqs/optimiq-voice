package control_test

import (
	"encoding/json"
	"strings"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The wire half of rungs 5, 6 and 7: the operations that were REFUSED by name at the last rung and
// are served now, and the ones that still are not.
//
// Every case here is a `[]byte -> []byte` call, exactly as the rest of this suite is. That is the
// property that makes a refusal testable at all: a refusal IS the reply, so asserting on it is
// asserting on bytes rather than on a log line nobody reads.

// --- Rung 5: direction, which is how hold arrives ---------------------------------------------

func TestAllocateServesEveryDirection(t *testing.T) {
	// RUNG 5. `sendonly` and `recvonly` used to be refused by name — "hold is signalling plus music,
	// and mediad has neither" — and answering `sendrecv` to a `sendonly` offer would have put a held
	// caller back into a conversation they had been taken out of. Both are served now, and the
	// assertion is on the two things that must both be true: the ANSWER says the right thing, and the
	// media plane's own gates moved to match it.
	cases := []struct {
		name       string
		offered    string
		requested  contract.MediaAllocateSessionRequestDirection
		wantAnswer string
		wantMuteIn bool
		wantMuteTx bool
	}{
		{
			name: "an ordinary call", offered: "a=sendrecv", requested: "sendrecv",
			wantAnswer: "a=sendrecv",
		},
		{
			// The classic hold offer. The offerer will only SEND, so this leg must not send to it —
			// which in media-plane terms is muting what goes OUT.
			name: "the far end put us on hold", offered: "a=sendonly", requested: "sendrecv",
			wantAnswer: "a=recvonly", wantMuteTx: true,
		},
		{
			name: "the far end will only listen", offered: "a=recvonly", requested: "sendrecv",
			wantAnswer: "a=sendonly", wantMuteIn: true,
		},
		{
			// A leg that is ringing rather than answered. The engine knows things the SDP does not, so
			// its request wins where it is more restrictive.
			name: "the engine asks for inactive", offered: "a=sendrecv", requested: "inactive",
			wantAnswer: "a=inactive", wantMuteIn: true, wantMuteTx: true,
		},
		{
			name: "the engine asks for sendonly", offered: "a=sendrecv", requested: "sendonly",
			wantAnswer: "a=sendonly", wantMuteIn: true,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rig := newRig(t)
			request := validAllocate()
			request.SDPOffer = strings.Replace(offerBody, "a=sendrecv", testCase.offered, 1)
			request.Direction = testCase.requested

			response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, request)))
			if !response.Ok {
				t.Fatalf("allocate refused: %+v", response)
			}
			if !strings.Contains(*response.SDPAnswer, testCase.wantAnswer+"\r\n") {
				t.Errorf("the answer does not carry %q\n---\n%s", testCase.wantAnswer, *response.SDPAnswer)
			}

			allocated := rig.sessions.allocateCalls()
			if len(allocated) != 1 {
				t.Fatalf("%d allocate calls reached the packet path, want 1", len(allocated))
			}
			if allocated[0].MuteIn != testCase.wantMuteIn || allocated[0].MuteOut != testCase.wantMuteTx {
				t.Errorf("gates = in %v out %v, want in %v out %v",
					allocated[0].MuteIn, allocated[0].MuteOut,
					testCase.wantMuteIn, testCase.wantMuteTx)
			}
		})
	}
}

func TestARenegotiationRepointsALiveSession(t *testing.T) {
	// A repeat allocate is either a RETRY or a RE-INVITE, and one line tells them apart: a retry
	// carries the same direction and applying it changes nothing, while a hold carries a different
	// one and applying it is the whole point. `Allocate` itself stays idempotent — no second port,
	// no mode change — which is what keeps "a retry must not mutate a live call" true.
	rig := newRig(t)

	first := validAllocate()
	if response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, first))); !response.Ok {
		t.Fatalf("the first allocate refused: %+v", response)
	}

	held := validAllocate()
	held.SDPOffer = strings.Replace(offerBody, "a=sendrecv", "a=sendonly", 1)
	if response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, held))); !response.Ok {
		t.Fatalf("the renegotiation refused: %+v", response)
	}

	applied := rig.sessions.directionCalls()
	if len(applied) != 2 {
		t.Fatalf("%d direction applications, want 2 (one per allocate)", len(applied))
	}
	if applied[0].muteIn || applied[0].muteOut {
		t.Errorf("the first allocate raised a gate: in %v out %v", applied[0].muteIn, applied[0].muteOut)
	}
	if applied[1].muteOut != true || applied[1].muteIn {
		t.Errorf("the hold did not mute the outbound direction: in %v out %v",
			applied[1].muteIn, applied[1].muteOut)
	}
}

// --- Rung 5: tones and music on hold, over the playback subject --------------------------------

func TestStartPlaybackServesGeneratedTones(t *testing.T) {
	// `tone:` was refused as "a generator scheme mediad has no synthesiser for" — design doc §10
	// question 11's "there is no tone generator, and two features name it". It is served now, and it
	// needs NO PROMPT LIBRARY: an instance that can bridge a call can now tell the caller the far end
	// is ringing, which a mount-dependent implementation could not.
	// An instance with NO prompt library at all, which is what makes the point: a tone needs no mount.
	rig := newRigWithLibrary(t, "")
	allocateSession(t, rig)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID: testSession, PlaybackRef: "pb-1", Media: []string{"tone:ringback"},
		})))
	if !response.Ok {
		t.Fatalf("a tone was refused on an instance with no prompt library: %+v", response)
	}

	starts := rig.sessions.playbackCalls()
	if len(starts) != 1 {
		t.Fatalf("%d playbacks started, want 1", len(starts))
	}
	if !starts[0].opts.Loop {
		t.Error("ringback does not loop; a cadence that played once would say the far end gave up")
	}
	if starts[0].opts.Kind != rtp.PlaybackTone {
		t.Errorf("kind = %q, want tone", starts[0].opts.Kind)
	}
	if len(starts[0].opts.Frames) == 0 {
		t.Error("the tone generated no frames")
	}
}

func TestStartPlaybackServesMusicOnHoldAsALoop(t *testing.T) {
	// `startMusicOnHold` reaches this media plane over `start-playback` with a `moh:` reference, and
	// `stopMusicOnHold` over `stop-playback` with the same reference. The LOOP is derived from the
	// scheme rather than from a flag on the wire, which is what stops a caller asking for a looping
	// voicemail greeting.
	rig := newRig(t)
	writeULawPrompt(t, rig, "moh/default.wav", 5)
	allocateSession(t, rig)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID: testSession, PlaybackRef: "moh-1", Media: []string{"moh:default"},
		})))
	if !response.Ok {
		t.Fatalf("music on hold was refused: %+v", response)
	}

	starts := rig.sessions.playbackCalls()
	if !starts[0].opts.Loop {
		t.Error("hold music does not loop")
	}
	if starts[0].opts.Kind != rtp.PlaybackMusicOnHold {
		t.Errorf("kind = %q, want moh", starts[0].opts.Kind)
	}

	// And the stop half, which needed no change at all: `stop-playback` carries a reference and
	// nothing else, and a hold loop is a playback.
	stop := decodeStopPlayback(t, rig.server.HandleStopPlayback(mustJSON(t,
		contract.MediaStopPlaybackRequest{PlaybackRef: "moh-1"})))
	if !stop.Ok || !stop.Stopped {
		t.Errorf("stop-playback did not stop the hold loop: %+v", stop)
	}
}

func TestStartPlaybackRefusesAMixOfLoopingAndOneShotSources(t *testing.T) {
	// A menu concatenated onto the end of an infinite loop is audio no caller ever reaches. Refused
	// naming both rather than served in whichever order they arrived.
	rig := newRig(t)
	writeULawPrompt(t, rig, "moh/default.wav", 2)
	writeULawPrompt(t, rig, "welcome.wav", 2)
	allocateSession(t, rig)

	response := decodeStartPlayback(t, rig.server.HandleStartPlayback(mustJSON(t,
		contract.MediaStartPlaybackRequest{
			SessionID: testSession, PlaybackRef: "pb-1",
			Media: []string{"moh:default", "sound:welcome"},
		})))
	if response.Ok {
		t.Fatal("a looping source was concatenated with a prompt")
	}
	if response.Reason == nil || string(*response.Reason) != "bad_request" {
		t.Errorf("reason = %v, want bad_request", response.Reason)
	}
}

// --- Rung 4's two remaining refusals, closed ---------------------------------------------------

func TestStartRecordingServesBeepAndTerminateOn(t *testing.T) {
	// Both together, because design doc §10 questions 10 and 11 said they had to be: `terminateOn`
	// needed DTMF detection, `beep` needed the tone generator, voicemail sends both, and
	// "implementing one without the other moves no call off Asterisk".
	rig := newRig(t)
	allocateSession(t, rig)

	beep := true
	hash := "#"
	response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{
			SessionID: testSession, RecordingRef: "rec-1",
			Beep: &beep, TerminateOn: &hash,
		})))
	if !response.Ok {
		t.Fatalf("a voicemail recording was refused: %+v", response)
	}

	recordings := rig.sessions.recordingCalls()
	if len(recordings) != 1 {
		t.Fatalf("%d recordings started, want 1", len(recordings))
	}
	if recordings[0].opts.TerminateOn != "#" {
		t.Errorf("TerminateOn = %q, want #", recordings[0].opts.TerminateOn)
	}

	// The beep is a PLAYBACK, started after the recorder so that no word spoken during it is lost to
	// a file that does not exist yet.
	playbacks := rig.sessions.playbackCalls()
	if len(playbacks) != 1 {
		t.Fatalf("%d beeps played, want 1", len(playbacks))
	}
	if playbacks[0].opts.Kind != rtp.PlaybackTone {
		t.Errorf("the beep is a %q, want a tone", playbacks[0].opts.Kind)
	}
	if playbacks[0].opts.Loop {
		t.Error("the beep loops; it would talk over the message it exists to introduce")
	}
	if !strings.HasPrefix(playbacks[0].opts.Ref, "rec-1") {
		t.Errorf("the beep's playback ref is %q; it must be derived from the recording's so it can "+
			"never collide with one the engine assigned", playbacks[0].opts.Ref)
	}
}

func TestABeepThatCannotPlayDoesNotFailTheRecording(t *testing.T) {
	// The refusal this replaced existed because a voicemail whose beep never sounds clips the first
	// words of every message. A recording that is already running and merely started quietly is a
	// smaller problem than one that did not start at all.
	rig := newRig(t)
	allocateSession(t, rig)
	rig.sessions.playbackErr = rtp.ErrNoRemote

	beep := true
	response := decodeStartRecording(t, rig.server.HandleStartRecording(mustJSON(t,
		contract.MediaStartRecordingRequest{
			SessionID: testSession, RecordingRef: "rec-1", Beep: &beep,
		})))
	if !response.Ok {
		t.Fatalf("the recording failed because its beep could not play: %+v", response)
	}
	if len(rig.sessions.recordingCalls()) != 1 {
		t.Error("the recording never reached the packet path")
	}
}

// --- Rung 6: the tap pair ----------------------------------------------------------------------

func TestTapSessionServesTheThreeSupervisionModes(t *testing.T) {
	// The wire half of design doc §10 question 4's W6 addendum. Three features, three argument
	// combinations, one handler — and the SIDES are carried through untouched, because the mixer is
	// the thing that resolves them and a control surface that reinterpreted them could disagree.
	cases := []struct {
		name    string
		hear    contract.MediaTapSessionRequestHear
		speakTo contract.MediaTapSessionRequestSpeakTo
	}{
		{"eavesdrop", "both", "none"},
		{"whisper", "both", "a"},
		{"barge", "both", "both"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)

			response := decodeTap(t, rig.server.HandleTapSession(mustJSON(t,
				contract.MediaTapSessionRequest{
					TapID:           "tap-1",
					TapSessionID:    "supervisor-leg",
					TargetSessionID: testSession,
					Hear:            testCase.hear,
					SpeakTo:         testCase.speakTo,
				})))
			if !response.Ok {
				t.Fatalf("%s was refused: %+v", testCase.name, response)
			}
			if response.BridgeID == nil || *response.BridgeID == "" {
				t.Error("the reply names no room; the engine cannot tear down what it cannot name")
			}
			if len(response.SessionIDs) == 0 {
				t.Error("the reply lists nobody in the room")
			}

			taps := rig.sessions.tapCalls()
			if len(taps) != 1 {
				t.Fatalf("%d taps reached the packet path, want 1", len(taps))
			}
			if string(taps[0].Hear) != string(testCase.hear) ||
				string(taps[0].SpeakTo) != string(testCase.speakTo) {
				t.Errorf("sides = %q/%q, want %q/%q",
					taps[0].Hear, taps[0].SpeakTo, testCase.hear, testCase.speakTo)
			}
		})
	}
}

func TestTapSessionRefusals(t *testing.T) {
	cases := []struct {
		name    string
		request contract.MediaTapSessionRequest
		reason  string
	}{
		{
			name:    "no tap id",
			request: contract.MediaTapSessionRequest{TapSessionID: "s", TargetSessionID: testSession, Hear: "both", SpeakTo: "none"},
			reason:  "bad_request",
		},
		{
			// A tap is a routing statement about sessions that already exist. mediad does not allocate
			// the supervisor's leg for them.
			name:    "no supervisor session",
			request: contract.MediaTapSessionRequest{TapID: "tap-1", TargetSessionID: testSession, Hear: "both", SpeakTo: "none"},
			reason:  "bad_request",
		},
		{
			name:    "no target",
			request: contract.MediaTapSessionRequest{TapID: "tap-1", TapSessionID: "s", Hear: "both", SpeakTo: "none"},
			reason:  "bad_request",
		},
		{
			// A side is the whole of what a tap routes on, and guessing one would put a supervisor
			// somewhere nobody asked for.
			name:    "a side that does not exist",
			request: contract.MediaTapSessionRequest{TapID: "tap-1", TapSessionID: "s", TargetSessionID: testSession, Hear: "left", SpeakTo: "none"},
			reason:  "bad_request",
		},
		{
			name:    "no sides at all",
			request: contract.MediaTapSessionRequest{TapID: "tap-1", TapSessionID: "s", TargetSessionID: testSession},
			reason:  "bad_request",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)

			response := decodeTap(t, rig.server.HandleTapSession(mustJSON(t, testCase.request)))
			if response.Ok {
				t.Fatal("the tap was accepted")
			}
			if response.Reason == nil || string(*response.Reason) != testCase.reason {
				t.Errorf("reason = %v, want %q", response.Reason, testCase.reason)
			}
			if len(rig.sessions.tapCalls()) != 0 {
				t.Error("a refused tap still reached the packet path")
			}
		})
	}
}

func TestUntapOfAnUnknownTapIsASuccess(t *testing.T) {
	// The engine retries, and a retry after a lost reply must not look like a failure — the same
	// shape `unbridge` and `stop-playback` use.
	rig := newRig(t)

	response := decodeUntap(t, rig.server.HandleUntapSession(mustJSON(t,
		contract.MediaUntapSessionRequest{TapID: "tap-1"})))
	if !response.Ok {
		t.Fatalf("untapping an unknown tap was an error: %+v", response)
	}
	if response.Untapped {
		t.Error("untapping an unknown tap reported that it stopped one")
	}
}

func TestUntapRequiresATapID(t *testing.T) {
	rig := newRig(t)
	response := decodeUntap(t, rig.server.HandleUntapSession(mustJSON(t,
		contract.MediaUntapSessionRequest{})))
	if response.Ok {
		t.Fatal("untap accepted a request naming no tap")
	}
	if response.Reason == nil || string(*response.Reason) != "bad_request" {
		t.Errorf("reason = %v, want bad_request", response.Reason)
	}
}

// --- Rung 7: the answer ------------------------------------------------------------------------

func TestAllocateNegotiatesWidebandAndOpus(t *testing.T) {
	// Rung 7's negotiation, at the seam. G.722 and Opus are both answerable now; the difference
	// between them is what happens LATER — G.722 can be mixed and transcoded, Opus can only be
	// relayed — and that difference is deliberately invisible here, because an offer is answered on
	// what the two ends can carry rather than on what a conference might one day need.
	cases := []struct {
		name       string
		formats    string
		rtpmap     []string
		wantCodec  string
		wantAnswer string
	}{
		{
			name:    "G.722 first",
			formats: "m=audio 41000 RTP/AVP 9 0 101",
			rtpmap: []string{
				"a=rtpmap:9 G722/8000", "a=rtpmap:0 PCMU/8000", "a=rtpmap:101 telephone-event/8000",
			},
			wantCodec: "G722",
			// The clock rate in the rtpmap is 8000, not 16000. RFC 3551 §4.5.2's erratum, and the
			// single most common G.722 interop bug in the industry.
			wantAnswer: "a=rtpmap:9 G722/8000",
		},
		{
			name:    "Opus first",
			formats: "m=audio 41000 RTP/AVP 111 0 101",
			rtpmap: []string{
				"a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1",
				"a=rtpmap:0 PCMU/8000", "a=rtpmap:101 telephone-event/8000",
			},
			wantCodec: "opus",
			// Answered under the offer's OWN dynamic number, because Opus has no static one — and
			// with `/2` whatever the stream carries, which RFC 7587 §7 fixes.
			wantAnswer: "a=rtpmap:111 opus/48000/2",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rig := newRig(t)
			request := validAllocate()
			request.SDPOffer = "v=0\r\no=- 1 1 IN IP4 203.0.113.9\r\ns=-\r\n" +
				"c=IN IP4 203.0.113.9\r\nt=0 0\r\n" + testCase.formats + "\r\n" +
				strings.Join(testCase.rtpmap, "\r\n") + "\r\na=sendrecv\r\n"

			response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, request)))
			if !response.Ok {
				t.Fatalf("allocate refused: %+v", response)
			}
			if response.Codec == nil || string(*response.Codec) != testCase.wantCodec {
				t.Errorf("codec = %v, want %s", response.Codec, testCase.wantCodec)
			}
			if !strings.Contains(*response.SDPAnswer, testCase.wantAnswer+"\r\n") {
				t.Errorf("the answer does not carry %q\n---\n%s",
					testCase.wantAnswer, *response.SDPAnswer)
			}
		})
	}
}

func TestOpusFmtpIsEchoedRatherThanInvented(t *testing.T) {
	// There is no Opus encoder here, so every fmtp parameter is one this service cannot act on.
	// Answering with parameters mediad invented would be telling the far end something about a stream
	// it is passing through untouched.
	rig := newRig(t)
	request := validAllocate()
	request.SDPOffer = "v=0\r\no=- 1 1 IN IP4 203.0.113.9\r\ns=-\r\n" +
		"c=IN IP4 203.0.113.9\r\nt=0 0\r\nm=audio 41000 RTP/AVP 111\r\n" +
		"a=rtpmap:111 opus/48000/2\r\na=fmtp:111 maxplaybackrate=16000;stereo=0\r\na=sendrecv\r\n"

	response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, request)))
	if !response.Ok {
		t.Fatalf("allocate refused: %+v", response)
	}
	if !strings.Contains(*response.SDPAnswer, "a=fmtp:111 maxplaybackrate=16000;stereo=0\r\n") {
		t.Errorf("the offerer's fmtp was not echoed\n---\n%s", *response.SDPAnswer)
	}
}

func TestTheAllocatedSessionCarriesTheNegotiatedCodec(t *testing.T) {
	// The packet path needs the CODEC and not just the payload type, because rung 7 made those two
	// different questions: G.722 is static type 9 and Opus is dynamic, so a number alone stopped
	// naming a codec.
	rig := newRig(t)
	request := validAllocate()
	request.SDPOffer = "v=0\r\no=- 1 1 IN IP4 203.0.113.9\r\ns=-\r\n" +
		"c=IN IP4 203.0.113.9\r\nt=0 0\r\nm=audio 41000 RTP/AVP 9\r\n" +
		"a=rtpmap:9 G722/8000\r\na=sendrecv\r\n"

	if response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, request))); !response.Ok {
		t.Fatalf("allocate refused: %+v", response)
	}
	allocated := rig.sessions.allocateCalls()
	if allocated[0].Format != audio.FormatG722 {
		t.Errorf("the session was created as %s, want G722", allocated[0].Format)
	}
	if allocated[0].AudioPayloadType != rtp.PayloadTypeG722 {
		t.Errorf("payload type = %d, want 9", allocated[0].AudioPayloadType)
	}
}

func decodeTap(t *testing.T, payload []byte) contract.MediaTapSessionResponse {
	t.Helper()
	var response contract.MediaTapSessionResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatalf("decoding a tap reply: %v\n%s", err, payload)
	}
	return response
}

func decodeUntap(t *testing.T, payload []byte) contract.MediaUntapSessionResponse {
	t.Helper()
	var response contract.MediaUntapSessionResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatalf("decoding an untap reply: %v\n%s", err, payload)
	}
	return response
}

// --- Rung 5's state pair, reaching the wire ---------------------------------------------------
//
// `internal/rtp/hold.go` has held both suppression gates and the music loop since rung 5. What it
// never had was a subject, so `MediadMediaPort` refused hold, unhold, mute, unmute and
// music-on-hold BY NAME. These are the tests for the two commands that close that.

func decodeMute(t *testing.T, payload []byte) contract.MediaMuteSessionResponse {
	t.Helper()
	var response contract.MediaMuteSessionResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatalf("decoding a mute reply: %v\n%s", err, payload)
	}
	return response
}

func decodeHold(t *testing.T, payload []byte) contract.MediaHoldSessionResponse {
	t.Helper()
	var response contract.MediaHoldSessionResponse
	if err := json.Unmarshal(payload, &response); err != nil {
		t.Fatalf("decoding a hold reply: %v\n%s", err, payload)
	}
	return response
}

func TestMuteGatesTheDirectionItWasAskedFor(t *testing.T) {
	cases := []struct {
		name      string
		direction contract.MediaMuteSessionRequestDirection
		wantIn    bool
		wantOut   bool
	}{
		// `in` is audio arriving FROM the leg: the party cannot be HEARD. A conference `*6`.
		{"a participant nobody can hear", "in", true, false},
		// `out` is audio sent TO the leg: the party cannot HEAR.
		{"a participant who cannot hear", "out", false, true},
		{"both", "both", true, true},
		// ARI's own default, matched deliberately: a mute with no direction mutes everything, and
		// matching Asterisk matters more than picking the direction this service would have chosen.
		{"no direction at all", "", true, true},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)

			response := decodeMute(t, rig.server.HandleMuteSession(mustJSON(t,
				contract.MediaMuteSessionRequest{
					SessionID: testSession,
					Direction: testCase.direction,
				})))
			if !response.Ok {
				t.Fatalf("the mute was refused: %+v", response)
			}
			if response.MutedIn != testCase.wantIn || response.MutedOut != testCase.wantOut {
				t.Errorf("state = in %v out %v, want in %v out %v",
					response.MutedIn, response.MutedOut, testCase.wantIn, testCase.wantOut)
			}
		})
	}
}

func TestMuteIsAdditiveAndTheReplyProvesIt(t *testing.T) {
	// The whole reason the handler READS the state back instead of deriving it from the request.
	// Muting `in` on a leg already muted `out` must leave both set — the alternative, a direction
	// field that replaces whatever was there, is how a conference participant gets their audio back
	// because somebody muted their microphone.
	rig := newRig(t)
	allocateSession(t, rig)

	rig.server.HandleMuteSession(mustJSON(t, contract.MediaMuteSessionRequest{
		SessionID: testSession, Direction: "out",
	}))
	response := decodeMute(t, rig.server.HandleMuteSession(mustJSON(t,
		contract.MediaMuteSessionRequest{SessionID: testSession, Direction: "in"})))

	if !response.MutedIn || !response.MutedOut {
		t.Errorf("state = in %v out %v; the second mute replaced the first instead of adding to it",
			response.MutedIn, response.MutedOut)
	}

	// And the unmute lifts only what it names.
	response = decodeMute(t, rig.server.HandleMuteSession(mustJSON(t,
		contract.MediaMuteSessionRequest{SessionID: testSession, Direction: "in", Unmute: true})))
	if response.MutedIn || !response.MutedOut {
		t.Errorf("state = in %v out %v, want in false out true", response.MutedIn, response.MutedOut)
	}
}

func TestMuteSessionRefusals(t *testing.T) {
	cases := []struct {
		name    string
		request contract.MediaMuteSessionRequest
		reason  string
	}{
		{
			name:    "no session id",
			request: contract.MediaMuteSessionRequest{Direction: "both"},
			reason:  control.ReasonBadRequest,
		},
		{
			// Validated before the session is looked up, exactly as a tap's side letters are: a
			// direction of "left" is a caller bug and should read the same whether or not the call it
			// names is up.
			name:    "a direction that does not exist",
			request: contract.MediaMuteSessionRequest{SessionID: testSession, Direction: "left"},
			reason:  control.ReasonBadRequest,
		},
		{
			name:    "a session this instance does not have",
			request: contract.MediaMuteSessionRequest{SessionID: "somebody-elses-leg", Direction: "both"},
			reason:  control.ReasonUnknown,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			rig := newRig(t)
			allocateSession(t, rig)
			before := len(rig.sessions.muteCalls())

			response := decodeMute(t, rig.server.HandleMuteSession(mustJSON(t, testCase.request)))
			if response.Ok {
				t.Fatal("the mute was accepted")
			}
			if response.Reason == nil || string(*response.Reason) != testCase.reason {
				t.Errorf("reason = %v, want %q", response.Reason, testCase.reason)
			}
			if testCase.reason == control.ReasonBadRequest &&
				len(rig.sessions.muteCalls()) != before {
				t.Error("a refused mute still reached the packet path")
			}
		})
	}
}

func TestHoldResolvesItsMusicBeforeItAnswers(t *testing.T) {
	// The reason this subject's deadline is a second where the rest of the family's is 500 ms: a
	// hold that names music READS AND DECODES A FILE first, exactly as `start-playback` does, so an
	// `ok` means the loop is in memory rather than that the request was accepted for consideration.
	rig := newRig(t)
	allocateSession(t, rig)
	writeULawPrompt(t, rig, "moh/default.wav", 4)

	response := decodeHold(t, rig.server.HandleHoldSession(mustJSON(t,
		contract.MediaHoldSessionRequest{
			SessionID: testSession,
			Music:     stringOf("moh:default"),
			MusicRef:  stringOf("hold-1"),
		})))
	if !response.Ok {
		t.Fatalf("the hold was refused: %+v", response)
	}
	if !response.Held {
		t.Error("the reply does not say the leg is held")
	}
	if response.MusicRef == nil || *response.MusicRef != "hold-1" {
		t.Errorf("musicRef = %v, want hold-1", response.MusicRef)
	}

	holds := rig.sessions.holdCalls()
	if len(holds) != 1 {
		t.Fatalf("%d holds reached the packet path, want 1", len(holds))
	}
	if len(holds[0].opts.MusicFrames) == 0 {
		// PRE-DECODED, so the packet path does no I/O: a disk read between "the agent pressed hold"
		// and "the caller stopped hearing them" is exactly what this ordering exists to prevent.
		t.Error("the hold reached the packet path with no decoded frames")
	}
	if holds[0].opts.MusicDescription != "moh:default" {
		t.Errorf("description = %q, want moh:default", holds[0].opts.MusicDescription)
	}
}

func TestAHoldWithNoMusicIsALegalSilentHold(t *testing.T) {
	// An instance with no music mounted still has to be able to take a party out of a conversation.
	// The caller hears silence, the suppression stands, and nothing pretends a file existed.
	rig := newRigWithLibrary(t, "")
	allocateSession(t, rig)

	response := decodeHold(t, rig.server.HandleHoldSession(mustJSON(t,
		contract.MediaHoldSessionRequest{SessionID: testSession})))
	if !response.Ok || !response.Held {
		t.Fatalf("a silent hold was refused: %+v", response)
	}
	if response.MusicRef != nil && *response.MusicRef != "" {
		t.Errorf("musicRef = %v; a hold with no music has no loop to name", response.MusicRef)
	}
}

func TestUnholdOfAnUnheldLegIsASuccess(t *testing.T) {
	// The engine retries an unhold, and a retry after a lost reply must not look like a failure —
	// the same shape `unbridge`, `stop-playback` and `untap` use.
	rig := newRig(t)
	allocateSession(t, rig)

	response := decodeHold(t, rig.server.HandleHoldSession(mustJSON(t,
		contract.MediaHoldSessionRequest{SessionID: testSession, Unhold: true})))
	if !response.Ok {
		t.Fatalf("unholding an unheld leg was an error: %+v", response)
	}
	if response.Held {
		t.Error("the reply says the leg is still held")
	}
}

func TestHoldSessionRefusals(t *testing.T) {
	t.Run("no session id", func(t *testing.T) {
		rig := newRig(t)
		response := decodeHold(t, rig.server.HandleHoldSession(mustJSON(t,
			contract.MediaHoldSessionRequest{})))
		if response.Ok || response.Reason == nil ||
			string(*response.Reason) != control.ReasonBadRequest {
			t.Errorf("a hold with no session was not refused as bad_request: %+v", response)
		}
		if len(rig.sessions.holdCalls()) != 0 {
			t.Error("a refused hold still reached the packet path")
		}
	})

	t.Run("music this instance cannot resolve", func(t *testing.T) {
		// The music is resolved BEFORE the flags go up, so a hold that cannot find its file has not
		// half-happened: the party is still in the conversation and the engine is told why.
		rig := newRig(t)
		allocateSession(t, rig)

		response := decodeHold(t, rig.server.HandleHoldSession(mustJSON(t,
			contract.MediaHoldSessionRequest{
				SessionID: testSession,
				Music:     stringOf("moh:nothing-here"),
			})))
		if response.Ok {
			t.Fatal("a hold naming an absent clip was accepted")
		}
		if len(rig.sessions.holdCalls()) != 0 {
			t.Error("a refused hold still reached the packet path")
		}
	})

	t.Run("a session this instance does not have", func(t *testing.T) {
		rig := newRig(t)
		response := decodeHold(t, rig.server.HandleHoldSession(mustJSON(t,
			contract.MediaHoldSessionRequest{
				SessionID: "somebody-elses-leg",
				Music:     stringOf("moh:default"),
			})))
		if response.Ok || response.Reason == nil ||
			string(*response.Reason) != control.ReasonUnknown {
			t.Errorf("reason = %v, want unknown_session", response.Reason)
		}
	})
}

// --- Rung 6's room, reached through bridge-sessions --------------------------------------------

func TestBridgeSeatsThreeSessionsInARoom(t *testing.T) {
	// THIS CASE USED TO ASSERT A REFUSAL naming rung 6. Until now the only wire path into a
	// Conference was `tap-session` converting a two-party bridge, so a conference bridge the engine
	// asked for was refused by name while a working mixer sat one function call away.
	rig := newRig(t)
	for _, id := range []string{"leg-a", "leg-b", "leg-c"} {
		request := validAllocate()
		request.SessionID = id
		if response := decodeAllocate(t, rig.server.HandleAllocateSession(mustJSON(t, request))); !response.Ok {
			t.Fatalf("allocating %s: %+v", id, response)
		}
	}

	response := decodeBridge(t, rig.server.HandleBridgeSessions(mustJSON(t,
		contract.MediaBridgeSessionsRequest{
			BridgeID:   "room-1",
			SessionIDs: []string{"leg-a", "leg-b", "leg-c"},
		})))
	if !response.Ok {
		t.Fatalf("a three-way bridge was refused: %+v", response)
	}
	if !response.Mixed {
		// The one fact an operator needs to explain "the call developed sixty milliseconds of delay
		// the moment the third person joined".
		t.Error("the reply does not say the arrangement is a mix")
	}
	if len(response.SessionIDs) != 3 {
		t.Errorf("SessionIDs = %v, want all three", response.SessionIDs)
	}

	joins := rig.sessions.joinCalls()
	if len(joins) != 3 {
		t.Fatalf("%d joins reached the packet path, want 3", len(joins))
	}
	for _, join := range joins {
		if join.conferenceID != "room-1" {
			// A room that renamed itself on the way in would leave an `unbridge-sessions` naming
			// nothing: the engine tears down what it created, under the name it created it with.
			t.Errorf("conferenceId = %q, want the bridge's own id", join.conferenceID)
		}
		if !join.opts.Hear.All() || !join.opts.SpeakTo.All() {
			// A bridge means everybody hears everybody. Asymmetric membership is what tap-session is
			// for, and a bridge that could express it would be two ways to say one thing.
			t.Error("a bridge member was seated with asymmetric routing")
		}
	}

	// Two members is still a RELAY — no buffer, no decode, no added delay — which is the whole
	// reason the arrangement is chosen here rather than named by the caller.
	if len(rig.sessions.bridgeCallsMade()) != 0 {
		t.Error("a three-way bridge went down the two-party relay path")
	}
}

func TestAHalfBuiltRoomIsTornDownRatherThanLeftRunning(t *testing.T) {
	// The one state that must not survive: some members mixing and some relaying is a call where
	// one party can hear and another cannot, which reads as a network fault and is not one.
	rig := newRig(t)
	rig.sessions.joinErr = rtp.ErrConferenceCodec

	response := decodeBridge(t, rig.server.HandleBridgeSessions(mustJSON(t,
		contract.MediaBridgeSessionsRequest{
			BridgeID:   "room-1",
			SessionIDs: []string{"leg-a", "leg-b", "leg-c"},
		})))
	if response.Ok {
		t.Fatal("a room whose first join failed was accepted")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
		// A leg whose codec cannot be decoded cannot be in a mix. The engine's recovery is to route
		// this room to Asterisk.
		t.Errorf("reason = %v, want not_supported", response.Reason)
	}
	if len(rig.sessions.destroyedConferences()) == 0 {
		t.Error("the half-built room was left running")
	}
}

// --- targetSide: the letters stop depending on argument order ----------------------------------

func TestTapCarriesTheDeclaredTargetSide(t *testing.T) {
	// `MediaPort.TapRequest` has always carried this; the wire did not, so the media plane fixed the
	// only convention it could defend (`a` is the target) and the ENGINE had to pass, as
	// `targetSessionId`, the leg it would have called side `a`. That obligation has moved.
	rig := newRig(t)
	allocateSession(t, rig)

	side := contract.LegSideB
	response := decodeTap(t, rig.server.HandleTapSession(mustJSON(t,
		contract.MediaTapSessionRequest{
			TapID:           "tap-1",
			TapSessionID:    "supervisor-leg",
			TargetSessionID: testSession,
			TargetSide:      &side,
			Hear:            "both",
			SpeakTo:         "b",
		})))
	if !response.Ok {
		t.Fatalf("the tap was refused: %+v", response)
	}

	taps := rig.sessions.tapCalls()
	if len(taps) != 1 {
		t.Fatalf("%d taps reached the packet path, want 1", len(taps))
	}
	if taps[0].TargetSide != rtp.SideB {
		t.Errorf("TargetSide = %q, want %q", taps[0].TargetSide, rtp.SideB)
	}
}

func TestATapWithNoTargetSideKeepsTheOldConvention(t *testing.T) {
	// ABSENT is a supported state, not a defect: it is what a caller compiled before the field
	// existed sends, and it must behave exactly as it did — target-first, `a` is the target. The
	// handler leaves it EMPTY rather than defaulting, so `resolveAudiences` is the single place that
	// decision is written down instead of two places that could drift.
	rig := newRig(t)
	allocateSession(t, rig)

	response := decodeTap(t, rig.server.HandleTapSession(mustJSON(t,
		contract.MediaTapSessionRequest{
			TapID:           "tap-1",
			TapSessionID:    "supervisor-leg",
			TargetSessionID: testSession,
			Hear:            "both",
			SpeakTo:         "none",
		})))
	if !response.Ok {
		t.Fatalf("the tap was refused: %+v", response)
	}
	if got := rig.sessions.tapCalls()[0].TargetSide; got != "" {
		t.Errorf("TargetSide = %q, want it left empty for resolveAudiences to decide", got)
	}
}

func stringOf(value string) *string { return &value }
