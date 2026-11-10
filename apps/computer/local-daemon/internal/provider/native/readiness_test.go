package native

import (
	"testing"
)

// The readiness counters of a Run name the work it did to get a process: a
// reused one shows nothing, a changed input shows the spawn, the reopened
// session and the recycle with its reason.
func TestCodexReadinessCounters(t *testing.T) {
	fake := newCodexFake(t, nil, nil)
	rt := fake.runtime(nil)
	run := func(model, resume string) []any {
		spec := fake.spec()
		spec.Model, spec.ResumeID = model, resume
		spec.Readiness = &ReadinessCounters{}
		if out, _ := codexDrain(t, rt, "go", spec); out.Status != statusCompleted {
			t.Fatalf("run = %+v", out)
		}
		return spec.Readiness.LogAttrs()
	}
	want := func(got []any, spawns, starts, resumes, rebounds int, recycles string) {
		t.Helper()
		expect := []any{"spawns", spawns, "session_starts", starts, "session_resumes", resumes, "rebounds", rebounds, "recycles", recycles}
		for i := range expect {
			if got[i] != expect[i] {
				t.Fatalf("counters = %v, want %v", got, expect)
			}
		}
	}
	want(run("m", ""), 1, 1, 0, 0, "")
	want(run("m", "thread-1"), 0, 0, 0, 0, "")
	want(run("other", "thread-1"), 1, 0, 1, 0, "incompatible:model=1")
}
