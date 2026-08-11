// Package sdp is mediad's half of media negotiation: it reads an offer and writes the answer.
//
// # Why this lives in mediad and nowhere else
//
// plans/mediad-design.md §5 draws the line. apps/sipd terminates SIP and hands the engine the SDP
// body as OPAQUE BYTES — it does not parse beyond what proxying needs and it never picks a codec.
// apps/engine decides what the call IS and couriers the bytes. mediad is the only process that
// knows which ports are free, which payload types it can really handle, and which address is
// reachable, so it is the only process that may answer. Anything else would be a second source of
// truth about mediad's own capabilities, held by a service that cannot check it.
//
// # What "negotiation" means at rung 2
//
// G.711 PASSTHROUGH. Bytes in, same bytes out (design doc §7). The answer therefore does exactly
// one interesting thing: pick ONE codec both ends have, and refuse the offer if there is none. A
// mismatch is resolved by refusing, never by resampling in the media path — that is precisely what
// makes bridged calls achievable without a DSP, a CPU cliff, or an audio-quality argument against
// Asterisk.
//
// RFC 4733 telephone-event rides alongside when the offer carries it. It is NEGOTIATED rather than
// assumed at 101: 101 is the de-facto value and it is not the universal one, and a session that
// forwarded DTMF under a payload type the far end never agreed to would produce digits the far end
// drops — an IVR that "randomly" ignores keypresses.
package sdp

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	pionsdp "github.com/pion/sdp/v3"
)

// Codec is a G.711 variant mediad can carry. v1 has no others; see the package doc.
type Codec string

const (
	// CodecPCMU is G.711 µ-law, RFC 3551 static payload type 0.
	CodecPCMU Codec = "PCMU"
	// CodecPCMA is G.711 A-law, RFC 3551 static payload type 8.
	CodecPCMA Codec = "PCMA"
)

// PayloadType is the static RTP payload type for a codec (RFC 3551 Table 4).
func (c Codec) PayloadType() uint8 {
	if c == CodecPCMA {
		return 8
	}
	return 0
}

// Direction is an SDP media direction attribute.
type Direction string

// The four direction attributes RFC 4566 §6 defines.
const (
	DirectionSendRecv Direction = "sendrecv"
	DirectionSendOnly Direction = "sendonly"
	DirectionRecvOnly Direction = "recvonly"
	DirectionInactive Direction = "inactive"
)

// ErrNoCommonCodec is returned when the offer contains no G.711 payload type.
//
// A distinct error because it is the one negotiation failure that is a CAPABILITY statement rather
// than a malformed input: the offer is perfectly valid and this media plane cannot serve it. The
// control surface turns it into a `not_supported` refusal, which tells the engine to route the leg
// to Asterisk rather than to retry here.
var ErrNoCommonCodec = errors.New("sdp: the offer carries no payload type mediad can handle (want PCMU or PCMA)")

// ErrNoAudio is returned when the offer has no `m=audio` line at all.
var ErrNoAudio = errors.New("sdp: the offer contains no audio media description")

// Offer is the subset of an inbound SDP offer that mediad acts on.
//
// Deliberately not the parsed SessionDescription: an offer carries thirty attributes and this
// service reads four. Carrying the whole thing would put every one of them into the shape the rest
// of mediad compiles against, and the ones nobody reads are exactly the ones that would be wrong.
type Offer struct {
	// Codec is the FIRST G.711 payload type the offerer listed, which is the one it prefers.
	//
	// Offer order is preference order (RFC 3264 §5.1) and honouring it is not politeness: an
	// endpoint that lists PCMA first is usually on a network where PCMA is what its hardware
	// encodes natively, and answering PCMU would make it transcode for no reason.
	Codec Codec
	// TelephoneEventPayloadType is the RFC 4733 dynamic type, when the offer negotiated one.
	// Zero means the offer carried none, and DTMF for this leg will be inband audio only.
	TelephoneEventPayloadType uint8
	// Direction is the offerer's direction attribute, defaulting to sendrecv per RFC 4566.
	Direction Direction
	// RemoteAddress is the `c=`/`m=` address the offerer ADVERTISED.
	//
	// Advisory only, and this is important: the session latches to the address packets actually
	// arrive FROM (symmetric RTP, RFC 4961), because behind NAT the advertised address is a private
	// one the endpoint sincerely believes in and the only one that works is the one the NAT
	// rewrote. This field exists for logs and for telling "the far end never sent" from "the far
	// end sent from somewhere else".
	RemoteAddress netip.AddrPort
}

// supportedStaticTypes maps the two G.711 static payload types to their codec.
var supportedStaticTypes = map[uint8]Codec{0: CodecPCMU, 8: CodecPCMA}

