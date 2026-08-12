package rtp_test

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	pionrtp "github.com/pion/rtp"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/rtp"
)

// The bridge suite drives REAL sockets over loopback rather than a mocked packet path.
//
// A relay is three things — a peer pointer, a header rewrite and a WriteToUDP — and two of them are
// only observable on the wire. A test with a fake socket would assert that we called a method,
// which is precisely the assertion that stays green when the bytes are wrong.

// bridgeRig is two sessions on one manager, each with a far end standing in for a phone.
type bridgeRig struct {
	manager *rtp.Manager
	aID     string
	bID     string
	aPort   int
	bPort   int
	aPhone  *phone
	bPhone  *phone
}

// phone is a UDP socket that sends RTP to a session and reads what comes back.
type phone struct {
	conn    *net.UDPConn
	session *net.UDPAddr
}

func newPhone(t *testing.T, sessionPort int) *phone {
	t.Helper()
	conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0})
	if err != nil {
		t.Fatalf("binding a far end: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return &phone{
		conn:    conn,
		session: &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: sessionPort},
	}
}

// send puts one RTP packet on the wire, as a phone would.
func (p *phone) send(t *testing.T, packet pionrtp.Packet) {
	t.Helper()
	encoded, err := packet.Marshal()
	if err != nil {
		t.Fatalf("marshalling a packet: %v", err)
	}
	if _, err := p.conn.WriteToUDP(encoded, p.session); err != nil {
		t.Fatalf("sending to the session: %v", err)
	}
}

// receive waits for one packet, or reports that none arrived.
func (p *phone) receive(t *testing.T) (pionrtp.Packet, bool) {
	t.Helper()
	if err := p.conn.SetReadDeadline(time.Now().Add(bridgeReadTimeout)); err != nil {
		t.Fatalf("setting a read deadline: %v", err)
	}
	buf := make([]byte, 1500)
	n, _, err := p.conn.ReadFromUDP(buf)
	if err != nil {
		return pionrtp.Packet{}, false
	}
	var packet pionrtp.Packet
	if err := packet.Unmarshal(buf[:n]); err != nil {
		t.Fatalf("the relayed bytes are not RTP: %v", err)
	}
	return packet, true
}

const bridgeReadTimeout = 500 * time.Millisecond

func newBridgeRig(t *testing.T, low, high int) *bridgeRig {
	t.Helper()
	return newBridgeRigWithTypes(t, low, high,
		rtp.PayloadTypePCMU, rtp.PayloadTypeTelephoneEvent,
		rtp.PayloadTypePCMU, rtp.PayloadTypeTelephoneEvent)
}

func newBridgeRigWithTypes(
	t *testing.T,
	low, high int,
	aAudio, aTelephone, bAudio, bTelephone uint8,
) *bridgeRig {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})

	a, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-a", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: aAudio, TelephoneEventPayloadType: aTelephone,
	})
	if err != nil {
		t.Fatalf("allocating leg A: %v", err)
	}
	b, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-b", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: bAudio, TelephoneEventPayloadType: bTelephone,
	})
	if err != nil {
		t.Fatalf("allocating leg B: %v", err)
	}

	return &bridgeRig{
		manager: manager,
		aID:     a.SessionID, bID: b.SessionID,
		aPort: a.RTPPort, bPort: b.RTPPort,
		aPhone: newPhone(t, a.RTPPort),
		bPhone: newPhone(t, b.RTPPort),
	}
}

// latch makes both sessions learn their far ends, which is a precondition for any forwarding: a
// session with no latched remote has nowhere to send. One packet each side, exactly as a real call
// starts.
func (r *bridgeRig) latch(t *testing.T) {
	t.Helper()
	r.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0xff},
	})
	r.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0xff},
	})
	// Both packets arrive before the bridge exists, so neither is forwarded; they exist purely to
	// teach each session where its own phone is.
	waitFor(t, "both sessions latched onto their far ends", func() bool {
		a, aOK := r.manager.Get(r.aID)
		b, bOK := r.manager.Get(r.bID)
		return aOK && bOK && a.Remote() != nil && b.Remote() != nil
	})
}

