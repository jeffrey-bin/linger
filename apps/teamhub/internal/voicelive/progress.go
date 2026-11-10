package voicelive

import (
	"fmt"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
)

// ProgressScopes are what list_tasks can report on: the tasks this voice
// session started, or every Agent Run still working in the Room.
const (
	ProgressScopeMyRequests = "my_requests"
	ProgressScopeRoom       = "room"
)

// ProgressArguments selects the task or Room progress to report.
type ProgressArguments struct {
	Scope  string `json:"scope"`
	RoomID string `json:"room_id"`
}

// RecentRunWindow is how far back a Room report looks for finished Runs.
const RecentRunWindow = 24 * time.Hour

// RoomProgress reports every Agent still working in a Room and the latest
// two Runs that finished, newest first.
func RoomProgress(now time.Time, runs []ProgressRun, events []taskexecution.RunEvent) map[string]any {
	working, finished := []map[string]any{}, []map[string]any{}
	for index := len(runs) - 1; index >= 0; index-- {
		run := runs[index]
		if run.FinishedAt == nil {
			working = append(working, RunProgress(now, run, events))
		} else if len(finished) < 2 {
			report := RunProgress(now, run, events)
			report["finished_ago"] = SpokenDuration(now.Sub(*run.FinishedAt))
			finished = append(finished, report)
		}
	}
	return map[string]any{"working_agents": working, "recent_finished": finished}
}

// ProgressTask is one background Task the Room's Meta delegated that is still
// running or waiting for an approval.
type ProgressTask struct {
	Title, Status string
	CreatedAt     time.Time
}

// TaskProgress reports the Room's background Tasks, oldest first.
func TaskProgress(now time.Time, tasks []ProgressTask) []map[string]any {
	reports := make([]map[string]any, 0, len(tasks))
	for _, task := range tasks {
		reports = append(reports, map[string]any{
			"title": truncateRunes(Snippet(task.Title), 80), "state": task.Status,
			"running_for": SpokenDuration(now.Sub(task.CreatedAt)),
		})
	}
	return reports
}

// ProgressRun is the bounded Run state used in a spoken progress report.
type ProgressRun struct {
	ID, Status, Agent string
	CreatedAt         time.Time
	FinishedAt        *time.Time
}

// RunProgress describes one Run from its state and the events it reported.
func RunProgress(now time.Time, run ProgressRun, events []taskexecution.RunEvent) map[string]any {
	report := map[string]any{"agent": run.Agent, "state": run.Status}
	if run.FinishedAt != nil {
		report["took"] = SpokenDuration(run.FinishedAt.Sub(run.CreatedAt))
	} else {
		report["running_for"] = SpokenDuration(now.Sub(run.CreatedAt))
	}
	activity := taskexecution.ReadRunActivity(run.ID, events)
	if activity.PlanTotal > 0 {
		report["plan"] = fmt.Sprintf("%d of %d steps done", activity.PlanDone, activity.PlanTotal)
	}
	if activity.LatestOutput != "" {
		report["latest_reply"] = Snippet(activity.LatestOutput)
	}
	if run.FinishedAt == nil && activity.Status != "" {
		report["now"] = activity.Status
		report["now_for"] = SpokenDuration(now.Sub(activity.StatusSince))
	}
	if len(activity.Steps) > 0 {
		titles := make([]string, 0, len(activity.Steps))
		for _, step := range activity.Steps {
			titles = append(titles, step.Title)
		}
		report["recent_steps"] = titles
	}
	return report
}

// SpokenDuration is a short duration the live model can read aloud.
func SpokenDuration(duration time.Duration) string {
	seconds := int(duration.Round(time.Second) / time.Second)
	if seconds < 0 {
		seconds = 0
	}
	if seconds < 60 {
		return fmt.Sprintf("%ds", seconds)
	}
	if seconds < 3600 {
		return fmt.Sprintf("%dm%ds", seconds/60, seconds%60)
	}
	return fmt.Sprintf("%dh%dm", seconds/3600, seconds%3600/60)
}
