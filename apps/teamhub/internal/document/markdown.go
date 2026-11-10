package document

import (
	"errors"
)

// markdownError reports a Markdown parse or render failure as the Document error its
// callers already handle. Errors from the callers' own Asset reads pass
// through unchanged.
func markdownError(err error) error {
	switch {
	case errors.Is(err, ErrInvalidMarkdown):
		return ErrInvalidInput
	case errors.Is(err, ErrAssetUnresolved):
		return ErrAssetUnavailable
	case errors.Is(err, ErrTooLarge):
		return ErrAssetQuotaExceeded
	default:
		return err
	}
}
