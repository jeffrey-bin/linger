package jobs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"slices"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
)

type retryableFailure struct{ retryable bool }

func (e *retryableFailure) Error() string             { return "connection check failed" }
func (e *retryableFailure) RetryableJobFailure() bool { return e.retryable }

func TestErrorLoggerWarnsOnRetryableJobFailure(t *testing.T) {
	job := &rivertype.JobRow{Kind: "external.connection_reconcile", ID: 7, Attempt: 3}
	tests := []struct {
		name  string
		err   error
		level string
	}{
		{name: "retryable identity", err: &retryableFailure{retryable: true}, level: "WARN"},
		{name: "wrapped retryable", err: fmt.Errorf("check: %w", &retryableFailure{retryable: true}), level: "WARN"},
		{name: "auth failure", err: &retryableFailure{retryable: false}, level: "ERROR"},
		{name: "other job", err: errors.New("database unavailable"), level: "ERROR"},
		{name: "joined write error", err: errors.Join(errors.New("database unavailable"), &retryableFailure{retryable: true}), level: "ERROR"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var logs bytes.Buffer
			errorLogger{logger: slog.New(slog.NewTextHandler(&logs, nil))}.HandleError(t.Context(), job, test.err)
			text := logs.String()
			if !strings.Contains(text, "level="+test.level) || !strings.Contains(text, "run TeamHub job") {
				t.Fatalf("log=%q want level=%s", text, test.level)
			}
			if test.level == "WARN" && strings.Contains(text, "level=ERROR") {
				t.Fatalf("retryable failure logged as ERROR: %s", text)
			}
			if test.level == "ERROR" && strings.Contains(text, "level=WARN") {
				t.Fatalf("terminal failure logged as WARN: %s", text)
			}
		})
	}
}

func TestUniqueUnfinishedOmitsRetryable(t *testing.T) {
	for _, state := range UniqueUnfinished.ByState {
		if state == rivertype.JobStateRetryable {
			t.Fatal("UniqueUnfinished must omit retryable")
		}
	}
}

type countedArgs struct{}

func (countedArgs) Kind() string { return "test.counted" }

type countedWorker struct {
	river.WorkerDefaults[countedArgs]
	runs int
}

func (w *countedWorker) Work(context.Context, *river.Job[countedArgs]) error {
	w.runs++
	return nil
}

// A job of a feature whose configuration is missing completes without work.
func TestAddWorkerWhenSkipsWorkWhileDisabled(t *testing.T) {
	enabled := false
	inner := &countedWorker{}
	workers := river.NewWorkers()
	AddWorkerWhen[countedArgs](workers, func() bool { return enabled }, inner)
	worker := &enabledWorker[countedArgs]{Worker: inner, enabled: func() bool { return enabled }}
	if err := worker.Work(t.Context(), &river.Job[countedArgs]{}); err != nil || inner.runs != 0 {
		t.Fatalf("disabled job ran: runs=%d err=%v", inner.runs, err)
	}
	enabled = true
	if err := worker.Work(t.Context(), &river.Job[countedArgs]{}); err != nil || inner.runs != 1 {
		t.Fatalf("enabled job did not run: runs=%d err=%v", inner.runs, err)
	}
}

func TestQueueConfigsPollOnTheClientInterval(t *testing.T) {
	options := Options{Queues: map[string]river.QueueConfig{"voice": {MaxWorkers: 8}}}
	queues := queueConfigs(options)
	if _, ok := queues["voice"]; !ok || len(queues) != 9 {
		t.Fatalf("queues=%v", slices.Sorted(maps.Keys(queues)))
	}
	for name, queue := range queues {
		if queue.FetchPollInterval != 0 || queue.FetchCooldown != 0 {
			t.Fatalf("queue %s overrides the client poll: %+v", name, queue)
		}
	}
	if got := NewDueNotifier(nil, options, nil).queues; !slices.Equal(got, slices.Sorted(maps.Keys(queues))) {
		t.Fatalf("notifier queues=%v", got)
	}
	// pgxpool connects lazily, so validation needs no database.
	pool, err := pgxpool.New(t.Context(), "postgres://localhost/unused")
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := NewClient(pool, Options{Workers: river.NewWorkers(), Queues: options.Queues}); err != nil {
		t.Fatalf("River rejects the production intervals: %v", err)
	}
}
