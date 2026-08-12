package sdp_test

import (
	"errors"
	"net/netip"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// offer builds an SDP offer body from its media line and attributes, so a table case reads as the
// one thing it is about rather than as twelve lines of boilerplate.
func offer(mediaLine string, attributes ...string) string {
	var body strings.Builder
	body.WriteString("v=0\r\n")
	body.WriteString("o=- 12345 1 IN IP4 203.0.113.9\r\n")
	body.WriteString("s=-\r\n")
	body.WriteString("c=IN IP4 203.0.113.9\r\n")
	body.WriteString("t=0 0\r\n")
	body.WriteString(mediaLine + "\r\n")
	for _, attribute := range attributes {
		body.WriteString(attribute + "\r\n")
	}
	return body.String()
}

func TestParseOffer(t *testing.T) {
	cases := []struct {
		name          string
		body          string
		wantCodec     sdp.Codec
		wantTelephone uint8
		wantDirection sdp.Direction
		wantErr       error
	}{
		{
			// The offer a Yealink or a Polycom actually sends.
			name: "picks the offerer's first preference",
			body: offer("m=audio 41000 RTP/AVP 0 8 101",
				"a=rtpmap:0 PCMU/8000",
				"a=rtpmap:8 PCMA/8000",
				"a=rtpmap:101 telephone-event/8000",
				"a=fmtp:101 0-16"),
			wantCodec:     sdp.CodecPCMU,
			wantTelephone: 101,
			wantDirection: sdp.DirectionSendRecv,
		},
		{
			// Order is preference (RFC 3264 §5.1). An endpoint that lists PCMA first usually
			// encodes PCMA natively, and answering PCMU would make it transcode for nothing.
			name: "honours PCMA-first preference",
			body: offer("m=audio 41000 RTP/AVP 8 0 101",
				"a=rtpmap:8 PCMA/8000",
				"a=rtpmap:0 PCMU/8000",
				"a=rtpmap:101 telephone-event/8000"),
			wantCodec:     sdp.CodecPCMA,
			wantTelephone: 101,
			wantDirection: sdp.DirectionSendRecv,
		},
		{
			// 101 is the de-facto value, not the rule. An offer on 96 must negotiate 96, or DTMF
			// arrives under a payload type the far end never agreed to and is dropped.
			name: "negotiates a non-default telephone-event type",
			body: offer("m=audio 41000 RTP/AVP 0 96",
				"a=rtpmap:0 PCMU/8000",
				"a=rtpmap:96 telephone-event/8000"),
			wantCodec:     sdp.CodecPCMU,
			wantTelephone: 96,
			wantDirection: sdp.DirectionSendRecv,
		},
		{
			// Static types need no rtpmap at all; plenty of gateways omit it.
			name:          "resolves a static payload type with no rtpmap",
			body:          offer("m=audio 41000 RTP/AVP 8"),
			wantCodec:     sdp.CodecPCMA,
			wantDirection: sdp.DirectionSendRecv,
		},
		{
			// An rtpmap OVERRIDES the static table, so a remapped 0 is not silently taken as PCMU.
			name: "lets an rtpmap override the static table",
			body: offer("m=audio 41000 RTP/AVP 0 8",
				"a=rtpmap:0 G729/8000",
				"a=rtpmap:8 PCMA/8000"),
			wantCodec:     sdp.CodecPCMA,
			wantDirection: sdp.DirectionSendRecv,
		},
		{
			name: "reads a media-level direction",
			body: offer("m=audio 41000 RTP/AVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=sendonly"),
			wantCodec:     sdp.CodecPCMU,
			wantDirection: sdp.DirectionSendOnly,
		},
		{
			// RUNG 7 CHANGED THIS CASE. It used to assert that an offer of G.722 and Opus was refused
			// because rung 2 had no codec but G.711 — "the whole point of refusing rather than
			// transcoding". Both are negotiable now, so the offer is ACCEPTED at the offerer's own
			// first preference, which is G.722.
			name: "accepts a wideband offer at the offerer's preference",
			body: offer("m=audio 41000 RTP/AVP 9 111",
				"a=rtpmap:9 G722/8000",
				"a=rtpmap:111 opus/48000/2"),
			wantCodec:     sdp.CodecG722,
			wantDirection: sdp.DirectionSendRecv,
		},
		{
			// The refusal still exists; it just needs an offer with nothing mediad speaks in it.
			name: "refuses an offer with no codec mediad carries",
			body: offer("m=audio 41000 RTP/AVP 96 97",
				"a=rtpmap:96 AMR-WB/16000",
				"a=rtpmap:97 iLBC/8000"),
			wantErr: sdp.ErrNoCommonCodec,
		},
		{
			name:    "refuses an offer with no audio section",
			body:    offer("m=video 41000 RTP/AVP 96", "a=rtpmap:96 VP8/90000"),
			wantErr: sdp.ErrNoAudio,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := sdp.ParseOffer(tc.body)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("ParseOffer error = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseOffer: %v", err)
			}
			if got.Codec != tc.wantCodec {
				t.Errorf("Codec = %q, want %q", got.Codec, tc.wantCodec)
			}
			if got.TelephoneEventPayloadType != tc.wantTelephone {
				t.Errorf("TelephoneEventPayloadType = %d, want %d",
					got.TelephoneEventPayloadType, tc.wantTelephone)
			}
			if got.Direction != tc.wantDirection {
				t.Errorf("Direction = %q, want %q", got.Direction, tc.wantDirection)
			}
		})
	}
}

