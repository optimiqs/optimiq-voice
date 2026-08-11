package control_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The handlers are pure functions of the payload, so this whole suite runs with no broker and no
// sockets. sipd draws the same line: the wire is left to the gated integration suite and the logic
// is tested where it lives.

const (
	testOrg     = "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293"
	testCall    = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b4c"
	testSession = "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b53"
	thisNode    = "mediad-under-test"
)

// offerBody is what a phone actually sends: PCMU first, PCMA second, telephone-event on 101.
const offerBody = "v=0\r\n" +
	"o=- 12345 1 IN IP4 203.0.113.9\r\n" +
	"s=-\r\n" +
	"c=IN IP4 203.0.113.9\r\n" +
	"t=0 0\r\n" +
	"m=audio 41000 RTP/AVP 0 8 101\r\n" +
	"a=rtpmap:0 PCMU/8000\r\n" +
	"a=rtpmap:8 PCMA/8000\r\n" +
	"a=rtpmap:101 telephone-event/8000\r\n" +
	"a=sendrecv\r\n"

// stubSessions stands in for *rtp.Manager.
type stubSessions struct {
	mu sync.Mutex

	allocErr  error
	bridgeErr error

	allocated  []rtp.AllocateOptions
	bridged    []bridgeCall
	unbridged  []string
	released   []string
	live       map[string]bool
	bridges    map[string][]string
	nextPort   int
	audioForce uint8
}

type bridgeCall struct {
	bridgeID string
	first    string
	second   string
}

func newStub() *stubSessions {
	return &stubSessions{
		live:     make(map[string]bool),
		bridges:  make(map[string][]string),
		nextPort: 30000,
	}
}

func (s *stubSessions) Allocate(opts rtp.AllocateOptions) (rtp.Descriptor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.allocated = append(s.allocated, opts)
	if s.allocErr != nil {
		return rtp.Descriptor{}, s.allocErr
	}

	port := s.nextPort
	s.nextPort += 2
	s.live[opts.SessionID] = true

	audio := opts.AudioPayloadType
	if s.audioForce != 0 {
		audio = s.audioForce
	}
	mode := rtp.ModeRelay
	if opts.Inactive {
		mode = rtp.ModeInactive
	}
	return rtp.Descriptor{
		SessionID:                 opts.SessionID,
		Address:                   netip.MustParseAddr("203.0.113.10"),
		RTPPort:                   port,
		RTCPPort:                  port + 1,
		SSRC:                      0xfeedface,
		Mode:                      mode,
		AudioPayloadType:          audio,
		TelephoneEventPayloadType: opts.TelephoneEventPayloadType,
	}, nil
}

func (s *stubSessions) Bridge(bridgeID, first, second string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.bridged = append(s.bridged, bridgeCall{bridgeID, first, second})
	if s.bridgeErr != nil {
		return s.bridgeErr
	}
	s.bridges[bridgeID] = []string{first, second}
	return nil
}

func (s *stubSessions) Unbridge(bridgeID string) ([]string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unbridged = append(s.unbridged, bridgeID)
	pair, ok := s.bridges[bridgeID]
	if !ok {
		return nil, false
	}
	delete(s.bridges, bridgeID)
	return pair, true
}

func (s *stubSessions) Release(sessionID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.released = append(s.released, sessionID)
	if s.live[sessionID] {
		delete(s.live, sessionID)
		return true
	}
	return false
}

func (s *stubSessions) allocateCalls() []rtp.AllocateOptions {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]rtp.AllocateOptions(nil), s.allocated...)
}

type rig struct {
	server   *control.Server
	sessions *stubSessions
	dir      *directory.FakeStore
}

func newRig(t *testing.T) *rig {
	t.Helper()
	sessions := newStub()
	dir := directory.NewFakeStore()
	// Discard logs: the refusal paths log at WARN, and a passing suite should be silent.
	server, err := control.NewServer(control.ServerOptions{
		Sessions:   sessions,
		Directory:  dir,
		InstanceID: thisNode,
		PublicAddr: netip.MustParseAddr("203.0.113.10"),
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return &rig{server: server, sessions: sessions, dir: dir}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshalling a request: %v", err)
	}
	return payload
}

func decodeAllocate(t *testing.T, raw []byte) contract.MediaAllocateSessionResponse {
	t.Helper()
	var response contract.MediaAllocateSessionResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding an allocate reply: %v\n%s", err, raw)
	}
	return response
}

