// Package sdp is mediad's half of media negotiation: it reads an offer and writes the answer.
// mediad is the only process that knows which ports are free, which payload types it can handle and
// which address is reachable, so it is the only process that may answer. An answer names exactly one
// codec, refusing the offer when there is none in common; RFC 4733 telephone-event is negotiated
// from the offer rather than assumed at 101, since DTMF sent under an unagreed payload type is
// silently dropped by the far end.
package sdp

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	pionsdp "github.com/pion/sdp/v3"

	"github.com/optimiqs/optimiq-voice/apps/mediad/internal/audio"
)

// Codec is an audio format mediad can carry. PCMU, PCMA and G.722 can be transcoded and mixed;
// Opus can only be relayed byte-for-byte, since this build has no Opus codec, and anything that
// would require decoding it refuses by name.
type Codec string

const (
	// CodecPCMU is G.711 µ-law, RFC 3551 static payload type 0.
	CodecPCMU Codec = "PCMU"
	// CodecPCMA is G.711 A-law, RFC 3551 static payload type 8.
	CodecPCMA Codec = "PCMA"
	// CodecG722 is ITU-T G.722 at 64 kbit/s, RFC 3551 static payload type 9.
	CodecG722 Codec = "G722"
	// CodecOpus is RFC 6716 Opus. DYNAMIC payload type — it has no static number, so a session
	// carries whatever the offer used and the answer echoes it.
	CodecOpus Codec = "opus"
)

// preferenceOrder ranks codecs when the offerer expressed no preference. Offer order is preference
// order (RFC 3264 §5.1) and ParseOffer honours that first. Narrowband is listed first deliberately:
// a wideband leg costs a resample when mixed and a transcode when bridged to a narrowband one.
var preferenceOrder = []Codec{CodecPCMU, CodecPCMA, CodecG722, CodecOpus}

// PayloadType is the static RTP payload type for a codec (RFC 3551 Table 4). Zero for Opus, which
// is a dynamic type: a caller needing an Opus payload type must read Offer.AudioPayloadType.
func (c Codec) PayloadType() uint8 {
	switch c {
	case CodecPCMA:
		return 8
	case CodecG722:
		return 9
	case CodecOpus:
		return 0
	default:
		return 0
	}
}

// ClockRate is the RTP timestamp rate the codec's rtpmap advertises. 8000 for G.722 is not a typo:
// RFC 3551 §4.5.2 keeps the erroneous 8000 registration, so `G722/16000` is an interop bug.
func (c Codec) ClockRate() int {
	if c == CodecOpus {
		return 48000
	}
	return 8000
}

// Format maps a negotiated codec onto the DSP vocabulary internal/audio speaks.
func (c Codec) Format() audio.Format {
	switch c {
	case CodecPCMA:
		return audio.FormatALaw
	case CodecG722:
		return audio.FormatG722
	case CodecOpus:
		return audio.FormatOpus
	default:
		return audio.FormatULaw
	}
}

