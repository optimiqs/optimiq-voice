// Package sipua is a minimal SIP user agent for driving a running sipd from tests: it speaks
// UDP, TCP and TLS, answers digest challenges, and hands back parsed responses.
//
// It is a test helper, not a SIP stack: it keeps one dialog's worth of state and leaves
// retransmission to the caller.
package sipua

import (
	"bytes"
	"crypto/md5"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"math/rand/v2"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo/sip"
	"github.com/icholy/digest"
)

// Transport is the wire a UA is dialled on.
type Transport string

const (
	UDP Transport = "udp"
	TCP Transport = "tcp"
	TLS Transport = "tls"
)

// ErrTimeout is returned when no message arrived before the read deadline.
var ErrTimeout = errors.New("sipua: no response before the deadline")

// UA is one user agent bound to one socket. It is not safe for concurrent use.
type UA struct {
	Transport Transport
	Realm     string
	User      string
	Password  string
	Remote    string

	// Timeout bounds every read; zero means five seconds.
	Timeout time.Duration
	// Trace, when set, is called with every payload written and read. For debugging a scenario.
	Trace func(direction string, payload []byte)

	conn net.Conn
	udp  *net.UDPConn
	// remote is the signalling address a UDP UA writes to. The socket is deliberately UNCONNECTED:
	// a proxy originates an inbound INVITE from its own client-transaction socket, and a connected
	// socket would drop every datagram that did not come from the port we dialled.
	remote *net.UDPAddr
	// LastPeer is the source address of the last datagram read, which is how a UDP UA learns where
	// an inbound request came from.
	LastPeer   net.Addr
	parser     *sip.Parser
	pending    []byte
	nonceCount int
	callID     string
	fromTag    string
	cseq       int
}

// Options configures Dial.
type Options struct {
	Transport Transport
	Remote    string
	Realm     string
	User      string
	Password  string
	Timeout   time.Duration
	// TLSConfig is used for Transport TLS; nil means InsecureSkipVerify, which is what a
	// self-signed local listener needs.
	TLSConfig *tls.Config
}

// Dial opens the socket. The caller owns Close.
func Dial(options Options) (*UA, error) {
	ua := &UA{
		Transport: options.Transport,
		Realm:     options.Realm,
		User:      options.User,
		Password:  options.Password,
		Remote:    options.Remote,
		Timeout:   cmpOr(options.Timeout, 5*time.Second),
		parser:    sip.NewParser(),
		callID:    fmt.Sprintf("sipua-%s-%d", options.User, rand.Uint64()),
		fromTag:   fmt.Sprintf("t%d", rand.Uint64()),
	}
	switch options.Transport {
	case UDP:
		remote, err := net.ResolveUDPAddr("udp", options.Remote)
		if err != nil {
			return nil, err
		}
		conn, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			return nil, err
		}
		ua.udp, ua.conn, ua.remote = conn, conn, remote
	case TCP:
		conn, err := net.DialTimeout("tcp", options.Remote, ua.Timeout)
		if err != nil {
			return nil, err
		}
		ua.conn = conn
	case TLS:
		config := options.TLSConfig
		if config == nil {
			config = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // the local listener is self-signed on purpose
		}
		conn, err := tls.DialWithDialer(&net.Dialer{Timeout: ua.Timeout}, "tcp", options.Remote, config)
		if err != nil {
			return nil, err
		}
		ua.conn = conn
	default:
		return nil, fmt.Errorf("sipua: unknown transport %q", options.Transport)
	}
	return ua, nil
}

// Close releases the socket.
func (u *UA) Close() error {
	if u.conn == nil {
		return nil
	}
	return u.conn.Close()
}

// LocalAddr is the address the far end sees, which is what a Contact and a Via must carry.
func (u *UA) LocalAddr() string { return u.conn.LocalAddr().String() }

// CallID is the Call-ID every request from this UA carries.
func (u *UA) CallID() string { return u.callID }

// SetCallID overrides the Call-ID, which a second device on one AOR needs.
func (u *UA) SetCallID(id string) { u.callID = id }

// viaProtocol is the transport token a Via header carries; TLS is spelled TLS, not TCP.
func (u *UA) viaProtocol() string {
	if u.Transport == TLS {
		return "TLS"
	}
	return strings.ToUpper(string(u.Transport))
}

func (u *UA) contactTransport() string {
	if u.Transport == TLS {
		return "tls"
	}
	return string(u.Transport)
}

// WriteRaw sends bytes exactly as given, for malformed-input tests.
func (u *UA) WriteRaw(payload []byte) error {
	if u.Trace != nil {
		u.Trace(">>>", payload)
	}
	if u.udp != nil {
		_, err := u.udp.WriteToUDP(payload, u.remote)
		return err
	}
	_, err := u.conn.Write(payload)
	return err
}

// Read returns the next response, or ErrTimeout.
func (u *UA) Read() (*sip.Response, error) {
	message, err := u.readMessage()
	if err != nil {
		return nil, err
	}
	response, ok := message.(*sip.Response)
	if !ok {
		return nil, fmt.Errorf("sipua: received a %T, want a response", message)
	}
	return response, nil
}

// ReadMessage returns the next message of either kind, for a UA that must answer an inbound INVITE.
func (u *UA) ReadMessage() (sip.Message, error) { return u.readMessage() }

