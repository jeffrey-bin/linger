// Package roomdocument is the HTTP adapter of the Document Runtime: it
// implements document.Runtime and the Runtime disconnect over the generated
// node-services-internal contract.
package roomdocument

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

const maxDocumentRuntimeIdentityLength = 64

var documentRuntimeIdentityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]*$`)

// The adapter reports the Document service's own errors, so callers need no
// second error vocabulary.
var (
	ErrInvalidState       = document.ErrRuntimeResultInvalid
	ErrRuntimeUnavailable = document.ErrRuntimeUnavailable
)

func validDocumentSessionID(value string) bool {
	return value != "" && len(value) <= maxDocumentRuntimeIdentityLength &&
		documentRuntimeIdentityPattern.MatchString(value)
}

func uniqueDocumentIDs(values []string) bool {
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		if !validDocumentSessionID(value) {
			return false
		}
		if _, exists := seen[value]; exists {
			return false
		}
		seen[value] = struct{}{}
	}
	return true
}

func bytesHash(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
