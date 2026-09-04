package control_test

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The B-leg pair — create-offer and accept-answer — tested the same way the rest of the surface is:
// the handlers are []byte -> []byte over a faked Sessions, with no broker and no socket anywhere.

// answerBody is what a callee's 200 OK carries: it picks ONE codec from the offer. PCMU with DTMF.
const answerBodyPCMU = "v=0\r\n" +
	"o=- 77 1 IN IP4 198.51.100.7\r\n" +
	"s=-\r\n" +
	"c=IN IP4 198.51.100.7\r\n" +
	"t=0 0\r\n" +
	"m=audio 40000 RTP/AVP 0 101\r\n" +
	"a=rtpmap:0 PCMU/8000\r\n" +
	"a=rtpmap:101 telephone-event/8000\r\n" +
	"a=sendrecv\r\n"

// A callee that prefers A-law answers PCMA, on a non-default telephone-event type.
const answerBodyPCMA = "v=0\r\n" +
	"o=- 77 1 IN IP4 198.51.100.7\r\n" +
	"s=-\r\n" +
	"c=IN IP4 198.51.100.7\r\n" +
	"t=0 0\r\n" +
	"m=audio 40000 RTP/AVP 8 96\r\n" +
	"a=rtpmap:8 PCMA/8000\r\n" +
	"a=rtpmap:96 telephone-event/8000\r\n" +
	"a=sendrecv\r\n"

func decodeCreateOffer(t *testing.T, raw []byte) contract.MediaCreateOfferResponse {
	t.Helper()
	var response contract.MediaCreateOfferResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding a create-offer reply: %v\n%s", err, raw)
	}
	return response
}

func decodeAcceptAnswer(t *testing.T, raw []byte) contract.MediaAcceptAnswerResponse {
	t.Helper()
	var response contract.MediaAcceptAnswerResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding an accept-answer reply: %v\n%s", err, raw)
	}
	return response
}

func validCreateOffer() contract.MediaCreateOfferRequest {
	return contract.MediaCreateOfferRequest{
		SessionID: testSession,
		OrgID:     testOrg,
		CallID:    testCall,
		Direction: contract.MediaCreateOfferRequestDirectionSendrecv,
	}
}

func TestCreateOfferHappyPath(t *testing.T) {
	rig := newRig(t)

	response := decodeCreateOffer(t, rig.server.HandleCreateOffer(mustJSON(t, validCreateOffer())))

	if !response.Ok {
		t.Fatalf("create-offer refused: %+v", response)
	}
	if response.SessionID != testSession {
		t.Errorf("sessionId = %q, want %q", response.SessionID, testSession)
	}
	if response.SDPOffer == nil {
		t.Fatal("create-offer returned no sdpOffer")
	}
	offer := *response.SDPOffer

	// The offer LISTS what mediad serves — PCMU and PCMA — plus a telephone-event rtpmap.
	for _, line := range []string{
		"m=audio ", // the port is the descriptor's, asserted through the field below
		"RTP/AVP 0 8 101",
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:8 PCMA/8000",
		"a=rtpmap:101 telephone-event/8000",
		"a=sendrecv",
	} {
		if !strings.Contains(offer, line) {
			t.Errorf("offer is missing %q\n---\n%s", line, offer)
		}
	}

	// Ports and ssrc come back so the engine can put them in the INVITE.
	if response.RtpPort == nil || *response.RtpPort == 0 {
		t.Error("create-offer returned no rtpPort")
	}
	if response.RtcpPort == nil || *response.RtcpPort != *response.RtpPort+1 {
		t.Errorf("rtcpPort = %v, want rtpPort+1", response.RtcpPort)
	}
	if response.Ssrc == nil || *response.Ssrc == 0 {
		t.Error("create-offer returned no ssrc")
	}
	if response.Address == nil || *response.Address == "" {
		t.Error("create-offer returned no address")
	}
	if response.TelephoneEventPayloadType == nil || *response.TelephoneEventPayloadType != 101 {
		t.Errorf("telephoneEventPayloadType = %v, want 101", response.TelephoneEventPayloadType)
	}
	// The m= line must carry the descriptor's real port.
	if !strings.Contains(offer, "m=audio "+strconv.Itoa(*response.RtpPort)+" RTP/AVP") {
		t.Errorf("offer m= line does not carry the descriptor port %d\n---\n%s", *response.RtpPort, offer)
	}

	// The session was allocated on mediad's DEFAULT codec: the real one is the callee's to pick.
	allocated := rig.sessions.allocateCalls()
	if len(allocated) != 1 {
		t.Fatalf("Allocate called %d times, want 1", len(allocated))
	}
	got := allocated[0]
	if got.AudioPayloadType != rtp.PayloadTypePCMU {
		t.Errorf("allocated audio PT = %d, want PCMU (%d)", got.AudioPayloadType, rtp.PayloadTypePCMU)
	}
	if got.Format != audio.FormatULaw {
		t.Errorf("allocated format = %v, want FormatULaw", got.Format)
	}
	if got.TelephoneEventPayloadType != rtp.PayloadTypeTelephoneEvent {
		t.Errorf("allocated telephone-event PT = %d, want 101", got.TelephoneEventPayloadType)
	}
}