// ParseOffer reads an offer and extracts what mediad negotiates on.
//
// It is tolerant of everything it does not use — extra media sections, ICE candidates, unknown
// attributes — because an offer from a real phone is full of things this media plane has no opinion
// about, and refusing one over an attribute nobody reads would be refusing a call for no reason.
func ParseOffer(raw string) (Offer, error) {
	var description pionsdp.SessionDescription
	if err := description.UnmarshalString(raw); err != nil {
		return Offer{}, fmt.Errorf("sdp: parsing the offer: %w", err)
	}

	audio := firstAudioMedia(&description)
	if audio == nil {
		return Offer{}, ErrNoAudio
	}

	offer := Offer{Direction: directionOf(audio, &description)}

	// Dynamic payload types are only meaningful with an `a=rtpmap`, so both loops read the same
	// map: static ones are recognised by number, dynamic ones by encoding name.
	rtpmap := rtpmapOf(audio)

	for _, format := range audio.MediaName.Formats {
		payloadType, err := strconv.ParseUint(format, 10, 8)
		if err != nil {
			// A format token that is not a number is an application/* or a broken offer. Skipped
			// rather than fatal: the offer may still list a codec we can serve after it.
			continue
		}
		pt := uint8(payloadType)

		if offer.Codec == "" {
			if codec, ok := codecFor(pt, rtpmap); ok {
				offer.Codec = codec
			}
		}
		if offer.TelephoneEventPayloadType == 0 && isTelephoneEvent(pt, rtpmap) {
			offer.TelephoneEventPayloadType = pt
		}
	}

	if offer.Codec == "" {
		return Offer{}, ErrNoCommonCodec
	}

	offer.RemoteAddress = remoteAddressOf(audio, &description)
	return offer, nil
}

// codecFor resolves one payload type to a codec, by static number or by rtpmap encoding name.
//
// The rtpmap branch matters for a real reason: an endpoint may offer PCMU under a DYNAMIC payload
// type, which is legal, and reading only the static table would answer "no common codec" to an
// offer that plainly contains one.
func codecFor(pt uint8, rtpmap map[uint8]string) (Codec, bool) {
	if name, ok := rtpmap[pt]; ok {
		switch strings.ToUpper(name) {
		case "PCMU":
			return CodecPCMU, true
		case "PCMA":
			return CodecPCMA, true
		}
		// An rtpmap that names something else is authoritative: it OVERRIDES the static table, so a
		// payload type 0 remapped to another codec is not silently treated as PCMU.
		return "", false
	}
	codec, ok := supportedStaticTypes[pt]
	return codec, ok
}

func isTelephoneEvent(pt uint8, rtpmap map[uint8]string) bool {
	name, ok := rtpmap[pt]
	return ok && strings.EqualFold(name, "telephone-event")
}

// rtpmapOf indexes `a=rtpmap:<pt> <encoding>/<clock>` by payload type.
func rtpmapOf(media *pionsdp.MediaDescription) map[uint8]string {
	mapped := make(map[uint8]string, len(media.Attributes))
	for _, attribute := range media.Attributes {
		if attribute.Key != "rtpmap" {
			continue
		}
		payloadPart, encodingPart, found := strings.Cut(strings.TrimSpace(attribute.Value), " ")
		if !found {
			continue
		}
		pt, err := strconv.ParseUint(payloadPart, 10, 8)
		if err != nil {
			continue
		}
		encoding, _, _ := strings.Cut(encodingPart, "/")
		mapped[uint8(pt)] = encoding
	}
	return mapped
}

func firstAudioMedia(description *pionsdp.SessionDescription) *pionsdp.MediaDescription {
	for _, media := range description.MediaDescriptions {
		if media.MediaName.Media == "audio" {
			return media
		}
	}
	return nil
}

// directionOf reads the media-level direction, falling back to the session level and then to
// sendrecv, which is what RFC 4566 §6 says an absent attribute means.
func directionOf(
	media *pionsdp.MediaDescription,
	description *pionsdp.SessionDescription,
) Direction {
	for _, attributes := range [][]pionsdp.Attribute{media.Attributes, description.Attributes} {
		for _, attribute := range attributes {
			switch Direction(attribute.Key) {
			case DirectionSendRecv, DirectionSendOnly, DirectionRecvOnly, DirectionInactive:
				return Direction(attribute.Key)
			}
		}
	}
	return DirectionSendRecv
}

// remoteAddressOf reads the media-level `c=` line, falling back to the session-level one.
//
// A zero AddrPort when the offer holds a hostname rather than an address, or holds `0.0.0.0` (the
// classic "hold" offer). Neither is an error here — the value is advisory, and the session learns
// the real far end from the packets anyway.
func remoteAddressOf(
	media *pionsdp.MediaDescription,
	description *pionsdp.SessionDescription,
) netip.AddrPort {
	connection := media.ConnectionInformation
	if connection == nil || connection.Address == nil {
		connection = description.ConnectionInformation
	}
	if connection == nil || connection.Address == nil {
		return netip.AddrPort{}
	}
	// `c=IN IP4 203.0.113.9/127` — the TTL/multicast suffix is not part of the address.
	host, _, _ := strings.Cut(connection.Address.Address, "/")
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return netip.AddrPort{}
	}
	return netip.AddrPortFrom(addr.Unmap(), uint16(media.MediaName.Port.Value))
}