// CodecForFormat is the inverse, for a caller holding a session's DSP format.
func CodecForFormat(format audio.Format) Codec {
	switch format {
	case audio.FormatALaw:
		return CodecPCMA
	case audio.FormatG722:
		return CodecG722
	case audio.FormatOpus:
		return CodecOpus
	default:
		return CodecPCMU
	}
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

// ErrNoCommonCodec is returned when the offer carries no payload type mediad can handle. Distinct
// from a parse failure because the offer is valid: the control surface turns it into a
// `not_supported` refusal rather than a retry.
//
// The message lists preferenceOrder rather than a literal, so adding a codec cannot leave the
// refusal naming a stale set.
var ErrNoCommonCodec = errors.New("sdp: the offer carries no payload type mediad can handle (want " +
	strings.Join(codecNames(preferenceOrder), ", ") + ")")

// ErrNoPayloadType is returned when an answer names a dynamic codec with no payload type to answer
// it under. Opus has no static number, so rendering one anyway would put the answer on PT 0 — a
// malformed body the far end reads as PCMU.
var ErrNoPayloadType = errors.New("sdp: the answer names a dynamic codec with no payload type")

// codecNames renders codecs for a message.
func codecNames(codecs []Codec) []string {
	names := make([]string, len(codecs))
	for index, codec := range codecs {
		names[index] = string(codec)
	}
	return names
}

// ErrNoAudio is returned when the offer has no `m=audio` line at all.
var ErrNoAudio = errors.New("sdp: the offer contains no audio media description")

// Offer is the subset of an inbound SDP offer that mediad acts on.
type Offer struct {
	// Codec is the first supported payload type the offerer listed, which is the one it prefers:
	// offer order is preference order (RFC 3264 §5.1).
	Codec Codec
	// AudioPayloadType is the RTP payload type the chosen codec was offered under. Separate from
	// Codec.PayloadType() because Opus has no static number and must be answered under the offered
	// one; for the static codecs the two agree.
	AudioPayloadType uint8
	// TelephoneEventPayloadType is the RFC 4733 dynamic type, when the offer negotiated one.
	// Zero means the offer carried none, and DTMF for this leg will be inband audio only.
	TelephoneEventPayloadType uint8
	// OpusFmtp is the offerer's `a=fmtp` line for Opus, echoed back unchanged when one was given.
	// Echoed rather than negotiated: the parameters act on an Opus encoder, and this build has none.
	OpusFmtp string
	// Direction is the offerer's direction attribute, defaulting to sendrecv per RFC 4566.
	Direction Direction
	// RemoteAddress is the `c=`/`m=` address the offerer advertised. Advisory only: the session
	// latches to the address packets actually arrive from (symmetric RTP, RFC 4961), since behind NAT
	// the advertised address is private and only the NAT-rewritten one works.
	RemoteAddress netip.AddrPort
	// AudioProtocol is the transport of the audio section, upper-cased, as AudioProtocol returns it.
	// Carried here so the allocate path does not unmarshal the same offer twice.
	AudioProtocol string
	// Crypto is the offerer's SDES key (RFC 4568), read only for a SAVP transport. A zero value
	// means the offer carried no suite mediad can serve, and the answer must fall back to plain RTP.
	Crypto Crypto
}

// supportedStaticTypes maps the static payload types to their codec (RFC 3551 Table 4).
var supportedStaticTypes = map[uint8]Codec{0: CodecPCMU, 8: CodecPCMA, 9: CodecG722}

// ParseOffer reads an offer and extracts what mediad negotiates on. It is tolerant of everything it
// does not use — extra media sections, ICE candidates, unknown attributes — so a real phone's offer
// is never refused over an attribute nobody reads.
func ParseOffer(raw string) (Offer, error) {
	var description pionsdp.SessionDescription
	if err := description.UnmarshalString(raw); err != nil {
		return Offer{}, fmt.Errorf("sdp: parsing the offer: %w", err)
	}

	media := firstAudioMedia(&description)
	if media == nil {
		return Offer{}, ErrNoAudio
	}

	offer := Offer{Direction: directionOf(media, &description)}

	// Dynamic payload types are only meaningful with an `a=rtpmap`: static ones are recognised by
	// number, dynamic ones by encoding name.
	rtpmap := rtpmapOf(media)

	for _, format := range media.MediaName.Formats {
		payloadType, err := strconv.ParseUint(format, 10, 8)
		if err != nil {
			// A non-numeric format token is skipped rather than fatal: the offer may still list a
			// codec we can serve after it.
			continue
		}
		pt := uint8(payloadType)

		if offer.Codec == "" {
			if codec, ok := codecFor(pt, rtpmap); ok {
				// First wins: offer order is preference order (RFC 3264 §5.1), and it is the
				// offerer's preference to express.
				offer.Codec = codec
				offer.AudioPayloadType = pt
			}
		}
		if offer.TelephoneEventPayloadType == 0 && isTelephoneEvent(pt, rtpmap) {
			offer.TelephoneEventPayloadType = pt
		}
	}

	if offer.Codec == "" {
		return Offer{}, ErrNoCommonCodec
	}
	if offer.Codec == CodecOpus {
		offer.OpusFmtp = fmtpFor(media, offer.AudioPayloadType)
	}

	offer.RemoteAddress = remoteAddressOf(media, &description)
	offer.AudioProtocol = audioProtocolOf(media)
	if IsSecureProtocol(offer.AudioProtocol) {
		var err error
		// Only under SAVP: a crypto line on a plain RTP/AVP offer keys nothing, and refusing the
		// whole offer over a malformed one would break a leg that never asked for SRTP.
		if offer.Crypto, err = parseCrypto(media.Attributes); err != nil {
			return Offer{}, err
		}
	}
	return offer, nil
}

// audioProtocolOf renders one media section's transport the way AudioProtocol reports it.
func audioProtocolOf(media *pionsdp.MediaDescription) string {
	return strings.ToUpper(strings.Join(media.MediaName.Protos, "/"))
}

// sdpBodyHint is the capacity a rendered answer or offer is grown to up front; a real body is around
// three hundred bytes.
const sdpBodyHint = 512

// AudioProtocol is the transport of the first audio media section, before codec negotiation.
func AudioProtocol(raw string) (string, error) {
	var description pionsdp.SessionDescription
	if err := description.UnmarshalString(raw); err != nil {
		return "", err
	}
	media := firstAudioMedia(&description)
	if media == nil {
		return "", ErrNoAudio
	}
	return audioProtocolOf(media), nil
}

// codecFor resolves one payload type to a codec, by static number or by rtpmap encoding name. The
// rtpmap branch is required because offering PCMU under a dynamic payload type is legal.
func codecFor(pt uint8, rtpmap map[uint8]string) (Codec, bool) {
	if name, ok := rtpmap[pt]; ok {
		switch strings.ToUpper(name) {
		case "PCMU":
			return CodecPCMU, true
		case "PCMA":
			return CodecPCMA, true
		case "G722":
			return CodecG722, true
		case "OPUS":
			// Opus has no static number, so an rtpmap is the whole of its negotiation.
			return CodecOpus, true
		}
		// An rtpmap that names something else overrides the static table, so a payload type 0
		// remapped to another codec is not silently treated as PCMU.
		return "", false
	}
	codec, ok := supportedStaticTypes[pt]
	return codec, ok
}

// fmtpFor finds the `a=fmtp` line for one payload type, or an empty string.
func fmtpFor(media *pionsdp.MediaDescription, pt uint8) string {
	prefix := strconv.Itoa(int(pt)) + " "
	for _, attribute := range media.Attributes {
		if attribute.Key != "fmtp" {
			continue
		}
		if value := strings.TrimSpace(attribute.Value); strings.HasPrefix(value, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(value, prefix))
		}
	}
	return ""
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

// remoteAddressOf reads the media-level `c=` line, falling back to the session-level one. Returns a
// zero AddrPort for a hostname or an unparseable address; the value is advisory, since the session
// learns the real far end from the packets.
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
	// Address is the PUBLIC address (MEDIAD_PUBLIC_IP), never the bind address: getting it wrong
	// fails as one-way audio rather than as an error.
	Address netip.Addr
	Port    int
	Codec   Codec
	// AudioPayloadType is the number to answer the codec under. Zero falls back to the codec's own
	// static type — see Offer.AudioPayloadType. A dynamic codec has no static type, so zero there
	// is a caller error [Answer.Validate] reports.
	AudioPayloadType uint8
	// TelephoneEventPayloadType echoes the offer's, when it had one. Zero omits it entirely.
	TelephoneEventPayloadType uint8
	// OpusFmtp is echoed back when the offer carried one. Ignored for every other codec.
	OpusFmtp  string
	Direction Direction
	// Crypto is OUR key, with the tag of the offered crypto line it answers (RFC 4568 §5.1.2).
	// Zero renders a plain RTP/AVP answer, byte-for-byte as an unencrypted leg has always been.
	Crypto Crypto
}

