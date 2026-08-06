// Package credentials resolves the SIP account behind a REGISTER.
//
// The registrar never sees a plaintext password: RFC 2617 digest only needs
// HA1 = MD5(username:realm:password), so that is what a Credential carries and what apps/api will
// eventually return. A store that is handed plaintext computes HA1 immediately and discards it.
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
}

// Store resolves a SIP username within a realm.
//
// Implementations must be safe for concurrent use: every REGISTER on every transport calls this.
type Store interface {
	Lookup(ctx context.Context, realm, username string) (Credential, error)
}

// HA1 computes MD5(username:realm:password).
//
// MD5 is not a choice: RFC 2617 digest specifies it, every SIP phone implements it, and the digest
// exchange never transmits it. It is a legacy construction protected by the transport (use TLS on
// any untrusted network), not a password hash — never reuse an HA1 as a stored password digest.
func HA1(username, realm, password string) string {
	sum := md5.Sum([]byte(username + ":" + realm + ":" + password))
	return hex.EncodeToString(sum[:])
}

// Validate checks a credential is usable before it reaches the digest verifier: a record missing
// its org or carrying a malformed HA1 must fail loudly at load time, not silently authenticate.
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
