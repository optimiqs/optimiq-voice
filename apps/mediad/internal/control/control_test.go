package control_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"

	contract "github.com/optimiqs/optimiq-voice/packages/events-go"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/control"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/directory"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The handlers are pure functions of the payload, so this whole suite runs with no broker and no
// sockets.

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

	// The playback half of the packet path.
	playbackErr    error
	playbackStarts []playbackCall
	playbackStops  []string
	playing        map[string]string
	// codecFor overrides what AudioPayloadType reports for a session, so a test can put a prompt on
	// an A-law leg without going anywhere near a socket.
	codecFor map[string]uint8

	// `telephoneEventFor` defaults to 101 for a live session; a test sets it to 0 to stand in for a
	// leg that negotiated no RFC 4733 type.
	dtmfErr           error
	dtmfSends         []dtmfCall
	telephoneEventFor map[string]uint8

	recordingErr    error
	recordingStarts []recordingCall
	recordingStops  []string
	recordingPauses []recordingPauseCall
	recording       map[string]string
	paused          map[string]bool
	tenancy         map[string][2]string

	// The renegotiation record and the tap pair.
	directions    []directionCall
	seededRemotes []seedCall
	// The B-leg's accept-answer settle record. `settleErr` forces a failure; `settlePort` fixes the
	// descriptor's port so a create-offer→accept-answer flow can assert on a stable value.
	settles     []settleCall
	srtpSettles []string
	// The negotiation state rtp.Manager keeps per session id, and the lock the exchange runs under.
	negotiations map[string]rtp.Negotiation
	negotiateMu  sync.Mutex
	settleErr    error
	settlePort   int
	tapErr       error
	taps         []rtp.TapOptions
	untaps       []string
	tapped       map[string]string

	// `muted` is a pair of flags per session because a mute is ADDITIVE and a stub that replaced them
	// would let a handler bug pass: the handler reads the state back because it cannot derive it.
	muteErr    error
	mutes      []muteCall
	muted      map[string][2]bool
	holdErr    error
	holds      []holdCall
	unholds    []string
	held       map[string]string
	holdActive map[string]bool

	// The room, reached through `bridge-sessions` rather than only through a tap.
	joinErr     error
	joins       []joinCall
	conferences map[string][]string
	destroyed   []string
}

type muteCall struct {
	sessionID string
	direction rtp.MediaDirection
	unmute    bool
}

type holdCall struct {
	sessionID string
	opts      rtp.HoldOptions
}

type joinCall struct {
	conferenceID string
	sessionID    string
	opts         rtp.JoinOptions
}

// seedCall is one SeedRemote call: the session and the advertised address it was seeded with.
type seedCall struct {
	sessionID string
	addr      netip.AddrPort
}

type directionCall struct {
	sessionID string
	muteIn    bool
	muteOut   bool
}

type settleCall struct {
	sessionID        string
	format           audio.Format
	audioPT          uint8
	telephoneEventPT uint8
}

type dtmfCall struct {
	sessionID string
	opts      rtp.DtmfOptions
}

type recordingCall struct {
	sessionID string
	opts      rtp.RecordingOptions
}

type playbackCall struct {
	sessionID string
	opts      rtp.PlaybackOptions
}

type bridgeCall struct {
	bridgeID string
	first    string
	second   string
}

