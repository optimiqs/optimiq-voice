package command

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/dialog"
)

// stubDialogs is the whole of what these handlers need. Every method answers from a script and
// records what it was asked, which is what lets the refusal vocabulary be asserted as a table with
// no broker, no socket and no dialog machine anywhere.
type stubDialogs struct {
	ringErr      error
	answerErr    error
	answerAt     time.Time
	hangupMethod contract.SipHangupResponseMethod
	hangupErr    error
	originateErr error
	requestURI   string
	sipCallID    string

	ringStatus  int
	ringAnswer  string
	answerBody  string
	hangupCause int
	originated  contract.SipOriginateRequest
}

func (s *stubDialogs) Ring(_ context.Context, _ string, status int, sdpAnswer string) error {
	s.ringStatus, s.ringAnswer = status, sdpAnswer
	return s.ringErr
}

func (s *stubDialogs) Answer(_ context.Context, _ string, sdpAnswer string) (time.Time, error) {
	s.answerBody = sdpAnswer
	return s.answerAt, s.answerErr
}

func (s *stubDialogs) Hangup(_ context.Context, _ string, cause int, _ string) (contract.SipHangupResponseMethod, error) {
	s.hangupCause = cause
	return s.hangupMethod, s.hangupErr
}

func (s *stubDialogs) Originate(_ context.Context, request contract.SipOriginateRequest) (string, string, error) {
	s.originated = request
	return s.requestURI, s.sipCallID, s.originateErr
}

func newTestServer(t *testing.T, dialogs Dialogs) *Server {
	t.Helper()
	server, err := NewServer(Options{Dialogs: dialogs, InstanceID: "sipd-test"})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return server
}

func decode[T any](t *testing.T, payload []byte) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(payload, &value); err != nil {
		t.Fatalf("cannot decode reply %s: %v", payload, err)
	}
	return value
}

// A refusal is always a REPLY and never a silence. Every handler is driven with bytes that cannot
// possibly be a valid request, and every one of them must still answer — because a responder that
// stays quiet is indistinguishable from a crashed one and the caller pays the whole timeout to
// learn nothing.
func TestEveryHandlerAnswersMalformedBytes(t *testing.T) {
	server := newTestServer(t, &stubDialogs{})
	garbage := []byte("{not json")

	for name, handle := range map[string]func([]byte) []byte{
		"ring":      server.HandleRing,
		"answer":    server.HandleAnswer,
		"hangup":    server.HandleHangup,
		"reinvite":  server.HandleReinvite,
		"originate": server.HandleOriginate,
	} {
		t.Run(name, func(t *testing.T) {
			reply := decode[struct {
				Ok     bool    `json:"ok"`
				Reason string  `json:"reason"`
				Error  *string `json:"error"`
			}](t, handle(garbage))

			if reply.Ok {
				t.Fatalf("a malformed %s was accepted", name)
			}
			if reply.Reason != ReasonBadRequest {
				t.Fatalf("reason = %q, want %q", reply.Reason, ReasonBadRequest)
			}
			if reply.Error == nil || !strings.Contains(*reply.Error, "malformed "+name+" request") {
				t.Fatalf("error = %v, want it to name the malformed %s request", reply.Error, name)
			}
		})
	}
}

// The instance id is on every reply, refusal included, because the caller's next move on a
// `wrong_instance` is to work out who DID answer.
func TestEveryReplyCarriesTheInstanceID(t *testing.T) {
	server := newTestServer(t, &stubDialogs{hangupMethod: contract.SipHangupResponseMethodBye})

	replies := [][]byte{
		server.HandleRing(mustJSON(t, contract.SipRingRequest{LegID: "leg-1"})),
		server.HandleAnswer(mustJSON(t, contract.SipAnswerRequest{LegID: "leg-1", SDPAnswer: "v=0"})),
		server.HandleHangup(mustJSON(t, contract.SipHangupRequest{LegID: "leg-1"})),
		server.HandleReinvite(mustJSON(t, contract.SipReinviteRequest{LegID: "leg-1", SDPOffer: "v=0"})),
		server.HandleOriginate([]byte(`{}`)),
	}
	for index, payload := range replies {
		reply := decode[struct {
			InstanceID *string `json:"instanceId"`
		}](t, payload)
		if reply.InstanceID == nil || *reply.InstanceID != "sipd-test" {
			t.Fatalf("reply %d carried instanceId %v, want sipd-test", index, reply.InstanceID)
		}
	}
}

