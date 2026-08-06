package credentials

import (
	"context"
	"errors"
	"time"
)

// NATSStore will resolve credentials over NATS request-reply against apps/api.
//
// # STATUS: NOT IMPLEMENTED — the interface is wired, the transport is not.
//
// The contract this needs does not exist yet, and inventing it inside sipd would put a second,
// unversioned copy of a cross-service RPC shape in the repo. packages/events owns every subject on
// the backbone (plan §3.5) and is frozen while another track is working in it, so the request and
// response types below are LOCAL PLACEHOLDERS that document the intended shape. When the contract
// lands in packages/events (as rpc.sip.v1.credential, alongside rpc.routing.v1.resolve and
// rpc.authz.v1.check), delete these types, regenerate packages/events-go, and use the generated
// ones — the compiler will point at every line that has to change.
//
// Intended subject and shape:
//
//	subject: rpc.sip.v1.credential          (NATS core request-reply, never JetStream)
//	timeout: 500ms                          (on the REGISTER path; slow is the same as broken)
//
//	request  { "realm": "acme.example.com", "username": "1001",
//	           "sourceAddress": "203.0.113.9:5060", "transport": "udp" }
//	response { "found": true, "enabled": true,
//	           "orgId": "…uuid…", "username": "1001", "realm": "acme.example.com",
//	           "ha1": "…32 hex…",            // MD5(username:realm:password); never a password
//	           "deviceId": "…uuid…", "extensionId": "…uuid…" }
//
// Design notes for whoever implements it:
//
//   - The reply carries HA1, not a password. apps/api stores HA1 per (username, realm) so a realm
//     change is an explicit re-provisioning event rather than a silent auth outage.
//   - `found: false` and `enabled: false` are distinct in the reply and MERGED at the SIP layer
//     (both answer 403), so the RPC stays useful for the admin UI without letting a caller
//     enumerate extensions.
//   - sourceAddress and transport are sent so apps/api can apply per-account ACLs and feed the
//     fail2ban-style counters described in plan §5 T1, not because the registrar needs them.
//   - A short-TTL positive cache belongs here, keyed on (realm, username) and invalidated by a
//     JetStream consumer on the provisioning/audit stream. Without it every re-REGISTER of every
//     device becomes an api round trip, which is exactly the load spike a registrar must not create.
type NATSStore struct {
	// Timeout is the per-request deadline. Kept so the field exists at the call site the day the
	// transport is wired.
	Timeout time.Duration
}

// ErrNotImplemented is returned by every NATSStore method until the RPC contract lands.
var ErrNotImplemented = errors.New(
	"credentials: the NATS credential RPC is not implemented yet; run sipd with " +
		"SIPD_CREDENTIAL_SOURCE=file until rpc.sip.v1.credential exists in packages/events",
)

// NewNATSStore constructs the stub. It succeeds so that wiring and configuration can be exercised;
// Lookup is what fails.
func NewNATSStore(timeout time.Duration) *NATSStore {
	if timeout <= 0 {
		timeout = 500 * time.Millisecond
	}
	return &NATSStore{Timeout: timeout}
}

// Lookup implements Store. It always fails with ErrNotImplemented.
func (s *NATSStore) Lookup(_ context.Context, _, _ string) (Credential, error) {
	return Credential{}, ErrNotImplemented
}

// credentialLookupRequest is the placeholder request body. See the NATSStore doc comment.
type credentialLookupRequest struct {
	Realm         string `json:"realm"`
	Username      string `json:"username"`
	SourceAddress string `json:"sourceAddress,omitempty"`
	Transport     string `json:"transport,omitempty"`
}

// credentialLookupResponse is the placeholder reply body. See the NATSStore doc comment.
type credentialLookupResponse struct {
	Found       bool   `json:"found"`
	Enabled     bool   `json:"enabled"`
	OrgID       string `json:"orgId,omitempty"`
	Username    string `json:"username,omitempty"`
	Realm       string `json:"realm,omitempty"`
	HA1         string `json:"ha1,omitempty"`
	DeviceID    string `json:"deviceId,omitempty"`
	ExtensionID string `json:"extensionId,omitempty"`
}

// Referenced so the placeholders stay compiled (and therefore stay honest) until they are replaced
// by the generated contract types.
var (
	_ = credentialLookupRequest{}
	_ = credentialLookupResponse{}
)
