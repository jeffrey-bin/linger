package voicelive

import (
	"strings"
	"testing"
)

func TestTaskIDRoundTrip(t *testing.T) {
	if got := TaskID(12); got != "t12" {
		t.Fatalf("TaskID=%q", got)
	}
	for _, bad := range []string{"", "t0", "12", "task1", "t1x"} {
		if _, ok := TaskOrdinal(bad); ok {
			t.Fatalf("%q parsed as a task", bad)
		}
	}
	if ordinal, ok := TaskOrdinal(" t3 "); !ok || ordinal != 3 {
		t.Fatalf("t3 => %d %v", ordinal, ok)
	}
}

func TestTaskViewFollowsTheDelegatedTask(t *testing.T) {
	report := &TaskReport{ID: "r1", Body: "JD needs a new login: scan with the JD app."}
	for _, check := range []struct {
		record TaskRecord
		state  string
	}{
		{TaskRecord{Execution: ""}, TaskPending},
		{TaskRecord{Execution: "running", Steps: []string{"Open JD"}}, TaskWorking},
		// A report is a result or what the task needs: the live voice reads it.
		{TaskRecord{Execution: "idle", Report: report}, TaskReported},
		{TaskRecord{Execution: "waiting_for_approval"}, TaskWaitingForApproval},
		// An answer makes it run again.
		{TaskRecord{Execution: "running", Report: report}, TaskWorking},
		{TaskRecord{Execution: "failed", Report: report}, TaskFailed},
		{TaskRecord{Execution: "idle", Report: report, Canceled: true}, TaskCanceled},
	} {
		if view := View(check.record); view.State != check.state {
			t.Fatalf("%+v: got %s, want %s", check.record, view.State, check.state)
		}
	}
}

func TestTaskRequirementIsTheGoalAndWhere(t *testing.T) {
	brief := TaskRequirement("Compare noise-canceling headphones under 2000 on JD", SurfaceWeb)
	for _, want := range []string{"Compare noise-canceling headphones under 2000 on JD", "It needs websites.", "Choose your own tools.", "the user's language"} {
		if !strings.Contains(brief, want) {
			t.Fatalf("brief misses %q:\n%s", want, brief)
		}
	}
}

func TestTaskListGivesTheLatestReport(t *testing.T) {
	output := TaskListOutput([]TaskView{
		View(TaskRecord{Ordinal: 1, Goal: "Compare prices", Execution: "idle", Report: &TaskReport{ID: "r", Body: "Scan the QR code to log in to JD"}}),
		View(TaskRecord{Ordinal: 2, Goal: "Write an email", Canceled: true}),
	})
	tasks := output["tasks"].([]map[string]any)
	if tasks[0]["state"] != TaskReported || tasks[0]["latest_report"] != "Scan the QR code to log in to JD" || tasks[1]["state"] != TaskCanceled {
		t.Fatalf("tasks: %v", tasks)
	}
}
