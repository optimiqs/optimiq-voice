package dialog

import (
	"bytes"
	"strings"
	"time"
)

// Direction is the RFC 4566 §6 media direction attribute, from the point of view of whoever wrote
// the SDP.
//
// It is the ONLY thing this edge reads out of an SDP body: sipd holds no codec knowledge in either
// direction (design §5.2), but `dialog.held` and `dialog.resumed` can be learned nowhere else —
// mediad never sees the re-INVITE. The parser below is deliberately incapable of reading more.
type Direction string

const (
	// DirectionSendRecv is the default when no attribute appears at all (RFC 4566 §6.7).
	DirectionSendRecv Direction = "sendrecv"
	// DirectionSendOnly is the classic hold: "I will send, do not send to me".
	DirectionSendOnly Direction = "sendonly"
	// DirectionRecvOnly is the other half, and is NOT hold: a far end that will only receive is
	// still listening to us.
	DirectionRecvOnly Direction = "recvonly"
	// DirectionInactive is hold with no media at all, and the spelling most SIP phones send today.
	DirectionInactive Direction = "inactive"
)

// Holds reports whether this direction, as written by the FAR END, means the far end has put us on
// hold. The attribute describes what its AUTHOR will do, so `sendonly` and `inactive` are hold
// while `recvonly` — listening but sending nothing — is a muted microphone.
func (d Direction) Holds() bool {
	return d == DirectionSendOnly || d == DirectionInactive
}

// Valid reports whether the value is one of the four RFC 4566 directions.
func (d Direction) Valid() bool {
	switch d {
	case DirectionSendRecv, DirectionSendOnly, DirectionRecvOnly, DirectionInactive:
		return true
	default:
		return false
	}
}

// DirectionOf reads the media direction out of an SDP body.
//
// Precedence follows RFC 4566 §6.7, where a session-level attribute is only a default: the first
// AUDIO media section's own attribute wins, then the session-level one, then sendrecv. Non-audio
// sections are skipped rather than guessed from.
//
// An empty or unparsable body answers sendrecv, the safest wrong answer: calling a live call held
// would leave music-on-hold running for ever, where the reverse only loses a lamp.
func DirectionOf(sdp []byte) Direction {
	if len(sdp) == 0 {
		return DirectionSendRecv
	}

	sessionLevel := DirectionSendRecv
	sessionSeen := false
	inAudio := false
	sawMedia := false

	for raw := range bytes.SplitSeq(sdp, []byte("\n")) {
		line := strings.TrimRight(string(raw), "\r")
		switch {
		case strings.HasPrefix(line, "m="):
			sawMedia = true
			// `m=audio 49170 RTP/AVP 0` — only the media type is read, which is what keeps codec
			// knowledge out of this process.
			inAudio = strings.HasPrefix(line, "m=audio ") || line == "m=audio"
		case strings.HasPrefix(line, "a="):
			direction := Direction(strings.TrimSpace(strings.TrimPrefix(line, "a=")))
			if !direction.Valid() {
				continue
			}
			if !sawMedia {
				sessionLevel = direction
				sessionSeen = true
				continue
			}
			if inAudio {
				return direction
			}
		}
	}
	if sessionSeen {
		return sessionLevel
	}
	return DirectionSendRecv
}

// offerState is this dialog's offer/answer bookkeeping. The bytes are retained because RFC 3261
// §13.2.1 requires a 200 following a 183-with-an-answer to repeat THAT answer byte for byte;
// getting it wrong produces a call that connects with no audio.
type offerState struct {
	// answer is the SDP answer this side has committed to, if any.
	answer []byte
	// remoteDirection is the direction the far end last declared. It is what `dialog.held` and
	// `dialog.resumed` are derived from.
	remoteDirection Direction
	// localDirection is the direction WE last declared. It exists to make hold idempotent: a second
	// `hold` on a leg already held must not put a second re-INVITE on the wire, and the only way to
	// know is to remember what we last said.
	localDirection Direction
	// weOffered records whether OUR INVITE carried the offer. When it did, the ACK carries no body;
	// when it did not (a late offer, which this edge does not send but may receive), the ACK is
	// where our answer goes.
	weOffered bool
	// outstanding is the glare flag: an offer of ours is in flight and unanswered, so an offer
	// arriving from the far end must be refused 491 (RFC 3261 §14.2).
	outstanding bool
	// version counts committed offer/answer exchanges. It is what makes "is this the answer to the
	// offer I sent, or to the one before it" answerable at all.
	version uint64
}

// commitAnswer records the answer that has been (or is about to be) put on the wire.
func (o *offerState) commitAnswer(sdp []byte) {
	if len(sdp) == 0 {
		return
	}
	o.answer = bytes.Clone(sdp)
	o.version++
	o.outstanding = false
}

// committedAnswer returns the answer already committed, for the 200 that must repeat a 183's.
func (o *offerState) committedAnswer() []byte {
	if o.answer == nil {
		return nil
	}
	return bytes.Clone(o.answer)
}

// ackBody is what goes in the ACK for a 2xx: nothing when our INVITE carried the offer (every
// B-leg this edge places), our answer when the far end offered late.
func (o *offerState) ackBody() []byte {
	if o.weOffered {
		return nil
	}
	return o.committedAnswer()
}

// noteRemoteDirection records the far end's declared direction and reports whether it CHANGED the
// hold state. Only the change is worth an event: publishing `dialog.held` for a codec change or a
// NAT re-latch would start music-on-hold over a live call.
func (o *offerState) noteRemoteDirection(direction Direction) (changed bool, held bool) {
	previous := o.remoteDirection
	if previous == "" {
		previous = DirectionSendRecv
	}
	o.remoteDirection = direction
	return previous.Holds() != direction.Holds(), direction.Holds()
}

// GlareBackoff is RFC 3261 §14.1's retry interval for a re-INVITE that was refused 491. The two
// ends draw from different ranges so they cannot collide again, and which range is decided by
// comparing Call-IDs: the higher waits 2.1–4.0s, the lower 0–2.0s.
//
// `fraction` is a value in [0,1) — callers pass rand.Float64(), tests pass a constant.
func GlareBackoff(weHaveHigherCallID bool, fraction float64) time.Duration {
	fraction = min(max(fraction, 0), 0.999999)
	if weHaveHigherCallID {
		// 2.1 to 4.0 seconds.
		return time.Duration(float64(2100*time.Millisecond) + fraction*float64(1900*time.Millisecond))
	}
	// 0 to 2.0 seconds.
	return time.Duration(fraction * float64(2000*time.Millisecond))
}

// HasHigherCallID compares two Call-IDs the way RFC 3261 §14.1 means it: as octet strings —
// lexicographic on bytes, not on length and not case-folded.
func HasHigherCallID(local, remote string) bool {
	return strings.Compare(local, remote) > 0
}
