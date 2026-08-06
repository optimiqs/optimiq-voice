package credentials_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/optimiqs/optimiq-voice/apps/sipd/internal/credentials"
)

func writeFixture(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "credentials.json")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing the fixture: %v", err)
	}
	return path
}

func TestHA1MatchesRFC2617(t *testing.T) {
	// The canonical example from RFC 2617 §3.5.
	if got := credentials.HA1("Mufasa", "testrealm@host.com", "Circle Of Life"); got != "939e7578ed9e3c518a452acee763bce9" {
		t.Errorf("HA1 = %q, want the RFC 2617 §3.5 worked example", got)
	}
}

func TestFileStoreLoadsPasswordsAndPrecomputedHashes(t *testing.T) {
	path := writeFixture(t, `{
		"realm": "acme.example.com",
		"accounts": [
			{
				"orgId": "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
				"username": "1001",
				"password": "s3cret",
				"deviceId": "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50"
			},
			{
				"orgId": "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
				"username": "1002",
				"ha1": "939e7578ed9e3c518a452acee763bce9"
			},
			{
				"orgId": "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
				"username": "1003",
				"password": "x",
				"enabled": false
			}
		]
	}`)

	store, err := credentials.NewFileStore(path, credentials.FileStoreOptions{})
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	if store.Len() != 3 {
		t.Fatalf("loaded %d accounts, want 3", store.Len())
	}

	ctx := context.Background()

	byPassword, err := store.Lookup(ctx, "acme.example.com", "1001")
	if err != nil {
		t.Fatalf("Lookup(1001): %v", err)
	}
	if byPassword.HA1 != credentials.HA1("1001", "acme.example.com", "s3cret") {
		t.Error("a plaintext password must be converted to HA1 at load")
	}
	if byPassword.Realm != "acme.example.com" {
		t.Errorf("realm = %q, want the document-level default", byPassword.Realm)
	}
	if byPassword.DeviceID == "" {
		t.Error("deviceId must survive: it is what joins a live binding to inventory")
	}

	byHash, err := store.Lookup(ctx, "acme.example.com", "1002")
	if err != nil {
		t.Fatalf("Lookup(1002): %v", err)
	}
	if byHash.HA1 != "939e7578ed9e3c518a452acee763bce9" {
		t.Errorf("HA1 = %q, want the precomputed value verbatim", byHash.HA1)
	}

	if _, err := store.Lookup(ctx, "acme.example.com", "1003"); !errors.Is(err, credentials.ErrDisabled) {
		t.Errorf("err = %v, want ErrDisabled", err)
	}
	if _, err := store.Lookup(ctx, "acme.example.com", "9999"); !errors.Is(err, credentials.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound", err)
	}
}

func TestFileStoreRealmIsCaseInsensitiveAndUsernameIsNot(t *testing.T) {
	path := writeFixture(t, `{
		"realm": "Acme.Example.COM",
		"accounts": [{"orgId": "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293", "username": "Alice", "password": "p"}]
	}`)
	store, err := credentials.NewFileStore(path, credentials.FileStoreOptions{})
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}
	ctx := context.Background()

	// RFC 3261 §19.1.4: host parts compare case-insensitively, user parts do not.
	if _, err := store.Lookup(ctx, "acme.example.com", "Alice"); err != nil {
		t.Errorf("a differently-cased realm must still match: %v", err)
	}
	if _, err := store.Lookup(ctx, "acme.example.com", "alice"); !errors.Is(err, credentials.ErrNotFound) {
		t.Errorf("err = %v, want ErrNotFound: SIP user parts are case-sensitive", err)
	}
}

func TestFileStoreRejectsBadFixturesAtLoad(t *testing.T) {
	cases := map[string]string{
		"no orgId": `{"realm":"a.example.com","accounts":[{"username":"1001","password":"p"}]}`,
		"no realm anywhere": `{"accounts":[
			{"orgId":"018f4f5e-1c2a-7a3b-9c4d-5e6f70819293","username":"1001","password":"p"}]}`,
		"malformed ha1": `{"realm":"a.example.com","accounts":[
			{"orgId":"018f4f5e-1c2a-7a3b-9c4d-5e6f70819293","username":"1001","ha1":"nope"}]}`,
		"non-hex ha1": `{"realm":"a.example.com","accounts":[
			{"orgId":"018f4f5e-1c2a-7a3b-9c4d-5e6f70819293","username":"1001",
			 "ha1":"zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"}]}`,
		"duplicate account": `{"realm":"a.example.com","accounts":[
			{"orgId":"018f4f5e-1c2a-7a3b-9c4d-5e6f70819293","username":"1001","password":"p"},
			{"orgId":"018f4f5e-1c2a-7a3b-9c4d-5e6f70819293","username":"1001","password":"q"}]}`,
		"not json": `{`,
	}

	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := credentials.NewFileStore(writeFixture(t, body), credentials.FileStoreOptions{}); err == nil {
				t.Error("a bad fixture must fail at boot, not at the first REGISTER")
			}
		})
	}

	if _, err := credentials.NewFileStore(filepath.Join(t.TempDir(), "absent.json"), credentials.FileStoreOptions{}); err == nil {
		t.Error("a missing file must fail at boot")
	}
}

