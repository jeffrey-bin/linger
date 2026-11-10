package jobs

import "github.com/riverqueue/river"

// DecisionRunArgs runs an approved decision, or hands off a decision that
// ended, after the decision commits. A run waits on other systems, and waking
// a delegated Task locks the Task, which the decision transaction must not do
// after it has locked the Room. Decisions end in more than one package (a
// Document access request ends its cards), so the job lives here; typedcard
// registers its worker.
type DecisionRunArgs struct {
	DecisionID string `json:"decision_id"`
}

// Kind names the job.
func (DecisionRunArgs) Kind() string { return "decision.run" }

// InsertOpts retries the job; the claim applies the executor's Rerun to a run
// that stopped midway. A Human who approves waits for the run, so it stays off
// the external queue, where imports and listener polls hold slots for minutes.
func (DecisionRunArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: QueueDefault, MaxAttempts: 5}
}