func TestBridgeRelaysAudioBothWays(t *testing.T) {
	rig := newBridgeRig(t, 56000, 56019)
	rig.latch(t)

	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	// A → B.
	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111, SequenceNumber: 7, Timestamp: 160},
		Payload: []byte{0x01, 0x02, 0x03},
	})
	got, ok := rig.bPhone.receive(t)
	if !ok {
		t.Fatal("leg B heard nothing: a bridged relay did not forward")
	}
	if string(got.Payload) != string([]byte{0x01, 0x02, 0x03}) {
		t.Errorf("payload = %v, want the sender's bytes verbatim: v1 is passthrough", got.Payload)
	}
	if got.Timestamp != 160 {
		// A relay does not resample, so the sampling instant is still true. Rewriting it would be
		// inventing a clock.
		t.Errorf("Timestamp = %d, want the original 160", got.Timestamp)
	}
	if got.SequenceNumber == 7 {
		// Passing the sender's numbers through would make the sequence space jump on a re-bridge,
		// which a jitter buffer reads as catastrophic loss.
		t.Error("SequenceNumber was passed through; it must be the outgoing session's own")
	}
	if got.SSRC == 111 {
		t.Error("SSRC was passed through; each leg must see one stable synchronisation source")
	}

	// B → A, on the same bridge.
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0x09},
	})
	back, ok := rig.aPhone.receive(t)
	if !ok {
		t.Fatal("leg A heard nothing: the relay is not bidirectional")
	}
	if string(back.Payload) != string([]byte{0x09}) {
		t.Errorf("reverse payload = %v, want 0x09", back.Payload)
	}
}

// Each leg must see ONE synchronisation source for its whole life, and consecutive sequence
// numbers. This is the property an endpoint's jitter buffer is built around.
func TestBridgeGivesEachLegOneStableStream(t *testing.T) {
	rig := newBridgeRig(t, 56020, 56039)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	var ssrc uint32
	var previous uint16
	for i := 0; i < 3; i++ {
		rig.aPhone.send(t, pionrtp.Packet{
			// The sender's own numbers jump around; the relay's must not.
			Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111, SequenceNumber: uint16(1000 * i)},
			Payload: []byte{byte(i)},
		})
		got, ok := rig.bPhone.receive(t)
		if !ok {
			t.Fatalf("packet %d was not relayed", i)
		}
		if i == 0 {
			ssrc, previous = got.SSRC, got.SequenceNumber
			continue
		}
		if got.SSRC != ssrc {
			t.Errorf("packet %d changed SSRC from %d to %d", i, ssrc, got.SSRC)
		}
		if got.SequenceNumber != previous+1 {
			t.Errorf("packet %d has sequence %d, want %d", i, got.SequenceNumber, previous+1)
		}
		previous = got.SequenceNumber
	}
}

// DTMF is the reason rung 3 is nearly free: a telephone-event payload is bytes to a relay. What is
// NOT free is the payload-type number, which the two legs routinely negotiate differently.
func TestBridgeTranslatesTheTelephoneEventPayloadType(t *testing.T) {
	rig := newBridgeRigWithTypes(t, 56040, 56059,
		rtp.PayloadTypePCMU, 101, // leg A negotiated 101
		rtp.PayloadTypePCMU, 96) // leg B negotiated 96
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	// RFC 4733 digit 5, start of event: the marker bit is the start-of-digit flag.
	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: 101, SSRC: 111, Marker: true},
		Payload: []byte{0x05, 0x0a, 0x00, 0xa0},
	})

	got, ok := rig.bPhone.receive(t)
	if !ok {
		t.Fatal("the DTMF event was not relayed")
	}
	if got.PayloadType != 96 {
		t.Errorf("PayloadType = %d, want 96: the peer negotiated 96 and would drop 101",
			got.PayloadType)
	}
	if !got.Marker {
		t.Error("the marker bit was dropped; without it a keypress is undetectable")
	}
	if string(got.Payload) != string([]byte{0x05, 0x0a, 0x00, 0xa0}) {
		t.Errorf("payload = %v, want the RFC 4733 event verbatim", got.Payload)
	}
}

// A leg that never negotiated telephone-event has no number to send DTMF under. Dropping is the
// only safe answer: an RFC 4733 payload rendered as G.711 is a loud click.
func TestBridgeDropsDTMFWhenThePeerNegotiatedNone(t *testing.T) {
	rig := newBridgeRigWithTypes(t, 56060, 56079,
		rtp.PayloadTypePCMU, 101,
		rtp.PayloadTypePCMU, 0)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: 101, SSRC: 111, Marker: true},
		Payload: []byte{0x05, 0x0a, 0x00, 0xa0},
	})
	if _, ok := rig.bPhone.receive(t); ok {
		t.Error("a telephone-event was relayed to a leg that never negotiated one")
	}

	// Audio on the same bridge still flows: the drop is per-payload-type, not a broken relay.
	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0x42},
	})
	if _, ok := rig.bPhone.receive(t); !ok {
		t.Error("audio stopped flowing after a dropped DTMF event")
	}
}

