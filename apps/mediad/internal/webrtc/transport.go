// Package webrtc terminates ICE, DTLS and SRTP before handing packets to the media pipeline.
package webrtc

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	mediasdp "github.com/optimiqs/optimiq-voice/apps/mediad/internal/sdp"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

type Options struct {
	BindIP           netip.Addr
	PublicIP         netip.Addr
	PortMin, PortMax uint16
}

type Factory struct{ api *pion.API }

func NewFactory(opts Options) (*Factory, error) {
	media := &pion.MediaEngine{}
	for _, codec := range []pion.RTPCodecParameters{
		{RTPCodecCapability: pion.RTPCodecCapability{MimeType: pion.MimeTypePCMU, ClockRate: 8000, Channels: 1}, PayloadType: 0},
		{RTPCodecCapability: pion.RTPCodecCapability{MimeType: "audio/telephone-event", ClockRate: 8000, Channels: 1, SDPFmtpLine: "0-16"}, PayloadType: 101},
	} {
		if err := media.RegisterCodec(codec, pion.RTPCodecTypeAudio); err != nil {
			return nil, err
		}
	}
	settings := pion.SettingEngine{}
	settings.SetNetworkTypes([]pion.NetworkType{pion.NetworkTypeUDP4})
	settings.SetIncludeLoopbackCandidate(true)
	if err := settings.SetEphemeralUDPPortRange(opts.PortMin, opts.PortMax); err != nil {
		return nil, err
	}
	if opts.BindIP.IsValid() && !opts.BindIP.IsUnspecified() {
		settings.SetIPFilter(func(ip net.IP) bool {
			parsed, ok := netip.AddrFromSlice(ip)
			return ok && parsed.Unmap() == opts.BindIP.Unmap()
		})
	}
	if opts.PublicIP.IsValid() && !opts.PublicIP.IsLoopback() {
		if err := settings.SetICEAddressRewriteRules(pion.ICEAddressRewriteRule{
			External: []string{opts.PublicIP.String()}, AsCandidateType: pion.ICECandidateTypeHost,
			Mode: pion.ICEAddressRewriteReplace,
		}); err != nil {
			return nil, err
		}
	}
	settings.SetICETimeouts(5*time.Second, 25*time.Second, 2*time.Second)
	return &Factory{api: pion.NewAPI(pion.WithMediaEngine(media), pion.WithSettingEngine(settings))}, nil
}

type Transport struct {
	ssrc                   uint32
	pc                     *pion.PeerConnection
	track                  *packetTrack
	rtp, rtcp              chan []byte
	done, connected        chan struct{}
	closeOnce, connectOnce sync.Once
	signalMu               sync.Mutex
	lastOffer, lastAnswer  string

	// droppedRTP and droppedRTCP count packets discarded because the buffer to the media pipeline
	// was full. Counted rather than silent for exactly the reason every other drop on this path is
	// (see rtp.Stats): a stalled Session.Run fills 128 packets in under three seconds and the audio
	// goes with it, and "the browser leg was choppy" is unanswerable without a number.
	droppedRTP  atomic.Uint64
	droppedRTCP atomic.Uint64
}

// Dropped is how many inbound RTP and RTCP packets this transport discarded for want of buffer.
func (t *Transport) Dropped() (rtpDropped, rtcpDropped uint64) {
	return t.droppedRTP.Load(), t.droppedRTCP.Load()
}

func (f *Factory) New(id string) (*Transport, error) {
	pc, err := f.api.NewPeerConnection(pion.Configuration{})
	if err != nil {
		return nil, err
	}
	t := &Transport{pc: pc, track: &packetTrack{id: id}, rtp: make(chan []byte, 128), rtcp: make(chan []byte, 32), done: make(chan struct{}), connected: make(chan struct{})}
	pc.OnConnectionStateChange(func(state pion.PeerConnectionState) {
		if state == pion.PeerConnectionStateConnected {
			t.connectOnce.Do(func() { close(t.connected) })
		}
		if state == pion.PeerConnectionStateFailed {
			go func() { _ = t.Close() }()
		}
	})
	pc.OnTrack(func(track *pion.TrackRemote, receiver *pion.RTPReceiver) {
		go t.readReports(func(buf []byte) (int, error) { n, _, err := receiver.Read(buf); return n, err })
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			raw, err := packet.Marshal()
			if err != nil {
				continue
			}
			select {
			case t.rtp <- raw:
			case <-t.done:
				return
			default:
				t.droppedRTP.Add(1)
			}
		}
	})
	sender, err := pc.AddTrack(t.track)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}
	parameters := sender.GetParameters()
	if len(parameters.Encodings) == 0 {
		_ = pc.Close()
		return nil, errors.New("WebRTC sender has no encoding")
	}
	t.ssrc = uint32(parameters.Encodings[0].SSRC)
	go t.readReports(func(buf []byte) (int, error) { n, _, err := sender.Read(buf); return n, err })
	return t, nil
}

