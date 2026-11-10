package taskexecution

import (
	"testing"
	"time"
)

func TestReadRunActivitySummarizesOneRun(t *testing.T) {
	start := time.Date(2026, 11, 4, 8, 0, 0, 0, time.UTC)
	at := func(seconds int) time.Time { return start.Add(time.Duration(seconds) * time.Second) }
	status := func(seconds int, status, title string) RunEvent {
		return RunEvent{RunID: "run", Type: "status.changed", At: at(seconds), Payload: []byte(`{"status":"` + status + `","title":"` + title + `"}`)}
	}
	events := []RunEvent{
		status(1, "thinking", "Read the brief"),
		{RunID: "other", Type: "status.changed", At: at(2), Payload: []byte(`{"status":"working","title":"Elsewhere"}`)},
		status(3, "working", "Search pricing"),
		{RunID: "run", Type: "status.changed", At: at(4), Payload: []byte(`not json`)},
		status(5, "thinking", "Read the brief"),
		{RunID: "run", Type: "plan.updated", At: at(6), Payload: []byte(`{"steps":[{"status":"completed"},{"status":"in_progress"},{"status":"pending"}]}`)},
		{RunID: "run", Type: "plan.updated", At: at(7), Payload: []byte(`{"steps":[]}`)},
		{RunID: "run", Type: "presentation.output_created", At: at(8), OutputBody: "Draft is ready"},
		{RunID: "run", Type: "presentation.output_created", At: at(9)},
		status(10, "working", "Write summary"),
	}
	activity := ReadRunActivity("run", events)
	want := []RunStep{{"Read the brief", at(1)}, {"Search pricing", at(3)}, {"Write summary", at(10)}}
	if len(activity.Steps) != len(want) {
		t.Fatalf("steps = %v", activity.Steps)
	}
	for index, step := range want {
		if !activity.Steps[index].At.Equal(step.At) || activity.Steps[index].Title != step.Title {
			t.Fatalf("steps = %v", activity.Steps)
		}
	}
	if activity.Status != "working" || !activity.StatusSince.Equal(at(10)) ||
		activity.PlanDone != 1 || activity.PlanTotal != 3 || activity.LatestOutput != "Draft is ready" {
		t.Fatalf("activity = %+v", activity)
	}
}

func TestReadRunActivityKeepsTheLatestSteps(t *testing.T) {
	var events []RunEvent
	for index := range RecentRunSteps + 2 {
		events = append(events, RunEvent{RunID: "run", Type: "status.changed", Payload: []byte(`{"status":"working","title":"step ` + string(rune('a'+index)) + `"}`)})
	}
	steps := ReadRunActivity("run", events).Steps
	if len(steps) != RecentRunSteps || steps[0].Title != "step c" || steps[RecentRunSteps-1].Title != "step j" {
		t.Fatalf("steps = %v", steps)
	}
}