func TestUnbridgeStopsTheRelayAndLeavesBothSessionsAlive(t *testing.T) {
	rig := newBridgeRig(t, 56080, 56099)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	sessions, unbridged := rig.manager.Unbridge("bridge-1")
	if !unbridged {
		t.Fatal("Unbridge reported nothing to unbridge")
	}
	if len(sessions) != 2 {
		t.Errorf("Unbridge returned %v, want both session ids", sessions)
	}

	// Separating legs is NOT hanging them up: an attended transfer takes a leg out of one bridge
	// and puts it in another.
	if _, ok := rig.manager.Get(rig.aID); !ok {
		t.Error("leg A was torn down by an unbridge")
	}
	if _, ok := rig.manager.Get(rig.bID); !ok {
		t.Error("leg B was torn down by an unbridge")
	}

	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0x01},
	})
	if _, ok := rig.bPhone.receive(t); ok {
		t.Error("audio still flowed after an unbridge")
	}
}

// Idempotent, for the same reason allocate is: the engine's retry after a timeout is
// indistinguishable from a fresh request at this layer.
func TestUnbridgeIsIdempotent(t *testing.T) {
	rig := newBridgeRig(t, 56100, 56119)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}
	if _, unbridged := rig.manager.Unbridge("bridge-1"); !unbridged {
		t.Fatal("the first unbridge reported nothing to do")
	}
	sessions, unbridged := rig.manager.Unbridge("bridge-1")
	if unbridged {
		t.Error("the second unbridge claimed to have done something")
	}
	if len(sessions) != 0 {
		t.Errorf("a repeat unbridge returned %v, want nothing", sessions)
	}
}

// Re-bridging a session that is already in a bridge MOVES it. That is an attended transfer, and
// refusing it would force the engine to unbridge first, which the caller hears as a gap.
func TestBridgeRepointsASessionAndDetachesTheOldPeer(t *testing.T) {
	rig := newBridgeRig(t, 56120, 56159)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	third, err := rig.manager.Allocate(rtp.AllocateOptions{
		SessionID: "leg-c", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		t.Fatalf("allocating leg C: %v", err)
	}
	cPhone := newPhone(t, third.RTPPort)
	cPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 333},
		Payload: []byte{0xff},
	})
	waitFor(t, "leg C latched onto its far end", func() bool {
		session, ok := rig.manager.Get("leg-c")
		return ok && session.Remote() != nil
	})

	if err := rig.manager.Bridge("bridge-2", rig.aID, "leg-c"); err != nil {
		t.Fatalf("re-bridging leg A: %v", err)
	}

	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0x77},
	})
	if _, ok := cPhone.receive(t); !ok {
		t.Error("leg C heard nothing after the re-bridge")
	}
	if _, ok := rig.bPhone.receive(t); ok {
		t.Error("leg B still hears leg A: the old peer pointer was not cleared")
	}
	// The old bridge is gone rather than dangling.
	if _, stillThere := rig.manager.Unbridge("bridge-1"); stillThere {
		t.Error("the superseded bridge is still registered")
	}
}

// Releasing one half of a bridge stops the relay and leaves the survivor ALLOCATED. That is the
// shape of "one party hung up": the engine decides whether the survivor hears a prompt, is
// re-bridged, or is released in turn.
func TestReleasingOneLegTearsDownTheRelayAndKeepsTheOther(t *testing.T) {
	rig := newBridgeRig(t, 56160, 56179)
	rig.latch(t)
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	if !rig.manager.Release(rig.bID) {
		t.Fatal("Release reported nothing to release")
	}
	survivor, ok := rig.manager.Get(rig.aID)
	if !ok {
		t.Fatal("releasing one leg tore down the other")
	}
	if survivor.Peer() != nil {
		t.Error("the survivor still points at the released session")
	}
	if _, stillThere := rig.manager.Unbridge("bridge-1"); stillThere {
		t.Error("the bridge outlived one of its sessions")
	}
}

