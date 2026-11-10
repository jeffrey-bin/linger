package agentauth

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
)

// IdempotencyKey derives the stored fingerprint of one Agent command. Run
// provenance is not part of a command's identity.
func IdempotencyKey(operation, invocationID string) string {
	return fingerprint(operation, invocationID)
}

func fingerprint(fields ...string) string {
	hash := sha256.New()
	var length [8]byte
	for _, field := range fields {
		binary.BigEndian.PutUint64(length[:], uint64(len(field)))
		_, _ = hash.Write(length[:])
		_, _ = hash.Write([]byte(field))
	}
	return hex.EncodeToString(hash.Sum(nil))
}
