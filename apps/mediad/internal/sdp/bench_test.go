package sdp_test

import (
	"net/netip"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

const benchOffer = `v=0
o=- 3915093017 3915093017 IN IP4 198.51.100.7
s=-
c=IN IP4 198.51.100.7
t=0 0
m=audio 40000 RTP/AVP 0 8 9 101
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:9 G722/8000
a=rtpmap:101 telephone-event/8000
a=fmtp:101 0-16
a=ptime:20
a=sendrecv
`

func BenchmarkParseOffer(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if _, err := sdp.ParseOffer(benchOffer); err != nil {
			b.Fatalf("ParseOffer: %v", err)
		}
	}
}

func BenchmarkBuildAnswer(b *testing.B) {
	answer := sdp.Answer{
		SessionID:                 1,
		SessionVersion:            1,
		Address:                   netip.MustParseAddr("203.0.113.9"),
		Port:                      30000,
		Codec:                     sdp.CodecPCMU,
		AudioPayloadType:          0,
		TelephoneEventPayloadType: 101,
		Direction:                 sdp.DirectionSendRecv,
	}

	b.ReportAllocs()
	for b.Loop() {
		if sdp.BuildAnswer(answer) == "" {
			b.Fatal("BuildAnswer produced nothing")
		}
	}
}

func BenchmarkAudioProtocol(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		if _, err := sdp.AudioProtocol(benchOffer); err != nil {
			b.Fatalf("AudioProtocol: %v", err)
		}
	}
}