func TestBridgeRefusals(t *testing.T) {
	t.Run("unknown session", func(t *testing.T) {
		rig := newBridgeRig(t, 56180, 56199)
		err := rig.manager.Bridge("bridge-1", rig.aID, "nobody")
		if !errors.Is(err, rtp.ErrUnknownSession) {
			t.Errorf("Bridge error = %v, want ErrUnknownSession", err)
		}
	})

	t.Run("a codec mismatch is now TRANSLATED rather than refused", func(t *testing.T) {
		// RUNG 7 CHANGED THIS ASSERTION, and the change is the rung. Design doc §7 said "a codec
		// mismatch is resolved in SDP negotiation by refusing the offer, not in the media path by
		// resampling", which was right while there was no decode path anywhere in the service. Rung 6
		// built one for the mixer, so the premise is gone and the refusal with it: the bridge is
		// accepted and a translation is installed on each direction.
		rig := newBridgeRigWithTypes(t, 56200, 56219,
			rtp.PayloadTypePCMU, 101,
			rtp.PayloadTypePCMA, 101)
		if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
			t.Fatalf("Bridge: %v", err)
		}

		a, _ := rig.manager.Get(rig.aID)
		b, _ := rig.manager.Get(rig.bID)
		if a.Transcoder() == nil || b.Transcoder() == nil {
			t.Fatal("a mismatched bridge installed no translation, so one party would hear noise")
		}
		if got := a.Transcoder().To(); got != audio.FormatULaw {
			t.Errorf("the A leg is fed %s, want PCMU: a transcoder is installed on its DESTINATION", got)
		}
		if got := b.Transcoder().To(); got != audio.FormatALaw {
			t.Errorf("the B leg is fed %s, want PCMA", got)
		}
	})

	t.Run("two legs that agreed keep the passthrough fast path", func(t *testing.T) {
		// The other half of the rung, and the more important one: rung 7 must not slow rung 2 down.
		// A nil transcoder is what makes `forward` copy the payload byte for byte.
		rig := newBridgeRig(t, 56260, 56279)
		if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
			t.Fatalf("Bridge: %v", err)
		}
		a, _ := rig.manager.Get(rig.aID)
		if a.Transcoder() != nil {
			t.Error("two agreeing legs installed a transcoder; passthrough is the fast path")
		}
	})

	t.Run("a session cannot bridge to itself", func(t *testing.T) {
		rig := newBridgeRig(t, 56220, 56239)
		if err := rig.manager.Bridge("bridge-1", rig.aID, rig.aID); err == nil {
			t.Error("Bridge accepted a session relaying to itself")
		}
	})

	t.Run("missing ids", func(t *testing.T) {
		rig := newBridgeRig(t, 56240, 56259)
		if err := rig.manager.Bridge("", rig.aID, rig.bID); err == nil {
			t.Error("Bridge accepted an empty bridge id")
		}
		if err := rig.manager.Bridge("bridge-1", rig.aID, ""); err == nil {
			t.Error("Bridge accepted an empty session id")
		}
	})
}

// A session with a peer but NO latched far end on the peer's side has nowhere to send. It must drop
// rather than panic, and it must self-correct the moment that side speaks.
func TestRelayWaitsForThePeerToLatch(t *testing.T) {
	rig := newBridgeRig(t, 56260, 56279)

	// Only A speaks, so only A is latched.
	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0xff},
	})
	waitFor(t, "the talking session recorded its packet", func() bool {
		session, ok := rig.manager.Get(rig.aID)
		return ok && session.Remote() != nil
	})
	if err := rig.manager.Bridge("bridge-1", rig.aID, rig.bID); err != nil {
		t.Fatalf("Bridge: %v", err)
	}

	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0x01},
	})
	if _, ok := rig.bPhone.receive(t); ok {
		t.Error("something was sent to a far end nobody has learned yet")
	}

	// B speaks; the relay starts working with no further command.
	rig.bPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 222},
		Payload: []byte{0xff},
	})
	waitFor(t, "leg B latched onto its far end", func() bool {
		session, ok := rig.manager.Get(rig.bID)
		return ok && session.Remote() != nil
	})
	rig.aPhone.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0x02},
	})
	if _, ok := rig.bPhone.receive(t); !ok {
		t.Error("the relay did not start once the far end latched")
	}
}

// recordingLifecycle captures what the packet path announces.
type recordingLifecycle struct {
	mu         sync.Mutex
	ended      []endedCall
	timedOut   []timeoutCall
	playbacks  []rtp.PlaybackSummary
	recordings []rtp.RecordingSummary
	digits     []rtp.DtmfDigit
}