func TestCreateOfferRefusesMissingFields(t *testing.T) {
	cases := map[string]func(*contract.MediaCreateOfferRequest){
		"no sessionId": func(r *contract.MediaCreateOfferRequest) { r.SessionID = "" },
		"no callId":    func(r *contract.MediaCreateOfferRequest) { r.CallID = "" },
		"no orgId":     func(r *contract.MediaCreateOfferRequest) { r.OrgID = "" },
	}
	for name, break_ := range cases {
		t.Run(name, func(t *testing.T) {
			rig := newRig(t)
			request := validCreateOffer()
			break_(&request)

			response := decodeCreateOffer(t, rig.server.HandleCreateOffer(mustJSON(t, request)))
			if response.Ok {
				t.Fatalf("create-offer accepted a request with %s", name)
			}
			if response.Reason == nil || *response.Reason != contract.MediaCreateOfferResponseReasonBadRequest {
				t.Errorf("reason = %v, want bad_request", response.Reason)
			}
			if len(rig.sessions.allocateCalls()) != 0 {
				t.Error("a refused create-offer still bound a port")
			}
		})
	}
}

func TestCreateOfferRefusesMalformedJSON(t *testing.T) {
	rig := newRig(t)
	response := decodeCreateOffer(t, rig.server.HandleCreateOffer([]byte("{not json")))
	if response.Ok || response.Reason == nil ||
		*response.Reason != contract.MediaCreateOfferResponseReasonBadRequest {
		t.Errorf("malformed create-offer = %+v, want bad_request", response)
	}
}

// The whole B-leg flow: create-offer brings the session live, then accept-answer settles a codec
// onto it. PCMU and PCMA both settle, and the settled value comes back in the reply.
func TestAcceptAnswerHappyPath(t *testing.T) {
	cases := []struct {
		name         string
		answer       string
		wantCodec    contract.MediaAcceptAnswerResponseCodec
		wantFormat   audio.Format
		wantAudioPT  uint8
		wantTeleType int
	}{
		{"PCMU", answerBodyPCMU, contract.MediaAcceptAnswerResponseCodecPcmu, audio.FormatULaw, rtp.PayloadTypePCMU, 101},
		{"PCMA", answerBodyPCMA, contract.MediaAcceptAnswerResponseCodecPcma, audio.FormatALaw, rtp.PayloadTypePCMA, 96},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rig := newRig(t)
			// create-offer first: it is what makes the session live for the settle below.
			if r := decodeCreateOffer(t, rig.server.HandleCreateOffer(mustJSON(t, validCreateOffer()))); !r.Ok {
				t.Fatalf("create-offer refused: %+v", r)
			}

			request := contract.MediaAcceptAnswerRequest{SessionID: testSession, SDPAnswer: tc.answer}
			response := decodeAcceptAnswer(t, rig.server.HandleAcceptAnswer(mustJSON(t, request)))

			if !response.Ok {
				t.Fatalf("accept-answer refused: %+v", response)
			}
			if response.Codec == nil || *response.Codec != tc.wantCodec {
				t.Errorf("codec = %v, want %q", response.Codec, tc.wantCodec)
			}
			if response.TelephoneEventPayloadType == nil || *response.TelephoneEventPayloadType != tc.wantTeleType {
				t.Errorf("telephoneEventPayloadType = %v, want %d", response.TelephoneEventPayloadType, tc.wantTeleType)
			}

			// The settle actually reached the packet path with the negotiated codec, not the default.
			settles := rig.sessions.settleCalls()
			if len(settles) != 1 {
				t.Fatalf("SettleAnswer called %d times, want 1", len(settles))
			}
			if settles[0].format != tc.wantFormat {
				t.Errorf("settled format = %v, want %v", settles[0].format, tc.wantFormat)
			}
			if settles[0].audioPT != tc.wantAudioPT {
				t.Errorf("settled audio PT = %d, want %d", settles[0].audioPT, tc.wantAudioPT)
			}
		})
	}
}

