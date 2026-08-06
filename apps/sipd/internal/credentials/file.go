package credentials

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
)

// FileStore is the development / test-rig credential store: a JSON file, loaded into memory.
//
// It exists so sipd can be run and SIPp-tested without apps/api or a database. Production uses
// NATSStore. The file format accepts either a precomputed ha1 or a plaintext password (converted at
// load and then dropped), because a fixture nobody can read is a fixture nobody maintains.
//
//	{
//	  "realm": "acme.example.com",
//	  "accounts": [
//	    {
//	      "orgId": "018f4f5e-1c2a-7a3b-9c4d-5e6f70819293",
//	      "username": "1001",
//	      "password": "s3cret",
//	      "deviceId": "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b50",
//	      "extensionId": "0192c7a1-4b8e-7f21-8b3c-9d0e1f2a3b51"
//	    },
//	    { "orgId": "…", "username": "1002", "ha1": "…32 hex…", "enabled": false }
//	  ]
//	}
//
// The top-level realm is a default for accounts that do not state their own.
type FileStore struct {
	path string

	mu       sync.RWMutex
	accounts map[string]Credential
	disabled map[string]struct{}
}

type fileAccount struct {
	OrgID       string `json:"orgId"`
	Username    string `json:"username"`
	Realm       string `json:"realm"`
	Password    string `json:"password"`
	HA1         string `json:"ha1"`
	DeviceID    string `json:"deviceId"`
	ExtensionID string `json:"extensionId"`
	// Enabled defaults to true: a fixture should not need a field to work.
	Enabled *bool `json:"enabled"`
}

type fileDocument struct {
	Realm    string        `json:"realm"`
	Accounts []fileAccount `json:"accounts"`
}

// NewFileStore loads the file immediately so a bad fixture fails at boot, not at first REGISTER.
func NewFileStore(path string) (*FileStore, error) {
	store := &FileStore{path: path}
	if err := store.Reload(); err != nil {
		return nil, err
	}
	return store, nil
}

// Reload re-reads the file. Safe to call while the registrar is serving; a failed reload leaves the
// previously loaded set in place rather than emptying it.
func (s *FileStore) Reload() error {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		return fmt.Errorf("credentials: reading %s: %w", s.path, err)
	}
	var document fileDocument
	if err := json.Unmarshal(raw, &document); err != nil {
		return fmt.Errorf("credentials: parsing %s: %w", s.path, err)
	}

	accounts := make(map[string]Credential, len(document.Accounts))
	disabled := make(map[string]struct{})
	for index, account := range document.Accounts {
		realm := strings.TrimSpace(account.Realm)
		if realm == "" {
			realm = strings.TrimSpace(document.Realm)
		}
		credential := Credential{
			OrgID:       strings.TrimSpace(account.OrgID),
			Username:    strings.TrimSpace(account.Username),
			Realm:       realm,
			HA1:         strings.ToLower(strings.TrimSpace(account.HA1)),
			DeviceID:    strings.TrimSpace(account.DeviceID),
			ExtensionID: strings.TrimSpace(account.ExtensionID),
		}
		if credential.HA1 == "" && account.Password != "" {
			credential.HA1 = HA1(credential.Username, credential.Realm, account.Password)
		}
		if err := credential.Validate(); err != nil {
			return fmt.Errorf("credentials: %s account #%d: %w", s.path, index, err)
		}
		key := lookupKey(credential.Realm, credential.Username)
		if _, duplicate := accounts[key]; duplicate {
			return fmt.Errorf("credentials: %s declares %s twice", s.path, key)
		}
		accounts[key] = credential
		if account.Enabled != nil && !*account.Enabled {
			disabled[key] = struct{}{}
		}
	}

	s.mu.Lock()
	s.accounts, s.disabled = accounts, disabled
	s.mu.Unlock()
	return nil
}

// Lookup implements Store.
func (s *FileStore) Lookup(_ context.Context, realm, username string) (Credential, error) {
	key := lookupKey(realm, username)

	s.mu.RLock()
	credential, found := s.accounts[key]
	_, off := s.disabled[key]
	s.mu.RUnlock()

	if !found {
		return Credential{}, ErrNotFound
	}
	if off {
		return Credential{}, ErrDisabled
	}
	return credential, nil
}

// Len reports how many accounts are loaded. Used by the boot log and by tests.
func (s *FileStore) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.accounts)
}

// lookupKey keys accounts by realm and username. The realm is folded to lower case (RFC 3261
// §19.1.4: host parts are case-insensitive) and the username is not (user parts are case-sensitive).
func lookupKey(realm, username string) string {
	return strings.ToLower(strings.TrimSpace(realm)) + "/" + strings.TrimSpace(username)
}
