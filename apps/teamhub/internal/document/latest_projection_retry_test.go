package document

import (
	"errors"
	"fmt"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestRetryOnDocumentSerializationFailure(t *testing.T) {
	serialization := &pgconn.PgError{
		Code: "40001", Message: "could not serialize access due to concurrent update",
	}
	mismatch := errors.New("owner/grant mismatch")
	cases := []struct {
		name      string
		errors    []error
		wantCalls int
		wantErr   error
	}{
		{
			name:      "serialization then success",
			errors:    []error{serialization, nil},
			wantCalls: 2,
		},
		{
			name:      "wrapped serialization then success",
			errors:    []error{fmt.Errorf("settle latest: %w", serialization), nil},
			wantCalls: 2,
		},
		{
			name:      "owner grant mismatch fails immediately",
			errors:    []error{mismatch},
			wantCalls: 1,
			wantErr:   mismatch,
		},
		{
			name:      "exhausted serialization failures",
			errors:    []error{serialization, serialization, serialization},
			wantCalls: 3,
			wantErr:   serialization,
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			err := retryOnDocumentSerializationFailure(func() error {
				index := calls
				calls++
				if index >= len(test.errors) {
					return nil
				}
				return test.errors[index]
			})
			if calls != test.wantCalls {
				t.Fatalf("calls=%d want=%d", calls, test.wantCalls)
			}
			if test.wantErr == nil {
				if err != nil {
					t.Fatalf("err=%v want nil", err)
				}
				return
			}
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("err=%v want=%v", err, test.wantErr)
			}
		})
	}
}
