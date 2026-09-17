package sdp_test

import (
	"encoding/base64"
	"errors"
	"net/netip"
	"strings"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// key30 is 30 bytes of key material in the base64 form an inline parameter carries.
func key30(fill byte) string {
	material := make([]byte, sdp.SRTPKeyMaterial)
	for i := range material {
		material[i] = fill + byte(i)
	}
	return base64.StdEncoding.EncodeToString(material)
}

func TestParseOfferCrypto(t *testing.T) {
	cases := []struct {
		name    string
		body    string
		wantTag int
		wantSet bool
		wantErr error
	}{
		{
			name: "reads the supported suite under SAVP",
			body: offer("m=audio 41000 RTP/SAVP 0 101",
				"a=rtpmap:0 PCMU/8000",
				"a=rtpmap:101 telephone-event/8000",
				"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:"+key30(1)),
			wantTag: 1,
			wantSet: true,
		},
		{
			// RFC 4568 §9.1 allows a lifetime and MKI after the key; neither is honoured, but
			// neither may make the line unreadable.
			name: "tolerates a lifetime and MKI suffix",
			body: offer("m=audio 41000 RTP/SAVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=crypto:7 AES_CM_128_HMAC_SHA1_80 inline:"+key30(2)+"|2^20|1:4"),
			wantTag: 7,
			wantSet: true,
		},
		{
			name: "skips unsupported suites and takes the one it can serve",
			body: offer("m=audio 41000 RTP/SAVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=crypto:1 AES_CM_128_HMAC_SHA1_32 inline:"+key30(3),
				"a=crypto:2 AES_CM_128_HMAC_SHA1_80 inline:"+key30(4)),
			wantTag: 2,
			wantSet: true,
		},
		{
			name: "an offer of only unsupported suites carries no usable crypto",
			body: offer("m=audio 41000 RTP/SAVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=crypto:1 AEAD_AES_128_GCM inline:"+key30(5)),
		},
		{
			name: "short key material is refused rather than accepted",
			body: offer("m=audio 41000 RTP/SAVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:"+
					base64.StdEncoding.EncodeToString([]byte("too short"))),
			wantErr: sdp.ErrBadCryptoKey,
		},
		{
			name: "key material that is not base64 is refused",
			body: offer("m=audio 41000 RTP/SAVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:not!base64"),
			wantErr: sdp.ErrBadCryptoKey,
		},
		{
			// A crypto line keys nothing on a plain transport, so it must not make the offer fail.
			name: "a crypto line under RTP/AVP is ignored, even a malformed one",
			body: offer("m=audio 41000 RTP/AVP 0",
				"a=rtpmap:0 PCMU/8000",
				"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:nonsense"),
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parsed, err := sdp.ParseOffer(tc.body)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("ParseOffer error = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseOffer: %v", err)
			}
			if parsed.Crypto.IsSet() != tc.wantSet {
				t.Fatalf("Crypto.IsSet() = %v, want %v", parsed.Crypto.IsSet(), tc.wantSet)
			}
			if tc.wantSet && parsed.Crypto.Tag != tc.wantTag {
				t.Fatalf("Crypto.Tag = %d, want %d", parsed.Crypto.Tag, tc.wantTag)
			}
			if tc.wantSet && len(parsed.Crypto.MasterKey()) != sdp.SRTPKeyLen {
				t.Fatalf("MasterKey length = %d, want %d", len(parsed.Crypto.MasterKey()), sdp.SRTPKeyLen)
			}
		})
	}
}

func TestBuildAnswerSDES(t *testing.T) {
	local, err := sdp.GenerateKeyMaterial()
	if err != nil {
		t.Fatalf("GenerateKeyMaterial: %v", err)
	}
	// The tag of the offered line the answer selected (RFC 4568 §5.1.2).
	local.Tag = 4

	body := sdp.BuildAnswer(sdp.Answer{
		Address:          netip.MustParseAddr("203.0.113.10"),
		Port:             30000,
		Codec:            sdp.CodecPCMU,
		AudioPayloadType: 0,
		Direction:        sdp.DirectionSendRecv,
		Crypto:           local,
	})

	if !strings.Contains(body, "m=audio 30000 RTP/SAVP 0\r\n") {
		t.Fatalf("answer does not commit to SAVP:\n%s", body)
	}
	want := "a=crypto:4 AES_CM_128_HMAC_SHA1_80 inline:" + local.Inline() + "\r\n"
	if !strings.Contains(body, want) {
		t.Fatalf("answer is missing %q:\n%s", want, body)
	}
	if count := strings.Count(body, "a=crypto:"); count != 1 {
		t.Fatalf("answer carries %d crypto lines, want exactly 1:\n%s", count, body)
	}
}

// A zero Crypto must render the body an unencrypted leg has always been answered with.
func TestBuildAnswerWithoutSDESIsUnchanged(t *testing.T) {
	answer := sdp.Answer{
		Address:                   netip.MustParseAddr("203.0.113.10"),
		Port:                      30000,
		Codec:                     sdp.CodecPCMA,
		AudioPayloadType:          8,
		TelephoneEventPayloadType: 101,
		Direction:                 sdp.DirectionSendRecv,
	}
	body := sdp.BuildAnswer(answer)
	if strings.Contains(body, "a=crypto") || strings.Contains(body, "SAVP") {
		t.Fatalf("a plain answer must carry neither SAVP nor a crypto line:\n%s", body)
	}
	if !strings.Contains(body, "m=audio 30000 RTP/AVP 8 101\r\n") {
		t.Fatalf("plain answer m= line changed:\n%s", body)
	}
}

func TestBuildOfferSDES(t *testing.T) {
	local, err := sdp.GenerateKeyMaterial()
	if err != nil {
		t.Fatalf("GenerateKeyMaterial: %v", err)
	}
	body := sdp.BuildOffer(sdp.OfferParams{
		Address:                   netip.MustParseAddr("203.0.113.10"),
		Port:                      30002,
		Codecs:                    []sdp.Codec{sdp.CodecPCMU, sdp.CodecPCMA},
		TelephoneEventPayloadType: 101,
		Crypto:                    local,
	})
	if !strings.Contains(body, "m=audio 30002 RTP/SAVP 0 8 101\r\n") {
		t.Fatalf("offer does not commit to SAVP:\n%s", body)
	}
	if count := strings.Count(body, "a=crypto:"); count != 1 {
		t.Fatalf("offer carries %d crypto lines, want exactly 1:\n%s", count, body)
	}

	// The offer must parse back into the key it advertised, since that is exactly what the callee does.
	parsed, err := sdp.ParseOffer(body)
	if err != nil {
		t.Fatalf("ParseOffer of our own offer: %v", err)
	}
	if !parsed.Crypto.IsSet() || string(parsed.Crypto.KeyMaterial) != string(local.KeyMaterial) {
		t.Fatalf("round trip lost the key material")
	}
}

func TestBuildOfferWithoutSDESIsUnchanged(t *testing.T) {
	body := sdp.BuildOffer(sdp.OfferParams{
		Address:                   netip.MustParseAddr("203.0.113.10"),
		Port:                      30002,
		Codecs:                    []sdp.Codec{sdp.CodecPCMU},
		TelephoneEventPayloadType: 101,
	})
	if strings.Contains(body, "a=crypto") || strings.Contains(body, "SAVP") {
		t.Fatalf("a plain offer must carry neither SAVP nor a crypto line:\n%s", body)
	}
	if !strings.Contains(body, "m=audio 30002 RTP/AVP 0 101\r\n") {
		t.Fatalf("plain offer m= line changed:\n%s", body)
	}
}