// Validate reports whether the answer can be rendered. Call it before [BuildAnswer], which is a
// renderer and assumes a negotiated answer.
//
// The one case that cannot be rendered is a dynamic codec with no payload type: Opus takes its
// number from the offer, and Codec.PayloadType returns 0 for it, so a zero here would be rendered
// as PT 0 — which every far end reads as PCMU.
func (a Answer) Validate() error {
	if a.Codec == "" {
		return ErrNoCommonCodec
	}
	if a.AudioPayloadType == 0 && a.Codec.IsDynamic() {
		return fmt.Errorf("%w: %s must be answered under the payload type it was offered on",
			ErrNoPayloadType, a.Codec)
	}
	return nil
}

// IsDynamic reports whether the codec has no static payload type (RFC 3551 Table 4) and must
// therefore carry the number it was offered under.
func (c Codec) IsDynamic() bool {
	return c == CodecOpus
}

// BuildAnswer renders the answer body: one negotiated codec, plus telephone-event when it was
// offered. The `o=` and `c=` addresses are the public one, rtpmap is spelled out even for static
// payload types, and `a=rtcp` is stated explicitly (RFC 3605) rather than left to a port+1 guess.
//
// It assumes [Answer.Validate] passed; an unvalidated dynamic codec renders under PT 0.
func BuildAnswer(answer Answer) string {
	port := answer.Port
	payloadType := answer.AudioPayloadType
	if payloadType == 0 && !answer.Codec.IsDynamic() {
		payloadType = answer.Codec.PayloadType()
	}
	formats := strconv.Itoa(int(payloadType))
	if answer.TelephoneEventPayloadType != 0 {
		formats += " " + strconv.Itoa(int(answer.TelephoneEventPayloadType))
	}

	var body strings.Builder
	body.Grow(sdpBodyHint)
	body.WriteString("v=0\r\n")
	fmt.Fprintf(&body, "o=- %d %d IN %s %s\r\n",
		answer.SessionID, answer.SessionVersion, addrType(answer.Address), addrLiteral(answer.Address))
	body.WriteString("s=-\r\n")
	fmt.Fprintf(&body, "c=IN %s %s\r\n", addrType(answer.Address), addrLiteral(answer.Address))
	body.WriteString("t=0 0\r\n")
	fmt.Fprintf(&body, "m=audio %d %s %s\r\n", port, mediaProto(answer.Crypto), formats)
	writeCrypto(&body, answer.Crypto)
	if answer.Codec == CodecOpus {
		// RFC 7587 §7: the Opus rtpmap channel count is fixed at 2 whatever the stream carries; mono
		// is signalled through `stereo=0` in the fmtp instead.
		fmt.Fprintf(&body, "a=rtpmap:%d opus/48000/2\r\n", payloadType)
		if answer.OpusFmtp != "" {
			fmt.Fprintf(&body, "a=fmtp:%d %s\r\n", payloadType, answer.OpusFmtp)
		}
	} else {
		fmt.Fprintf(&body, "a=rtpmap:%d %s/%d\r\n", payloadType, answer.Codec, answer.Codec.ClockRate())
	}
	if answer.TelephoneEventPayloadType != 0 {
		fmt.Fprintf(&body, "a=rtpmap:%d telephone-event/8000\r\n", answer.TelephoneEventPayloadType)
		fmt.Fprintf(&body, "a=fmtp:%d 0-16\r\n", answer.TelephoneEventPayloadType)
	}
	body.WriteString("a=ptime:20\r\n")
	fmt.Fprintf(&body, "a=%s\r\n", answer.Direction)
	fmt.Fprintf(&body, "a=rtcp:%d\r\n", port+1)
	return body.String()
}