func (u *UA) readMessage() (sip.Message, error) {
	deadline := time.Now().Add(u.Timeout)
	if u.udp != nil {
		if err := u.udp.SetReadDeadline(deadline); err != nil {
			return nil, err
		}
		buffer := make([]byte, 16384)
		n, peer, err := u.udp.ReadFromUDP(buffer)
		if err != nil {
			if isTimeout(err) {
				return nil, ErrTimeout
			}
			return nil, err
		}
		u.LastPeer = peer
		return u.parse(buffer[:n])
	}
	if err := u.conn.SetReadDeadline(deadline); err != nil {
		return nil, err
	}
	for {
		if message, rest, ok := splitMessage(u.pending); ok {
			u.pending = rest
			return u.parse(message)
		}
		buffer := make([]byte, 16384)
		n, err := u.conn.Read(buffer)
		if err != nil {
			if isTimeout(err) {
				return nil, ErrTimeout
			}
			return nil, err
		}
		u.pending = append(u.pending, buffer[:n]...)
	}
}

func (u *UA) parse(payload []byte) (sip.Message, error) {
	if u.Trace != nil {
		u.Trace("<<<", payload)
	}
	message, err := u.parser.ParseSIP(payload)
	if err != nil {
		return nil, fmt.Errorf("sipua: parsing %q: %w", string(payload), err)
	}
	return message, nil
}

// splitMessage frames one message out of a stream: headers to the blank line, then Content-Length
// bytes (RFC 3261 §7.5).
func splitMessage(buffer []byte) ([]byte, []byte, bool) {
	head, _, found := bytes.Cut(buffer, []byte("\r\n\r\n"))
	if !found {
		return nil, buffer, false
	}
	length := 0
	for line := range strings.SplitSeq(string(head), "\r\n") {
		name, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(name)) {
		case "content-length", "l":
			if parsed, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				length = parsed
			}
		}
	}
	end := len(head) + 4 + length
	if len(buffer) < end {
		return nil, buffer, false
	}
	return buffer[:end], buffer[end:], true
}

// RegisterOptions varies one REGISTER.
type RegisterOptions struct {
	// Expires is the requested binding lifetime in seconds; 0 means 300 and -1 sends no header.
	// ExpiresZero sends the literal `Expires: 0` an un-REGISTER needs.
	Expires     int
	ExpiresZero bool
	// Contact overrides the default `sip:user@localaddr`, which an un-REGISTER (`*`) needs.
	Contact string
	// AuthRealm overrides the realm used to compute the digest response, for realm-mismatch tests.
	AuthRealm string
	// Password overrides the account password, for wrong-password tests.
	Password string
	// ExtraHeaders are appended verbatim.
	ExtraHeaders []string
}

// Register runs one challenge/answer exchange and returns the final response. The 401 is returned
// too when the exchange stops there.
func (u *UA) Register(options RegisterOptions) (*sip.Response, error) {
	challenge, err := u.sendRegister("", options)
	if err != nil {
		return nil, err
	}
	if challenge.StatusCode != 401 && challenge.StatusCode != 407 {
		return challenge, nil
	}
	authorization, err := u.Answer(challenge, "REGISTER", "sip:"+u.Realm, options)
	if err != nil {
		return nil, err
	}
	return u.sendRegister(authorization, options)
}

// Answer computes the Authorization header value for a challenge.
func (u *UA) Answer(response *sip.Response, method, uri string, options RegisterOptions) (string, error) {
	header := response.GetHeader("WWW-Authenticate")
	if header == nil {
		header = response.GetHeader("Proxy-Authenticate")
	}
	if header == nil {
		return "", fmt.Errorf("sipua: a %d carried no challenge", response.StatusCode)
	}
	challenge, err := digest.ParseChallenge(header.Value())
	if err != nil {
		return "", err
	}
	if options.AuthRealm != "" {
		challenge.Realm = options.AuthRealm
	}
	password := cmpOr(options.Password, u.Password)
	u.nonceCount++
	credential, err := digest.Digest(challenge, digest.Options{
		Method: method, URI: uri, Username: u.User, Password: password,
		Count: u.nonceCount, Cnonce: "0a4f113b",
	})
	if err != nil {
		return "", err
	}
	return credential.String(), nil
}

func (u *UA) sendRegister(authorization string, options RegisterOptions) (*sip.Response, error) {
	u.cseq++
	contact := options.Contact
	if contact == "" {
		contact = "<sip:" + u.User + "@" + u.LocalAddr() + ";transport=" + u.contactTransport() + ">"
	}
	lines := []string{
		"REGISTER sip:" + u.Realm + " SIP/2.0",
		fmt.Sprintf("Via: SIP/2.0/%s %s;branch=z9hG4bK%s%d;rport", u.viaProtocol(), u.LocalAddr(), u.fromTag, u.cseq),
		"Max-Forwards: 70",
		"From: <sip:" + u.User + "@" + u.Realm + ">;tag=" + u.fromTag,
		"To: <sip:" + u.User + "@" + u.Realm + ">",
		"Call-ID: " + u.callID,
		"CSeq: " + strconv.Itoa(u.cseq) + " REGISTER",
		"Contact: " + contact,
		"User-Agent: sipua-e2e",
	}
	switch {
	case options.ExpiresZero:
		lines = append(lines, "Expires: 0")
	case options.Expires > 0:
		lines = append(lines, "Expires: "+strconv.Itoa(options.Expires))
	case options.Expires == 0:
		lines = append(lines, "Expires: 300")
	}
	if authorization != "" {
		lines = append(lines, "Authorization: "+authorization)
	}
	lines = append(lines, options.ExtraHeaders...)
	lines = append(lines, "Content-Length: 0", "", "")
	if err := u.WriteRaw([]byte(strings.Join(lines, "\r\n"))); err != nil {
		return nil, err
	}
	return u.Read()
}

// HA1 is MD5(username:realm:password), the hash the registrar verifies against.
func HA1(username, realm, password string) string {
	sum := md5.Sum([]byte(username + ":" + realm + ":" + password))
	return hex.EncodeToString(sum[:])
}

func isTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func cmpOr[T comparable](value, fallback T) T {
	var zero T
	if value == zero {
		return fallback
	}
	return value
}
