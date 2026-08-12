package trunk

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// ClientRegistrar is the production Registrar: one REGISTER over sipgo's client, classified.
//
// # What it does and, more importantly, what it refuses to decide
//
// It builds the request, sends it, waits for a final response and turns that into one of the
// machine's four triggers. It makes no policy decision at all — not whether to retry, not whether to
// fail over, not what status to report — because every one of those is the gateway machine's, and a
// classifier that also decided would be a second state machine nobody wrote down.
type ClientRegistrar struct {
	client *sipgo.Client
	// contact is what this edge asks the carrier to send calls to. A registration whose Contact the
	// carrier cannot reach is a trunk that reports `up` and delivers nothing, which is the worst
	// available combination.
	contact sip.Uri
	// userAgent goes in the User-Agent header. Several carriers key interop workarounds off it.
	userAgent string
	// timeout bounds one REGISTER. Timer F is 64×T1 ≈ 32 s and that is the SIP answer; this is
	// shorter because a carrier that has not answered in eight seconds is one the backoff should
	// already be working on, and holding a goroutine for half a minute per trunk per attempt during
	// an outage is how a fleet runs out of them.
	timeout time.Duration
}

var _ Registrar = (*ClientRegistrar)(nil)

// RegistrarOptions configures a ClientRegistrar.
type RegistrarOptions struct {
	Contact   sip.Uri
	UserAgent string
	Timeout   time.Duration
}

// NewClientRegistrar wraps a sipgo client.
func NewClientRegistrar(client *sipgo.Client, opts RegistrarOptions) (*ClientRegistrar, error) {
	if client == nil {
		return nil, errors.New("trunk: a SIP client is required to register outward")
	}
	registrar := &ClientRegistrar{
		client:    client,
		contact:   opts.Contact,
		userAgent: opts.UserAgent,
		timeout:   opts.Timeout,
	}
	if registrar.userAgent == "" {
		registrar.userAgent = "optimiq-sipd"
	}
	if registrar.timeout <= 0 {
		registrar.timeout = 8 * time.Second
	}
	return registrar, nil
}

// Register implements Registrar.
func (r *ClientRegistrar) Register(
	ctx context.Context,
	config Config,
	registrarHost string,
	expires time.Duration,
) Result {
	target, err := registrarURI(registrarHost, config)
	if err != nil {
		// Nothing was sent and nothing will be. It is reported as a TIMEOUT rather than a rejection
		// because a rejection carries a status the carrier chose, and inventing one would put a
		// number in a `trunk.statusReason` column that no carrier ever said.
		return Result{Trigger: TriggerTimeout, Err: err}
	}

	req := sip.NewRequest(sip.REGISTER, target)
	address := sip.Uri{Scheme: "sip", User: config.AuthUser, Host: target.Host}
	fromParams := sip.NewParams()
	fromParams.Add("tag", sip.GenerateTagN(16))
	req.AppendHeader(&sip.FromHeader{Address: address, Params: fromParams})
	req.AppendHeader(&sip.ToHeader{Address: address, Params: sip.NewParams()})

	contact := r.contact
	if config.Contact != "" {
		parsed := sip.Uri{}
		if err := sip.ParseUri(config.Contact, &parsed); err == nil {
			contact = parsed
		}
	}
	req.AppendHeader(&sip.ContactHeader{Address: contact})
	req.AppendHeader(sip.NewHeader("Expires", strconv.Itoa(int(expires/time.Second))))
	req.AppendHeader(sip.NewHeader("Max-Forwards", "70"))
	req.AppendHeader(sip.NewHeader("User-Agent", r.userAgent))
	if config.OutboundProxy != "" {
		// The Request-URI still names the registrar and the packet goes to the SBC. Same split the
		// INVITE path draws, and for the same reason.
		req.SetDestination(config.OutboundProxy)
	}
	if config.Transport != "" {
		req.SetTransport(strings.ToUpper(config.Transport))
	}

	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	res, err := r.client.Do(ctx, req)
	if err != nil {
		// No final response inside the deadline. Timer F's own expiry looks identical from here and
		// so does a transport failure, and the machine treats them the same: a reachability problem,
		// which is what a secondary registrar exists for.
		return Result{Trigger: TriggerTimeout, Err: err}
	}

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return Result{Trigger: TriggerAccepted, GrantedExpires: grantedExpires(res, expires)}
	case res.StatusCode == 401 || res.StatusCode == 407:
		// sipgo answers a digest challenge inside the same transaction when it has a credential, so
		// reaching here means it could not — no credential, or a realm we hold nothing for. That is
		// OUR problem and not the carrier's address, which is exactly why the machine refuses to fail
		// over on it: the secondary is the same carrier with the same missing credential.
		return Result{Trigger: TriggerChallenged, Status: res.StatusCode}
	default:
		return Result{Trigger: TriggerRejected, Status: res.StatusCode}
	}
}

// registrarURI turns the configured host into the REGISTER's Request-URI.
//
// A REGISTER's Request-URI names the DOMAIN and carries no user part (RFC 3261 §10.2) — the user is
// in the To and From. Putting the auth user in it produces a request most registrars answer 404,
// and the symptom is a trunk that authenticates perfectly and never registers.
func registrarURI(host string, config Config) (sip.Uri, error) {
	trimmed := strings.TrimSpace(host)
	if trimmed == "" {
		return sip.Uri{}, errors.New("trunk: no registrar to send REGISTER to")
	}
	uri := sip.Uri{}
	if err := sip.ParseUri(trimmed, &uri); err == nil && uri.Host != "" {
		uri.User = ""
		return uri, nil
	}
	name, port, found := strings.Cut(trimmed, ":")
	target := sip.Uri{Scheme: "sip", Host: name}
	if found {
		if number, err := strconv.Atoi(port); err == nil {
			target.Port = number
		} else {
			target.Host = trimmed
		}
	}
	if target.Host == "" {
		return sip.Uri{}, errors.New("trunk: the registrar names no host")
	}
	_ = config
	return target, nil
}

// grantedExpires reads what the registrar actually gave us.
//
// The GRANTED interval and not the requested one, and this is the single most common way an
// outbound registration silently lapses: a carrier that shortens 3600 to 120 and a client that
// refreshes on its own number is a trunk that is unregistered for fifty-eight minutes out of every
// hour, reporting `up` throughout.
//
// The Contact's own `expires` parameter wins over the Expires header when both are present, which is
// RFC 3261 §10.2.4's ordering: the parameter is per-binding and the header is a default for the
// bindings that do not carry one.
func grantedExpires(res *sip.Response, requested time.Duration) time.Duration {
	if contact := res.Contact(); contact != nil && contact.Params != nil {
		if raw, found := contact.Params.Get("expires"); found {
			if seconds, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && seconds > 0 {
				return time.Duration(seconds) * time.Second
			}
		}
	}
	if header := res.GetHeader("Expires"); header != nil {
		if seconds, err := strconv.Atoi(strings.TrimSpace(header.Value())); err == nil && seconds > 0 {
			return time.Duration(seconds) * time.Second
		}
	}
	// A 200 with no interval at all means the registrar accepted what was asked for.
	return requested
}
