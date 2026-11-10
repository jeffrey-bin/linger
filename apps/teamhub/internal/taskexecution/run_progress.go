package taskexecution

import (
	"encoding/json"
	"slices"
	"time"
)

// RunEvent is one event a Run reported about how its work goes: a status
// change, a plan update, or an output Message.
type RunEvent struct {
	RunID, Type string
	Payload     []byte
	At          time.Time
	// OutputBody is the body of the Message an output event created.
	OutputBody string
}

// RunStep is one step title a Run reported and when it first did.
type RunStep struct {
	Title string
	At    time.Time
}

// RunActivity is what a Run's events say about its work so far.
type RunActivity struct {
	// Steps are the latest distinct step titles, oldest first.
	Steps []RunStep
	// Status is the latest reported status (working, thinking), held since
	// StatusSince.
	Status      string
	StatusSince time.Time
	// PlanDone of PlanTotal steps of the latest plan are completed; both are
	// zero without a plan.
	PlanDone, PlanTotal int
	// LatestOutput is the body of the latest output Message.
	LatestOutput string
}

// RecentRunSteps is how many of a Run's latest step titles are kept, so a
// reader can tell what the work just did in some detail.
const RecentRunSteps = 8

// ReadRunActivity summarizes one Run from its events, oldest first; events
// of other Runs are ignored.
func ReadRunActivity(runID string, events []RunEvent) RunActivity {
	var activity RunActivity
	for _, event := range events {
		if event.RunID != runID {
			continue
		}
		switch event.Type {
		case "status.changed":
			var payload struct{ Status, Title string }
			if json.Unmarshal(event.Payload, &payload) != nil {
				continue
			}
			activity.Status, activity.StatusSince = payload.Status, event.At
			if payload.Title != "" && !slices.ContainsFunc(activity.Steps, func(step RunStep) bool { return step.Title == payload.Title }) {
				activity.Steps = append(activity.Steps, RunStep{Title: payload.Title, At: event.At})
			}
		case "plan.updated":
			var payload struct{ Steps []struct{ Status string } }
			if json.Unmarshal(event.Payload, &payload) != nil || len(payload.Steps) == 0 {
				continue
			}
			activity.PlanDone, activity.PlanTotal = 0, len(payload.Steps)
			for _, step := range payload.Steps {
				if step.Status == "completed" {
					activity.PlanDone++
				}
			}
		case "presentation.output_created":
			if event.OutputBody != "" {
				activity.LatestOutput = event.OutputBody
			}
		}
	}
	if len(activity.Steps) > RecentRunSteps {
		activity.Steps = activity.Steps[len(activity.Steps)-RecentRunSteps:]
	}
	return activity
}