func validAllocate() contract.MediaAllocateSessionRequest {
	return contract.MediaAllocateSessionRequest{
		SessionID: testSession,
		OrgID:     testOrg,
		CallID:    testCall,
		SDPOffer:  offerBody,
		Direction: "sendrecv",
	}
}

func TestNewServerValidatesItsOptions(t *testing.T) {
	valid := control.ServerOptions{
		Sessions:   newStub(),
		Directory:  directory.NewFakeStore(),
		InstanceID: thisNode,
		PublicAddr: netip.MustParseAddr("203.0.113.10"),
	}

	cases := map[string]func(*control.ServerOptions){
		"no sessions":    func(o *control.ServerOptions) { o.Sessions = nil },
		"no directory":   func(o *control.ServerOptions) { o.Directory = nil },
		"no instance id": func(o *control.ServerOptions) { o.InstanceID = "" },
		"no public addr": func(o *control.ServerOptions) { o.PublicAddr = netip.Addr{} },
	}
	for name, break_ := range cases {
		t.Run(name, func(t *testing.T) {
			opts := valid
			break_(&opts)
			if _, err := control.NewServer(opts); err == nil {
				t.Errorf("NewServer accepted options with %s", name)
			}
		})
	}
}

// The happy path, end to end through the handler: an offer in, an answer out, a directory entry
// behind it.
func TestAllocateAnswersAnOfferAndRecordsTheSession(t *testing.T) {
	r := newRig(t)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, validAllocate())))
	if !response.Ok {
		t.Fatalf("allocate refused: %+v", response)
	}
	if response.SDPAnswer == nil {
		t.Fatal("the reply carries no SDP answer")
	}

	answer := *response.SDPAnswer
	for _, line := range []string{
		// The answer advertises the PUBLIC address and the session's REAL port.
		"c=IN IP4 203.0.113.10",
		"m=audio 30000 RTP/AVP 0 101",
		"a=rtpmap:0 PCMU/8000",
		"a=rtpmap:101 telephone-event/8000",
		"a=sendrecv",
		"a=rtcp:30001",
	} {
		if !strings.Contains(answer, line+"\r\n") {
			t.Errorf("the answer is missing %q\n---\n%s", line, answer)
		}
	}

	if response.InstanceID == nil || *response.InstanceID != thisNode {
		t.Errorf("InstanceID = %v, want %q", response.InstanceID, thisNode)
	}
	if response.RtpPort == nil || *response.RtpPort != 30000 {
		t.Errorf("RtpPort = %v, want 30000", response.RtpPort)
	}
	if response.RtcpPort == nil || *response.RtcpPort != 30001 {
		t.Errorf("RtcpPort = %v, want 30001", response.RtcpPort)
	}
	if response.Codec == nil || *response.Codec != "PCMU" {
		t.Errorf("Codec = %v, want PCMU", response.Codec)
	}
	if response.TelephoneEventPayloadType == nil || *response.TelephoneEventPayloadType != 101 {
		t.Errorf("TelephoneEventPayloadType = %v, want 101", response.TelephoneEventPayloadType)
	}

	// The negotiated types reach the packet path, which is what makes a session drop what its own
	// answer did not agree to.
	calls := r.sessions.allocateCalls()
	if len(calls) != 1 {
		t.Fatalf("Allocate called %d times, want 1", len(calls))
	}
	if calls[0].AudioPayloadType != rtp.PayloadTypePCMU {
		t.Errorf("AudioPayloadType = %d, want PCMU", calls[0].AudioPayloadType)
	}
	if calls[0].TelephoneEventPayloadType != 101 {
		t.Errorf("TelephoneEventPayloadType = %d, want 101", calls[0].TelephoneEventPayloadType)
	}
	if calls[0].OrgID != testOrg || calls[0].CallID != testCall {
		t.Errorf("attribution = %+v, want the request's org and call", calls[0])
	}

	entry, found, err := r.dir.Get(context.Background(), testSession)
	if err != nil || !found {
		t.Fatalf("no session directory entry was written (err=%v)", err)
	}
	if entry.InstanceID != thisNode {
		t.Errorf("directory InstanceID = %q, want %q", entry.InstanceID, thisNode)
	}
	if entry.RTPPort != 30000 || entry.RTCPPort != 30001 {
		t.Errorf("directory ports = %d/%d, want 30000/30001", entry.RTPPort, entry.RTCPPort)
	}
	if entry.OrgID != testOrg || entry.CallID != testCall {
		t.Errorf("directory attribution = %+v", entry)
	}
	if entry.AllocatedAt == 0 {
		t.Error("directory entry has no allocation timestamp")
	}
}