// OfferParams is everything needed to render mediad's own offer for a leg it is originating, as
// opposed to Offer, which is the parse of somebody else's SDP.
type OfferParams struct {
	// SessionID and SessionVersion go in the `o=` line, derived from the session so a re-offer of the
	// same session is recognisable as one.
	SessionID      uint64
	SessionVersion uint64
	// Address is the PUBLIC address (MEDIAD_PUBLIC_IP), never the bind address: getting it wrong
	// fails as one-way audio rather than as an error.
	Address netip.Addr
	Port    int
	// Codecs are the audio codecs to propose, in preference order; each becomes one m=audio format
	// and one a=rtpmap line. Empty is a programming error the builder does not paper over.
	Codecs []Codec
	// TelephoneEventPayloadType is the RFC 4733 type to propose, or 0 to omit telephone-event
	// entirely. mediad proposes 101, the de-facto value.
	TelephoneEventPayloadType uint8
	// Direction is the media direction to offer, defaulting to sendrecv.
	Direction Direction
	// Crypto is OUR key to offer under SAVP. Zero offers plain RTP/AVP.
	Crypto Crypto
}

// BuildOffer renders an offer body for a leg mediad is originating. Unlike an answer, it lists every
// codec in Codecs as an m=audio format and an a=rtpmap line, in the order given, which is the
// preference order the callee is asked to honour (RFC 3264 §5.1).
func BuildOffer(offer OfferParams) string {
	direction := offer.Direction
	if direction == "" {
		direction = DirectionSendRecv
	}

	formats := make([]string, 0, len(offer.Codecs)+1)
	for _, codec := range offer.Codecs {
		formats = append(formats, strconv.Itoa(int(codec.PayloadType())))
	}
	if offer.TelephoneEventPayloadType != 0 {
		formats = append(formats, strconv.Itoa(int(offer.TelephoneEventPayloadType)))
	}

	var body strings.Builder
	body.Grow(sdpBodyHint)
	body.WriteString("v=0\r\n")
	fmt.Fprintf(&body, "o=- %d %d IN %s %s\r\n",
		offer.SessionID, offer.SessionVersion, addrType(offer.Address), addrLiteral(offer.Address))
	body.WriteString("s=-\r\n")
	fmt.Fprintf(&body, "c=IN %s %s\r\n", addrType(offer.Address), addrLiteral(offer.Address))
	body.WriteString("t=0 0\r\n")
	fmt.Fprintf(&body, "m=audio %d %s %s\r\n", offer.Port, mediaProto(offer.Crypto), strings.Join(formats, " "))
	writeCrypto(&body, offer.Crypto)
	// Spelled out even for the static types, since endpoints exist that read rtpmap and never the
	// static table. Opus is not originated here, so there is no channel-count special case.
	for _, codec := range offer.Codecs {
		fmt.Fprintf(&body, "a=rtpmap:%d %s/%d\r\n", codec.PayloadType(), codec, codec.ClockRate())
	}
	if offer.TelephoneEventPayloadType != 0 {
		fmt.Fprintf(&body, "a=rtpmap:%d telephone-event/8000\r\n", offer.TelephoneEventPayloadType)
		fmt.Fprintf(&body, "a=fmtp:%d 0-16\r\n", offer.TelephoneEventPayloadType)
	}
	body.WriteString("a=ptime:20\r\n")
	fmt.Fprintf(&body, "a=%s\r\n", direction)
	fmt.Fprintf(&body, "a=rtcp:%d\r\n", offer.Port+1)
	return body.String()
}

