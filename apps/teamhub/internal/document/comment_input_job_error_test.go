package document

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/riverqueue/river/rivertype"
)

func TestCommentInputJobErrorSnoozesLostSerializationRace(t *testing.T) {
	for _, code := range []string{"40001", "40P01"} {
		err := commentInputJobError(fmt.Errorf("freeze: %w", &pgconn.PgError{Code: code}))
		var snooze *rivertype.JobSnoozeError
		if !errors.As(err, &snooze) || snooze.Duration != commentInputSnoozeDelay {
			t.Fatalf("code %s: err=%v, want snooze %s", code, err, commentInputSnoozeDelay)
		}
	}
	other := &pgconn.PgError{Code: "23505"}
	if err := commentInputJobError(other); err != other { //nolint:errorlint // asserts the error is returned unchanged
		t.Fatalf("non-retryable error = %v, want it unchanged", err)
	}
	if err := commentInputJobError(nil); err != nil {
		t.Fatalf("nil error = %v", err)
	}
}
