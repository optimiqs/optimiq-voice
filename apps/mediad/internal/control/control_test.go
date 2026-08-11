package control_test

import (
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The handlers are pure functions of the payload, so this whole suite runs with no broker and no
// sockets. sipd draws the same line: the wire is left to the gated integration suite and the logic
// is tested where it lives.
//
// stubSessions stands in for *rtp.Manager.
type stubSessions struct {
	mu sync.Mutex

	// allocErr, when set, is what Allocate returns.
	allocErr error
	// released records the ids Release was called with.
	released []string
	// allocated records the (id, mode) pairs Allocate was called with.
	allocated []allocateCall
	// live is the set of ids a Release should report as found.
	live map[string]bool

	nextPort int
}

type allocateCall struct {
	id   string
	mode rtp.Mode
}

func newStub() *stubSessions {
	return &stubSessions{live: make(map[string]bool), nextPort: 30000}
}

func (s *stubSessions) Allocate(sessionID string, mode rtp.Mode) (rtp.Descriptor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.allocated = append(s.allocated, allocateCall{id: sessionID, mode: mode})
	if s.allocErr != nil {
		return rtp.Descriptor{}, s.allocErr
	}

	port := s.nextPort
	s.nextPort += 2
	s.live[sessionID] = true
	return rtp.Descriptor{
		SessionID:    sessionID,
		Address:      netip.MustParseAddr("203.0.113.10"),
		RTPPort:      port,
		RTCPPort:     port + 1,
		SSRC:         0xfeedface,
		Mode:         mode,
		PayloadTypes: rtp.SupportedPayloadTypes(),
	}, nil
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

func (s *stubSessions) calls() []allocateCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]allocateCall(nil), s.allocated...)
}

func newServer(t *testing.T, sessions control.Sessions) *control.Server {
	t.Helper()
	// Discard logs: the refusal paths log at WARN, and a passing suite should be silent.
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	server, err := control.NewServer(sessions, log)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return server
}

func allocate(t *testing.T, server *control.Server, request any) control.AllocateResponse {
	t.Helper()
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshalling the request: %v", err)
	}
	var reply control.AllocateResponse
	if err := json.Unmarshal(server.HandleAllocate(payload), &reply); err != nil {
		t.Fatalf("the handler produced a reply that is not JSON: %v", err)
	}
	return reply
}

func release(t *testing.T, server *control.Server, request any) control.ReleaseResponse {
	t.Helper()
	payload, err := json.Marshal(request)
	if err != nil {
		t.Fatalf("marshalling the request: %v", err)
	}
	var reply control.ReleaseResponse
	if err := json.Unmarshal(server.HandleRelease(payload), &reply); err != nil {
		t.Fatalf("the handler produced a reply that is not JSON: %v", err)
	}
	return reply
}

func TestNewServerRequiresASessionManager(t *testing.T) {
	if _, err := control.NewServer(nil, nil); err == nil {
		t.Error("NewServer accepted a nil session manager")
	}
}

// The v0 subjects are what the engine's client will hard-code until they are promoted into
// packages/events. Pinning them here makes a rename a test failure rather than a silent
// disconnection between two services that both start fine.
func TestSubjectsAreVersionedV0(t *testing.T) {
	if control.SubjectAllocate != "rpc.media.v0.allocate" {
		t.Errorf("SubjectAllocate = %q", control.SubjectAllocate)
	}
	if control.SubjectRelease != "rpc.media.v0.release" {
		t.Errorf("SubjectRelease = %q", control.SubjectRelease)
	}
	// v0, not v1: the shape is not stable and nothing outside mediad and the engine's mediad
	// client may depend on it. Promotion to packages/events makes it rpc.media.v1.*.
	for _, subject := range []string{control.SubjectAllocate, control.SubjectRelease} {
		if !strings.Contains(subject, ".v0.") {
			t.Errorf("%q is not marked v0; see the package comment on promotion", subject)
		}
	}
}