// The dialog layer's errors must reach the wire as the contract's reasons, THROUGH a wrap. The wrap
// is what puts the leg id in the operator's log line, and a mapping that used a type switch instead
// of errors.Is would collapse every wrapped refusal to `internal` — which tells the engine to give
// up on a call it should have retried elsewhere.
func TestWrappedDialogErrorsMapOntoTheRefusalVocabulary(t *testing.T) {
	for _, row := range []struct {
		err  error
		want string
	}{
		{dialog.ErrUnknownDialog, ReasonUnknownDialog},
		{dialog.ErrDialogGone, ReasonDialogGone},
		{dialog.ErrCancelTooLate, ReasonDialogGone},
		{dialog.ErrInvalidState, ReasonInvalidState},
		{dialog.ErrWrongRole, ReasonInvalidState},
		{dialog.ErrDuplicateLeg, ReasonInvalidState},
		{dialog.ErrSessionClosed, ReasonShuttingDown},
		{dialog.ErrUnregisteredTarget, ReasonUnregisteredTarget},
		{dialog.ErrUnknownTrunk, ReasonUnknownTrunk},
		{dialog.ErrNoRoute, ReasonNoRoute},
		{dialog.ErrCapacity, ReasonCapacity},
		{dialog.ErrNotSupported, ReasonNotSupported},
		{errors.New("something nobody classified"), ReasonInternal},
	} {
		t.Run(row.want+"/"+row.err.Error(), func(t *testing.T) {
			wrapped := errors.Join(errors.New("invite: answer for leg leg-1"), row.err)
			reason, detail := refusalFor(wrapped)
			if reason != row.want {
				t.Fatalf("refusalFor(%v) = %q, want %q", row.err, reason, row.want)
			}
			if !strings.Contains(detail, "leg-1") {
				t.Fatalf("detail %q lost the wrap; an operator needs the leg id", detail)
			}
		})
	}
}

// `answer` replies when the 2xx is on the socket, and the reply carries WHEN. That instant is the
// anchor for a post-dial-delay plot, and a reply that omitted it would make the whole measurement
// impossible from outside this process.
func TestAnswerReportsWhenTheResponseWentOut(t *testing.T) {
	sent := time.Date(2026, 8, 12, 10, 30, 0, 0, time.UTC)
	server := newTestServer(t, &stubDialogs{answerAt: sent})

	reply := decode[contract.SipAnswerResponse](t,
		server.HandleAnswer(mustJSON(t, contract.SipAnswerRequest{LegID: "leg-1", SDPAnswer: "v=0\r\n"})))

	if !reply.Ok {
		t.Fatalf("answer refused: %+v", reply)
	}
	if reply.SentAt == nil || !reply.SentAt.Time.Equal(sent) {
		t.Fatalf("sentAt = %v, want %v", reply.SentAt, sent)
	}
}

// A 200 OK answering an offer with no body is a call that connects to silence — invisible to
// everything except the two people on it. It is refused before it reaches the dialog layer.
func TestAnswerRefusesAnEmptyBody(t *testing.T) {
	dialogs := &stubDialogs{}
	server := newTestServer(t, dialogs)

	reply := decode[contract.SipAnswerResponse](t,
		server.HandleAnswer(mustJSON(t, contract.SipAnswerRequest{LegID: "leg-1"})))

	if reply.Ok {
		t.Fatal("an answer with no SDP was accepted")
	}
	if reply.Reason == nil || string(*reply.Reason) != ReasonBadRequest {
		t.Fatalf("reason = %v, want %q", reply.Reason, ReasonBadRequest)
	}
	if dialogs.answerBody != "" {
		t.Fatal("the dialog layer was asked to answer with no body")
	}
}

// Early media is refused by NAME. A 183 carrying an answer commits the offer/answer exchange and
// the 200 must then repeat it byte for byte (RFC 3261 §13.2.1); a half-built path is a call that
// connects with no audio.
func TestRingRefusesEarlyMediaAndSaysWhy(t *testing.T) {
	answer := "v=0\r\n"
	server := newTestServer(t, &stubDialogs{})

	reply := decode[contract.SipRingResponse](t,
		server.HandleRing(mustJSON(t, contract.SipRingRequest{LegID: "leg-1", Status: 183, SDPAnswer: &answer})))

	if reply.Ok {
		t.Fatal("early media was accepted")
	}
	if reply.Reason == nil || string(*reply.Reason) != ReasonNotSupported {
		t.Fatalf("reason = %v, want %q", reply.Reason, ReasonNotSupported)
	}
	if reply.Error == nil || !strings.Contains(*reply.Error, "13.2.1") {
		t.Fatalf("error = %v, want it to cite the RFC that decides it", reply.Error)
	}
}

