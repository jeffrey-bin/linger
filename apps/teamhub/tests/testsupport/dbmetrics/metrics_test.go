package dbmetrics_test

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/tests/testsupport/dbmetrics"
)

func TestReportIsStableAndAggregated(t *testing.T) {
	var metrics dbmetrics.Metrics
	metrics.RecordTemplatePhase("migrate", 1500*time.Millisecond)
	metrics.RecordTemplatePhase("skill_install", 250*time.Millisecond)
	metrics.RecordClone(40 * time.Millisecond)
	metrics.RecordClone(60 * time.Millisecond)
	metrics.RecordCleanup(25 * time.Millisecond)

	want := "teamhub-integration-db:" +
		" total_ms=0 control_ms=0 bare_create_ms=0 migrate_ms=1500" +
		" seed_identities_ms=0 password_hashes_ms=0 bare_seal_ms=0" +
		" skill_template_clone_ms=0 skill_install_ms=250 skill_seal_ms=0" +
		" clones=2 clone_total_ms=100 clone_max_ms=60" +
		" cleanups=1 cleanup_total_ms=25 cleanup_max_ms=25"
	if got := metrics.Report(); got != want {
		t.Fatalf("metrics report = %q, want %q", got, want)
	}
}

func TestConcurrentRecordingAndReporting(t *testing.T) {
	var metrics dbmetrics.Metrics
	var workers sync.WaitGroup
	for index := range 32 {
		workers.Go(func() {
			duration := time.Duration(index+1) * time.Millisecond
			metrics.RecordTemplatePhase("migrate", duration)
			metrics.RecordClone(duration)
			metrics.RecordCleanup(duration)
			_ = metrics.Report()
		})
	}
	workers.Wait()

	report := metrics.Report()
	for _, want := range []string{
		" migrate_ms=528 ",
		" clones=32 clone_total_ms=528 clone_max_ms=32",
		" cleanups=32 cleanup_total_ms=528 cleanup_max_ms=32",
	} {
		if !strings.Contains(report, want) {
			t.Fatalf("metrics report = %q, want %q", report, want)
		}
	}
}
