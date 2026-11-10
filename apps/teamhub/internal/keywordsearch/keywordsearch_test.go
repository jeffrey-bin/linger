package keywordsearch

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestNormalizeCountsCharacters(t *testing.T) {
	for _, tc := range []struct {
		query, want string
		ok          bool
	}{
		{"  Kraken Plan ", "Kraken Plan", true},
		{"   ", "", false},
		{strings.Repeat("€", HumanQueryChars), strings.Repeat("€", HumanQueryChars), true},
		{strings.Repeat("€", HumanQueryChars+1), "", false},
	} {
		got, ok := Normalize(tc.query, HumanQueryChars)
		if ok != tc.ok || (ok && got != tc.want) {
			t.Fatalf("Normalize(%q) = %q, %v", tc.query, got, ok)
		}
	}
}

func TestTimedOutRecognizesTheStatementTimeout(t *testing.T) {
	timeout := fmt.Errorf("search: %w", &pgconn.PgError{Code: "57014"})
	if !TimedOut(context.Background(), timeout) {
		t.Fatal("a wrapped 57014 must be a timeout")
	}
	if TimedOut(context.Background(), &pgconn.PgError{Code: "40001"}) || TimedOut(context.Background(), errors.New("boom")) {
		t.Fatal("other errors are not timeouts")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if TimedOut(canceled, timeout) {
		t.Fatal("a canceled request is not a timeout")
	}
}
