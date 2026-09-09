package sdp_test

import (
	"errors"
	"net/netip"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// The refusal names every codec BuildAnswer can actually render, so adding one cannot leave the
// message advertising a stale set.
func TestNoCommonCodecNamesEveryNegotiableCodec(t *testing.T) {
	message := sdp.ErrNoCommonCodec.Error()
	for _, codec := range []sdp.Codec{sdp.CodecPCMU, sdp.CodecPCMA, sdp.CodecG722, sdp.CodecOpus} {
		if !strings.Contains(message, string(codec)) {
			t.Errorf("ErrNoCommonCodec does not mention %s: %q", codec, message)
		}
	}
}

// Opus takes its payload type from the offer. Rendering it without one would put the answer on PT 0,
// which the far end reads as PCMU — a connected call carrying noise.
func TestAnswerValidationRefusesADynamicCodecWithNoPayloadType(t *testing.T) {
	answer := sdp.Answer{
		Address:   netip.MustParseAddr("203.0.113.10"),
		Port:      30000,
		Codec:     sdp.CodecOpus,
		Direction: sdp.DirectionSendRecv,
	}
	err := answer.Validate()
	if !errors.Is(err, sdp.ErrNoPayloadType) {
		t.Fatalf("Validate() = %v, want ErrNoPayloadType", err)
	}

	answer.AudioPayloadType = 111
	if err := answer.Validate(); err != nil {
		t.Fatalf("Validate() with the offered payload type: %v", err)
	}
	if body := sdp.BuildAnswer(answer); !strings.Contains(body, "a=rtpmap:111 opus/48000/2") {
		t.Errorf("the answer did not use the offered payload type:\n%s", body)
	}
}

// Every static codec is renderable with an unset payload type: it falls back to its RFC 3551 number,
// and PCMU's really is 0.
func TestAnswerValidationAcceptsStaticCodecsWithoutAPayloadType(t *testing.T) {
	for _, codec := range []sdp.Codec{sdp.CodecPCMU, sdp.CodecPCMA, sdp.CodecG722} {
		answer := sdp.Answer{
			Address:   netip.MustParseAddr("203.0.113.10"),
			Port:      30000,
			Codec:     codec,
			Direction: sdp.DirectionSendRecv,
		}
		if err := answer.Validate(); err != nil {
			t.Errorf("Validate() for %s = %v", codec, err)
		}
		if codec.IsDynamic() {
			t.Errorf("%s reports itself dynamic; it has a static payload type", codec)
		}
	}
	if !sdp.CodecOpus.IsDynamic() {
		t.Error("opus has no static payload type and must report itself dynamic")
	}
}

func TestAnswerValidationRefusesAnUnnegotiatedAnswer(t *testing.T) {
	if err := (sdp.Answer{}).Validate(); !errors.Is(err, sdp.ErrNoCommonCodec) {
		t.Errorf("Validate() on an empty answer = %v, want ErrNoCommonCodec", err)
	}
}
