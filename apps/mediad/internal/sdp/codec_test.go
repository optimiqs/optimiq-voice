package sdp_test

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// Rung 7's negotiation. Two codecs join the vocabulary and they do not cost the same: G.722 can be
// transcoded and mixed, Opus can only be relayed. That difference is deliberately invisible in the
// ANSWER — an offer is answered on what the two ends can carry rather than on what a conference
// might one day need — so it is tested here as a property of the codec rather than of the answer.

func TestCodecFacts(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		codec       sdp.Codec
		payloadType uint8
		clockRate   int
		format      audio.Format
	}{
		{"PCMU", sdp.CodecPCMU, 0, 8000, audio.FormatULaw},
		{"PCMA", sdp.CodecPCMA, 8, 8000, audio.FormatALaw},
		{
			// The clock rate is 8000 and the codec samples at 16 kHz. RFC 3551 §4.5.2 records the
			// mismatch as an error in G.722's original registration that shipped anyway, and
			// `a=rtpmap:9 G722/16000` is the commonest G.722 interop bug there is.
			"G722", sdp.CodecG722, 9, 8000, audio.FormatG722,
		},
		{
			// Opus has NO static payload type. Zero here means "there isn't one", which is why an
			// answer carries the offer's own number instead.
			"opus", sdp.CodecOpus, 0, 48000, audio.FormatOpus,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			if got := testCase.codec.PayloadType(); got != testCase.payloadType {
				t.Errorf("PayloadType() = %d, want %d", got, testCase.payloadType)
			}
			if got := testCase.codec.ClockRate(); got != testCase.clockRate {
				t.Errorf("ClockRate() = %d, want %d", got, testCase.clockRate)
			}
			if got := testCase.codec.Format(); got != testCase.format {
				t.Errorf("Format() = %v, want %v", got, testCase.format)
			}
			if back := sdp.CodecForFormat(testCase.format); back != testCase.codec {
				t.Errorf("CodecForFormat(%v) = %q, want %q", testCase.format, back, testCase.codec)
			}
		})
	}
}

func TestParseOfferHonoursPreferenceAcrossFourCodecs(t *testing.T) {
	t.Parallel()

	// Offer order is preference order (RFC 3264 §5.1), and honouring it is not politeness: an
	// endpoint that lists G.722 first is telling us it would rather be wideband, and answering PCMU
	// because this parser happened to check it first would override a preference the RFC says is the
	// offerer's to express.
	cases := []struct {
		name            string
		formats         string
		rtpmap          []string
		wantCodec       sdp.Codec
		wantPayloadType uint8
	}{
		{
			name:    "PCMU first",
			formats: "0 8 9 111",
			rtpmap: []string{
				"a=rtpmap:0 PCMU/8000", "a=rtpmap:8 PCMA/8000",
				"a=rtpmap:9 G722/8000", "a=rtpmap:111 opus/48000/2",
			},
			wantCodec: sdp.CodecPCMU, wantPayloadType: 0,
		},
		{
			name:    "G.722 first",
			formats: "9 0 8",
			rtpmap: []string{
				"a=rtpmap:9 G722/8000", "a=rtpmap:0 PCMU/8000", "a=rtpmap:8 PCMA/8000",
			},
			wantCodec: sdp.CodecG722, wantPayloadType: 9,
		},
		{
			name:    "Opus first, under its own dynamic number",
			formats: "111 0",
			rtpmap: []string{
				"a=rtpmap:111 opus/48000/2", "a=rtpmap:0 PCMU/8000",
			},
			wantCodec: sdp.CodecOpus, wantPayloadType: 111,
		},
		{
			// A different endpoint, a different dynamic number for the same codec. Opus is reachable
			// ONLY through an rtpmap, which is why that branch is the whole of its negotiation.
			name:      "Opus under a different dynamic number",
			formats:   "96",
			rtpmap:    []string{"a=rtpmap:96 opus/48000/2"},
			wantCodec: sdp.CodecOpus, wantPayloadType: 96,
		},
		{
			// G.722 by its STATIC number with no rtpmap, which older endpoints really do send.
			name:      "G.722 with no rtpmap",
			formats:   "9",
			rtpmap:    nil,
			wantCodec: sdp.CodecG722, wantPayloadType: 9,
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			body := "v=0\r\no=- 1 1 IN IP4 203.0.113.9\r\ns=-\r\nc=IN IP4 203.0.113.9\r\nt=0 0\r\n" +
				"m=audio 41000 RTP/AVP " + testCase.formats + "\r\n"
			for _, line := range testCase.rtpmap {
				body += line + "\r\n"
			}

			offer, err := sdp.ParseOffer(body)
			if err != nil {
				t.Fatalf("ParseOffer: %v", err)
			}
			if offer.Codec != testCase.wantCodec {
				t.Errorf("Codec = %q, want %q", offer.Codec, testCase.wantCodec)
			}
			if offer.AudioPayloadType != testCase.wantPayloadType {
				t.Errorf("AudioPayloadType = %d, want %d",
					offer.AudioPayloadType, testCase.wantPayloadType)
			}
		})
	}
}