func TestAllocateReturnsTheDescriptor(t *testing.T) {
	stub := newStub()
	server := newServer(t, stub)

	reply := allocate(t, server, control.AllocateRequest{
		SessionID: "018f4f5e-0000-7000-8000-0000000000a1",
		CallID:    "call-1",
		Mode:      "echo",
	})

	if !reply.OK {
		t.Fatalf("allocate refused: %+v", reply)
	}
	if reply.SessionID != "018f4f5e-0000-7000-8000-0000000000a1" {
		t.Errorf("SessionID = %q", reply.SessionID)
	}
	// The ADVERTISED address, not the bind address: this is what goes in an SDP `c=` line.
	if reply.Address != "203.0.113.10" {
		t.Errorf("Address = %q", reply.Address)
	}
	if reply.RTPPort != 30000 {
		t.Errorf("RTPPort = %d", reply.RTPPort)
	}
	// Always RTP+1, and stated explicitly so a caller never re-derives the convention.
	if reply.RTCPPort != reply.RTPPort+1 {
		t.Errorf("RTCPPort = %d, want %d", reply.RTCPPort, reply.RTPPort+1)
	}
	if reply.SSRC != 0xfeedface {
		t.Errorf("SSRC = %#x", reply.SSRC)
	}
	if reply.Mode != "echo" {
		t.Errorf("Mode = %q", reply.Mode)
	}
	// G.711 passthrough plus RFC 4733 — the v1 codec stance, on the wire so the SDP wave reads it
	// instead of hard-coding the list engine-side.
	want := []int{
		int(rtp.PayloadTypePCMU), int(rtp.PayloadTypePCMA), int(rtp.PayloadTypeTelephoneEvent),
	}
	if len(reply.PayloadTypes) != len(want) {
		t.Fatalf("PayloadTypes = %v, want %v", reply.PayloadTypes, want)
	}
	for i, pt := range want {
		if reply.PayloadTypes[i] != pt {
			t.Errorf("PayloadTypes[%d] = %d, want %d", i, reply.PayloadTypes[i], pt)
		}
	}
	if reply.Error != "" || reply.Reason != "" {
		t.Errorf("a successful reply carries an error: %q / %q", reply.Error, reply.Reason)
	}
}

// An unset mode is the common case on the wire.
func TestAllocateDefaultsTheMode(t *testing.T) {
	stub := newStub()
	server := newServer(t, stub)

	reply := allocate(t, server, control.AllocateRequest{SessionID: "s1"})
	if !reply.OK {
		t.Fatalf("allocate refused: %+v", reply)
	}
	if reply.Mode != string(rtp.ModeEcho) {
		t.Errorf("Mode = %q, want the %q default", reply.Mode, rtp.ModeEcho)
	}
	if calls := stub.calls(); len(calls) != 1 || calls[0].mode != rtp.ModeEcho {
		t.Errorf("the manager was called with %+v", calls)
	}
}

func TestAllocatePassesInactiveThrough(t *testing.T) {
	stub := newStub()
	server := newServer(t, stub)

	reply := allocate(t, server, control.AllocateRequest{SessionID: "s1", Mode: "inactive"})
	if !reply.OK {
		t.Fatalf("allocate refused: %+v", reply)
	}
	if calls := stub.calls(); len(calls) != 1 || calls[0].mode != rtp.ModeInactive {
		t.Errorf("the manager was called with %+v", calls)
	}
}