func (t *Transport) readReports(read func([]byte) (int, error)) {
	buf := make([]byte, 8192)
	for {
		n, err := read(buf)
		if err != nil {
			return
		}
		select {
		case t.rtcp <- append([]byte(nil), buf[:n]...):
		case <-t.done:
			return
		default:
			t.droppedRTCP.Add(1)
		}
	}
}

func (t *Transport) Done() <-chan struct{} { return t.done }
func (t *Transport) LocalSSRC() uint32     { return t.ssrc }

func (t *Transport) Answer(ctx context.Context, offer string) (string, error) {
	t.signalMu.Lock()
	defer t.signalMu.Unlock()
	if t.lastOffer == offer && t.lastAnswer != "" {
		return t.lastAnswer, nil
	}
	parsed, err := mediasdp.ParseOffer(offer)
	if err != nil {
		return "", err
	}
	// SIP hold is reversible. Keep the Pion transceiver alive; the media session applies
	// the negotiated receive/send gates. Pion stops an inactive transceiver permanently.
	internalOffer := replaceDirection(offer, "sendrecv")
	// RFC 5763 retains the established DTLS roles when the next offer says actpass.
	// Pion's answer defaults to active, including when this peer originally offered.
	if remote := t.pc.RemoteDescription(); remote != nil {
		role := setupRole(remote.SDP)
		if role == "actpass" {
			if local := t.pc.LocalDescription(); local != nil {
				switch setupRole(local.SDP) {
				case "active":
					role = "passive"
				case "passive":
					role = "active"
				}
			}
		}
		if role == "active" || role == "passive" {
			if offered := setupRole(offer); offered != "actpass" && offered != role {
				return "", errors.New("renegotiation cannot change the established DTLS role")
			}
			internalOffer = strings.ReplaceAll(internalOffer, "a=setup:actpass", "a=setup:"+role)
		}
	}
	if err := t.pc.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeOffer, SDP: internalOffer}); err != nil {
		return "", err
	}
	answer, err := t.pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	local, err := t.setLocal(ctx, answer)
	if err == nil {
		local = replaceDirection(local, string(mediasdp.AnswerDirection(parsed.Direction, mediasdp.DirectionSendRecv)))
		t.lastOffer, t.lastAnswer = offer, local
	}
	return local, err
}

func setupRole(description string) string {
	for _, line := range strings.Split(description, "\n") {
		if strings.HasPrefix(line, "a=setup:") {
			return strings.TrimSpace(strings.TrimPrefix(line, "a=setup:"))
		}
	}
	return ""
}

func replaceDirection(description, direction string) string {
	for _, previous := range []string{"sendrecv", "sendonly", "recvonly", "inactive"} {
		description = strings.ReplaceAll(description, "a="+previous+"\r\n", "a="+direction+"\r\n")
	}
	return description
}

func (t *Transport) Offer(ctx context.Context) (string, error) {
	t.signalMu.Lock()
	defer t.signalMu.Unlock()
	if local := t.pc.LocalDescription(); local != nil {
		return local.SDP, nil
	}
	offer, err := t.pc.CreateOffer(nil)
	if err != nil {
		return "", err
	}
	return t.setLocal(ctx, offer)
}

func (t *Transport) AcceptAnswer(answer string) error {
	t.signalMu.Lock()
	defer t.signalMu.Unlock()
	if remote := t.pc.RemoteDescription(); remote != nil && remote.Type == pion.SDPTypeAnswer && remote.SDP == answer {
		return nil
	}
	return t.pc.SetRemoteDescription(pion.SessionDescription{Type: pion.SDPTypeAnswer, SDP: answer})
}

