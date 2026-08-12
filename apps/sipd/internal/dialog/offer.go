package dialog

import (
	"bytes"
	"strings"
	"time"
)

// Direction is the RFC 4566 §6 media direction attribute, from the point of view of whoever wrote
// the SDP.
//
// # This is the ONLY thing this edge reads out of an SDP body
//
// sipd holds no codec knowledge in either direction: inbound it forwards an offer it does not
// parse, outbound it forwards an offer it did not write (design §5.2). A direction attribute is not
// a codec — it is the difference between `dialog.held` and `dialog.resumed`, which are two members
// of the event union the orchestrator branches on, and there is nowhere else to learn it. mediad
// cannot answer it because mediad never sees the re-INVITE; the engine cannot because the engine is
// a courier for bytes it does not open.
//
// So: direction attributes, nothing else, and the parser below is deliberately incapable of
// reading anything more.
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
// hold.
//
// `sendonly` and `inactive` are hold; `recvonly` is not. The asymmetry catches people out, so it is
// worth stating: the attribute describes what its AUTHOR will do. A far end that writes `sendonly`
// is saying "I will send you music and I will not listen", which is exactly hold. A far end that
// writes `recvonly` is saying "I am listening but sending nothing", which is a muted microphone.
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
// # The precedence rule, and why it is not "the last one wins"
//
// RFC 4566 §6.7: a direction attribute at the SESSION level is a default that each media section
// may override. A body with `a=sendrecv` at the top and `a=sendonly` on its one audio stream is a
// hold, and a reader that took the session-level value would report the call as active while the
// caller listens to silence.
//
// So: the first AUDIO media section's own attribute wins; failing that, the session-level one;
// failing that, sendrecv, which is what the absence of an attribute means. Non-audio sections are
// skipped entirely — a held call with a still-active video stream is not something this PBX has an
// opinion about, and taking video's direction for audio's would be a guess.
//
// An empty or unparsable body answers sendrecv. It is the safest wrong answer available: reporting
// an active call as held stops music-on-hold from ever ending, whereas reporting a held call as
// active loses a lamp.
func DirectionOf(sdp []byte) Direction {
	if len(sdp) == 0 {
		return DirectionSendRecv
	}

	sessionLevel := DirectionSendRecv
	sessionSeen := false
	inAudio := false
	sawMedia := false

	for _, raw := range bytes.Split(sdp, []byte("\n")) {
		line := strings.TrimRight(string(raw), "\r")
		switch {
		case strings.HasPrefix(line, "m="):
			sawMedia = true
			// `m=audio 49170 RTP/AVP 0` — the media type is the first token after `m=`. Nothing
			// else on the line is read, which is the property that keeps codecs out of this process.
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

// offerState is this dialog's offer/answer bookkeeping.
//
// It holds bytes and a direction and nothing else. The bytes exist for one reason — RFC 3261
// §13.2.1 requires a 200 that follows a 183-with-an-answer to repeat THAT answer, byte for byte —
// and getting that wrong produces a call that connects and has no audio, which is the defect class
// that is invisible at the moment it happens.
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
	o.answer = append([]byte(nil), sdp...)
	o.version++
	o.outstanding = false
}

// committedAnswer returns the answer already committed, for the 200 that must repeat a 183's.
func (o *offerState) committedAnswer() []byte {
	if o.answer == nil {
		return nil
	}
	return append([]byte(nil), o.answer...)
}

// ackBody is what goes in the ACK for a 2xx.
//
// Nothing, when our INVITE carried the offer — which is the case for every B-leg this edge places,
// because a body-less INVITE is refused or mishandled by a meaningful share of carriers and
// handsets (design §5.2's rejection of option C). Our answer, when the far end offered late.
func (o *offerState) ackBody() []byte {
	if o.weOffered {
		return nil
	}
	return o.committedAnswer()
}

// noteRemoteDirection records the far end's declared direction and reports whether it CHANGED the
// hold state, which is the only transition worth an event.
//
// Reporting every re-INVITE as a hold change would publish `dialog.held` for a codec change and a
// NAT re-latch, and the orchestrator would start music-on-hold over a live call.
func (o *offerState) noteRemoteDirection(direction Direction) (changed bool, held bool) {
	previous := o.remoteDirection
	if previous == "" {
		previous = DirectionSendRecv
	}
	o.remoteDirection = direction
	return previous.Holds() != direction.Holds(), direction.Holds()
}

// GlareBackoff is RFC 3261 §14.1's retry interval for a re-INVITE that was refused 491.
//
// The rule and the reason: the two ends pick from different ranges so they do not collide again,
// and WHICH range you use is decided by comparing Call-IDs, because that is the one value both
// ends agree on and neither chose together. The higher Call-ID waits 2.1–4.0 seconds; the lower
// waits 0–2.0. Without it, a hold issued at the same moment the far end holds produces two dialogs
// each believing they own an outstanding offer, and the call's media direction is whichever answer
// lands last (design §4.5).
//
// `fraction` is a value in [0,1) — a caller passes rand.Float64(), and a test passes a constant.
func GlareBackoff(weHaveHigherCallID bool, fraction float64) time.Duration {
	if fraction < 0 {
		fraction = 0
	}
	if fraction >= 1 {
		fraction = 0.999999
	}
	if weHaveHigherCallID {
		// 2.1 to 4.0 seconds.
		return time.Duration(float64(2100*time.Millisecond) + fraction*float64(1900*time.Millisecond))
	}
	// 0 to 2.0 seconds.
	return time.Duration(fraction * float64(2000*time.Millisecond))
}

// HasHigherCallID compares two Call-IDs the way RFC 3261 §14.1 means it: as octet strings.
//
// Lexicographic on bytes, not on length and not case-folded. A Call-ID is opaque and the only thing
// that matters is that both ends reach the same answer from the same two strings.
func HasHigherCallID(local, remote string) bool {
	return strings.Compare(local, remote) > 0
}