// An offer that prefers PCMA gets a PCMA answer. Preference order is honoured because an endpoint
// that lists PCMA first usually encodes it natively.
func TestAllocateHonoursTheOffererPreference(t *testing.T) {
	r := newRig(t)
	request := validAllocate()
	request.SDPOffer = strings.Replace(offerBody,
		"m=audio 41000 RTP/AVP 0 8 101", "m=audio 41000 RTP/AVP 8 0 101", 1)

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, request)))
	if !response.Ok {
		t.Fatalf("allocate refused: %+v", response)
	}
	if response.Codec == nil || *response.Codec != "PCMA" {
		t.Errorf("Codec = %v, want PCMA", response.Codec)
	}
	if !strings.Contains(*response.SDPAnswer, "m=audio 30000 RTP/AVP 8 101\r\n") {
		t.Errorf("the answer did not settle on PCMA\n---\n%s", *response.SDPAnswer)
	}
}

// A ringing leg answers `inactive` and the session is created inactive, so no audio is sourced
// before the call is answered.
func TestAllocateAnInactiveLeg(t *testing.T) {
	r := newRig(t)
	request := validAllocate()
	request.Direction = "inactive"

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, request)))
	if !response.Ok {
		t.Fatalf("allocate refused: %+v", response)
	}
	if !strings.Contains(*response.SDPAnswer, "a=inactive\r\n") {
		t.Errorf("the answer is not inactive\n---\n%s", *response.SDPAnswer)
	}
	if calls := r.sessions.allocateCalls(); len(calls) != 1 || !calls[0].Inactive {
		t.Errorf("the session was not created inactive: %+v", calls)
	}
}

func TestAllocateRefusals(t *testing.T) {
	noG711 := strings.NewReplacer(
		"m=audio 41000 RTP/AVP 0 8 101", "m=audio 41000 RTP/AVP 9 111",
		"a=rtpmap:0 PCMU/8000", "a=rtpmap:9 G722/8000",
		"a=rtpmap:8 PCMA/8000", "a=rtpmap:111 opus/48000/2",
	).Replace(offerBody)

	cases := []struct {
		name       string
		mutate     func(*contract.MediaAllocateSessionRequest)
		allocErr   error
		wantReason string
	}{
		{
			name:       "no session id",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.SessionID = "" },
			wantReason: control.ReasonBadRequest,
		},
		{
			name:       "no call id",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.CallID = "" },
			wantReason: control.ReasonBadRequest,
		},
		{
			// Without an org there is no subject token for the lifecycle events, so the session
			// would end silently and the engine would never learn why.
			name:       "no org id",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.OrgID = "" },
			wantReason: control.ReasonBadRequest,
		},
		{
			name:       "no offer",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.SDPOffer = "" },
			wantReason: control.ReasonBadRequest,
		},
		{
			name:       "unparseable offer",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.SDPOffer = "not sdp at all" },
			wantReason: control.ReasonBadRequest,
		},
		{
			name:       "unknown direction",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.Direction = "duplex" },
			wantReason: control.ReasonBadRequest,
		},
		{
			// A perfectly valid offer this media plane cannot serve. The engine's recovery is to
			// route the leg to Asterisk, not to fix the bytes and retry — a different reason code.
			name:       "no common codec",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.SDPOffer = noG711 },
			wantReason: control.ReasonNotSupported,
		},
		{
			// Hold is rung 5. Answering sendrecv to a sendonly request would put a held caller back
			// into the conversation, so it is refused by name rather than downgraded.
			name:       "hold is not supported yet",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.Direction = "sendonly" },
			wantReason: control.ReasonNotSupported,
		},
		{
			name:       "ports exhausted",
			allocErr:   rtp.ErrPortsExhausted,
			wantReason: control.ReasonCapacity,
		},
		{
			name:       "shutting down",
			allocErr:   rtp.ErrClosed,
			wantReason: control.ReasonShuttingDown,
		},
		{
			name:       "anything else",
			allocErr:   errors.New("the socket layer fell over"),
			wantReason: control.ReasonInternal,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t)
			r.sessions.allocErr = tc.allocErr
			request := validAllocate()
			if tc.mutate != nil {
				tc.mutate(&request)
			}

			response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, request)))
			if response.Ok {
				t.Fatalf("allocate succeeded; want a refusal with reason %q", tc.wantReason)
			}
			if response.Reason == nil || string(*response.Reason) != tc.wantReason {
				t.Errorf("reason = %v, want %q", response.Reason, tc.wantReason)
			}
			// A refusal is a REPLY: it always says something a human can read, and always names the
			// instance so a support ticket can point at a process.
			if response.Error == nil || *response.Error == "" {
				t.Error("a refusal carried no error message")
			}
			if response.InstanceID == nil || *response.InstanceID != thisNode {
				t.Errorf("a refusal did not name the instance: %v", response.InstanceID)
			}
			if r.dir.Len() != 0 {
				t.Error("a refused allocate wrote a session directory entry")
			}
		})
	}
}

