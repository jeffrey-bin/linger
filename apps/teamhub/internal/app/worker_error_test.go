package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestReportWorkerError(t *testing.T) {
	for _, tt := range []struct {
		name    string
		stopped bool
		err     error
		wantLog bool
	}{
		{"shutdown cancellation", true, context.Canceled, false},
		{"wrapped cancellation", true, fmt.Errorf("query: %w", context.Canceled), false},
		{"joined cancellations", true, errors.Join(context.Canceled, fmt.Errorf("query: %w", context.Canceled)), false},
		{"live worker cancellation", false, context.Canceled, true},
		{"shutdown database failure", true, errors.New("database unavailable"), true},
		{"mixed failure", true, errors.Join(context.Canceled, errors.New("database unavailable")), true},
		{"deadline", true, context.DeadlineExceeded, true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tt.stopped {
				cancel()
			}
			var logs bytes.Buffer
			a := &App{logger: slog.New(slog.NewTextHandler(&logs, nil))}
			a.reportWorkerError(ctx, "worker failed", tt.err)
			if got := strings.Contains(logs.String(), "level=ERROR"); got != tt.wantLog {
				t.Fatalf("error log=%v want=%v: %s", got, tt.wantLog, logs.String())
			}
		})
	}
}