func newStub() *stubSessions {
	return &stubSessions{
		live:              make(map[string]bool),
		bridges:           make(map[string][]string),
		playing:           make(map[string]string),
		codecFor:          make(map[string]uint8),
		telephoneEventFor: make(map[string]uint8),
		recording:         make(map[string]string),
		tenancy:           make(map[string][2]string),
		tapped:            make(map[string]string),
		muted:             make(map[string][2]bool),
		held:              make(map[string]string),
		holdActive:        make(map[string]bool),
		conferences:       make(map[string][]string),
		nextPort:          30000,
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

	payloadType := opts.AudioPayloadType
	format := opts.Format
	if s.audioForce != 0 {
		payloadType = s.audioForce
		format = formatForPayloadType(payloadType)
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
		AudioPayloadType:          payloadType,
		Format:                    format,
		TelephoneEventPayloadType: opts.TelephoneEventPayloadType,
	}, nil
}

// formatForPayloadType is the stub's own version of what SDP negotiation would have decided, for the
// tests that force a codec onto a leg without going near a socket.
func formatForPayloadType(payloadType uint8) audio.Format {
	switch payloadType {
	case rtp.PayloadTypePCMA:
		return audio.FormatALaw
	case rtp.PayloadTypeG722:
		return audio.FormatG722
	default:
		return audio.FormatULaw
	}
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

func (s *stubSessions) StartPlayback(sessionID string, opts rtp.PlaybackOptions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.playbackStarts = append(s.playbackStarts, playbackCall{sessionID, opts})
	if s.playbackErr != nil {
		return s.playbackErr
	}
	s.playing[opts.Ref] = sessionID
	return nil
}

func (s *stubSessions) StopPlayback(playbackRef string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.playbackStops = append(s.playbackStops, playbackRef)
	sessionID, ok := s.playing[playbackRef]
	if !ok {
		return "", false
	}
	delete(s.playing, playbackRef)
	return sessionID, true
}

func (s *stubSessions) AudioPayloadType(sessionID string) (uint8, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.live[sessionID] {
		return 0, false
	}
	if forced, ok := s.codecFor[sessionID]; ok {
		return forced, true
	}
	return rtp.PayloadTypePCMU, true
}

func (s *stubSessions) SendDtmf(sessionID string, opts rtp.DtmfOptions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dtmfSends = append(s.dtmfSends, dtmfCall{sessionID, opts})
	return s.dtmfErr
}

func (s *stubSessions) StartRecording(sessionID string, opts rtp.RecordingOptions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recordingStarts = append(s.recordingStarts, recordingCall{sessionID, opts})
	if s.recordingErr != nil {
		return s.recordingErr
	}
	s.recording[opts.Ref] = sessionID
	return nil
}

func (s *stubSessions) StopRecording(recordingRef string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recordingStops = append(s.recordingStops, recordingRef)
	sessionID, ok := s.recording[recordingRef]
	if !ok {
		return "", false
	}
	delete(s.recording, recordingRef)
	return sessionID, true
}

// `PauseRecording` is a flag per live reference: the handler only ever reports it back.

type recordingPauseCall struct {
	ref    string
	paused bool
}

func (s *stubSessions) PauseRecording(recordingRef string, paused bool) (string, bool, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recordingPauses = append(s.recordingPauses, recordingPauseCall{recordingRef, paused})
	sessionID, ok := s.recording[recordingRef]
	if !ok {
		return "", false, false
	}
	if s.paused == nil {
		s.paused = map[string]bool{}
	}
	s.paused[recordingRef] = paused
	return sessionID, true, paused
}

// `ApplyDirection` records what a renegotiation asked for, so the allocate tests can assert that a
// `sendonly` offer actually moved the gate rather than merely being accepted.

func (s *stubSessions) ApplyDirection(sessionID string, muteIn, muteOut bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.directions = append(s.directions, directionCall{sessionID, muteIn, muteOut})
	if !s.live[sessionID] {
		return rtp.ErrUnknownSession
	}
	return nil
}

// SettleAnswer stands in for the packet path's `accept-answer` half: it records the settle and,
// like the real one, refuses an unknown session and otherwise reports the codec back through the
// descriptor so a handler that failed to read the settled value would fail these tests.
// SeedRemote records the address a handler seeded a session's far end with, so the allocate and
// accept-answer tests can assert that the negotiated `c=`/`m=` reached the packet path.
func (s *stubSessions) SeedRemote(sessionID string, addr netip.AddrPort) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.seededRemotes = append(s.seededRemotes, seedCall{sessionID, addr})
	if !s.live[sessionID] {
		return rtp.ErrUnknownSession
	}
	return nil
}

// seeds reports the SeedRemote calls made so far.
func (s *stubSessions) seeds() []seedCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.seededRemotes)
}

