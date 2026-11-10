package secretbox

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
)

// MaxSignedLength bounds the signed values Sign returns and Verify accepts.
const MaxSignedLength = 2048

// ErrTooLong reports a payload whose signed value would exceed MaxSignedLength.
var ErrTooLong = errors.New("signed value exceeds the maximum length")

// Sign encodes payload as base64url(JSON) "." base64url(HMAC-SHA256). The
// domain separates the uses of one key. The value has no "/" and fits one URL
// path segment. It returns ErrTooLong rather than a value Verify would reject.
func Sign(key []byte, domain string, payload any) (string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(raw)
	value := encoded + "." + base64.RawURLEncoding.EncodeToString(signature(key, domain, encoded))
	if len(value) > MaxSignedLength {
		return "", ErrTooLong
	}
	return value, nil
}

// Verify checks a value from Sign and decodes its payload. It reports false
// for a malformed, oversized, or forged value, or when key is empty.
func Verify(key []byte, domain, value string, payload any) bool {
	if len(key) == 0 || len(value) > MaxSignedLength {
		return false
	}
	encoded, mac, found := strings.Cut(value, ".")
	if !found {
		return false
	}
	got, err := base64.RawURLEncoding.DecodeString(mac)
	if err != nil || !hmac.Equal(got, signature(key, domain, encoded)) {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && json.Unmarshal(raw, payload) == nil
}

func signature(key []byte, domain, encodedPayload string) []byte {
	hash := hmac.New(sha256.New, key)
	_, _ = hash.Write([]byte(domain + "\n" + encodedPayload))
	return hash.Sum(nil)
}