func TestParseOfferReadsTheAdvertisedAddress(t *testing.T) {
	got, err := sdp.ParseOffer(offer("m=audio 41000 RTP/AVP 0", "a=rtpmap:0 PCMU/8000"))
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	want := netip.MustParseAddrPort("203.0.113.9:41000")
	if got.RemoteAddress != want {
		t.Errorf("RemoteAddress = %v, want %v", got.RemoteAddress, want)
	}
}

// A hostname in `c=` and the classic 0.0.0.0 hold offer are both legal and neither is an error
// here: the address is advisory, because the session latches to where packets actually come FROM.
func TestParseOfferToleratesAnUnusableConnectionAddress(t *testing.T) {
	body := strings.Replace(
		offer("m=audio 41000 RTP/AVP 0", "a=rtpmap:0 PCMU/8000"),
		"c=IN IP4 203.0.113.9", "c=IN IP4 phone.example.com", 1)
	got, err := sdp.ParseOffer(body)
	if err != nil {
		t.Fatalf("ParseOffer: %v", err)
	}
	if got.RemoteAddress.IsValid() {
		t.Errorf("RemoteAddress = %v, want the zero value for a hostname", got.RemoteAddress)
	}
	if got.Codec != sdp.CodecPCMU {
		t.Errorf("Codec = %q, want PCMU: an unparseable address must not fail negotiation", got.Codec)
	}
}

func TestBuildAnswer(t *testing.T) {
	address := netip.MustParseAddr("203.0.113.10")

	cases := []struct {
		name       string
		answer     sdp.Answer
		wantLines  []string
		absentText []string
	}{
		{
			name: "PCMU with DTMF",
			answer: sdp.Answer{
				SessionID:                 30002,
				SessionVersion:            1,
				Address:                   address,
				Port:                      30002,
				Codec:                     sdp.CodecPCMU,
				TelephoneEventPayloadType: 101,
				Direction:                 sdp.DirectionSendRecv,
			},
			wantLines: []string{
				"v=0",
				"o=- 30002 1 IN IP4 203.0.113.10",
				"c=IN IP4 203.0.113.10",
				"t=0 0",
				"m=audio 30002 RTP/AVP 0 101",
				"a=rtpmap:0 PCMU/8000",
				"a=rtpmap:101 telephone-event/8000",
				"a=fmtp:101 0-16",
				"a=ptime:20",
				"a=sendrecv",
				// RFC 3605, stated rather than left to the far end to guess.
				"a=rtcp:30003",
			},
		},
		{
			// An offer with no telephone-event gets an answer with none: offering one back would be
			// answering with a codec the offerer never proposed.
			name: "PCMA without DTMF",
			answer: sdp.Answer{
				SessionID:      30010,
				SessionVersion: 1,
				Address:        address,
				Port:           30010,
				Codec:          sdp.CodecPCMA,
				Direction:      sdp.DirectionInactive,
			},
			wantLines: []string{
				"m=audio 30010 RTP/AVP 8",
				"a=rtpmap:8 PCMA/8000",
				"a=inactive",
			},
			absentText: []string{"telephone-event", "a=fmtp:"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := sdp.BuildAnswer(tc.answer)
			for _, line := range tc.wantLines {
				if !strings.Contains(body, line+"\r\n") {
					t.Errorf("answer is missing %q\n---\n%s", line, body)
				}
			}
			for _, text := range tc.absentText {
				if strings.Contains(body, text) {
					t.Errorf("answer unexpectedly contains %q\n---\n%s", text, body)
				}
			}
			if !strings.HasPrefix(body, "v=0\r\n") {
				t.Errorf("answer does not start with v=0\n---\n%s", body)
			}
		})
	}
}