// Malformed bytes are answered, not dropped. A responder that stays silent is indistinguishable
// from a crashed one and the caller pays the whole timeout to learn nothing.
func TestEveryHandlerAnswersGarbage(t *testing.T) {
	r := newRig(t)
	garbage := []byte("{not json")

	for name, reply := range map[string][]byte{
		"allocate": r.server.HandleAllocateSession(garbage),
		"bridge":   r.server.HandleBridgeSessions(garbage),
		"unbridge": r.server.HandleUnbridgeSessions(garbage),
		"release":  r.server.HandleReleaseSession(garbage),
	} {
		t.Run(name, func(t *testing.T) {
			var envelope struct {
				OK     bool   `json:"ok"`
				Reason string `json:"reason"`
				Error  string `json:"error"`
			}
			if err := json.Unmarshal(reply, &envelope); err != nil {
				t.Fatalf("the reply to garbage is not JSON: %v\n%s", err, reply)
			}
			if envelope.OK {
				t.Error("garbage was accepted")
			}
			if envelope.Reason != control.ReasonBadRequest {
				t.Errorf("reason = %q, want %q", envelope.Reason, control.ReasonBadRequest)
			}
			if envelope.Error == "" {
				t.Error("the refusal carried no message")
			}
		})
	}
}

func decodeBridge(t *testing.T, raw []byte) contract.MediaBridgeSessionsResponse {
	t.Helper()
	var response contract.MediaBridgeSessionsResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding a bridge reply: %v\n%s", err, raw)
	}
	return response
}

func TestBridgeRelaysTwoSessionsAndNotesItInTheDirectory(t *testing.T) {
	r := newRig(t)
	for _, id := range []string{"leg-a", "leg-b"} {
		request := validAllocate()
		request.SessionID = id
		if response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, request))); !response.Ok {
			t.Fatalf("allocating %s: %+v", id, response)
		}
	}

	reply := r.server.HandleBridgeSessions(mustJSON(t, contract.MediaBridgeSessionsRequest{
		BridgeID:   "bridge-1",
		SessionIDs: []string{"leg-a", "leg-b"},
	}))
	response := decodeBridge(t, reply)
	if !response.Ok {
		t.Fatalf("bridge refused: %+v", response)
	}
	if len(response.SessionIDs) != 2 {
		t.Errorf("SessionIDs = %v, want both legs", response.SessionIDs)
	}

	for _, id := range []string{"leg-a", "leg-b"} {
		entry, found, err := r.dir.Get(context.Background(), id)
		if err != nil || !found {
			t.Fatalf("%s has no directory entry", id)
		}
		if entry.BridgeID != "bridge-1" {
			// A bridge that is invisible outside its own instance is a bridge a drain cannot move
			// and an operator cannot explain.
			t.Errorf("%s directory BridgeID = %q, want bridge-1", id, entry.BridgeID)
		}
	}
}

