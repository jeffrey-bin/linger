package transport

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

var ErrInvalidIdentity = errors.New("invalid daemon identity")

// Identity is the device identity, independent from any enrollment
// credential. The private key never belongs in a wire Command or Event.
type Identity struct {
	DaemonID   string
	PublicKey  ed25519.PublicKey
	PrivateKey ed25519.PrivateKey
}

// GenerateIdentity creates a new ed25519 daemon identity.
func GenerateIdentity() (Identity, error) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return Identity{}, fmt.Errorf("generate daemon identity: %w", err)
	}
	return NewIdentity(publicKey, privateKey)
}

// NewIdentity builds an identity from a matching ed25519 key pair.
func NewIdentity(publicKey ed25519.PublicKey, privateKey ed25519.PrivateKey) (Identity, error) {
	if len(publicKey) != ed25519.PublicKeySize || len(privateKey) != ed25519.PrivateKeySize {
		return Identity{}, ErrInvalidIdentity
	}
	if !privateKey.Public().(ed25519.PublicKey).Equal(publicKey) {
		return Identity{}, ErrInvalidIdentity
	}
	hash := sha256.Sum256(publicKey)
	return Identity{
		DaemonID:   base64.RawURLEncoding.EncodeToString(hash[:]),
		PublicKey:  append(ed25519.PublicKey(nil), publicKey...),
		PrivateKey: append(ed25519.PrivateKey(nil), privateKey...),
	}, nil
}

func (i Identity) Sign(message []byte) ([]byte, error) {
	if _, err := NewIdentity(i.PublicKey, i.PrivateKey); err != nil {
		return nil, err
	}
	return ed25519.Sign(i.PrivateKey, message), nil
}

func (i Identity) Verify(message, signature []byte) bool {
	if _, err := NewIdentity(i.PublicKey, i.PrivateKey); err != nil {
		return false
	}
	return ed25519.Verify(i.PublicKey, message, signature)
}
