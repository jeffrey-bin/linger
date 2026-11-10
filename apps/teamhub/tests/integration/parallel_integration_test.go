package integration_test

import (
	"flag"
	"runtime"
	"strconv"
	"testing"
)

// serialIntegrationReason documents why a top-level integration test must not
// run beside other tests in its shard. The layout test accepts only these values.
type serialIntegrationReason string

const (
	serialProcessEnv     serialIntegrationReason = "processEnv"
	serialProcessLogger  serialIntegrationReason = "processLogger"
	serialSuiteMeta      serialIntegrationReason = "suiteMeta"
	serialWallClockBound serialIntegrationReason = "wallClockBound"
	serialSubprocess     serialIntegrationReason = "subprocess"
)

// allowParallelIntegrationTest must be the first statement of every default
// top-level test. Only tests that own their database, HTTP servers, object
// roots and fakes may run beside other tests. Concurrency is bounded by go
// test's -parallel flag.
func allowParallelIntegrationTest(t *testing.T) {
	t.Helper()
	t.Parallel()
}

// integrationControlPoolSize sizes the control connection pool for the
// effective -parallel value, falling back to the same default go test uses.
func integrationControlPoolSize() int32 {
	parallelism := runtime.GOMAXPROCS(0)
	if parallelFlag := flag.Lookup("test.parallel"); parallelFlag != nil {
		if n, err := strconv.Atoi(parallelFlag.Value.String()); err == nil && n > 0 {
			parallelism = n
		}
	}
	return int32(parallelism + 2)
}

// serialIntegrationTest must be the first statement of a top-level test that
// mutates process-global state, touches the shared metrics registry or suite
// lifecycle, spawns subprocesses, or asserts a wall-clock upper bound that load
// can break. It only documents the reason.
func serialIntegrationTest(t *testing.T, reason serialIntegrationReason) {
	t.Helper()
}
