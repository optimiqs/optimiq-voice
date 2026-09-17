package control_test

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/netip"
	"regexp"
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

// savpAnswer is the callee's 200 OK to a create-offer that carried SDES: one codec, under SAVP,
// with the key material that settles the pending generation.
func savpAnswer() string {
	material := make([]byte, sdp.SRTPKeyMaterial)
	for i := range material {
		material[i] = byte(i + 11)
	}
	return strings.Join([]string{
		"v=0",
		"o=- 77 1 IN IP4 198.51.100.7",
		"s=-",
		"c=IN IP4 198.51.100.7",
		"t=0 0",
		"m=audio 40000 RTP/SAVP 0 101",
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:101 telephone-event/8000",
		"a=crypto:1 " + sdp.SRTPSuite + " inline:" + base64.StdEncoding.EncodeToString(material),
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

// mediaEncryption reads the per-leg encryption state off a reply. It is decoded separately because
// it is additive to the generated contract structs the other helpers unmarshal into.
func mediaEncryption(t *testing.T, payload []byte) string {
	t.Helper()
	var reply struct {
		MediaEncryption string `json:"mediaEncryption"`
	}
	if err := json.Unmarshal(payload, &reply); err != nil {
		t.Fatalf("cannot read the reply: %v", err)
	}
	return reply.MediaEncryption
}

// withLegPolicy renders a command as JSON carrying the per-leg override the contract struct has no
// field for, which is how the engine will send it.
func withLegPolicy(t *testing.T, request any, policy config.SRTPPolicy) []byte {
	t.Helper()
	var fields map[string]any
	if err := json.Unmarshal(mustJSON(t, request), &fields); err != nil {
		t.Fatalf("cannot re-render the request: %v", err)
	}
	fields["srtpPolicy"] = string(policy)
	payload, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("cannot render the request: %v", err)
	}
	return payload
}

// A leg the engine marks `require` is not covered by the deployment's laxer default.
func TestAllocateUnderALegRequirePolicyRefusesAPlainOffer(t *testing.T) {
	r := newPolicyRig(t, config.SRTPPrefer)

	response := decodeAllocate(t, r.server.HandleAllocateSession(withLegPolicy(t, validAllocate(), config.SRTPRequire)))
	if response.Ok {
		t.Fatal("a leg pinned to require accepted a plain RTP/AVP offer")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
		t.Fatalf("reason = %v, want %q", response.Reason, control.ReasonNotSupported)
	}
	if len(r.sessions.allocateCalls()) != 0 {
		t.Error("a refused offer bound a port pair")
	}
}

// And the other way: a leg the engine marks `disable` answers plain RTP on a `require` deployment.
func TestAllocateUnderALegDisablePolicyAnswersPlainRTP(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)

	payload := withLegPolicy(t, validAllocate(), config.SRTPDisable)
	response := decodeAllocate(t, r.server.HandleAllocateSession(payload))
	if !response.Ok {
		t.Fatalf("a leg pinned to disable was refused: %+v", response)
	}
	if strings.Contains(*response.SDPAnswer, "crypto") || strings.Contains(*response.SDPAnswer, "SAVP") {
		t.Fatalf("a disabled leg was answered with SDES:\n%s", *response.SDPAnswer)
	}
}

func TestCreateOfferUnderALegDisablePolicyOffersPlainRTP(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)

	response := decodeCreateOffer(t, r.server.HandleCreateOffer(withLegPolicy(t, validCreateOffer(), config.SRTPDisable)))
	if !response.Ok {
		t.Fatalf("create-offer refused: %+v", response)
	}
	if strings.Contains(*response.SDPOffer, "a=crypto:") || strings.Contains(*response.SDPOffer, " RTP/SAVP ") {
		t.Fatalf("a disabled leg was offered SDES:\n%s", *response.SDPOffer)
	}
}

// withoutKeyMaterial blanks the one part of a reply that is fresh per exchange, so two replies can
// be compared byte for byte.
var withoutKeyMaterial = regexp.MustCompile(`inline:[A-Za-z0-9+/=]+`)

// The regression guard for the additive contract: a command with no `srtpPolicy` must produce the
// reply it produced before the field existed, which is the server-wide policy's, down to the bytes.
func TestAnAbsentLegPolicyAnswersExactlyAsTheServerPolicyDoes(t *testing.T) {
	for _, policy := range []config.SRTPPolicy{config.SRTPPrefer, config.SRTPRequire, config.SRTPDisable} {
		for name, offer := range map[string]string{"savp": savpOffer(), "avp": validAllocate().SDPOffer} {
			t.Run(string(policy)+"/"+name, func(t *testing.T) {
				baseline := newPolicyRig(t, policy).server.HandleAllocateSession(mustJSON(t, allocateWith(offer)))
				pinned := newPolicyRig(t, policy).server.HandleAllocateSession(withLegPolicy(t, allocateWith(offer), policy))
				want := withoutKeyMaterial.ReplaceAllString(string(baseline), "inline:")
				got := withoutKeyMaterial.ReplaceAllString(string(pinned), "inline:")
				if got != want {
					t.Fatalf("naming the server's own policy per leg changed the reply:\n%s\n%s", want, got)
				}
			})
		}
	}
}

func TestTheReplyReportsWhetherTheLegIsEncrypted(t *testing.T) {
	r := newPolicyRig(t, config.SRTPPrefer)

	secure := r.server.HandleAllocateSession(mustJSON(t, allocateWith(savpOffer())))
	if got := mediaEncryption(t, secure); got != string(control.MediaEncrypted) {
		t.Fatalf("mediaEncryption = %q, want %q", got, control.MediaEncrypted)
	}
	plain := r.server.HandleAllocateSession(mustJSON(t, validAllocate()))
	if got := mediaEncryption(t, plain); got != string(control.MediaPlaintext) {
		t.Fatalf("mediaEncryption = %q, want %q", got, control.MediaPlaintext)
	}
}

// A B-leg is plaintext between create-offer and accept-answer: the local key is advertised but the
// callee's has not arrived, so nothing is protecting the socket yet.
func TestACreatedOfferIsPlaintextUntilItsAnswerSettles(t *testing.T) {
	r := newPolicyRig(t, config.SRTPRequire)

	offered := r.server.HandleCreateOffer(mustJSON(t, validCreateOffer()))
	if got := mediaEncryption(t, offered); got != string(control.MediaPlaintext) {
		t.Fatalf("an unsettled B-leg reported %q, want %q", got, control.MediaPlaintext)
	}
	offer := decodeCreateOffer(t, offered)
	if !offer.Ok {
		t.Fatalf("create-offer refused: %+v", offer)
	}

	settled := r.server.HandleAcceptAnswer(mustJSON(t, contract.MediaAcceptAnswerRequest{
		SessionID: testSession, SDPAnswer: savpAnswer(),
	}))
	if got := mediaEncryption(t, settled); got != string(control.MediaEncrypted) {
		t.Fatalf("a settled SDES B-leg reported %q, want %q", got, control.MediaEncrypted)
	}
}
