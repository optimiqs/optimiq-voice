// Package credentials resolves the SIP account behind a REGISTER.
//
// The registrar never sees a plaintext password: RFC 2617 digest only needs
// HA1 = MD5(username:realm:password), so that is what a Credential carries. A store handed
// plaintext computes HA1 immediately and discards it.
package credentials

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// ErrNotFound means the realm/username pair is unknown. It is deliberately indistinguishable from
// "known but disabled" at the SIP layer — both answer 403, so an attacker cannot enumerate
// extensions by comparing responses.
var ErrNotFound = errors.New("credentials: not found")

// ErrDisabled means the account exists but is administratively off.
var ErrDisabled = errors.New("credentials: disabled")

// Credential is everything the registrar needs to authenticate an AOR and attribute its binding to
// a tenant.
type Credential struct {
	MaxRegistrations int
	// OrgID is the tenant. It comes from the credential record, never from configuration: sipd is a
	// multi-tenant edge, and the org that owns an AOR is a property of the AOR.
	OrgID string
	// Username is the SIP user part, matched case-sensitively (RFC 3261 §19.1.4).
	Username string
	// Realm the HA1 was computed against.
	Realm string
	// HA1 is MD5(username:realm:password), lower-case hex.
	HA1 string
	// DeviceID and ExtensionID are the pbx-db rows this account maps to, when known. They travel in
	// the registration event so the admin UI can join a live binding to inventory.
	DeviceID    string
	ExtensionID string
	// SharedLineNumber and AppearanceIndex place this account in a shared line appearance (SLA).
	// They travel onto the binding and become the INVITE path's `Call-Info` appearance-index header,
	// so the phone lights the right line key. Nil for an extension outside any shared line.
	SharedLineNumber *string
	AppearanceIndex  *int
}

// Store resolves a SIP username within a realm.
//
// Implementations must be safe for concurrent use: every REGISTER on every transport calls this.
type Store interface {
	Lookup(ctx context.Context, realm, username string) (Credential, error)
}

// Refresher is a Store that caches, and can be told its answer for one account may be stale.
//
// It backs up the `credential.invalidated` subscription in invalidate.go rather than replacing it:
// `rpc.sip.v1.credential` is pull-only, so a missed or ungranted invalidation leaves this edge
// holding the previous HA1, and a digest that does not verify is the only other signal it gets. A
// rotated phone would otherwise be refused for a whole positive TTL while it re-REGISTERs perfectly
// correctly.
//
// Implementations must rate-bound the re-ask: a wrong password is far more often a wrong password
// than a rotation, and one RPC per failed digest is the amplification the negative cache exists to
// prevent.
type Refresher interface {
	Refresh(ctx context.Context, realm, username string) (Credential, error)
}

// HA1 computes MD5(username:realm:password).
//
// MD5 is mandated by RFC 2617 digest, not chosen. It is a legacy construction protected by the
// transport (use TLS on any untrusted network), not a password hash — never reuse an HA1 as a
// stored password digest.
func HA1(username, realm, password string) string {
	sum := md5.Sum([]byte(username + ":" + realm + ":" + password))
	return hex.EncodeToString(sum[:])
}

// Validate rejects a credential before it reaches the digest verifier: a record missing its org or
// carrying a malformed HA1 must fail loudly at load time rather than silently authenticate.
func (c Credential) Validate() error {
	switch {
	case strings.TrimSpace(c.OrgID) == "":
		return fmt.Errorf("credential for %q has no orgId", c.Username)
	case strings.TrimSpace(c.Username) == "":
		return errors.New("credential has no username")
	case strings.TrimSpace(c.Realm) == "":
		return fmt.Errorf("credential for %q has no realm", c.Username)
	case len(c.HA1) != 32:
		return fmt.Errorf("credential for %q has a malformed ha1 (want 32 hex characters)", c.Username)
	}
	if _, err := hex.DecodeString(c.HA1); err != nil {
		return fmt.Errorf("credential for %q has a non-hex ha1: %w", c.Username, err)
	}
	return nil
}
