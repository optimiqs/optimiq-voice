package control_test

import (
	"encoding/base64"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/config"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
)

// newPolicyRig is newRigWith under an explicit SDES policy.
func newPolicyRig(t *testing.T, policy config.SRTPPolicy) *rig {
	t.Helper()
	sessions := newStub()
	dir := directory.NewFakeStore()
	server, err := control.NewServer(control.ServerOptions{
		Sessions:      sessions,
		Directory:     dir,
		Library:       audio.NewLibrary(t.TempDir()),
		RecordingsDir: t.TempDir(),
		InstanceID:    thisNode,
		PublicAddr:    netip.MustParseAddr("203.0.113.10"),
		SRTPPolicy:    policy,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return &rig{server: server, sessions: sessions, dir: dir}
}

// savpOffer is a desk phone's SDES offer.
func savpOffer() string {
	material := make([]byte, sdp.SRTPKeyMaterial)
	for i := range material {
		material[i] = byte(i + 3)
	}
	return strings.Join([]string{
		"v=0",
		"o=- 12345 1 IN IP4 203.0.113.9",
		"s=-",
		"c=IN IP4 203.0.113.9",
		"t=0 0",
		"m=audio 41000 RTP/SAVP 0 101",
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:101 telephone-event/8000",
		"a=crypto:3 AES_CM_128_HMAC_SHA1_80 inline:" + base64.StdEncoding.EncodeToString(material),
		"a=sendrecv",
		"",
	}, "\r\n")
}

func allocateWith(body string) contract.MediaAllocateSessionRequest {
	request := validAllocate()
	request.SDPOffer = body
	return request
}

func TestAllocateUnderPreferAnswersSDESForASecureOffer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPPrefer)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, allocateWith(savpOffer()))))
	if !response.Ok {
		t.Fatalf("allocate refused a SAVP offer: %+v", response)
	}
	answer := *response.SDPAnswer
	if !strings.Contains(answer, " RTP/SAVP ") {
		t.Fatalf("the answer did not commit to SAVP:\n%s", answer)
	}
	// The tag of the offered line the answer selected (RFC 4568 §5.1.2).
	if !strings.Contains(answer, "a=crypto:3 "+sdp.SRTPSuite+" inline:") {
		t.Fatalf("the answer did not echo the offered crypto tag:\n%s", answer)
	}
	parsed, err := sdp.ParseOffer(answer)
	if err != nil {
		t.Fatalf("our own answer does not parse: %v", err)
	}
	if !parsed.Crypto.IsSet() {
		t.Fatal("the answer's key material is not usable")
	}
}

// prefer is the "allow RTP for UDP/TCP phones" default, so a plain offer must be answered plainly.
func TestAllocateUnderPreferFallsBackToPlainRTP(t *testing.T) {
	r := newPolicyRig(t, config.SRTPPrefer)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, validAllocate())))
	if !response.Ok {
		t.Fatalf("allocate refused a plain offer: %+v", response)
	}
	if strings.Contains(*response.SDPAnswer, "crypto") || strings.Contains(*response.SDPAnswer, "SAVP") {
		t.Fatalf("a plain offer was answered with SDES:\n%s", *response.SDPAnswer)
	}
}

func TestAllocateUnderRequireRefusesAnUnencryptedOffer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, validAllocate())))
	if response.Ok {
		t.Fatal("require accepted a plain RTP/AVP offer")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
		t.Fatalf("reason = %v, want %q", response.Reason, control.ReasonNotSupported)
	}
	if len(r.sessions.allocateCalls()) != 0 {
		t.Error("a refused offer bound a port pair")
	}
}

func TestAllocateUnderRequireAcceptsASecureOffer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, allocateWith(savpOffer()))))
	if !response.Ok {
		t.Fatalf("require refused a SAVP offer: %+v", response)
	}
	if !strings.Contains(*response.SDPAnswer, " RTP/SAVP ") {
		t.Fatalf("the answer did not commit to SAVP:\n%s", *response.SDPAnswer)
	}
}

func TestAllocateUnderDisableRefusesASecureOffer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPDisable)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, allocateWith(savpOffer()))))
	if response.Ok {
		t.Fatal("disable answered a SAVP offer")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
		t.Fatalf("reason = %v, want %q", response.Reason, control.ReasonNotSupported)
	}
}

// Only `require` originates an SDES offer: an offer names one transport, so offering SAVP would
// foreclose the plain-RTP fallback `prefer` exists to keep.
func TestCreateOfferKeysOnlyUnderRequire(t *testing.T) {
	for _, tc := range []struct {
		policy   config.SRTPPolicy
		wantSDES bool
	}{
		{config.SRTPPrefer, false},
		{config.SRTPDisable, false},
		{config.SRTPRequire, true},
	} {
		t.Run(string(tc.policy), func(t *testing.T) {
			r := newPolicyRig(t, tc.policy)
			response := decodeCreateOffer(t, r.server.HandleCreateOffer(mustJSON(t, validCreateOffer())))
			if !response.Ok {
				t.Fatalf("create-offer refused: %+v", response)
			}
			body := *response.SDPOffer
			if got := strings.Contains(body, "a=crypto:"); got != tc.wantSDES {
				t.Fatalf("offer carries SDES = %v, want %v:\n%s", got, tc.wantSDES, body)
			}
			if got := strings.Contains(body, " RTP/SAVP "); got != tc.wantSDES {
				t.Fatalf("offer commits to SAVP = %v, want %v:\n%s", got, tc.wantSDES, body)
			}
		})
	}
}
