package integration_test

import (
	"fmt"
	"io"
	"os"
	"sync"
)

// integrationAppLogs keeps the most recent app warn/error records so a failing
// run can show server-side causes; passing runs print nothing.
var integrationAppLogs = &appLogRing{limit: 2000}

type appLogRing struct {
	mu      sync.Mutex
	limit   int
	records []string
	total   int
}

// Write receives one slog record per call and keeps the newest limit records.
func (r *appLogRing) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.total++
	r.records = append(r.records, string(p))
	if len(r.records) > r.limit {
		r.records = r.records[len(r.records)-r.limit:]
	}
	return len(p), nil
}

func (r *appLogRing) dump(w io.Writer) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.total == 0 {
		return
	}
	_, _ = fmt.Fprintf(w, "teamhub integration app warn/error logs (last %d of %d records):\n", len(r.records), r.total)
	for _, record := range r.records {
		_, _ = fmt.Fprint(w, record)
	}
}

func dumpIntegrationAppLogsOnFailure(status int) {
	if status != 0 {
		integrationAppLogs.dump(os.Stderr)
	}
}
