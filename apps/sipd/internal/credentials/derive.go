package credentials

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
)

// The provisioning password derivation, byte-for-byte identical to the TypeScript one in
// apps/api/src/provisioning/render/provision-secret.ts.
//
// # What this is a contract with
//
// A provisioned phone is handed a password the API computed. When it registers, the registrar has
// to accept that same password. There is no password column in pbx-db to compare against —
// extension.sip_secret_ref is a HANDLE, and the schema is explicit that the plaintext is never
// stored — so the value is DERIVED on both sides from a shared root key:
//
//	password = base64url(hmac-sha256(rootKey, orgID + ":" + secretRef))[:24]
//	ha1      = md5(username + ":" + realm + ":" + password)
//
// A single byte of disagreement between the two implementations means every handset on the
// deployment fails to register, and it fails silently: the phone says "registration failed" and
// neither side can say why. testdata/derive_parity.json is therefore produced BY the TypeScript
// implementation (apps/api/scripts/emit-sip-derivation-vectors.ts) and asserted by derive_test.go,
// exactly as packages/events-go/testdata/parity.json pins the event contract. A second
// hand-written expectation would only prove this file agrees with whoever wrote its test.
//
// # Why this is not on the REGISTER path
//
// It is deliberately NOT how production sipd authenticates. The credential RPC
// (rpc.sip.v1.credential) returns a ready-made HA1 that the API derived, so the root key stays on
// the control plane and never reaches the SIP edge — the most exposed process in the system, and
// the one whose compromise would otherwise yield every tenant's password at once. See nats.go.
//
// What this file IS for:
//
//   - Parity. It is the executable statement that Go and TypeScript agree, checked on every CI run.
//   - The file store's derived form, so a development or SIPp-rig fixture can name an
//     (orgId, secretRef) pair and get exactly the password the API would render, instead of a
//     hand-copied literal that drifts. See file.go.
//   - The in-process responder the integration suite runs, which has to produce a real HA1.
//
// An operator who genuinely wants edge-side derivation can set SIPD_PROVISION_SECRET_KEY and use
// the file store's derived form; nothing here reads the environment on its own.

// derivedPasswordLength is how many base64url characters of the digest become the password.
// 24 characters ≈ 144 bits. Must equal PASSWORD_LENGTH in provision-secret.ts.
const derivedPasswordLength = 24

// ErrNoRootKey is returned when a derivation is attempted without a root key. It is an error
// rather than a derivation from the empty string on purpose: HMAC accepts an empty key perfectly
// happily, so the failure mode without this check is a deployment that authenticates every phone
// against a password derived from a key nobody set.
var ErrNoRootKey = errors.New("credentials: no provisioning root key (set SIPD_PROVISION_SECRET_KEY)")

// DeriveSipPassword computes the password a provisioned phone was handed for this line.
//
// The message is orgID + ":" + secretRef with no trailing separator, the key is the root key's
// raw UTF-8 bytes, and the output is the first 24 characters of the UNPADDED base64url encoding
// of the 32-byte digest — character truncation of the encoding, not byte truncation of the digest.
// Node's .digest("base64url") is RFC 4648 §5 without padding, which is base64.RawURLEncoding here.
func DeriveSipPassword(rootKey, orgID, secretRef string) (string, error) {
	if rootKey == "" {
		return "", ErrNoRootKey
	}

	mac := hmac.New(sha256.New, []byte(rootKey))
	// Write on a hash.Hash never returns an error (documented on hash.Hash), so the result is
	// discarded rather than dressed up as a failure this function cannot experience.
	mac.Write([]byte(orgID + ":" + secretRef))

	encoded := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded[:derivedPasswordLength], nil
}

// DeriveHA1 computes the digest hash for a line, composing DeriveSipPassword with HA1.
//
// This is the whole chain a REGISTER walks, and it is the composition apps/api's credential
// responder performs before it replies — which is why the golden vectors pin both halves rather
// than only the password.
func DeriveHA1(rootKey, orgID, secretRef, username, realm string) (string, error) {
	password, err := DeriveSipPassword(rootKey, orgID, secretRef)
	if err != nil {
		return "", err
	}
	return HA1(username, strings.TrimSpace(realm), password), nil
}