// Every refusal is a REPLY. A responder that stays silent is indistinguishable from a crashed one,
// and the caller pays the full timeout to learn nothing.
func TestAllocateRefusalsAreAlwaysReplies(t *testing.T) {
	cases := []struct {
		name       string
		payload    []byte
		allocErr   error
		wantReason string
		wantErrHas string
	}{
		{
			name:       "malformed json",
			payload:    []byte(`{"sessionId":`),
			wantReason: control.ReasonBadRequest,
			wantErrHas: "malformed allocate request",
		},
		{
			name:       "not json at all",
			payload:    []byte(`sessionId=s1`),
			wantReason: control.ReasonBadRequest,
			wantErrHas: "malformed allocate request",
		},
		{
			// The id is the caller's to assign — see AllocateRequest.SessionID.
			name:       "no session id",
			payload:    []byte(`{"callId":"call-1"}`),
			wantReason: control.ReasonBadRequest,
			wantErrHas: "sessionId is required",
		},
		{
			name:       "empty session id",
			payload:    []byte(`{"sessionId":""}`),
			wantReason: control.ReasonBadRequest,
			wantErrHas: "sessionId is required",
		},
		{
			name:       "unknown mode",
			payload:    []byte(`{"sessionId":"s1","mode":"sendrecv"}`),
			wantReason: control.ReasonBadRequest,
			wantErrHas: "unknown media mode",
		},
		{
			// A load signal, not a fault: the engine routes around it.
			name:       "ports exhausted",
			payload:    []byte(`{"sessionId":"s1"}`),
			allocErr:   rtp.ErrPortsExhausted,
			wantReason: control.ReasonCapacity,
		},
		{
			// Do not retry HERE — this instance is going away.
			name:       "shutting down",
			payload:    []byte(`{"sessionId":"s1"}`),
			allocErr:   rtp.ErrClosed,
			wantReason: control.ReasonShuttingDown,
		},
		{
			name:       "anything else",
			payload:    []byte(`{"sessionId":"s1"}`),
			allocErr:   errors.New("the socket layer fell over"),
			wantReason: control.ReasonInternal,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub()
			stub.allocErr = tc.allocErr
			server := newServer(t, stub)

			raw := server.HandleAllocate(tc.payload)
			if len(raw) == 0 {
				t.Fatal("the handler produced no reply; a refusal must still be a reply")
			}
			var reply control.AllocateResponse
			if err := json.Unmarshal(raw, &reply); err != nil {
				t.Fatalf("the reply is not JSON: %v", err)
			}

			if reply.OK {
				t.Fatalf("the handler accepted a bad request: %+v", reply)
			}
			if reply.Reason != tc.wantReason {
				t.Errorf("Reason = %q, want %q", reply.Reason, tc.wantReason)
			}
			if reply.Error == "" {
				t.Error("a refusal must carry a human-readable Error alongside its Reason")
			}
			if tc.wantErrHas != "" && !strings.Contains(reply.Error, tc.wantErrHas) {
				t.Errorf("Error = %q, want it to mention %q", reply.Error, tc.wantErrHas)
			}
			// A refusal must not leak a port number the caller might act on.
			if reply.RTPPort != 0 {
				t.Errorf("a refusal carries RTPPort %d", reply.RTPPort)
			}
		})
	}
}

// A bad request must never reach the packet path.
func TestAllocateDoesNotTouchTheManagerOnABadRequest(t *testing.T) {
	stub := newStub()
	server := newServer(t, stub)

	server.HandleAllocate([]byte(`{"sessionId":"s1","mode":"nonsense"}`))
	server.HandleAllocate([]byte(`{}`))
	server.HandleAllocate([]byte(`not json`))

	if calls := stub.calls(); len(calls) != 0 {
		t.Errorf("the manager was called %d times for requests that never validated: %+v",
			len(calls), calls)
	}
}

func TestReleaseReportsWhetherThereWasASession(t *testing.T) {
	stub := newStub()
	server := newServer(t, stub)

	if reply := allocate(t, server, control.AllocateRequest{SessionID: "s1"}); !reply.OK {
		t.Fatalf("allocate refused: %+v", reply)
	}

	first := release(t, server, control.ReleaseRequest{SessionID: "s1"})
	if !first.OK || !first.Released {
		t.Errorf("first release = %+v, want ok and released", first)
	}

	// Release is idempotent, and a retry after a lost reply must NOT look like an error: OK stays
	// true and Released reports the truth.
	second := release(t, server, control.ReleaseRequest{SessionID: "s1"})
	if !second.OK {
		t.Errorf("releasing an unknown session must succeed: %+v", second)
	}
	if second.Released {
		t.Error("the second release claimed to have released something")
	}
	if second.Error != "" || second.Reason != "" {
		t.Errorf("a repeat release carries an error: %q / %q", second.Error, second.Reason)
	}
}

func TestReleaseRefusalsAreAlwaysReplies(t *testing.T) {
	cases := []struct {
		name       string
		payload    []byte
		wantErrHas string
	}{
		{"malformed json", []byte(`{"sessionId":`), "malformed release request"},
		{"no session id", []byte(`{}`), "sessionId is required"},
		{"empty session id", []byte(`{"sessionId":""}`), "sessionId is required"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newStub()
			server := newServer(t, stub)

			var reply control.ReleaseResponse
			raw := server.HandleRelease(tc.payload)
			if err := json.Unmarshal(raw, &reply); err != nil {
				t.Fatalf("the reply is not JSON: %v", err)
			}
			if reply.OK {
				t.Fatalf("the handler accepted a bad request: %+v", reply)
			}
			if reply.Reason != control.ReasonBadRequest {
				t.Errorf("Reason = %q, want %q", reply.Reason, control.ReasonBadRequest)
			}
			if !strings.Contains(reply.Error, tc.wantErrHas) {
				t.Errorf("Error = %q, want it to mention %q", reply.Error, tc.wantErrHas)
			}
			if len(stub.released) != 0 {
				t.Errorf("the manager was asked to release %v for an invalid request", stub.released)
			}
		})
	}
}

