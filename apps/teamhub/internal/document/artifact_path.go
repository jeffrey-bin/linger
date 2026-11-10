package document

import (
	"errors"
	"path"
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// ErrInvalidArtifactPath reports an unsafe artifact relative path.
var ErrInvalidArtifactPath = errors.New("artifact relative path is invalid")

// Parse validates a logical path below a Room Artifact root.
func Parse(value string) ([]string, error) {
	if value == "" || len(value) > 1024 || !utf8.ValidString(value) || !norm.NFC.IsNormalString(value) ||
		path.IsAbs(value) || path.Clean(value) != value || strings.ContainsAny(value, "\\\x00") {
		return nil, ErrInvalidArtifactPath
	}
	components := strings.Split(value, "/")
	for index, component := range components {
		if component == "" || len(component) > 255 || strings.TrimSpace(component) != component || component == "." || component == ".." {
			return nil, ErrInvalidArtifactPath
		}
		if index == 0 && (strings.EqualFold(component, ".agents") || strings.EqualFold(component, ".teamhub")) {
			return nil, ErrInvalidArtifactPath
		}
	}
	return components, nil
}
