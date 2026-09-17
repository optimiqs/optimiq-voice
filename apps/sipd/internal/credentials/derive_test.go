package credentials_test

import (
	"encoding/json"
	"errors"
	"os"
	"regexp"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
)

// Cross-language parity for the provisioning password derivation.
//
// testdata/derive_parity.json is produced BY the TypeScript implementation
// (apps/api/src/provisioning/render/provision-secret.ts) via
// `pnpm --filter @optimiq-voice/api emit:sip-vectors`. Changing this derivation is a credential
// rotation that invalidates every provisioned handset, so it must be impossible to do by accident:
// an unregenerated golden fails `emit:sip-vectors --check`, a diverging Go side fails here.

type parityDocument struct {
	Algorithm      string         `json:"algorithm"`
	Message        string         `json:"message"`
	Encoding       string         `json:"encoding"`
	PasswordLength int            `json:"passwordLength"`
	Vectors        []parityVector `json:"vectors"`
}

type parityVector struct {
	Name           string `json:"name"`
	RootKey        string `json:"rootKey"`
	OrganizationID string `json:"organizationId"`
	SecretRef      string `json:"secretRef"`
	Username       string `json:"username"`
	Realm          string `json:"realm"`
	Password       string `json:"password"`
	HA1            string `json:"ha1"`
}

func loadParity(t *testing.T) parityDocument {
	t.Helper()

	raw, err := os.ReadFile("testdata/derive_parity.json")
	if err != nil {
		t.Fatalf("read golden: %v (regenerate with: pnpm --filter @optimiq-voice/api emit:sip-vectors)", err)
	}

	var doc parityDocument
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse golden: %v", err)
	}
	if len(doc.Vectors) == 0 {
		t.Fatal("golden has no vectors")
	}
	return doc
}

func TestDerivationMatchesTheTypeScriptGolden(t *testing.T) {
	doc := loadParity(t)

	if doc.Algorithm != "hmac-sha256" {
		t.Errorf("golden algorithm = %q, want hmac-sha256", doc.Algorithm)
	}
	if doc.PasswordLength != 24 {
		t.Errorf("golden passwordLength = %d, want 24", doc.PasswordLength)
	}

	for _, v := range doc.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			password, err := credentials.DeriveSipPassword(v.RootKey, v.OrganizationID, v.SecretRef)
			if err != nil {
				t.Fatalf("DeriveSipPassword: %v", err)
			}
			if password != v.Password {
				t.Errorf("password = %q, golden %q", password, v.Password)
			}

			ha1, err := credentials.DeriveHA1(v.RootKey, v.OrganizationID, v.SecretRef, v.Username, v.Realm)
			if err != nil {
				t.Fatalf("DeriveHA1: %v", err)
			}
			if ha1 != v.HA1 {
				t.Errorf("ha1 = %q, golden %q", ha1, v.HA1)
			}

			// The composition must be exactly "derive, then hash".
			if want := credentials.HA1(v.Username, v.Realm, password); ha1 != want {
				t.Errorf("DeriveHA1 = %q, but HA1(user, realm, DeriveSipPassword(...)) = %q", ha1, want)
			}
		})
	}
}

func TestDerivedPasswordAlphabetIsPhoneSafe(t *testing.T) {
	// base64url only: `+` and `/` are legal in a SIP password but break several vendors'
	// plain-text .cfg parsers, which is why provision-secret.ts picked this alphabet.
	safe := regexp.MustCompile(`^[A-Za-z0-9_-]{24}$`)

	for _, v := range loadParity(t).Vectors {
		password, err := credentials.DeriveSipPassword(v.RootKey, v.OrganizationID, v.SecretRef)
		if err != nil {
			t.Fatalf("%s: %v", v.Name, err)
		}
		if !safe.MatchString(password) {
			t.Errorf("%s: password %q is not 24 base64url characters", v.Name, password)
		}
	}
}

func TestDerivationSeparatesTenantsAndRefs(t *testing.T) {
	const key = "provision-root-key-0123456789abcdef"

	seen := map[string]string{}
	inputs := []struct{ org, ref string }{
		{"018f4f5e-0000-7000-8000-0000000000a1", "ext/1001/sip"},
		{"018f4f5e-0000-7000-8000-0000000000b2", "ext/1001/sip"}, // same ref, different tenant
		{"018f4f5e-0000-7000-8000-0000000000a1", "ext/1002/sip"}, // same tenant, different ref
		{"018f4f5e-0000-7000-8000-0000000000a1", "device/aa:bb:cc:dd:ee:ff/line/1"},
		{"018f4f5e-0000-7000-8000-0000000000a1", "device/aa:bb:cc:dd:ee:ff/line/2"},
	}

	for _, in := range inputs {
		password, err := credentials.DeriveSipPassword(key, in.org, in.ref)
		if err != nil {
			t.Fatalf("derive(%q, %q): %v", in.org, in.ref, err)
		}
		if previous, clash := seen[password]; clash {
			t.Errorf("derive(%q, %q) collides with %s", in.org, in.ref, previous)
		}
		seen[password] = in.org + "|" + in.ref
	}
}

// The message is a plain `orgID + ":" + secretRef` concatenation, so it is NOT injective:
// ("org-a", "b:c") and ("org-a:b", "c") both produce "org-a:b:c" and the same password. Both
// languages agree on this (the golden's `separator-adjacent` pair).
//
// It is not exploitable as written: organizationId is a UUID, which contains no colon, so a real
// message's split point is unambiguous whatever secretRef holds. Making it injective would change
// every derived password on every deployment — a credential rotation, and one that must be done in
// provision-secret.ts first.
func TestDerivationMessageIsNotInjectiveAcrossTheSeparator(t *testing.T) {
	const key = "provision-root-key-0123456789abcdef"

	left, err := credentials.DeriveSipPassword(key, "org-a", "b:c")
	if err != nil {
		t.Fatalf("left: %v", err)
	}
	right, err := credentials.DeriveSipPassword(key, "org-a:b", "c")
	if err != nil {
		t.Fatalf("right: %v", err)
	}
	if left != right {
		t.Errorf("the separator ambiguity has been closed on one side only: %q vs %q — "+
			"if this is intended, change provision-secret.ts and regenerate the golden", left, right)
	}
}

func TestDerivationIsDeterministic(t *testing.T) {
	const key = "provision-root-key-0123456789abcdef"

	first, err := credentials.DeriveSipPassword(key, "org-a", "ext/1001/sip")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	for range 16 {
		again, err := credentials.DeriveSipPassword(key, "org-a", "ext/1001/sip")
		if err != nil {
			t.Fatalf("again: %v", err)
		}
		if again != first {
			t.Fatalf("derivation is not deterministic: %q then %q", first, again)
		}
	}
}

func TestDerivationRefusesAnEmptyRootKey(t *testing.T) {
	// HMAC accepts an empty key, so without this guard a deployment that forgot the variable would
	// authenticate every phone against a password derived from nothing.
	if _, err := credentials.DeriveSipPassword("", "org-a", "ext/1001/sip"); !errors.Is(err, credentials.ErrNoRootKey) {
		t.Errorf("DeriveSipPassword with no key: err = %v, want ErrNoRootKey", err)
	}
	if _, err := credentials.DeriveHA1("", "org-a", "ext/1001/sip", "1001", "acme.example.com"); !errors.Is(err, credentials.ErrNoRootKey) {
		t.Errorf("DeriveHA1 with no key: err = %v, want ErrNoRootKey", err)
	}
}