func TestBridgeRefusals(t *testing.T) {
	t.Run("three sessions is a conference, not a bridge", func(t *testing.T) {
		r := newRig(t)
		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{
				BridgeID:   "bridge-1",
				SessionIDs: []string{"a", "b", "c"},
			})))
		if response.Ok {
			t.Fatal("a three-way bridge was accepted")
		}
		if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
			t.Errorf("reason = %v, want not_supported", response.Reason)
		}
		if response.Error == nil || !strings.Contains(*response.Error, "rung 6") {
			// A not-supported refusal must name the capability, so the reader knows whether to wait
			// for it or design around it.
			t.Errorf("the refusal does not name the missing capability: %v", response.Error)
		}
	})

	t.Run("no bridge id", func(t *testing.T) {
		r := newRig(t)
		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{SessionIDs: []string{"a", "b"}})))
		if response.Ok || response.Reason == nil || string(*response.Reason) != control.ReasonBadRequest {
			t.Errorf("a bridge with no id was not refused as bad_request: %+v", response)
		}
	})

	t.Run("codec mismatch is not supported", func(t *testing.T) {
		r := newRig(t)
		r.sessions.bridgeErr = rtp.ErrCodecMismatch
		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{
				BridgeID:   "bridge-1",
				SessionIDs: []string{"a", "b"},
			})))
		if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
			t.Errorf("reason = %v, want not_supported", response.Reason)
		}
	})

	t.Run("an unknown session on this instance", func(t *testing.T) {
		r := newRig(t)
		r.sessions.bridgeErr = rtp.ErrUnknownSession
		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{
				BridgeID:   "bridge-1",
				SessionIDs: []string{"a", "b"},
			})))
		if response.Reason == nil || string(*response.Reason) != control.ReasonUnknown {
			t.Errorf("reason = %v, want unknown_session", response.Reason)
		}
	})

	// THE reason the directory exists: "somebody else has it" and "nobody has it" need opposite
	// recoveries, and answering the wrong one tears down a healthy call during a scale-out.
	t.Run("a session that lives on another instance", func(t *testing.T) {
		r := newRig(t)
		r.sessions.bridgeErr = rtp.ErrUnknownSession
		if err := r.dir.Put(context.Background(), directory.Entry{
			SessionID:  "leg-b",
			InstanceID: "mediad-somewhere-else",
			OrgID:      testOrg,
			CallID:     testCall,
			Address:    "203.0.113.11",
			RTPPort:    31000,
			RTCPPort:   31001,
		}); err != nil {
			t.Fatalf("seeding the directory: %v", err)
		}

		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{
				BridgeID:   "bridge-1",
				SessionIDs: []string{"leg-a", "leg-b"},
			})))
		if response.Reason == nil || string(*response.Reason) != control.ReasonWrongNode {
			t.Errorf("reason = %v, want wrong_instance", response.Reason)
		}
	})
}

func decodeUnbridge(t *testing.T, raw []byte) contract.MediaUnbridgeSessionsResponse {
	t.Helper()
	var response contract.MediaUnbridgeSessionsResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding an unbridge reply: %v\n%s", err, raw)
	}
	return response
}

func TestUnbridgeIsIdempotentAndClearsTheDirectory(t *testing.T) {
	r := newRig(t)
	for _, id := range []string{"leg-a", "leg-b"} {
		request := validAllocate()
		request.SessionID = id
		r.server.HandleAllocateSession(mustJSON(t, request))
	}
	r.server.HandleBridgeSessions(mustJSON(t, contract.MediaBridgeSessionsRequest{
		BridgeID:   "bridge-1",
		SessionIDs: []string{"leg-a", "leg-b"},
	}))

	first := decodeUnbridge(t, r.server.HandleUnbridgeSessions(
		mustJSON(t, contract.MediaUnbridgeSessionsRequest{BridgeID: "bridge-1"})))
	if !first.Ok || !first.Unbridged {
		t.Fatalf("the first unbridge did nothing: %+v", first)
	}
	for _, id := range []string{"leg-a", "leg-b"} {
		entry, _, _ := r.dir.Get(context.Background(), id)
		if entry.BridgeID != "" {
			t.Errorf("%s still shows bridge %q after an unbridge", id, entry.BridgeID)
		}
	}

	// A retry after a lost reply must not look like a failure.
	second := decodeUnbridge(t, r.server.HandleUnbridgeSessions(
		mustJSON(t, contract.MediaUnbridgeSessionsRequest{BridgeID: "bridge-1"})))
	if !second.Ok {
		t.Errorf("a repeat unbridge was refused: %+v", second)
	}
	if second.Unbridged {
		t.Error("a repeat unbridge claimed to have done something")
	}
}