func (t *Transport) setLocal(ctx context.Context, description pion.SessionDescription) (string, error) {
	complete := pion.GatheringCompletePromise(t.pc)
	if err := t.pc.SetLocalDescription(description); err != nil {
		return "", err
	}
	select {
	case <-complete:
		return t.pc.LocalDescription().SDP, nil
	case <-ctx.Done():
		return "", ctx.Err()
	case <-t.done:
		return "", io.ErrClosedPipe
	}
}

func readPacket(buf []byte, packets <-chan []byte, done <-chan struct{}) (int, error) {
	select {
	case packet := <-packets:
		if len(packet) > len(buf) {
			return 0, io.ErrShortBuffer
		}
		return copy(buf, packet), nil
	case <-done:
		return 0, net.ErrClosed
	}
}

func (t *Transport) ReadRTP(buf []byte) (int, error)  { return readPacket(buf, t.rtp, t.done) }
func (t *Transport) ReadRTCP(buf []byte) (int, error) { return readPacket(buf, t.rtcp, t.done) }
func (t *Transport) WriteRTP(buf []byte) (int, error) {
	select {
	case <-t.connected:
	case <-t.done:
		return 0, net.ErrClosed
	default:
		// This is called on the peer's packet loop. Waiting for ICE here stalls that loop,
		// accumulates stale audio in its socket, and bursts it into recordings on connection.
		return 0, errors.New("WebRTC media is not connected")
	}
	return t.track.write(buf)
}
func (t *Transport) WriteRTCP(buf []byte) (int, error) {
	packets, err := rtcp.Unmarshal(buf)
	if err != nil {
		return 0, err
	}
	if err := t.pc.WriteRTCP(packets); err != nil {
		return 0, err
	}
	return len(buf), nil
}
func (t *Transport) Close() error {
	var err error
	t.closeOnce.Do(func() { close(t.done); err = t.pc.Close() })
	return err
}

// packetTrack preserves negotiated telephone-event payloads alongside the audio stream.
// TrackLocalStaticRTP rewrites every payload as audio, which would corrupt RFC 4733 digits.
type packetTrack struct {
	id       string
	mu       sync.RWMutex
	context  pion.TrackLocalContext
	payloads map[uint8]bool
}

func (t *packetTrack) Bind(ctx pion.TrackLocalContext) (pion.RTPCodecParameters, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	payloads := make(map[uint8]bool)
	var audio pion.RTPCodecParameters
	for _, codec := range ctx.CodecParameters() {
		if strings.EqualFold(codec.MimeType, pion.MimeTypePCMU) {
			audio = codec
			payloads[uint8(codec.PayloadType)] = true
		}
		if strings.EqualFold(codec.MimeType, "audio/telephone-event") {
			payloads[uint8(codec.PayloadType)] = true
		}
	}
	if audio.MimeType == "" {
		return audio, errors.New("WebRTC peer did not negotiate PCMU")
	}
	t.context, t.payloads = ctx, payloads
	return audio, nil
}
func (t *packetTrack) Unbind(ctx pion.TrackLocalContext) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.context != nil && t.context.ID() == ctx.ID() {
		t.context = nil
	}
	return nil
}
func (t *packetTrack) ID() string              { return t.id }
func (t *packetTrack) StreamID() string        { return "voice" }
func (t *packetTrack) RID() string             { return "" }
func (t *packetTrack) Kind() pion.RTPCodecType { return pion.RTPCodecTypeAudio }
func (t *packetTrack) write(buf []byte) (int, error) {
	var packet rtp.Packet
	if err := packet.Unmarshal(buf); err != nil {
		return 0, err
	}
	t.mu.RLock()
	ctx := t.context
	allowed := t.payloads[packet.PayloadType]
	t.mu.RUnlock()
	if ctx == nil {
		return 0, io.ErrClosedPipe
	}
	if !allowed {
		return 0, errors.New("unnegotiated WebRTC payload type")
	}
	packet.SSRC = uint32(ctx.SSRC())
	// SIP-side extension IDs and CSRCs belong to another RTP session.
	packet.Extension, packet.Extensions, packet.CSRC = false, nil, nil
	return ctx.WriteStream().WriteRTP(&packet.Header, packet.Payload)
}