type endedCall struct {
	summary rtp.SessionSummary
	reason  rtp.EndReason
}

type timeoutCall struct {
	summary   rtp.SessionSummary
	silentFor time.Duration
}

func (l *recordingLifecycle) SessionEnded(summary rtp.SessionSummary, reason rtp.EndReason) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.ended = append(l.ended, endedCall{summary, reason})
}

func (l *recordingLifecycle) RTPTimedOut(summary rtp.SessionSummary, silentFor time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.timedOut = append(l.timedOut, timeoutCall{summary, silentFor})
}

func (l *recordingLifecycle) PlaybackFinished(_ rtp.SessionSummary, playback rtp.PlaybackSummary) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.playbacks = append(l.playbacks, playback)
}

func (l *recordingLifecycle) RecordingFinished(_ rtp.SessionSummary, recording rtp.RecordingSummary) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.recordings = append(l.recordings, recording)
}

func (l *recordingLifecycle) DtmfReceived(_ rtp.SessionSummary, digit rtp.DtmfDigit) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.digits = append(l.digits, digit)
}

// detectedDigits copies out the keypresses the packet path announced.
func (l *recordingLifecycle) detectedDigits() []rtp.DtmfDigit {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]rtp.DtmfDigit(nil), l.digits...)
}

// recordingSummaries copies out what the packet path announced about finished recordings.
func (l *recordingLifecycle) recordingSummaries() []rtp.RecordingSummary {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]rtp.RecordingSummary(nil), l.recordings...)
}

// playbackSummaries copies out what the packet path announced about finished prompts.
func (l *recordingLifecycle) playbackSummaries() []rtp.PlaybackSummary {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]rtp.PlaybackSummary(nil), l.playbacks...)
}

func (l *recordingLifecycle) endedReasons() []rtp.EndReason {
	l.mu.Lock()
	defer l.mu.Unlock()
	reasons := make([]rtp.EndReason, 0, len(l.ended))
	for _, entry := range l.ended {
		reasons = append(reasons, entry.reason)
	}
	return reasons
}

func newLifecycleManager(
	t *testing.T,
	low, high int,
	idleAfter, rtpTimeout time.Duration,
	now func() time.Time,
) (*rtp.Manager, *recordingLifecycle) {
	t.Helper()

	allocator, err := rtp.NewAllocator(loopback, low, high)
	if err != nil {
		t.Fatalf("NewAllocator: %v", err)
	}
	lifecycle := &recordingLifecycle{}
	manager, err := rtp.NewManager(rtp.ManagerOptions{
		Allocator:  allocator,
		PublicAddr: publicAddr,
		IdleAfter:  idleAfter,
		RTPTimeout: rtpTimeout,
		Lifecycle:  lifecycle,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:        now,
	})
	if err != nil {
		t.Fatalf("NewManager: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		if err := manager.Drain(ctx); err != nil {
			t.Errorf("Drain: %v", err)
		}
	})
	return manager, lifecycle
}

// The two silences are DIFFERENT events, and conflating them would make every abandoned call setup
// look like a media failure.
func TestReaperSeparatesRTPTimeoutFromAnIdleLeak(t *testing.T) {
	clock := time.Now()
	manager, lifecycle := newLifecycleManager(t, 56300, 56339,
		time.Minute, 30*time.Second, func() time.Time { return clock })

	// A session that HEARD something and then stopped: a media failure on a live call.
	talked, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "talked", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	talker := newPhone(t, talked.RTPPort)
	talker.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0xff},
	})
	waitFor(t, "the talking session recorded its packet", func() bool {
		session, ok := manager.Get("talked")
		return ok && session.Stats().PacketsReceived == 1
	})

	// A session that never heard anything: a leaked port, not a media failure.
	if _, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "silent", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU,
	}); err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	// 45 s: past the 30 s RTP timeout, short of the 60 s idle backstop.
	clock = clock.Add(45 * time.Second)
	if reaped := manager.ReapIdle(); reaped != 1 {
		t.Fatalf("ReapIdle reaped %d sessions, want only the one that went silent", reaped)
	}

	lifecycle.mu.Lock()
	timeouts := len(lifecycle.timedOut)
	var timedOutID string
	if timeouts == 1 {
		timedOutID = lifecycle.timedOut[0].summary.SessionID
	}
	lifecycle.mu.Unlock()

	if timeouts != 1 || timedOutID != "talked" {
		t.Errorf("RTPTimedOut fired %d times for %q, want once for \"talked\"", timeouts, timedOutID)
	}
	if reasons := lifecycle.endedReasons(); len(reasons) != 1 || reasons[0] != rtp.EndReasonRTPTimeout {
		t.Errorf("ended reasons = %v, want one rtp-timeout", reasons)
	}
	if _, stillThere := manager.Get("silent"); !stillThere {
		t.Error("the never-latched session was reaped before its own, longer deadline")
	}

	// Past the idle backstop, the silent one goes too — as a LEAK, not as a media failure.
	clock = clock.Add(30 * time.Second)
	if reaped := manager.ReapIdle(); reaped != 1 {
		t.Fatalf("ReapIdle reaped %d sessions on the second pass, want 1", reaped)
	}
	reasons := lifecycle.endedReasons()
	if len(reasons) != 2 || reasons[1] != rtp.EndReasonIdleReaped {
		t.Errorf("ended reasons = %v, want [rtp-timeout idle-reaped]", reasons)
	}
	lifecycle.mu.Lock()
	moreTimeouts := len(lifecycle.timedOut)
	lifecycle.mu.Unlock()
	if moreTimeouts != 1 {
		t.Errorf("RTPTimedOut fired %d times, want 1: an idle leak is not a media failure", moreTimeouts)
	}
}

