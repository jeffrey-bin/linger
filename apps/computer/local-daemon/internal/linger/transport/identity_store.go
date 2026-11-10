package transport

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// IdentityStore loads the daemon identity, creating it on first use.
type IdentityStore interface {
	LoadOrCreate(context.Context) (Identity, error)
}

// IdentityFileStore keeps the daemon identity in an owner-private file.
type IdentityFileStore struct {
	Path string
}

type fileIdentity struct {
	PublicKey  string `json:"public_key"`
	PrivateKey string `json:"private_key"`
}

// LoadOrCreate returns the stored identity, or generates and publishes one
// when the file does not exist.
func (s IdentityFileStore) LoadOrCreate(ctx context.Context) (Identity, error) {
	if err := ctx.Err(); err != nil {
		return Identity{}, err
	}
	if s.Path == "" {
		return Identity{}, errors.New("identity path is empty")
	}
	loaded, err := s.load()
	if err == nil {
		return loaded, nil
	}
	if !errors.Is(err, fs.ErrNotExist) {
		return Identity{}, err
	}
	created, err := GenerateIdentity()
	if err != nil {
		return Identity{}, err
	}
	if err := s.persist(created); err != nil {
		if errors.Is(err, fs.ErrExist) {
			return s.load()
		}
		return Identity{}, err
	}
	return created, nil
}

func (s IdentityFileStore) load() (Identity, error) {
	file, err := privatefs.OpenRead(s.Path, true)
	if err != nil {
		return Identity{}, fmt.Errorf("open daemon identity: %w", err)
	}
	defer file.Close()
	var encoded fileIdentity
	if err := json.NewDecoder(file).Decode(&encoded); err != nil {
		return Identity{}, fmt.Errorf("decode daemon identity: %w", err)
	}
	publicKey, err := base64.RawStdEncoding.DecodeString(encoded.PublicKey)
	if err != nil {
		return Identity{}, fmt.Errorf("decode daemon public key: %w", err)
	}
	privateKey, err := base64.RawStdEncoding.DecodeString(encoded.PrivateKey)
	if err != nil {
		return Identity{}, fmt.Errorf("decode daemon private key: %w", err)
	}
	return NewIdentity(ed25519.PublicKey(publicKey), ed25519.PrivateKey(privateKey))
}

func (s IdentityFileStore) persist(identity Identity) error {
	encoded := fileIdentity{PublicKey: base64.RawStdEncoding.EncodeToString(identity.PublicKey), PrivateKey: base64.RawStdEncoding.EncodeToString(identity.PrivateKey)}
	data, err := json.Marshal(encoded)
	if err != nil {
		return err
	}
	return privatefs.WriteFile(s.Path, append(data, '\n'), true)
}
