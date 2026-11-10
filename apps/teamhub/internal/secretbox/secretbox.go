// Package secretbox encrypts deployment secrets saved in the database and
// signs the short-lived capabilities TeamHub hands to browsers.
package secretbox

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
)

// Box seals values with AES-256-GCM. The nonce is stored before the ciphertext.
type Box struct {
	aead cipher.AEAD
}

func New(encodedKey string) (*Box, error) {
	key, err := base64.StdEncoding.DecodeString(encodedKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("secret encryption key must be 32 bytes in standard base64")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &Box{aead: aead}, nil
}

func (b *Box) Seal(plaintext []byte) ([]byte, error) {
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	return b.aead.Seal(nonce, nonce, plaintext, nil), nil
}

func (b *Box) Open(sealed []byte) ([]byte, error) {
	if len(sealed) < b.aead.NonceSize() {
		return nil, errors.New("sealed secret is too short")
	}
	nonce, ciphertext := sealed[:b.aead.NonceSize()], sealed[b.aead.NonceSize():]
	return b.aead.Open(nil, nonce, ciphertext, nil)
}