func TestParseOfferReadsTheOpusFmtp(t *testing.T) {
	t.Parallel()

	offer, err := sdp.ParseOffer("v=0\r\no=- 1 1 IN IP4 203.0.113.9\r\ns=-\r\n" +
		"c=IN IP4 203.0.113.9\r\nt=0 0\r\nm=audio 41000 RTP/AVP 111\r\n" +
		"a=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1\r\n")
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	if offer.OpusFmtp != "minptime=10;useinbandfec=1" {
		t.Errorf("OpusFmtp = %q, want the offerer's own parameters", offer.OpusFmtp)
	}
}

func TestBuildAnswerRendersEachCodecCorrectly(t *testing.T) {
	t.Parallel()

	address := netip.MustParseAddr("203.0.113.10")

	cases := []struct {
		name     string
		answer   sdp.Answer
		contains []string
		absent   []string
	}{
		{
			name: "G.722 advertises the 8 kHz clock rate",
			answer: sdp.Answer{
				SessionID: 1, SessionVersion: 1, Address: address, Port: 30000,
				Codec: sdp.CodecG722, AudioPayloadType: 9, Direction: sdp.DirectionSendRecv,
			},
			contains: []string{"m=audio 30000 RTP/AVP 9\r\n", "a=rtpmap:9 G722/8000\r\n"},
			absent:   []string{"G722/16000"},
		},
		{
			name: "Opus keeps the offer's dynamic number and the fixed /2",
			answer: sdp.Answer{
				SessionID: 1, SessionVersion: 1, Address: address, Port: 30000,
				Codec: sdp.CodecOpus, AudioPayloadType: 111,
				OpusFmtp: "minptime=10", Direction: sdp.DirectionSendRecv,
			},
			// RFC 7587 §7 fixes the channel count at two whatever the stream carries; mono is
			// signalled through `stereo=0` in the fmtp instead, and an answer that wrote `/1` is
			// rejected by endpoints that check it.
			contains: []string{
				"m=audio 30000 RTP/AVP 111\r\n",
				"a=rtpmap:111 opus/48000/2\r\n",
				"a=fmtp:111 minptime=10\r\n",
			},
		},
		{
			name: "Opus with no fmtp offers none back",
			answer: sdp.Answer{
				SessionID: 1, SessionVersion: 1, Address: address, Port: 30000,
				Codec: sdp.CodecOpus, AudioPayloadType: 111, Direction: sdp.DirectionSendRecv,
			},
			absent: []string{"a=fmtp:111"},
		},
		{
			name: "G.711 is unchanged from every rung before this one",
			answer: sdp.Answer{
				SessionID: 1, SessionVersion: 1, Address: address, Port: 30000,
				Codec: sdp.CodecPCMA, AudioPayloadType: 8,
				TelephoneEventPayloadType: 101, Direction: sdp.DirectionSendRecv,
			},
			contains: []string{
				"m=audio 30000 RTP/AVP 8 101\r\n",
				"a=rtpmap:8 PCMA/8000\r\n",
				"a=rtpmap:101 telephone-event/8000\r\n",
				"a=fmtp:101 0-16\r\n",
			},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			body := sdp.BuildAnswer(testCase.answer)
			for _, want := range testCase.contains {
				if !strings.Contains(body, want) {
					t.Errorf("the answer does not carry %q\n---\n%s", want, body)
				}
			}
			for _, unwanted := range testCase.absent {
				if strings.Contains(body, unwanted) {
					t.Errorf("the answer carries %q and should not\n---\n%s", unwanted, body)
				}
			}
		})
	}
}
