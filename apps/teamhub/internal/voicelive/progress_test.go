package voicelive

import (
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
)

func TestRunProgressKeepsTheLatestEightDistinctSteps(t *testing.T) {
	start := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	var events []taskexecution.RunEvent
	for index, title := range []string{"Read messages", "Check inbox", "Check inbox", "Write body", "Add images", "Lay out", "Check links", "Save draft", "Verify recipients", "Send it to me"} {
		events = append(events, taskexecution.RunEvent{
			RunID: "run", Type: "status.changed", At: start.Add(time.Duration(index) * time.Second),
			Payload: []byte(`{"status":"thinking","title":"` + title + `"}`),
		})
	}
	report := RunProgress(start.Add(time.Minute), ProgressRun{ID: "run", Status: "running", CreatedAt: start}, events)
	steps, _ := report["recent_steps"].([]string)
	if len(steps) != 8 || steps[0] != "Check inbox" || steps[7] != "Send it to me" || report["running_for"] != "1m0s" {
		t.Fatalf("steps=%v", steps)
	}
}

func TestRoomProgressListsWorkingAgentsAndTheLatestTwoFinished(t *testing.T) {
	start := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	finishedAt := func(minutes int) *time.Time { value := start.Add(time.Duration(minutes) * time.Minute); return &value }
	runs := []ProgressRun{ // oldest first
		{ID: "old", Status: "succeeded", Agent: "A", CreatedAt: start, FinishedAt: finishedAt(1)},
		{ID: "mid", Status: "failed", Agent: "B", CreatedAt: start.Add(2 * time.Minute), FinishedAt: finishedAt(3)},
		{ID: "new", Status: "succeeded", Agent: "C", CreatedAt: start.Add(4 * time.Minute), FinishedAt: finishedAt(5)},
		{ID: "live", Status: "running", Agent: "D", CreatedAt: start.Add(6 * time.Minute)},
	}
	events := []taskexecution.RunEvent{{RunID: "new", Type: "presentation.output_created", OutputBody: "The travel plan is set"}}
	report := RoomProgress(start.Add(10*time.Minute), runs, events)
	working, _ := report["working_agents"].([]map[string]any)
	finished, _ := report["recent_finished"].([]map[string]any)
	if len(working) != 1 || working[0]["agent"] != "D" || working[0]["running_for"] != "4m0s" {
		t.Fatalf("working=%v", working)
	}
	if len(finished) != 2 || finished[0]["agent"] != "C" || finished[0]["finished_ago"] != "5m0s" ||
		finished[0]["latest_reply"] != "The travel plan is set" || finished[1]["state"] != "failed" {
		t.Fatalf("finished=%v", finished)
	}
}

func TestTaskProgressReportsEachBackgroundTaskWithItsStateAndAge(t *testing.T) {
	start := time.Date(2026, 10, 18, 9, 0, 0, 0, time.UTC)
	report := TaskProgress(start.Add(10*time.Minute), []ProgressTask{
		{Title: "Compile the weekly report", Status: "running", CreatedAt: start},
		{Title: "Email the client", Status: "waiting_for_approval", CreatedAt: start.Add(8 * time.Minute)},
	})
	if len(report) != 2 || report[0]["title"] != "Compile the weekly report" || report[0]["running_for"] != "10m0s" ||
		report[1]["state"] != "waiting_for_approval" || report[1]["running_for"] != "2m0s" {
		t.Fatalf("report=%v", report)
	}
}

func TestSpokenDuration(t *testing.T) {
	for duration, want := range map[time.Duration]string{
		-time.Second: "0s", 42 * time.Second: "42s", 312 * time.Second: "5m12s", 2*time.Hour + 5*time.Minute: "2h5m",
	} {
		if got := SpokenDuration(duration); got != want {
			t.Fatalf("%s -> %s, want %s", duration, got, want)
		}
	}
}
