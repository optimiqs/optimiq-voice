package credentials

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// The provisioning password derivation, byte-for-byte identical to the TypeScript one in
// apps/api/src/provisioning/render/provision-secret.ts. pbx-db stores no plaintext —
// extension.sip_secret_ref is a handle — so both sides derive from a shared root key:
//
//	password = base64url(hmac-sha256(rootKey, orgID + ":" + secretRef))[:24]
//	ha1      = md5(username + ":" + realm + ":" + password)
//
// Parity is pinned by testdata/derive_parity.json, emitted by the TypeScript implementation
// (apps/api/scripts/emit-sip-derivation-vectors.ts) and asserted in derive_test.go.
//
// This is deliberately NOT the production REGISTER path: the credential RPC
// (rpc.sip.v1.credential) returns an HA1 apps/api already derived, so the root key stays on the
// control plane and never reaches the SIP edge. See nats.go. Here it serves parity, the file
// store's derived form (file.go), and the integration suite's in-process responder.

// derivedPasswordLength is how many base64url characters of the digest become the password.
// 24 characters ≈ 144 bits. Must equal PASSWORD_LENGTH in provision-secret.ts.
const derivedPasswordLength = 24

// ErrNoRootKey is returned when a derivation is attempted without a root key. HMAC accepts an
// empty key happily, so without this check a deployment would authenticate every phone against a
// password derived from a key nobody set.
var ErrNoRootKey = errors.New("credentials: no provisioning root key (set SIPD_PROVISION_SECRET_KEY)")

// DeriveSipPassword computes the password a provisioned phone was handed for this line.
//
// The message is orgID + ":" + secretRef with no trailing separator, the key is the root key's raw
// UTF-8 bytes, and the output is the first 24 characters of the UNPADDED base64url encoding of the
// 32-byte digest — character truncation of the encoding, not byte truncation of the digest
// (Node's .digest("base64url") is RFC 4648 §5 unpadded, i.e. base64.RawURLEncoding).
func DeriveSipPassword(rootKey, orgID, secretRef string) (string, error) {
	if rootKey == "" {
		return "", ErrNoRootKey
	}

	mac := hmac.New(sha256.New, []byte(rootKey))
	// hash.Hash documents that Write never returns an error.
	mac.Write([]byte(orgID + ":" + secretRef))

	encoded := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded[:derivedPasswordLength], nil
}

// DeriveHA1 computes the digest hash for a line, composing DeriveSipPassword with HA1. This is the
// same composition apps/api's credential responder performs, so the golden vectors pin both halves.
func DeriveHA1(rootKey, orgID, secretRef, username, realm string) (string, error) {
	password, err := DeriveSipPassword(rootKey, orgID, secretRef)
	if err != nil {
		return "", err
	}
	return HA1(username, strings.TrimSpace(realm), password), nil
}
