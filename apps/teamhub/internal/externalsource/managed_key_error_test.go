package externalsource

import (
	"errors"
	"net/http"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
)

func TestConnectionKeyErrorsDistinguishForbidden(t *testing.T) {
	for _, tc := range []struct {
		status int
		want   error
	}{
		{http.StatusUnauthorized, ErrManagedKeyRejected},
		{http.StatusForbidden, ErrManagedKeyForbidden},
	} {
		err := classifyConnectionAuthError(composio.RemoteStatusError("connect", tc.status))
		if !errors.Is(err, tc.want) || (tc.status == http.StatusForbidden && errors.Is(err, ErrManagedKeyRejected)) {
			t.Errorf("status %d: unexpected error %v", tc.status, err)
		}
	}
}