// Negotiate mirrors rtp.Manager.Negotiate: one exchange at a time per session id, replaying the
// committed result for an identical request. Its own mutex, because the exchange calls Allocate.
func (s *stubSessions) Negotiate(
	sessionID, request string,
	exchange func(prior rtp.Negotiation, replay bool) (*rtp.Negotiation, *rtp.SRTPContext, error),
) (rtp.Negotiation, error) {
	s.negotiateMu.Lock()
	defer s.negotiateMu.Unlock()

	s.mu.Lock()
	prior := s.negotiations[sessionID]
	s.mu.Unlock()

	committed, secure, err := exchange(prior, prior.Committed() && prior.Request == request)
	if err != nil {
		return rtp.Negotiation{}, err
	}
	if committed == nil {
		return prior, nil
	}
	next := *committed
	if next.Request == "" {
		next.Request = request
	}
	next.Generation = prior.Generation + 1

	s.mu.Lock()
	defer s.mu.Unlock()
	if secure != nil {
		s.srtpSettles = append(s.srtpSettles, sessionID)
	}
	if s.negotiations == nil {
		s.negotiations = map[string]rtp.Negotiation{}
	}
	s.negotiations[sessionID] = next
	return next, nil
}

func (s *stubSessions) SettleAnswer(
	sessionID string,
	format audio.Format,
	audioPT, telephoneEventPT uint8,
) (rtp.Descriptor, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.settles = append(s.settles, settleCall{sessionID, format, audioPT, telephoneEventPT})
	if s.settleErr != nil {
		return rtp.Descriptor{}, s.settleErr
	}
	if !s.live[sessionID] {
		return rtp.Descriptor{}, fmt.Errorf("%w: %s", rtp.ErrUnknownSession, sessionID)
	}
	port := s.settlePort
	if port == 0 {
		port = 30000
	}
	return rtp.Descriptor{
		SessionID:                 sessionID,
		Address:                   netip.MustParseAddr("203.0.113.10"),
		RTPPort:                   port,
		RTCPPort:                  port + 1,
		SSRC:                      0xfeedface,
		Mode:                      rtp.ModeRelay,
		AudioPayloadType:          audioPT,
		Format:                    format,
		TelephoneEventPayloadType: telephoneEventPT,
	}, nil
}

func (s *stubSessions) settleCalls() []settleCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.settles)
}

func (s *stubSessions) Tap(opts rtp.TapOptions) (rtp.TapResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.taps = append(s.taps, opts)
	if s.tapErr != nil {
		return rtp.TapResult{}, s.tapErr
	}
	s.tapped[opts.TapID] = opts.TapSessionID
	return rtp.TapResult{
		ConferenceID: "conference-" + opts.TargetSessionID,
		SessionIDs:   []string{opts.TargetSessionID, opts.TapSessionID},
		Converted:    true,
	}, nil
}

// `Mute` is ADDITIVE here exactly as the real one is, so a handler that derived its reply from the
// request instead of reading the state back would fail these tests.
func (s *stubSessions) Mute(sessionID string, direction rtp.MediaDirection) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mutes = append(s.mutes, muteCall{sessionID, direction, false})
	if s.muteErr != nil {
		return s.muteErr
	}
	if !s.live[sessionID] {
		return fmt.Errorf("%w: %s", rtp.ErrUnknownSession, sessionID)
	}
	state := s.muted[sessionID]
	if direction == rtp.DirectionIn || direction == rtp.DirectionBoth {
		state[0] = true
	}
	if direction == rtp.DirectionOut || direction == rtp.DirectionBoth {
		state[1] = true
	}
	s.muted[sessionID] = state
	return nil
}