// The wire format is the CONTRACT: the engine's client is TypeScript and reads these exact field
// names. A rename here is a silent break there, so the JSON is pinned rather than the struct.
func TestWireFieldNames(t *testing.T) {
	stub := newStub()
	server := newServer(t, stub)

	var decoded map[string]any
	if err := json.Unmarshal(
		server.HandleAllocate([]byte(`{"sessionId":"s1","callId":"c1","mode":"echo"}`)),
		&decoded,
	); err != nil {
		t.Fatalf("the reply is not JSON: %v", err)
	}

	for _, field := range []string{"ok", "sessionId", "address", "rtpPort", "rtcpPort", "ssrc", "mode", "payloadTypes"} {
		if _, ok := decoded[field]; !ok {
			t.Errorf("a successful allocate reply is missing %q; the fields are camelCase, as "+
				"every other contract in packages/events is", field)
		}
	}
	// Optional fields must be absent rather than present-and-empty, so a caller can tell "no
	// error" from "an empty error".
	if _, ok := decoded["error"]; ok {
		t.Error("a successful reply carries an `error` key")
	}

	// The request side must accept exactly the names the engine will send.
	var request control.AllocateRequest
	if err := json.Unmarshal([]byte(`{"sessionId":"s1","callId":"c1","mode":"inactive"}`), &request); err != nil {
		t.Fatalf("decoding a request: %v", err)
	}
	if request.SessionID != "s1" || request.CallID != "c1" || request.Mode != "inactive" {
		t.Errorf("request decoded as %+v", request)
	}
}

// Both deadlines are on the call path, where a slow reply is the same as a broken one. The shape
// mirrors packages/events-go's TimeoutXxxRPC constants, which is where these move on promotion.
func TestTimeoutsAreShortEnoughToSitInsideACallSetup(t *testing.T) {
	if control.TimeoutAllocateRPC <= 0 || control.TimeoutAllocateRPC > 2_000_000_000 {
		t.Errorf("TimeoutAllocateRPC = %s; allocate binds a socket and should answer in "+
			"microseconds", control.TimeoutAllocateRPC)
	}
	if control.TimeoutReleaseRPC <= 0 || control.TimeoutReleaseRPC > 2_000_000_000 {
		t.Errorf("TimeoutReleaseRPC = %s", control.TimeoutReleaseRPC)
	}
}

// Subscribe needs a real connection; a nil one is a programming error refused at wiring time
// rather than at the first request.
func TestSubscribeRequiresAConnection(t *testing.T) {
	server := newServer(t, newStub())
	if _, err := server.Subscribe(nil, "mediad"); err == nil {
		t.Error("Subscribe accepted a nil connection")
	}
}

// A regression test for a bug a Go-to-Go round trip cannot see.
//
// `[]uint8` is `[]byte` to Go, and encoding/json marshals `[]byte` as a base64 STRING. The reply
// carried `"payloadTypes":"AAhl"` instead of `[0,8,101]`, which decodes back to the right thing in
// Go and is simply the wrong type to the TypeScript engine. Only an assertion against the actual
// JSON catches it, so this test reads the raw value rather than unmarshalling into the response
// struct.
func TestPayloadTypesAreAJSONArrayNotBase64(t *testing.T) {
	server := newServer(t, newStub())

	raw := server.HandleAllocate([]byte(`{"sessionId":"s1"}`))

	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("the reply is not JSON: %v", err)
	}
	field, ok := decoded["payloadTypes"]
	if !ok {
		t.Fatal("the reply has no payloadTypes")
	}
	if field[0] != '[' {
		t.Fatalf("payloadTypes is %s, want a JSON array; a []uint8 field marshals as base64 and "+
			"the TypeScript engine would receive a string", field)
	}

	var payloadTypes []int
	if err := json.Unmarshal(field, &payloadTypes); err != nil {
		t.Fatalf("payloadTypes is not an array of numbers: %v", err)
	}
	want := []int{0, 8, 101} // PCMU, PCMA, telephone-event
	if len(payloadTypes) != len(want) {
		t.Fatalf("payloadTypes = %v, want %v", payloadTypes, want)
	}
	for i := range want {
		if payloadTypes[i] != want[i] {
			t.Errorf("payloadTypes[%d] = %d, want %d", i, payloadTypes[i], want[i])
		}
	}
}
