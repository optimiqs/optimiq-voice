package rtp_test

import (
	"errors"
	"math"
	"testing"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// Rung 7, at the bridge boundary. The two properties that matter are opposites of each other:
// a MISMATCHED bridge must translate, and a MATCHED one must not — because passthrough is what makes
// rung 2's numbers what they are and rung 7 must not spend them.

func TestTranscoderRefusesTheIdentityTranslation(t *testing.T) {
	t.Parallel()

	// A transcoder installed for two legs that agreed would decode and re-encode every frame of every
	// call for no change in the bytes, turning the fast path into the slow one invisibly. A caller
	// that reaches here with two equal formats has a bug, and it is better to see it than to hear it
	// as CPU.
	if _, err := rtp.NewTranscoder(audio.FormatULaw, audio.FormatULaw); err == nil {
		t.Error("NewTranscoder accepted a translation from a codec to itself")
	}
}

func TestTranscoderTranslatesBetweenEveryPairItCanDecode(t *testing.T) {
	t.Parallel()

	// Nine ordered pairs over three codecs, minus the three identities. Each is asserted on the LEVEL
	// rather than on the bytes: a translation that produced the right number of bytes at the wrong
	// amplitude is one party sounding faint, which is the failure a byte-count assertion misses.
	formats := []audio.Format{audio.FormatULaw, audio.FormatALaw, audio.FormatG722}

	for _, from := range formats {
		for _, to := range formats {
			if from == to {
				continue
			}
			t.Run(from.String()+" to "+to.String(), func(t *testing.T) {
				t.Parallel()

				coder, err := rtp.NewTranscoder(from, to)
				if err != nil {
					t.Fatalf("NewTranscoder(%s, %s): %v", from, to, err)
				}
				sourceEncoder, err := audio.NewFrameEncoder(from)
				if err != nil {
					t.Fatalf("NewFrameEncoder: %v", err)
				}
				destinationDecoder, err := audio.NewFrameDecoder(to)
				if err != nil {
					t.Fatalf("NewFrameDecoder: %v", err)
				}

				in := sine(audio.FrameSamples*10, 1000, 8000, audio.SampleRate)
				var out []int16
				for offset := 0; offset < len(in); offset += audio.FrameSamples {
					payload := sourceEncoder.EncodeFrame(in[offset : offset+audio.FrameSamples])
					translated, ok := coder.Translate(payload)
					if !ok {
						t.Fatal("Translate refused a full frame")
					}
					if len(translated) != audio.FrameSamples {
						t.Fatalf("translated frame is %d bytes, want %d: every codec here packs 20 ms "+
							"into 160 octets, which is why no repacketisation is needed",
							len(translated), audio.FrameSamples)
					}
					out = append(out, destinationDecoder.DecodeFrame(translated)...)
				}

				want := goertzel(in[400:], 1000, audio.SampleRate)
				got := goertzel(out[400:], 1000, audio.SampleRate)
				if ratio := got / want; ratio < 0.8 || ratio > 1.2 {
					t.Errorf("a 1 kHz tone survived %s→%s at %.3f×", from, to, ratio)
				}
			})
		}
	}
}

func TestTranscoderRefusesACodecItCannotDecode(t *testing.T) {
	t.Parallel()

	// Opus. The refusal is by NAME and it is what routes a call the engine cannot serve here to
	// Asterisk — the per-capability cutover working as designed rather than a failed call. See
	// internal/audio/g722.go for the cgo decision behind it.
	_, err := rtp.NewTranscoder(audio.FormatOpus, audio.FormatULaw)
	if !errors.Is(err, rtp.ErrCannotTranscode) {
		t.Errorf("NewTranscoder(opus, PCMU) = %v, want ErrCannotTranscode", err)
	}
	_, err = rtp.NewTranscoder(audio.FormatULaw, audio.FormatOpus)
	if !errors.Is(err, rtp.ErrCannotTranscode) {
		t.Errorf("NewTranscoder(PCMU, opus) = %v, want ErrCannotTranscode", err)
	}
}

func TestABridgedMismatchIsTranslatedOnTheWire(t *testing.T) {
	// End to end: a µ-law leg bridged to an A-law one, with a real socket at each end. The assertion
	// is that the bytes CHANGED and the sound did not — which is the whole of transcoding, and is
	// two assertions a passthrough relay would fail in opposite directions.
	rig := newBridgeRigWithTypes(t, 60000, 60039,
		rtp.PayloadTypePCMU, rtp.PayloadTypeTelephoneEvent,
		rtp.PayloadTypePCMA, rtp.PayloadTypeTelephoneEvent)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	const level = 4000
	encoded := audio.LinearToULaw(level)
	payload := make([]byte, audio.FrameSamples)
	for index := range payload {
		payload[index] = encoded
	}

	rig.aPhone.send(t, pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111,
			SequenceNumber: 1, Timestamp: 160,
		},
		Payload: payload,
	})

	got, ok := rig.bPhone.receive(t)
	if !ok {
		t.Fatal("the A-law leg heard nothing across a transcoded bridge")
	}
	if got.PayloadType != rtp.PayloadTypePCMA {
		t.Errorf("payload type = %d, want %d: a translated frame must be labelled with the codec it "+
			"is actually in", got.PayloadType, rtp.PayloadTypePCMA)
	}
	if got.Payload[0] == encoded {
		t.Error("the payload byte was passed through unchanged; the far end would hear a rasp")
	}
	if decoded := audio.ALawToLinear(got.Payload[0]); !closeEnough(decoded, audio.ULawToLinear(encoded)) {
		t.Errorf("the translated level is %d, want about %d", decoded, audio.ULawToLinear(encoded))
	}
	// The timestamp survives, because every codec here shares an 8 kHz RTP clock — including G.722,
	// whose 16 kHz sampling and 8000 clock rate are RFC 3551 §4.5.2's erratum. Rewriting it would be
	// inventing a clock, which §6 refuses.
	if got.Timestamp != 160 {
		t.Errorf("Timestamp = %d, want the original 160", got.Timestamp)
	}
	if stats := mustSession(t, rig, rig.bID).Stats(); stats.Transcoded == 0 {
		t.Error("the Transcoded counter did not move; the passthrough/translate ratio is the one " +
			"diagnostic that says a deployment's endpoints are misconfigured")
	}
}

