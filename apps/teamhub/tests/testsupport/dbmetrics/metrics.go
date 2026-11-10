// Package dbmetrics reports timings from the integration database harness.
package dbmetrics

import (
	"fmt"
	"strings"
	"sync"
	"time"
)

// Metrics aggregates database timings. Its zero value is ready for concurrent use.
type Metrics struct {
	mu             sync.Mutex
	templatePhases map[string]time.Duration
	cloneCount     int
	cloneTotal     time.Duration
	cloneMaximum   time.Duration
	cleanupCount   int
	cleanupTotal   time.Duration
	cleanupMaximum time.Duration
}

func (metrics *Metrics) RecordTemplatePhase(name string, duration time.Duration) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	if metrics.templatePhases == nil {
		metrics.templatePhases = make(map[string]time.Duration)
	}
	metrics.templatePhases[name] += duration
}

func (metrics *Metrics) RecordClone(duration time.Duration) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.cloneCount++
	metrics.cloneTotal += duration
	if duration > metrics.cloneMaximum {
		metrics.cloneMaximum = duration
	}
}

func (metrics *Metrics) RecordCleanup(duration time.Duration) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	metrics.cleanupCount++
	metrics.cleanupTotal += duration
	if duration > metrics.cleanupMaximum {
		metrics.cleanupMaximum = duration
	}
}

// Report preserves the stable field order consumed by CI timing reports.
func (metrics *Metrics) Report() string {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	var report strings.Builder
	report.WriteString("teamhub-integration-db:")
	for _, phase := range [...]string{
		"total",
		"control",
		"bare_create",
		"migrate",
		"seed_identities",
		"password_hashes",
		"bare_seal",
		"skill_template_clone",
		"skill_install",
		"skill_seal",
	} {
		fmt.Fprintf(&report, " %s_ms=%d", phase, metrics.templatePhases[phase].Milliseconds())
	}
	fmt.Fprintf(
		&report,
		" clones=%d clone_total_ms=%d clone_max_ms=%d cleanups=%d cleanup_total_ms=%d cleanup_max_ms=%d",
		metrics.cloneCount,
		metrics.cloneTotal.Milliseconds(),
		metrics.cloneMaximum.Milliseconds(),
		metrics.cleanupCount,
		metrics.cleanupTotal.Milliseconds(),
		metrics.cleanupMaximum.Milliseconds(),
	)
	return report.String()
}
