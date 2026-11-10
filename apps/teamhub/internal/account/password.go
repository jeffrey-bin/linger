package account

// Password hashing and verification for local Account credentials.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

// An Account password is PasswordMinBytes to PasswordMaxBytes bytes. Login and
// the current password in a change accept any non-empty password up to
// PasswordMaxBytes. Bytes, not characters, bound the Argon2id input.
const (
	PasswordMinBytes = 8
	PasswordMaxBytes = 1024
)

// ValidNewPassword reports whether password may become an Account password.
func ValidNewPassword(password string) bool {
	return len(password) >= PasswordMinBytes && len(password) <= PasswordMaxBytes
}

const (
	argonMemory      = 64 * 1024
	argonIterations  = 1
	argonParallelism = 4
	argonSaltLength  = 16
	argonKeyLength   = 32
)

// HashPassword produces an encoded hash with a random salt, using the service's current Argon2id parameters.
func HashPassword(password string) (string, error) {
	salt := make([]byte, argonSaltLength)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argonIterations, argonMemory, argonParallelism, argonKeyLength)
	encoding := base64.RawStdEncoding
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s", argonMemory, argonIterations, argonParallelism, encoding.EncodeToString(salt), encoding.EncodeToString(key)), nil
}

// VerifyPassword verifies an encoded Argon2id hash.
// The verifier caps the m/t/p cost that an external hash declares; changing the caps affects compatibility with existing hashes.
func VerifyPassword(password, encoded string) (bool, error) {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[1] != "argon2id" || parts[2] != "v=19" {
		return false, errors.New("invalid Argon2id hash")
	}
	var memory, iterations uint32
	var parallelism uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &iterations, &parallelism); err != nil {
		return false, fmt.Errorf("parse Argon2id parameters: %w", err)
	}
	if memory == 0 || iterations == 0 || parallelism == 0 {
		return false, errors.New("invalid Argon2id parameters")
	}
	if memory > argonMemory || iterations > 10 || parallelism > 16 {
		return false, errors.New("Argon2id parameters exceed verifier limits")
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false, fmt.Errorf("decode Argon2id salt: %w", err)
	}
	expected, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(expected) == 0 {
		return false, errors.New("decode Argon2id key")
	}
	actual := argon2.IDKey([]byte(password), salt, iterations, memory, parallelism, uint32(len(expected)))
	// The constant-time comparison covers only the content comparison of the two derived keys; it does not make the whole verification or login flow constant-time.
	return subtle.ConstantTimeCompare(actual, expected) == 1, nil
}