// AnswerDirection is the direction to answer an offer with, given what the engine asked for.
// RFC 3264 §6.1: an answer's direction mirrors the offer's, intersected with what the answerer is
// willing to do. The engine's request wins where it is more restrictive, since it knows things the
// SDP does not — a ringing leg is inactive however enthusiastic its offer was.
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

// addrType names an address's SDP addrtype. An IPv6 address emitted under `IN IP4` is malformed SDP
// that conformant far ends reject; an IPv4-mapped v6 address is still IP4, since addrLiteral puts
// its dotted form on the wire.
func addrType(address netip.Addr) string {
	if address.Is6() && !address.Is4In6() {
		return "IP6"
	}
	return "IP4"
}

// addrLiteral is the address as it belongs on an SDP line: a v4-mapped v6 address in its dotted
// form, so `IN IP4 ::ffff:203.0.113.10` — an addrtype and a literal that disagree — cannot happen.
func addrLiteral(address netip.Addr) string {
	return address.Unmap().String()
}

// mediaProto is the `m=audio` transport for a body that may or may not commit to SRTP.
func mediaProto(crypto Crypto) string {
	if crypto.IsSet() {
		return ProtoSAVP
	}
	return ProtoAVP
}

// writeCrypto renders the one `a=crypto` line a committed SDES body carries, and nothing at all
// otherwise: RFC 4568 §5.1.2 allows exactly one crypto attribute in an answer.
func writeCrypto(body *strings.Builder, crypto Crypto) {
	if !crypto.IsSet() {
		return
	}
	fmt.Fprintf(body, "a=crypto:%d %s inline:%s\r\n", crypto.Tag, SRTPSuite, crypto.Inline())
}