// A zero status is an OMITTED field, not an invalid one: the contract defaults it to 180 and Go
// cannot tell the two apart. Reading it as invalid would refuse every well-formed ring.
func TestRingDefaultsAnOmittedStatusTo180(t *testing.T) {
	dialogs := &stubDialogs{}
	server := newTestServer(t, dialogs)

	reply := decode[contract.SipRingResponse](t,
		server.HandleRing(mustJSON(t, contract.SipRingRequest{LegID: "leg-1"})))

	if !reply.Ok {
		t.Fatalf("ring refused: %+v", reply)
	}
	if dialogs.ringStatus != 180 {
		t.Fatalf("status = %d, want 180", dialogs.ringStatus)
	}
}

// `reinvite` refuses `not_supported` and names sipgo and the missing piece, because the operator
// reading that log line needs to know whether to wait for a release or to file a bug. A MALFORMED
// one is still `bad_request` — the two are different instructions to the caller.
func TestReinviteRefusesNotSupportedButStillValidatesFirst(t *testing.T) {
	server := newTestServer(t, &stubDialogs{})

	wellFormed := decode[contract.SipReinviteResponse](t,
		server.HandleReinvite(mustJSON(t, contract.SipReinviteRequest{
			LegID: "leg-1", SDPOffer: "v=0\r\n", Intent: contract.SipReinviteRequestIntentHold,
		})))
	if wellFormed.Ok {
		t.Fatal("a reinvite was accepted; this build has no re-INVITE")
	}
	if wellFormed.Reason == nil || string(*wellFormed.Reason) != ReasonNotSupported {
		t.Fatalf("reason = %v, want %q", wellFormed.Reason, ReasonNotSupported)
	}
	if wellFormed.Error == nil || !strings.Contains(*wellFormed.Error, "sipgo") {
		t.Fatalf("error = %v, want it to name sipgo", wellFormed.Error)
	}

	missingOffer := decode[contract.SipReinviteResponse](t,
		server.HandleReinvite(mustJSON(t, contract.SipReinviteRequest{LegID: "leg-1"})))
	if missingOffer.Reason == nil || string(*missingOffer.Reason) != ReasonBadRequest {
		t.Fatalf("a reinvite with no offer got %v, want %q", missingOffer.Reason, ReasonBadRequest)
	}
}

// The method the edge chose is REPORTED, and `deferred` is the one that matters: it is the outcome
// where the hangup succeeded, no packet left, and a later `dialog.terminated` is still owed.
func TestHangupReportsTheMethodIncludingDeferred(t *testing.T) {
	for _, method := range []contract.SipHangupResponseMethod{
		contract.SipHangupResponseMethodBye,
		contract.SipHangupResponseMethodCancel,
		contract.SipHangupResponseMethodRespond,
		contract.SipHangupResponseMethodDeferred,
		contract.SipHangupResponseMethodNone,
	} {
		t.Run(string(method), func(t *testing.T) {
			server := newTestServer(t, &stubDialogs{hangupMethod: method})
			reply := decode[contract.SipHangupResponse](t,
				server.HandleHangup(mustJSON(t, contract.SipHangupRequest{LegID: "leg-1"})))

			if !reply.Ok {
				t.Fatalf("hangup refused: %+v", reply)
			}
			if reply.Method == nil || *reply.Method != method {
				t.Fatalf("method = %v, want %q", reply.Method, method)
			}
		})
	}
}

// A method outside the contract's five is a bug in the implementation, and reporting it verbatim
// would put an unparseable value on a closed vocabulary. `none` is the honest fallback.
func TestHangupClampsAMethodTheContractDoesNotKnow(t *testing.T) {
	server := newTestServer(t, &stubDialogs{hangupMethod: "smoke-signal"})
	reply := decode[contract.SipHangupResponse](t,
		server.HandleHangup(mustJSON(t, contract.SipHangupRequest{LegID: "leg-1"})))

	if reply.Method == nil || *reply.Method != contract.SipHangupResponseMethodNone {
		t.Fatalf("method = %v, want %q", reply.Method, contract.SipHangupResponseMethodNone)
	}
}

