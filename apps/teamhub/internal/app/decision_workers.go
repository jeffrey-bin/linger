package app

import (
	"context"
	"encoding/json"
	"time"

	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// decisionRunWorker runs an approved decision through its kind's executor
// and tells the requesting Agent how it ended; for a denial it only tells the
// Agent.
type decisionRunWorker struct {
	river.WorkerDefaults[jobs.DecisionRunArgs]
	app *App
}

// Timeout covers at most five Composio requests of 20 seconds each: status,
// tool, two draft reads and the call. A run cut short finds the decision
// executing when retried, and its executor's Rerun decides what happens.
func (*decisionRunWorker) Timeout(*river.Job[jobs.DecisionRunArgs]) time.Duration {
	return 3 * time.Minute
}

func (w *decisionRunWorker) Work(ctx context.Context, job *river.Job[jobs.DecisionRunArgs]) error {
	notice, err := w.app.typedCards.RunDecision(ctx, job.Args.DecisionID)
	if err != nil {
		return err
	}
	return w.app.deliverDecisionNotice(ctx, notice)
}

// decisionExpireWorker expires a decision nobody made in time; expiring it
// tells the Agent nothing ran.
type decisionExpireWorker struct {
	river.WorkerDefaults[typedcard.DecisionExpireArgs]
	app *App
}

func (w *decisionExpireWorker) Work(ctx context.Context, job *river.Job[typedcard.DecisionExpireArgs]) error {
	_, wait, err := w.app.typedCards.ExpireDecision(ctx, job.Args.DecisionID)
	if err != nil {
		return err
	}
	if wait > 0 {
		return river.JobSnooze(wait)
	}
	return nil
}

// deliverDecisionNotice wakes the delegated Task whose AlterEgo asked for a
// decision; a Room Agent was already told in the card's Room. A retried job
// may repeat the notice, never the run.
func (a *App) deliverDecisionNotice(ctx context.Context, notice typedcard.DecisionNotice) error {
	if notice.AlterEgoTaskID == "" || notice.Text == "" {
		return nil
	}
	return a.wakeTaskWithSystemInput(ctx, notice.AgentManagementID, notice.AlterEgoTaskID, notice.Text)
}

// registerDecisionExecutors installs what each decision kind runs once
// approved, and how a run that stopped midway ends.
func (a *App) registerDecisionExecutors() {
	// A connector write may have reached the provider, so it never runs twice.
	a.typedCards.RegisterDecisionExecutor(typedcard.DecisionKindConnectorWrite, typedcard.DecisionExecutor{
		Run: func(ctx context.Context, decision typedcard.ClaimedDecision) (typedcard.DecisionResult, error) {
			var request typedcard.ConnectorWriteRequest
			if err := json.Unmarshal(decision.Request, &request); err != nil {
				return typedcard.DecisionResult{}, err
			}
			status, outcome, data := a.agentConnectedApps.ExecuteConfirmed(ctx, decision.ID, decision.TenantID,
				decision.RequestedByActorID, request.ConnectionID, request.Action)
			return typedcard.DecisionResult{Status: status, Outcome: outcome, Data: data}, nil
		},
	})
	// Every Agent change is idempotent per decision, so a retry runs it again.
	a.typedCards.RegisterDecisionExecutor(typedcard.DecisionKindAgentChange, typedcard.DecisionExecutor{
		Rerun: true, Run: a.agents.RunAgentChangeDecision,
	})
}