func (s *stubSessions) Unmute(sessionID string, direction rtp.MediaDirection) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.mutes = append(s.mutes, muteCall{sessionID, direction, true})
	if s.muteErr != nil {
		return s.muteErr
	}
	if !s.live[sessionID] {
		return fmt.Errorf("%w: %s", rtp.ErrUnknownSession, sessionID)
	}
	state := s.muted[sessionID]
	if direction == rtp.DirectionIn || direction == rtp.DirectionBoth {
		state[0] = false
	}
	if direction == rtp.DirectionOut || direction == rtp.DirectionBoth {
		state[1] = false
	}
	s.muted[sessionID] = state
	return nil
}

func (s *stubSessions) MuteState(sessionID string) (in, out, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.live[sessionID] {
		return false, false, false
	}
	state := s.muted[sessionID]
	return state[0], state[1], true
}

func (s *stubSessions) Hold(sessionID string, opts rtp.HoldOptions) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.holds = append(s.holds, holdCall{sessionID, opts})
	if s.holdErr != nil {
		return s.holdErr
	}
	if !s.live[sessionID] {
		return fmt.Errorf("%w: %s", rtp.ErrUnknownSession, sessionID)
	}
	s.holdActive[sessionID] = true
	// The music only "starts" when there are frames, which is what makes a silent hold — an empty
	// clip, or a leg that has not sent a packet — visibly different in the reply.
	if len(opts.MusicFrames) > 0 {
		s.held[sessionID] = opts.MusicRef
	}
	return nil
}

func (s *stubSessions) Unhold(sessionID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unholds = append(s.unholds, sessionID)
	if s.holdErr != nil {
		return false, s.holdErr
	}
	if !s.live[sessionID] {
		return false, fmt.Errorf("%w: %s", rtp.ErrUnknownSession, sessionID)
	}
	was := s.holdActive[sessionID]
	delete(s.holdActive, sessionID)
	delete(s.held, sessionID)
	return was, nil
}

func (s *stubSessions) HoldState(sessionID string) (bool, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.live[sessionID] {
		return false, "", false
	}
	return s.holdActive[sessionID], s.held[sessionID], true
}

func (s *stubSessions) JoinConference(
	conferenceID, sessionID string,
	opts rtp.JoinOptions,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.joins = append(s.joins, joinCall{conferenceID, sessionID, opts})
	if s.joinErr != nil {
		return s.joinErr
	}
	if !s.live[sessionID] {
		return fmt.Errorf("%w: %s", rtp.ErrUnknownSession, sessionID)
	}
	s.conferences[conferenceID] = append(s.conferences[conferenceID], sessionID)
	return nil
}

func (s *stubSessions) DestroyConference(conferenceID string) ([]string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.destroyed = append(s.destroyed, conferenceID)
	members, ok := s.conferences[conferenceID]
	delete(s.conferences, conferenceID)
	return members, ok
}

func (s *stubSessions) Untap(tapID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.untaps = append(s.untaps, tapID)
	sessionID, ok := s.tapped[tapID]
	if !ok {
		return "", false
	}
	delete(s.tapped, tapID)
	return sessionID, true
}

func (s *stubSessions) TelephoneEventPayloadType(sessionID string) (uint8, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.live[sessionID] {
		return 0, false
	}
	if forced, ok := s.telephoneEventFor[sessionID]; ok {
		return forced, true
	}
	return rtp.PayloadTypeTelephoneEvent, true
}

// forceTenancy makes a live session report an org and call the control surface would never have
// accepted, so the recording path's own guard can be tested rather than assumed.
func (s *stubSessions) forceTenancy(sessionID, orgID, callID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tenancy == nil {
		s.tenancy = make(map[string][2]string)
	}
	s.tenancy[sessionID] = [2]string{orgID, callID}
}

