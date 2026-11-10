package voicemedia

import (
	"context"
	"errors"
	"log/slog"
	"maps"
	"math"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/rivertype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// registeredKinds reads the job kinds registered in workers. River keeps its
// worker map unexported, so the test reads the field directly.
func registeredKinds(workers *river.Workers) []string {
	kinds := reflect.ValueOf(workers).Elem().FieldByName("workersMap").MapKeys()
	names := make([]string, 0, len(kinds))
	for _, kind := range kinds {
		names = append(names, kind.String())
	}
	slices.Sort(names)
	return names
}

func TestAddWorkersRegistersOnlyConfiguredCapabilities(t *testing.T) {
	complete := func(context.Context, string) (time.Duration, error) { return JobDone, nil }
	full := &Service{provider: &publisherGrantProvider{}, materializer: &HLSMaterializer{}, documents: &document.Service{}}
	full.SetArchiveTranscriber(recoveryASR{}, strings.TrimSpace)
	for _, tc := range []struct {
		name     string
		service  *Service
		complete func(context.Context, string) (time.Duration, error)
		want     []string
		queues   []string
	}{
		{name: "nothing configured", service: &Service{}},
		{
			name: "LiveKit only", service: &Service{provider: &publisherGrantProvider{}},
			want:   []string{"voice_capture_reconcile", "voice_capture_stop", "voice_session_reconcile"},
			queues: []string{QueueVoice},
		},
		{
			name: "full", service: full, complete: complete,
			want: []string{
				"voice_capture_completion", "voice_capture_materialize", "voice_capture_reconcile", "voice_capture_stop",
				"voice_session_reconcile", "voice_staging_cleanup", "voice_transcript_recovery",
			},
			queues: []string{QueueVoice, QueueVoiceMedia, QueueVoiceRecovery},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			workers := river.NewWorkers()
			queues := map[string]river.QueueConfig{}
			tc.service.AddWorkers(workers, queues, slog.Default(), tc.complete)
			if got := registeredKinds(workers); !slices.Equal(got, tc.want) {
				t.Fatalf("kinds:\n got %v\nwant %v", got, tc.want)
			}
			if got := slices.Sorted(maps.Keys(queues)); !slices.Equal(got, slices.Sorted(slices.Values(tc.queues))) {
				t.Fatalf("queues:\n got %v\nwant %v", got, tc.queues)
			}
		})
	}
}

func TestDueWait(t *testing.T) {
	for _, tc := range []struct {
		seconds float64
		want    time.Duration
	}{
		{math.Inf(1), JobDone},
		{math.NaN(), JobDone},
		{-3, jobRecheckWait},
		{0.1, jobRecheckWait},
		{2, 2 * time.Second},
		{90, 90 * time.Second},
	} {
		if got := dueWait(tc.seconds); got != tc.want {
			t.Fatalf("dueWait(%v) = %v, want %v", tc.seconds, got, tc.want)
		}
	}
}

// A step's result maps onto River: done completes the job, a wait snoozes it
// without spending an attempt, and a failure is retried on the step's own
// schedule but never sooner than the error wait. A done step whose job a wake
// touched while it ran, or whose completion failed, runs again.
func TestStepWorkerResults(t *testing.T) {
	failure := errors.New("provider unavailable")
	for _, tc := range []struct {
		name      string
		next      time.Duration
		err       error
		woken     bool
		finishErr error
		snooze    time.Duration
	}{
		{name: "done", next: JobDone},
		{name: "wait", next: 30 * time.Second, snooze: 30 * time.Second},
		{name: "failure that settled", next: JobDone, err: failure},
		{name: "failure retried later", next: 10 * time.Second, err: failure, snooze: 10 * time.Second},
		{name: "failure retried at once", next: 0, err: context.Canceled, snooze: jobErrorWait},
		{name: "done but woken during the step", next: JobDone, woken: true, snooze: jobRecheckWait},
		{name: "done but completion failed", next: JobDone, finishErr: failure, snooze: jobErrorWait},
	} {
		t.Run(tc.name, func(t *testing.T) {
			worker := &stepWorker[CaptureStopArgs]{
				logger:  slog.New(slog.DiscardHandler),
				version: func(context.Context, int64) (string, error) { return "1", nil },
				finish: func(_ context.Context, _ *river.Job[CaptureStopArgs], version string) (bool, error) {
					if version != "1" {
						t.Fatalf("finish version = %q, want the version read at start", version)
					}
					return !tc.woken && tc.finishErr == nil, tc.finishErr
				},
				step: func(context.Context, CaptureStopArgs) (time.Duration, error) {
					return tc.next, tc.err
				},
			}
			err := worker.Work(t.Context(), &river.Job[CaptureStopArgs]{JobRow: &rivertype.JobRow{Kind: "voice_capture_stop"}})
			var snooze *rivertype.JobSnoozeError
			switch {
			case tc.snooze == 0 && err != nil:
				t.Fatalf("Work = %v, want completion", err)
			case tc.snooze != 0 && (!errors.As(err, &snooze) || snooze.Duration != tc.snooze):
				t.Fatalf("Work = %v, want snooze %v", err, tc.snooze)
			}
		})
	}
}

// Every kind ListUnfinishedVoiceWork reports maps onto its job, and an unknown
// kind is an error rather than some other job.
func TestUnfinishedVoiceJob(t *testing.T) {
	for kind, want := range map[string]river.JobArgs{
		"session":             VoiceSessionReconcileArgs{VoiceSessionID: "key"},
		"capture":             CaptureReconcileArgs{CaptureSessionID: "key"},
		"stop":                CaptureStopArgs{CaptureSessionID: "key"},
		"materialize":         CaptureMaterializeArgs{CaptureSessionID: "key"},
		"transcript_recovery": TranscriptRecoveryArgs{CaptureSessionID: "key"},
		"completion":          CaptureCompletionArgs{CaptureSessionID: "key"},
		"staging_cleanup":     StagingCleanupArgs{CaptureSessionID: "key"},
	} {
		got, err := unfinishedVoiceJob(store.ListUnfinishedVoiceWorkRow{Kind: kind, ID: "key"})
		if err != nil || got != want {
			t.Fatalf("unfinishedVoiceJob(%s) = %v, %v; want %v", kind, got, err, want)
		}
	}
	if _, err := unfinishedVoiceJob(store.ListUnfinishedVoiceWorkRow{Kind: "unknown", ID: "key"}); err == nil {
		t.Fatal("unfinishedVoiceJob accepted an unknown kind")
	}
}
