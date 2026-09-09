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

// ClientRegistrar is the production Registrar: one REGISTER over sipgo's client, classified into
// one of the machine's four triggers. It makes no policy decision — retry, failover and status are
// all the gateway machine's, and a classifier that also decided would be a second state machine.
type ClientRegistrar struct {
	client *sipgo.Client
	// contact is what this edge asks the carrier to send calls to. A Contact the carrier cannot
	// reach is a trunk that reports `up` and delivers nothing.
	contact sip.Uri
	// userAgent goes in the User-Agent header. Several carriers key interop workarounds off it.
	userAgent string
	// timeout bounds one REGISTER. Deliberately shorter than Timer F (64xT1 ~ 32 s): holding a
	// goroutine for half a minute per trunk per attempt during an outage exhausts the fleet.
	timeout time.Duration
	auth    Authorizer
}

var _ Registrar = (*ClientRegistrar)(nil)

// RegistrarOptions configures a ClientRegistrar.
type RegistrarOptions struct {
	Contact   sip.Uri
	UserAgent string
	Timeout   time.Duration
	Auth      Authorizer
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
		auth:      opts.Auth,
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
		// Nothing was sent. Reported as a TIMEOUT rather than a rejection because a rejection
		// carries a status the carrier chose, and inventing one would write a number into
		// `trunk.statusReason` that no carrier ever said.
		return Result{Trigger: TriggerTimeout, Err: err}
	}

	req := sip.NewRequest(sip.REGISTER, target)
	address := sip.Uri{Scheme: "sip", User: config.AuthUser, Host: target.Host}
	fromParams := sip.NewParams()
	fromParams.Add("tag", sip.GenerateTagN(16))
	req.AppendHeader(&sip.FromHeader{Address: address, Params: fromParams})
	req.AppendHeader(&sip.ToHeader{Address: address, Params: sip.NewParams()})

	contact := r.contact
	contact.User = config.AuthUser
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
		// The Request-URI still names the registrar; the packet goes to the SBC.
		req.SetDestination(config.OutboundProxy)
	}
	if config.Transport != "" {
		req.SetTransport(strings.ToUpper(config.Transport))
	}

	ctx, cancel := context.WithTimeout(ctx, r.timeout)
	defer cancel()

	res, err := r.client.Do(ctx, req)
	seen := make(map[string]bool)
	for err == nil && r.auth != nil && len(seen) < 3 {
		key := ChallengeKey(res)
		if key == "" || seen[key] {
			break
		}
		seen[key] = true
		authorized, authErr := r.auth.Authorize(ctx, config, req, res)
		if authErr != nil {
			return Result{Trigger: TriggerChallenged, Status: res.StatusCode, Err: authErr}
		}
		req = authorized
		res, err = r.client.Do(ctx, req)
	}
	if err != nil {
		// No final response inside the deadline. Timer F expiry and a transport failure look
		// identical here, and the machine treats both as a reachability problem.
		return Result{Trigger: TriggerTimeout, Err: err}
	}

	switch {
	case res.StatusCode >= 200 && res.StatusCode < 300:
		return Result{Trigger: TriggerAccepted, GrantedExpires: grantedExpires(res, expires)}
	case res.StatusCode == 401 || res.StatusCode == 407:
		// Authentication retries are bounded above. Do not treat a rejected credential as a
		// transport failure: another registrar would reject the same credential.
		return Result{Trigger: TriggerChallenged, Status: res.StatusCode}
	default:
		return Result{Trigger: TriggerRejected, Status: res.StatusCode}
	}
}

// registrarURI turns the configured host into the REGISTER's Request-URI.
//
// A REGISTER's Request-URI names the DOMAIN and carries no user part (RFC 3261 §10.2) — the user is
// in the To and From. An auth user in it is answered 404 by most registrars.
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

// grantedExpires reads the interval the registrar actually GRANTED, not the one requested: a
// carrier that shortens 3600 to 120, refreshed on our own number, is a trunk unregistered for most
// of every hour while reporting `up`.
//
// The Contact's own `expires` parameter wins over the Expires header (RFC 3261 §10.2.4): the
// parameter is per-binding, the header only a default for bindings without one.
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