func (s *stubSessions) SessionTenancy(sessionID string) (string, string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.live[sessionID] {
		return "", "", false
	}
	if forced, ok := s.tenancy[sessionID]; ok {
		return forced[0], forced[1], true
	}
	return testOrg, testCall, true
}

func (s *stubSessions) dtmfCalls() []dtmfCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.dtmfSends)
}

func (s *stubSessions) recordingCalls() []recordingCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.recordingStarts)
}

func (s *stubSessions) playbackCalls() []playbackCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.playbackStarts)
}

func (s *stubSessions) tapCalls() []rtp.TapOptions {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.taps)
}

func (s *stubSessions) directionCalls() []directionCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.directions)
}

func (s *stubSessions) allocateCalls() []rtp.AllocateOptions {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.allocated)
}

type rig struct {
	server   *control.Server
	sessions *stubSessions
	dir      *directory.FakeStore
	// prompts is the directory MEDIAD_SOUNDS_DIR points at, so a playback test can write a fixture.
	prompts string
	// recordings is the directory MEDIAD_RECORDINGS_DIR points at; the stub packet path never opens a
	// file, so a recording test asserts on the object key the handler derived.
	recordings string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	return newRigWithLibrary(t, t.TempDir())
}

// newRigWithLibrary builds a rig whose prompt library is rooted at `prompts`. An empty root is a
// deployment that has not mounted a prompt store, which must refuse every playback by name.
func newRigWithLibrary(t *testing.T, prompts string) *rig {
	t.Helper()
	return newRigWith(t, prompts, t.TempDir())
}

// newRigWith builds a rig with both mounts named. An empty root for either is a deployment that has
// not mounted that store, which must refuse the matching command by name rather than answer `ok`.
func newRigWith(t *testing.T, prompts, recordings string) *rig {
	t.Helper()
	sessions := newStub()
	dir := directory.NewFakeStore()
	// Discard logs: the refusal paths log at WARN, and a passing suite should be silent.
	server, err := control.NewServer(control.ServerOptions{
		Sessions:      sessions,
		Directory:     dir,
		Library:       audio.NewLibrary(prompts),
		RecordingsDir: recordings,
		InstanceID:    thisNode,
		PublicAddr:    netip.MustParseAddr("203.0.113.10"),
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	return &rig{server: server, sessions: sessions, dir: dir, prompts: prompts, recordings: recordings}
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

// The handler parses the offer once and reads the transport off the parse. An offer that is BOTH on
// an unsupported transport and free of any codec mediad carries must still be refused for the
// transport: the engine's recovery differs, and the transport is the cheaper thing to fix.
func TestAnUnsupportedTransportIsRefusedAheadOfTheCodecs(t *testing.T) {
	offer := strings.NewReplacer(
		"m=audio 41000 RTP/AVP 0 8 101", "m=audio 41000 SCTP/DTLS 96",
		"a=rtpmap:0 PCMU/8000", "a=rtpmap:96 AMR-WB/16000",
		"a=rtpmap:8 PCMA/8000", "a=rtpmap:97 iLBC/8000",
	).Replace(offerBody)

	r := newRig(t)
	request := validAllocate()
	request.SDPOffer = offer
	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, request)))

	if response.Ok {
		t.Fatal("allocate accepted an offer on an unsupported transport")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
		t.Errorf("reason = %v, want %q", response.Reason, control.ReasonNotSupported)
	}
	if response.Error == nil || !strings.Contains(*response.Error, "unsupported audio transport") {
		t.Errorf("error = %v; it should name the transport, not the codecs", response.Error)
	}
}