// `sipDialTargetSchema`'s refinement, checked on this side of the border. Without it a
// `{kind:"trunk"}` with no trunkId reaches the dial path as an empty string and becomes an
// `unknown_trunk` refusal, which blames the directory for what is a malformed request.
func TestOriginateAppliesTheDialTargetRefinement(t *testing.T) {
	empty := ""
	value := "018f0000-0000-7000-8000-000000000001"

	for name, target := range map[string]contract.SipOriginateRequestTarget{
		"aor without aor":       {Kind: contract.SipOriginateRequestTargetKindAOR},
		"aor with empty aor":    {Kind: contract.SipOriginateRequestTargetKindAOR, AOR: &empty},
		"trunk without trunkId": {Kind: contract.SipOriginateRequestTargetKindTrunk, Number: &value},
		"trunk without number":  {Kind: contract.SipOriginateRequestTargetKindTrunk, TrunkID: &value},
		"uri without uri":       {Kind: contract.SipOriginateRequestTargetKindURI},
		"unknown kind":          {Kind: "carrier-pigeon"},
	} {
		t.Run(name, func(t *testing.T) {
			dialogs := &stubDialogs{}
			server := newTestServer(t, dialogs)
			reply := decode[contract.SipOriginateResponse](t,
				server.HandleOriginate(mustJSON(t, contract.SipOriginateRequest{
					LegID:    "leg-1",
					OrgID:    "018f0000-0000-7000-8000-000000000000",
					CallID:   "call-1",
					SDPOffer: "v=0\r\n",
					Target:   target,
				})))

			if reply.Ok {
				t.Fatalf("%s was accepted", name)
			}
			if reply.Reason == nil || string(*reply.Reason) != ReasonBadRequest {
				t.Fatalf("reason = %v, want %q", reply.Reason, ReasonBadRequest)
			}
			if dialogs.originated.LegID != "" {
				t.Fatal("a malformed target reached the dial path")
			}
		})
	}
}

// The offer is mediad's and this edge never synthesises one. A body-less INVITE is refused or
// mishandled by a meaningful share of carriers, and the failure mode is "the phone rang and there
// was no audio".
func TestOriginateRefusesAMissingOffer(t *testing.T) {
	aorTarget := "sip:1001@acme.example.com"
	server := newTestServer(t, &stubDialogs{})

	reply := decode[contract.SipOriginateResponse](t,
		server.HandleOriginate(mustJSON(t, contract.SipOriginateRequest{
			LegID:  "leg-1",
			OrgID:  "018f0000-0000-7000-8000-000000000000",
			CallID: "call-1",
			Target: contract.SipOriginateRequestTarget{
				Kind: contract.SipOriginateRequestTargetKindAOR, AOR: &aorTarget,
			},
		})))

	if reply.Ok {
		t.Fatal("an originate with no offer was accepted")
	}
	if reply.Error == nil || !strings.Contains(*reply.Error, "sdpOffer is required") {
		t.Fatalf("error = %v, want it to name sdpOffer", reply.Error)
	}
}

// The reply carries the request URI and the Call-ID so a capture can be lined up before any event
// has been published — which is the only way to debug an outbound call that fails inside the first
// hundred milliseconds.
func TestOriginateReportsTheDiagnostics(t *testing.T) {
	aorTarget := "sip:1001@acme.example.com"
	dialogs := &stubDialogs{
		requestURI: "sip:1001@192.0.2.10:5060",
		sipCallID:  "a84b4c76e66710@pc33",
	}
	server := newTestServer(t, dialogs)

	reply := decode[contract.SipOriginateResponse](t,
		server.HandleOriginate(mustJSON(t, contract.SipOriginateRequest{
			LegID:    "leg-1",
			OrgID:    "018f0000-0000-7000-8000-000000000000",
			CallID:   "call-1",
			SDPOffer: "v=0\r\n",
			Target: contract.SipOriginateRequestTarget{
				Kind: contract.SipOriginateRequestTargetKindAOR, AOR: &aorTarget,
			},
		})))

	if !reply.Ok {
		t.Fatalf("originate refused: %+v", reply)
	}
	if reply.RequestURI == nil || *reply.RequestURI != dialogs.requestURI {
		t.Fatalf("requestUri = %v, want %q", reply.RequestURI, dialogs.requestURI)
	}
	if reply.SIPCallID == nil || *reply.SIPCallID != dialogs.sipCallID {
		t.Fatalf("sipCallId = %v, want %q", reply.SIPCallID, dialogs.sipCallID)
	}
}

// The four dialog commands are addressed AT ONE INSTANCE and originate is flat. Getting this wrong
// is not a cosmetic subject error: a queue-grouped `answer` is delivered to one member the server
// chooses, and seven times out of eight that member is not the one holding the call.
func TestSubjectsAreFourPerInstanceAndOneFlat(t *testing.T) {
	server := newTestServer(t, &stubDialogs{})
	subjects := server.Subjects()

	want := []string{
		"rpc.sip.v1.ring.sipd-test",
		"rpc.sip.v1.answer.sipd-test",
		"rpc.sip.v1.hangup.sipd-test",
		"rpc.sip.v1.reinvite.sipd-test",
		"rpc.sip.v1.originate",
	}
	if len(subjects) != len(want) {
		t.Fatalf("subjects = %v, want %d of them", subjects, len(want))
	}
	for index, subject := range want {
		if subjects[index] != subject {
			t.Fatalf("subject %d = %q, want %q", index, subjects[index], subject)
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("cannot encode %T: %v", value, err)
	}
	return payload
}