func TestReleaseAndDrainAnnounceTheirOwnReasons(t *testing.T) {
	manager, lifecycle := newLifecycleManager(t, 56340, 56379, 0, 0, nil)

	if _, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "released", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU,
	}); err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	if _, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "drained", OrgID: testOrg, CallID: testCall,
		AudioPayloadType: rtp.PayloadTypePCMU,
	}); err != nil {
		t.Fatalf("Allocate: %v", err)
	}

	manager.Release("released")

	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	if err := manager.Drain(ctx); err != nil {
		t.Fatalf("Drain: %v", err)
	}

	reasons := lifecycle.endedReasons()
	if len(reasons) != 2 {
		t.Fatalf("ended %d sessions, want 2: %v", len(reasons), reasons)
	}
	if reasons[0] != rtp.EndReasonReleased {
		t.Errorf("first reason = %q, want released", reasons[0])
	}
	if reasons[1] != rtp.EndReasonDrained {
		// "calls on this instance lose audio" is the honest description of a drain, and the event
		// says so rather than pretending the engine asked.
		t.Errorf("second reason = %q, want drained", reasons[1])
	}
}

// The summary a Lifecycle receives must be the session's FINAL state, taken before the close.
func TestSessionSummaryCarriesTheFinalCounters(t *testing.T) {
	manager, lifecycle := newLifecycleManager(t, 56380, 56399, 0, 0, nil)

	descriptor, err := manager.Allocate(rtp.AllocateOptions{
		SessionID: "counted", OrgID: testOrg, CallID: testCall, LegID: "leg-1",
		AudioPayloadType: rtp.PayloadTypePCMU,
	})
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	caller := newPhone(t, descriptor.RTPPort)
	caller.send(t, pionrtp.Packet{
		Header:  pionrtp.Header{Version: 2, PayloadType: rtp.PayloadTypePCMU, SSRC: 111},
		Payload: []byte{0xff},
	})
	waitFor(t, "the session recorded its packet", func() bool {
		session, ok := manager.Get("counted")
		return ok && session.Stats().PacketsReceived == 1
	})

	manager.Release("counted")

	lifecycle.mu.Lock()
	defer lifecycle.mu.Unlock()
	if len(lifecycle.ended) != 1 {
		t.Fatalf("ended %d sessions, want 1", len(lifecycle.ended))
	}
	summary := lifecycle.ended[0].summary
	if summary.Stats.PacketsReceived != 1 {
		t.Errorf("PacketsReceived = %d, want 1: the summary was taken after the close",
			summary.Stats.PacketsReceived)
	}
	if summary.OrgID != testOrg || summary.CallID != testCall || summary.LegID != "leg-1" {
		t.Errorf("summary attribution = %+v, want the allocate's org/call/leg", summary)
	}
	if summary.RTPPort != descriptor.RTPPort {
		t.Errorf("RTPPort = %d, want %d", summary.RTPPort, descriptor.RTPPort)
	}
	if summary.RemoteAddr == "" {
		t.Error("RemoteAddr is empty; the latched far end is what tells one silence from another")
	}
}