func TestDtmfStillCrossesATranscodedBridgeUntouched(t *testing.T) {
	// A telephone-event payload is BYTES, whatever the audio codec is, so it must take the renumber
	// path rather than the translate path. Sending a digit through a codec would produce four bytes
	// of noise and no digit — an IVR that stops working the moment two phones negotiate differently,
	// which is the exact failure rung 2's renumbering was built to avoid.
	rig := newBridgeRigWithTypes(t, 60040, 60079,
		rtp.PayloadTypePCMU, 96,
		rtp.PayloadTypeG722, 101)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	digit := []byte{0x04, 0x0a, 0x00, 0xa0}
	rig.aPhone.send(t, pionrtp.Packet{
		Header: pionrtp.Header{
			Version: 2, PayloadType: 96, SSRC: 111, SequenceNumber: 1, Timestamp: 320, Marker: true,
		},
		Payload: digit,
	})

	got, ok := rig.bPhone.receive(t)
	if !ok {
		t.Fatal("the digit did not cross a transcoded bridge")
	}
	if got.PayloadType != 101 {
		t.Errorf("payload type = %d, want 101: the telephone-event type is renumbered, not translated",
			got.PayloadType)
	}
	if string(got.Payload) != string(digit) {
		t.Errorf("payload = %v, want the digit's four bytes verbatim", got.Payload)
	}
	if !got.Marker {
		t.Error("the start-of-event marker was dropped; an IVR cannot detect the keypress")
	}
}

func TestUnbridgingClearsTheTranslation(t *testing.T) {
	// A translation belongs to the bridge it was built for. Leaving it installed would make a leg
	// re-bridged to a peer that DOES agree with it still pay for a decode and an encode — and, worse,
	// would leave codec state that a later bridge would resume mid-stream.
	rig := newBridgeRigWithTypes(t, 60080, 60119,
		rtp.PayloadTypePCMU, rtp.PayloadTypeTelephoneEvent,
		rtp.PayloadTypePCMA, rtp.PayloadTypeTelephoneEvent)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	if mustSession(t, rig, rig.aID).Transcoder() == nil {
		t.Fatal("a mismatched bridge installed no translation")
	}

	if _, ok := rig.manager.Unbridge("bridge-1"); !ok {
		t.Fatal("Unbridge reported nothing to unbridge")
	}
	for _, id := range []string{rig.aID, rig.bID} {
		if mustSession(t, rig, id).Transcoder() != nil {
			t.Errorf("%s kept its translation after the bridge ended", id)
		}
	}
}

// sine and goertzel are the same two helpers internal/audio's suite uses, restated here because a
// test package cannot import another test package. A Goertzel filter answers "how much 1 kHz is in
// this?" in one pass with no library — and is, not coincidentally, how a real DTMF detector works.
func sine(samples int, hertz, amplitude float64, rate int) []int16 {
	out := make([]int16, samples)
	for i := range out {
		out[i] = int16(amplitude * math.Sin(2*math.Pi*hertz*float64(i)/float64(rate)))
	}
	return out
}

func goertzel(samples []int16, hertz float64, rate int) float64 {
	omega := 2 * math.Pi * hertz / float64(rate)
	coefficient := 2 * math.Cos(omega)

	var s1, s2 float64
	for _, sample := range samples {
		s0 := float64(sample) + coefficient*s1 - s2
		s2, s1 = s1, s0
	}
	power := s1*s1 + s2*s2 - coefficient*s1*s2
	if power < 0 {
		return 0
	}
	return math.Sqrt(power) / float64(len(samples))
}

func mustSession(t *testing.T, rig *bridgeRig, id string) *rtp.Session {
	t.Helper()
	session, ok := rig.manager.Get(id)
	if !ok {
		t.Fatalf("session %s is gone", id)
	}
	return session
}