func TestFileStoreReloadKeepsTheOldSetOnFailure(t *testing.T) {
	path := writeFixture(t, `{"realm":"a.example.com","accounts":[
		{"orgId":"018f4f5e-1c2a-7a3b-9c4d-5e6f70819293","username":"1001","password":"p"}]}`)
	store, err := credentials.NewFileStore(path, credentials.FileStoreOptions{})
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	if err := os.WriteFile(path, []byte("{ broken"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := store.Reload(); err == nil {
		t.Fatal("Reload accepted a broken file")
	}
	// Every phone in the building must not fall off the network because someone fat-fingered a file.
	if _, err := store.Lookup(context.Background(), "a.example.com", "1001"); err != nil {
		t.Errorf("a failed reload emptied the store: %v", err)
	}
}

func TestNATSStoreRequiresAConnection(t *testing.T) {
	// The stub this replaced constructed happily and failed at Lookup, because there was no
	// transport to require. Now a nil connection is a wiring mistake, and a wiring mistake must
	// stop the process at boot rather than turn into a 403 per REGISTER.
	if _, err := credentials.NewNATSStore(nil, credentials.NATSOptions{}); err == nil {
		t.Error("NewNATSStore(nil) must fail: an edge with no transport authenticates nobody")
	}
}

func TestFileStoreDerivesFromASecretRef(t *testing.T) {
	// The derived form is what makes a development fixture agree with what apps/api would have
	// rendered for the same line, instead of a literal somebody copied once. It is confined to the
	// file store because it needs the root key, which production sipd deliberately does not hold.
	const (
		key   = "provision-root-key-0123456789abcdef"
		org   = "018f4f5e-0000-7000-8000-0000000000a1"
		realm = "acme.example.com"
		user  = "1001"
		ref   = "ext/1001/sip"
	)

	path := writeFixture(t, `{"realm":"`+realm+`","accounts":[
		{"orgId":"`+org+`","username":"`+user+`","secretRef":"`+ref+`"}
	]}`)

	store, err := credentials.NewFileStore(path, credentials.FileStoreOptions{ProvisionSecretKey: key})
	if err != nil {
		t.Fatalf("NewFileStore: %v", err)
	}

	credential, err := store.Lookup(context.Background(), realm, user)
	if err != nil {
		t.Fatalf("Lookup: %v", err)
	}

	want, err := credentials.DeriveHA1(key, org, ref, user, realm)
	if err != nil {
		t.Fatalf("DeriveHA1: %v", err)
	}
	if credential.HA1 != want {
		t.Errorf("ha1 = %q, want the derived %q", credential.HA1, want)
	}

	// Without the key the same fixture must refuse to load. Loading it with an empty-key
	// derivation would produce an account whose password nobody can compute, and the symptom
	// would be a phone that cannot register for no visible reason.
	if _, err := credentials.NewFileStore(path, credentials.FileStoreOptions{}); err == nil {
		t.Error("a secretRef account with no root key must fail at load")
	}
}

func TestCredentialValidate(t *testing.T) {
	valid := credentials.Credential{
		OrgID:    "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
		Username: "1001",
		Realm:    "acme.example.com",
		HA1:      credentials.HA1("1001", "acme.example.com", "p"),
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("a complete credential must validate: %v", err)
	}

	missingOrg := valid
	missingOrg.OrgID = ""
	if err := missingOrg.Validate(); err == nil {
		t.Error("a credential with no org would write a binding no tenant owns")
	}
}

// The example fixture is what the README tells a newcomer to run with. If it stops loading, the
// first five minutes of the project are broken, so it is checked here rather than in a comment.
func TestShippedExampleFixtureLoads(t *testing.T) {
	store, err := credentials.NewFileStore(filepath.Join("..", "..", "config", "credentials.example.json"),
		credentials.FileStoreOptions{})
	if err != nil {
		t.Fatalf("config/credentials.example.json does not load: %v", err)
	}
	if store.Len() == 0 {
		t.Fatal("the example fixture declares no accounts")
	}
	credential, err := store.Lookup(context.Background(), "acme.example.com", "1001")
	if err != nil {
		t.Fatalf("the account the README tells you to dial does not resolve: %v", err)
	}
	if credential.HA1 != credentials.HA1("1001", "acme.example.com", "s3cret") {
		t.Error("the example password no longer matches what the README documents")
	}
}