// A malformed direction is refused before the offer's codecs are judged, unchanged by the single
// parse: the two errors reach the engine through different reason codes.
func TestABadDirectionIsRefusedAheadOfTheCodecs(t *testing.T) {
	offer := strings.NewReplacer(
		"a=rtpmap:0 PCMU/8000", "a=rtpmap:96 AMR-WB/16000",
		"a=rtpmap:8 PCMA/8000", "a=rtpmap:97 iLBC/8000",
		"m=audio 41000 RTP/AVP 0 8 101", "m=audio 41000 RTP/AVP 96 97",
	).Replace(offerBody)

	r := newRig(t)
	request := validAllocate()
	request.SDPOffer = offer
	request.Direction = "duplex"
	response := decodeAllocate(t, r.server.HandleAllocateSession(mustJSON(t, request)))

	if response.Ok {
		t.Fatal("allocate accepted an unknown direction")
	}
	if response.Reason == nil || string(*response.Reason) != control.ReasonBadRequest {
		t.Errorf("reason = %v, want %q", response.Reason, control.ReasonBadRequest)
	}
}

func TestAllocateRefusals(t *testing.T) {
	noCommonCodec := strings.NewReplacer(
		"m=audio 41000 RTP/AVP 0 8 101", "m=audio 41000 RTP/AVP 96 97",
		"a=rtpmap:0 PCMU/8000", "a=rtpmap:96 AMR-WB/16000",
		"a=rtpmap:8 PCMA/8000", "a=rtpmap:97 iLBC/8000",
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
			// Both tenancy tokens become DIRECTORIES under the recordings root, so a dot-segment in
			// either is a path traversal: filepath.Join cleans `../` rather than refusing it, and a
			// recording started on this session would then be written outside the root entirely.
			name:       "org id that escapes the recordings root",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.OrgID = "../../../etc" },
			wantReason: control.ReasonBadRequest,
		},
		{
			name:       "call id that escapes the recordings root",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.CallID = ".." },
			wantReason: control.ReasonBadRequest,
		},
		{
			name:       "call id with a path separator",
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.CallID = "a/b" },
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
			mutate:     func(rq *contract.MediaAllocateSessionRequest) { rq.SDPOffer = noCommonCodec },
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
	// The CEILING: a room this mixer cannot hold is a not-supported refusal that names the reason,
	// because the engine's recovery for it is the one every capability gap gets.
	t.Run("a room larger than the mixer holds", func(t *testing.T) {
		r := newRig(t)
		ids := make([]string, 9)
		for i := range ids {
			ids[i] = "leg-" + string(rune('a'+i))
		}
		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{BridgeID: "bridge-1", SessionIDs: ids})))
		if response.Ok {
			t.Fatal("a nine-member room was accepted")
		}
		if response.Reason == nil || string(*response.Reason) != control.ReasonNotSupported {
			t.Errorf("reason = %v, want not_supported", response.Reason)
		}
		if response.Error == nil || !strings.Contains(*response.Error, "running-sum") {
			// A not-supported refusal must name what is missing, so the reader knows whether to wait
			// for it or design around it.
			t.Errorf("the refusal does not name the missing capability: %v", response.Error)
		}
	})

	t.Run("fewer than two is not a conversation", func(t *testing.T) {
		r := newRig(t)
		response := decodeBridge(t, r.server.HandleBridgeSessions(
			mustJSON(t, contract.MediaBridgeSessionsRequest{
				BridgeID:   "bridge-1",
				SessionIDs: []string{"a"},
			})))
		if response.Ok || response.Reason == nil || string(*response.Reason) != control.ReasonBadRequest {
			t.Errorf("a one-session bridge was not refused as bad_request: %+v", response)
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

func (s *stubSessions) muteCalls() []muteCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.mutes)
}

func (s *stubSessions) holdCalls() []holdCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.holds)
}

func (s *stubSessions) joinCalls() []joinCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.joins)
}

func (s *stubSessions) destroyedConferences() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.destroyed)
}

// bridgeCallsMade is the two-party RELAY path's record. A room must not go down it: two members
// relay byte for byte with no buffer and no decode, and three cannot.
func (s *stubSessions) bridgeCallsMade() []bridgeCall {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.bridged)
}