func decodeRelease(t *testing.T, raw []byte) contract.MediaReleaseSessionResponse {
	t.Helper()
	var response contract.MediaReleaseSessionResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatalf("decoding a release reply: %v\n%s", err, raw)
	}
	return response
}

// The directory delete is part of the CONTRACT: an entry that outlives its session is an instance
// name the engine keeps routing dead commands to.
func TestReleaseFreesTheSessionAndTheDirectoryEntry(t *testing.T) {
	r := newRig(t)
	if response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, validAllocate()))); !response.Ok {
		t.Fatalf("allocate: %+v", response)
	}
	if r.dir.Len() != 1 {
		t.Fatalf("directory holds %d entries after an allocate, want 1", r.dir.Len())
	}

	response := decodeRelease(t, r.server.HandleReleaseSession(
		mustJSON(t, contract.MediaReleaseSessionRequest{SessionID: testSession})))
	if !response.Ok || !response.Released {
		t.Fatalf("release: %+v", response)
	}
	if r.dir.Len() != 0 {
		t.Errorf("directory still holds %d entries after a release", r.dir.Len())
	}
}

// Releasing something this instance never had is a SUCCESS that still clears the directory: that is
// exactly the shape of a retry that landed on the wrong node after a failover.
func TestReleaseOfAnUnknownSessionSucceedsAndStillCleansUp(t *testing.T) {
	r := newRig(t)
	if err := r.dir.Put(context.Background(), directory.Entry{
		SessionID:  "ghost",
		InstanceID: "mediad-somewhere-else",
		OrgID:      testOrg,
		CallID:     testCall,
		Address:    "203.0.113.11",
		RTPPort:    31000,
		RTCPPort:   31001,
	}); err != nil {
		t.Fatalf("seeding the directory: %v", err)
	}

	response := decodeRelease(t, r.server.HandleReleaseSession(
		mustJSON(t, contract.MediaReleaseSessionRequest{SessionID: "ghost"})))
	if !response.Ok {
		t.Fatalf("release of an unknown session was refused: %+v", response)
	}
	if response.Released {
		t.Error("release claimed to have torn down a session this instance never had")
	}
	if r.dir.Len() != 0 {
		t.Error("the stale directory entry survived the release")
	}
}

func TestReleaseWithoutASessionIDIsRefused(t *testing.T) {
	r := newRig(t)
	response := decodeRelease(t, r.server.HandleReleaseSession(
		mustJSON(t, contract.MediaReleaseSessionRequest{})))
	if response.Ok {
		t.Fatal("a release with no session id was accepted")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonBadRequest {
		t.Errorf("reason = %v, want bad_request", response.Reason)
	}
}

// A directory that cannot be written must not fail a call. The session is already bound and
// answerable; failing here would fail the call AND hold the port until the reaper.
func TestAllocateSurvivesADirectoryFailure(t *testing.T) {
	r := newRig(t)
	r.dir.PutErr = errors.New("the broker is unwell")

	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, validAllocate())))
	if !response.Ok {
		t.Fatalf("a KV failure failed the allocate: %+v", response)
	}
	if response.SDPAnswer == nil {
		t.Error("no answer was produced")
	}
}

// The subjects this service answers are the contract's, not a local copy.
func TestSubjectsComeFromTheContract(t *testing.T) {
	cases := map[string]string{
		control.SubjectAllocateSession:  "rpc.media.v1.allocate-session",
		control.SubjectBridgeSessions:   "rpc.media.v1.bridge-sessions",
		control.SubjectUnbridgeSessions: "rpc.media.v1.unbridge-sessions",
		control.SubjectReleaseSession:   "rpc.media.v1.release-session",
	}
	for got, want := range cases {
		if got != want {
			t.Errorf("subject = %q, want %q", got, want)
		}
	}
}

func TestSubscribeRequiresAConnection(t *testing.T) {
	r := newRig(t)
	if _, err := r.server.Subscribe(nil, "mediad"); err == nil {
		t.Error("Subscribe accepted a nil connection")
	}
}