// Answer is everything needed to render mediad's reply to an offer.
type Answer struct {
	// SessionID and SessionVersion go in the `o=` line. Callers pass values derived from the
	// session so a re-answer of the same session is recognisable as one.
	SessionID      uint64
	SessionVersion uint64
	// Address is the PUBLIC address (MEDIAD_PUBLIC_IP), never the bind address. Getting this wrong
	// fails as one-way audio rather than as an error, which is why config refuses 0.0.0.0 for it.
	Address netip.Addr
	Port    int
	Codec   Codec
	// TelephoneEventPayloadType echoes the offer's, when it had one. Zero omits it entirely.
	TelephoneEventPayloadType uint8
	Direction                 Direction
}

// BuildAnswer renders the answer body.
//
// Written with a string builder rather than pion's marshaller on purpose. An SDP answer is
// line-oriented, twelve lines long, and every line here is a decision this file has to be able to
// justify; going through a generic object model would hide which of them mediad actually controls
// and make the golden test assert a library's formatting rather than this service's answer.
//
// The lines, and why each is what it is:
//
//	v=0                     RFC 4566 requires it and there is no other version.
//	o=- <id> <ver> IN IP4 … The origin's address is the PUBLIC one: some far ends key on it.
//	s=-                     No session name. `-` is the RFC's own "not applicable".
//	c=IN IP4 <public>       Where to send RTP.
//	t=0 0                   Unbounded — a call has no scheduled start or stop.
//	m=audio <port> RTP/AVP … ONE codec, plus telephone-event when it was offered. Answering with a
//	                        list would be answering with a question.
//	a=rtpmap:…              Spelled out even for the static types, because an endpoint that reads
//	                        rtpmap first and the static table never is a real endpoint.
//	a=fmtp:<te> 0-16        The DTMF events RFC 4733 §3.2 defines: digits, `*`, `#`, A-D, flash.
//	a=ptime:20              20 ms, the G.711 packetisation every SIP endpoint defaults to.
//	a=<direction>           The negotiated direction.
//	a=rtcp:<port+1>         Stated explicitly (RFC 3605) rather than left implicit, because an
//	                        endpoint behind a NAT that has to guess port+1 sometimes guesses wrong.
func BuildAnswer(answer Answer) string {
	port := answer.Port
	formats := strconv.Itoa(int(answer.Codec.PayloadType()))
	if answer.TelephoneEventPayloadType != 0 {
		formats += " " + strconv.Itoa(int(answer.TelephoneEventPayloadType))
	}

	var body strings.Builder
	body.WriteString("v=0\r\n")
	fmt.Fprintf(&body, "o=- %d %d IN IP4 %s\r\n",
		answer.SessionID, answer.SessionVersion, answer.Address)
	body.WriteString("s=-\r\n")
	fmt.Fprintf(&body, "c=IN IP4 %s\r\n", answer.Address)
	body.WriteString("t=0 0\r\n")
	fmt.Fprintf(&body, "m=audio %d RTP/AVP %s\r\n", port, formats)
	fmt.Fprintf(&body, "a=rtpmap:%d %s/8000\r\n", answer.Codec.PayloadType(), answer.Codec)
	if answer.TelephoneEventPayloadType != 0 {
		fmt.Fprintf(&body, "a=rtpmap:%d telephone-event/8000\r\n", answer.TelephoneEventPayloadType)
		fmt.Fprintf(&body, "a=fmtp:%d 0-16\r\n", answer.TelephoneEventPayloadType)
	}
	body.WriteString("a=ptime:20\r\n")
	fmt.Fprintf(&body, "a=%s\r\n", answer.Direction)
	fmt.Fprintf(&body, "a=rtcp:%d\r\n", port+1)
	return body.String()
}

// AnswerDirection is the direction to answer an offer with, given what the engine asked for.
//
// RFC 3264 §6.1: an answer's direction is the MIRROR of the offer's, intersected with what the
// answerer is willing to do. An offerer that said `sendonly` is not listening, so answering
// `sendrecv` would mean sending audio into a socket nobody reads.
//
// The engine's request wins where it is more restrictive, because the engine knows things the SDP
// does not — a leg that is ringing rather than answered should be `inactive` however enthusiastic
// its offer was.
func AnswerDirection(offered, requested Direction) Direction {
	if offered == DirectionInactive || requested == DirectionInactive {
		return DirectionInactive
	}
	mirrored := offered
	switch offered {
	case DirectionSendOnly:
		mirrored = DirectionRecvOnly
	case DirectionRecvOnly:
		mirrored = DirectionSendOnly
	}
	if requested != DirectionSendRecv && requested != mirrored {
		// The engine asked for something narrower than the mirror. Honour the engine.
		return requested
	}
	return mirrored
}

// ParseDirection validates a direction from the wire.
func ParseDirection(raw string) (Direction, error) {
	switch Direction(raw) {
	case DirectionSendRecv, DirectionSendOnly, DirectionRecvOnly, DirectionInactive:
		return Direction(raw), nil
	case "":
		return DirectionSendRecv, nil
	default:
		return "", fmt.Errorf("sdp: unknown media direction %q", raw)
	}
}
