package document

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// stableCreateID derives a row ID from its parts, so a retried command writes
// the same rows instead of new ones.
func stableCreateID(prefix string, parts ...string) string {
	digest := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return prefix + hex.EncodeToString(digest[:16])
}

// stableHistoryID derives a History row ID from the Document head it records.
func stableHistoryID(prefix, documentID string, persistedSeq int64, evidence string) string {
	hash := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%s", documentID, persistedSeq, evidence)))
	return prefix + hex.EncodeToString(hash[:16])
}

// documentBytesHash is the hex SHA-256 every Document digest uses.
func documentBytesHash(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
