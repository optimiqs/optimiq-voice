package directory

import (
	"context"
	"sync"
)

// FakeStore is an in-memory Store for the unit suite.
//
// In the package rather than in a _test.go file because the control package's tests need it too,
// and a fake that only one package can see is a fake that gets written twice. It mirrors sipd's
// in-memory credentials store for the same reason.
type FakeStore struct {
	mu      sync.Mutex
	entries map[string]Entry
	// PutErr and DeleteErr force a failure, so a caller's "log it and carry on" path is actually
	// covered rather than assumed.
	PutErr    error
	DeleteErr error
	// Puts and Deletes count calls, for asserting the release-cleans-up contract.
	Puts    int
	Deletes int
}

var _ Store = (*FakeStore)(nil)

// NewFakeStore returns an empty store.
func NewFakeStore() *FakeStore {
	return &FakeStore{entries: make(map[string]Entry)}
}

// Put records an entry.
func (s *FakeStore) Put(_ context.Context, entry Entry) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Puts++
	if s.PutErr != nil {
		return s.PutErr
	}
	s.entries[entry.SessionID] = entry
	return nil
}

// Get reads an entry back.
func (s *FakeStore) Get(_ context.Context, sessionID string) (Entry, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[sessionID]
	return entry, ok, nil
}

// Delete removes an entry.
func (s *FakeStore) Delete(_ context.Context, sessionID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.Deletes++
	if s.DeleteErr != nil {
		return s.DeleteErr
	}
	delete(s.entries, sessionID)
	return nil
}

// Len is how many entries the store holds.
func (s *FakeStore) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}
