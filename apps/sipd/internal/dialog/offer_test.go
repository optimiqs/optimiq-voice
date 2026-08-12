package dialog

import (
	"testing"
	"time"
)

// The media-level attribute wins over the session-level one (RFC 4566 §6.7). A reader that took the
// session-level value would report a held call as active and leave the caller listening to silence.
func TestDirectionOf(t *testing.T) {
	cases := []struct {
		name string
		sdp  string
		want Direction
	}{
		{
			name: "no attribute at all is sendrecv",
			sdp:  "v=0\r\nm=audio 40000 RTP/AVP 0\r\n",
			want: DirectionSendRecv,
		},
		{
			name: "a session-level attribute applies",
			sdp:  "v=0\r\na=inactive\r\nm=audio 40000 RTP/AVP 0\r\n",
			want: DirectionInactive,
		},
		{
			name: "the audio section overrides the session level",
			sdp:  "v=0\r\na=sendrecv\r\nm=audio 40000 RTP/AVP 0\r\na=sendonly\r\n",
			want: DirectionSendOnly,
		},
		{
			name: "a video section's direction is not taken for audio",
			sdp:  "v=0\r\na=sendrecv\r\nm=video 40002 RTP/AVP 96\r\na=inactive\r\nm=audio 40000 RTP/AVP 0\r\n",
			want: DirectionSendRecv,
		},
		{
			name: "bare LF line endings parse: not every stack sends CRLF",
			sdp:  "v=0\nm=audio 40000 RTP/AVP 0\na=recvonly\n",
			want: DirectionRecvOnly,
		},
		{
			name: "an unknown attribute is skipped rather than guessed at",
			sdp:  "v=0\r\nm=audio 40000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendonly\r\n",
			want: DirectionSendOnly,
		},
		{
			name: "an empty body is sendrecv",
			sdp:  "",
			want: DirectionSendRecv,
		},
		{
			name: "a body with no media section still honours the session level",
			sdp:  "v=0\r\na=inactive\r\n",
			want: DirectionInactive,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := DirectionOf([]byte(tc.sdp)); got != tc.want {
				t.Errorf("DirectionOf = %q, want %q", got, tc.want)
			}
		})
	}
}

// `sendonly` and `inactive` are hold; `recvonly` is a muted microphone and is not. The asymmetry
// catches people out, so it is asserted rather than assumed.
func TestDirectionHolds(t *testing.T) {
	cases := map[Direction]bool{
		DirectionSendRecv: false,
		DirectionSendOnly: true,
		DirectionRecvOnly: false,
		DirectionInactive: true,
	}
	for direction, want := range cases {
		t.Run(string(direction), func(t *testing.T) {
			if got := direction.Holds(); got != want {
				t.Errorf("Holds() = %v, want %v", got, want)
			}
			if !direction.Valid() {
				t.Errorf("%q must be a valid direction", direction)
			}
		})
	}
	if Direction("sideways").Valid() {
		t.Error("an invented direction must not be valid")
	}
}

// RFC 3261 §14.1: the higher Call-ID waits 2.1–4.0 seconds and the lower waits 0–2.0, so two ends
// that collide do not collide again.
func TestGlareBackoffRanges(t *testing.T) {
	cases := []struct {
		name     string
		higher   bool
		fraction float64
		wantMin  time.Duration
		wantMax  time.Duration
	}{
		{"the higher Call-ID at the bottom of its range", true, 0, 2100 * time.Millisecond, 2100 * time.Millisecond},
		{"the higher Call-ID at the top of its range", true, 0.999999, 3999 * time.Millisecond, 4000 * time.Millisecond},
		{"the lower Call-ID at the bottom of its range", false, 0, 0, 0},
		{"the lower Call-ID at the top of its range", false, 0.999999, 1999 * time.Millisecond, 2000 * time.Millisecond},
		{"a fraction below the range is clamped", true, -1, 2100 * time.Millisecond, 2100 * time.Millisecond},
		{"a fraction above the range is clamped", false, 5, 1999 * time.Millisecond, 2000 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := GlareBackoff(tc.higher, tc.fraction)
			if got < tc.wantMin || got > tc.wantMax {
				t.Errorf("GlareBackoff = %s, want between %s and %s", got, tc.wantMin, tc.wantMax)
			}
		})
	}
}

// The two ranges must not overlap, or the tie-break does not break the tie.
func TestGlareRangesDoNotOverlap(t *testing.T) {
	for _, fraction := range []float64{0, 0.25, 0.5, 0.75, 0.99} {
		lower := GlareBackoff(false, fraction)
		higher := GlareBackoff(true, fraction)
		if lower >= higher {
			t.Fatalf("at fraction %v the lower Call-ID waits %s and the higher waits %s", fraction, lower, higher)
		}
	}
	if GlareBackoff(false, 0.999999) >= GlareBackoff(true, 0) {
		t.Error("the top of the lower range must stay below the bottom of the higher one")
	}
}

func TestHasHigherCallID(t *testing.T) {
	cases := []struct {
		local, remote string
		want          bool
	}{
		{"b", "a", true},
		{"a", "b", false},
		{"a", "a", false},
		{"abc", "ab", true},
		// Byte comparison, not case-folded: both ends must reach the same answer from the same two
		// strings, and case folding is a rule the RFC does not state.
		{"A", "a", false},
	}
	for _, tc := range cases {
		t.Run(tc.local+" vs "+tc.remote, func(t *testing.T) {
			if got := HasHigherCallID(tc.local, tc.remote); got != tc.want {
				t.Errorf("HasHigherCallID(%q,%q) = %v, want %v", tc.local, tc.remote, got, tc.want)
			}
		})
	}
}

func TestOfferStateTracksHoldChangesOnly(t *testing.T) {
	state := offerState{}

	if changed, held := state.noteRemoteDirection(DirectionSendRecv); changed || held {
		t.Errorf("sendrecv on a fresh dialog: changed=%v held=%v, want false/false", changed, held)
	}
	if changed, held := state.noteRemoteDirection(DirectionSendOnly); !changed || !held {
		t.Errorf("moving to sendonly: changed=%v held=%v, want true/true", changed, held)
	}
	if changed, held := state.noteRemoteDirection(DirectionInactive); changed || !held {
		t.Errorf("sendonly to inactive is still held and is not a change: changed=%v held=%v", changed, held)
	}
	if changed, held := state.noteRemoteDirection(DirectionSendRecv); !changed || held {
		t.Errorf("resuming: changed=%v held=%v, want true/false", changed, held)
	}
}

func TestAckBodyIsEmptyWhenWeMadeTheOffer(t *testing.T) {
	offering := offerState{weOffered: true}
	offering.commitAnswer([]byte("v=0\r\n"))
	if offering.ackBody() != nil {
		t.Error("an ACK for a 2xx answering OUR offer carries no body")
	}

	late := offerState{}
	late.commitAnswer([]byte("v=0\r\n"))
	if string(late.ackBody()) != "v=0\r\n" {
		t.Error("an ACK for a late offer must carry our answer")
	}
}
