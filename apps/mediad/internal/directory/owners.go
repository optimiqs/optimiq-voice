package directory

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/nats-io/nats.go/jetstream"
	contract "github.com/optimiqs/optimiq-voice/packages/events-go"
)

// Owners stores immutable placement decisions. A retry must reach the original sockets.
// Calls share a placement key; sessions, bridges and operation references have separate indexes.
type Owners interface {
	Get(context.Context, string) (string, error)
	Claim(context.Context, string, string) (string, error)
	Refresh(context.Context, string, string) error
}

type KVOwners struct{ kv jetstream.KeyValue }

func OwnerKey(kind, id string) string {
	hash := sha256.Sum256([]byte(id))
	return kind + "." + hex.EncodeToString(hash[:])
}

func OpenOwners(ctx context.Context, js jetstream.JetStream) (*KVOwners, error) {
	def := contract.MediaOwnersKV
	kv, err := js.CreateOrUpdateKeyValue(ctx, jetstream.KeyValueConfig{
		Bucket: def.Name, Description: def.Description, TTL: def.TTL,
		History: def.History, Storage: jetstream.FileStorage, MaxValueSize: def.MaxValueSize,
		MaxBytes: def.MaxBytes, Replicas: def.NumReplicas,
	})
	if err != nil {
		return nil, fmt.Errorf("opening media ownership: %w", err)
	}
	return &KVOwners{kv: kv}, nil
}

func (s *KVOwners) Get(ctx context.Context, key string) (string, error) {
	entry, err := s.kv.Get(ctx, key)
	if errors.Is(err, jetstream.ErrKeyNotFound) || errors.Is(err, jetstream.ErrKeyDeleted) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if len(entry.Value()) == 0 {
		return "", errors.New("empty media owner")
	}
	return string(entry.Value()), nil
}

func (s *KVOwners) Claim(ctx context.Context, key, instance string) (string, error) {
	if instance == "" {
		return "", errors.New("cannot claim media with an empty owner")
	}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := s.kv.Create(ctx, key, []byte(instance)); err == nil {
			return instance, nil
		} else if !errors.Is(err, jetstream.ErrKeyExists) {
			return "", err
		}
		owner, err := s.Get(ctx, key)
		if err != nil || owner != "" {
			return owner, err
		}
		// The prior owner expired between Create and Get. Retry the atomic claim.
	}
	return "", errors.New("media ownership changed while claiming")
}

// Refresh uses CAS so a delayed heartbeat cannot overwrite a later placement decision.
func (s *KVOwners) Refresh(ctx context.Context, key, instance string) error {
	entry, err := s.kv.Get(ctx, key)
	if err != nil {
		return err
	}
	if string(entry.Value()) != instance {
		return errors.New("media ownership changed")
	}
	_, err = s.kv.Update(ctx, key, entry.Value(), entry.Revision())
	return err
}