// The answer must be parseable as an offer, because the far end parses it with the same kind of
// parser we do. Round-tripping it through ParseOffer is the cheapest possible proof.
func TestAnswerIsItselfParseable(t *testing.T) {
	body := sdp.BuildAnswer(sdp.Answer{
		SessionID:                 30002,
		SessionVersion:            1,
		Address:                   netip.MustParseAddr("203.0.113.10"),
		Port:                      30002,
		Codec:                     sdp.CodecPCMA,
		TelephoneEventPayloadType: 96,
		Direction:                 sdp.DirectionSendRecv,
	})

	parsed, err := sdp.ParseOffer(body)
	if err != nil {
		t.Fatalf("the answer we generate does not parse: %v\n---\n%s", err, body)
	}
	if parsed.Codec != sdp.CodecPCMA {
		t.Errorf("round-tripped codec = %q, want PCMA", parsed.Codec)
	}
	if parsed.TelephoneEventPayloadType != 96 {
		t.Errorf("round-tripped telephone-event = %d, want 96", parsed.TelephoneEventPayloadType)
	}
	if parsed.RemoteAddress != netip.MustParseAddrPort("203.0.113.10:30002") {
		t.Errorf("round-tripped address = %v", parsed.RemoteAddress)
	}
}

func TestAnswerDirection(t *testing.T) {
	cases := []struct {
		offered   sdp.Direction
		requested sdp.Direction
		want      sdp.Direction
	}{
		// The ordinary case.
		{sdp.DirectionSendRecv, sdp.DirectionSendRecv, sdp.DirectionSendRecv},
		// RFC 3264 §6.1: an answer mirrors the offer. An offerer that is not listening must not be
		// sent audio.
		{sdp.DirectionSendOnly, sdp.DirectionSendRecv, sdp.DirectionRecvOnly},
		{sdp.DirectionRecvOnly, sdp.DirectionSendRecv, sdp.DirectionSendOnly},
		// The engine knows things the SDP does not — a leg that is ringing rather than answered —
		// so a narrower request wins.
		{sdp.DirectionSendRecv, sdp.DirectionInactive, sdp.DirectionInactive},
		// Inactive on either side is inactive. There is nothing to intersect.
		{sdp.DirectionInactive, sdp.DirectionSendRecv, sdp.DirectionInactive},
	}
	for _, tc := range cases {
		t.Run(string(tc.offered)+"/"+string(tc.requested), func(t *testing.T) {
			if got := sdp.AnswerDirection(tc.offered, tc.requested); got != tc.want {
				t.Errorf("AnswerDirection(%q, %q) = %q, want %q",
					tc.offered, tc.requested, got, tc.want)
			}
		})
	}
}

func TestParseDirection(t *testing.T) {
	cases := []struct {
		raw     string
		want    sdp.Direction
		wantErr bool
	}{
		{"sendrecv", sdp.DirectionSendRecv, false},
		{"inactive", sdp.DirectionInactive, false},
		// An absent direction means sendrecv (RFC 4566 §6), which is also the contract's default.
		{"", sdp.DirectionSendRecv, false},
		// A typo must be a visible error, never a session that silently does the wrong thing.
		{"SendRecv", "", true},
		{"duplex", "", true},
	}
	for _, tc := range cases {
		t.Run("direction="+tc.raw, func(t *testing.T) {
			got, err := sdp.ParseDirection(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("ParseDirection(%q) = %q, want an error", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseDirection(%q): %v", tc.raw, err)
			}
			if got != tc.want {
				t.Errorf("ParseDirection(%q) = %q, want %q", tc.raw, got, tc.want)
			}
		})
	}
}