// A callee answering a codec create-offer never proposed is refused not_supported, whether the
// parser recognises the codec (G.722) or not (G.729). Either way the engine hangs the B-leg up.
func TestAcceptAnswerRefusesUnsupportedCodec(t *testing.T) {
	unsupported := map[string]string{
		"G722 which the parser carries but create-offer never offered": "v=0\r\n" +
			"o=- 77 1 IN IP4 198.51.100.7\r\ns=-\r\nc=IN IP4 198.51.100.7\r\nt=0 0\r\n" +
			"m=audio 40000 RTP/AVP 9\r\na=rtpmap:9 G722/8000\r\n",
		"G729 which mediad cannot carry at all": "v=0\r\n" +
			"o=- 77 1 IN IP4 198.51.100.7\r\ns=-\r\nc=IN IP4 198.51.100.7\r\nt=0 0\r\n" +
			"m=audio 40000 RTP/AVP 18\r\na=rtpmap:18 G729/8000\r\n",
	}
	for name, answer := range unsupported {
		t.Run(name, func(t *testing.T) {
			rig := newRig(t)
			if r := decodeCreateOffer(t, rig.server.HandleCreateOffer(mustJSON(t, validCreateOffer()))); !r.Ok {
				t.Fatalf("create-offer refused: %+v", r)
			}

			request := contract.MediaAcceptAnswerRequest{SessionID: testSession, SDPAnswer: answer}
			response := decodeAcceptAnswer(t, rig.server.HandleAcceptAnswer(mustJSON(t, request)))

			if response.Ok {
				t.Fatalf("accept-answer accepted an unsupported codec: %+v", response)
			}
			if response.Reason == nil || *response.Reason != contract.MediaAcceptAnswerResponseReasonNotSupported {
				t.Errorf("reason = %v, want not_supported", response.Reason)
			}
			// A refused answer must not have settled anything onto the live session.
			if len(rig.sessions.settleCalls()) != 0 {
				t.Error("a refused accept-answer still settled a codec")
			}
		})
	}
}

// An answer for a session this instance does not hold is unknown_session: the settle refuses, and
// the directory has no entry pointing elsewhere, so the refusal is unknown rather than wrong_instance.
func TestAcceptAnswerRefusesUnknownSession(t *testing.T) {
	rig := newRig(t)
	// No create-offer, so the session is not live.
	request := contract.MediaAcceptAnswerRequest{SessionID: testSession, SDPAnswer: answerBodyPCMU}
	response := decodeAcceptAnswer(t, rig.server.HandleAcceptAnswer(mustJSON(t, request)))

	if response.Ok {
		t.Fatalf("accept-answer accepted an answer for an unknown session: %+v", response)
	}
	if response.Reason == nil || *response.Reason != contract.MediaAcceptAnswerResponseReasonUnknownSession {
		t.Errorf("reason = %v, want unknown_session", response.Reason)
	}
}

func TestAcceptAnswerRefusesMissingFields(t *testing.T) {
	rig := newRig(t)
	cases := map[string]contract.MediaAcceptAnswerRequest{
		"no sessionId": {SessionID: "", SDPAnswer: answerBodyPCMU},
		"no sdpAnswer": {SessionID: testSession, SDPAnswer: ""},
	}
	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			response := decodeAcceptAnswer(t, rig.server.HandleAcceptAnswer(mustJSON(t, request)))
			if response.Ok {
				t.Fatalf("accept-answer accepted a request with %s", name)
			}
			if response.Reason == nil || *response.Reason != contract.MediaAcceptAnswerResponseReasonBadRequest {
				t.Errorf("reason = %v, want bad_request", response.Reason)
			}
		})
	}
}
