package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// A write that needs confirmation is stored exactly instead of run when the
// Agent executes it, runs once after approval even when decided twice at once,
// ends unknown when its run stopped midway, and the Agent is told how it ended
// in every case.
func TestConnectorConfirmationRunsStoredCallOnceAfterApproval(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Connector confirmation", "connector-confirmation")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	issued, err := agentcredential.New(env.pool).IssueManaged(t.Context(), acmeOfficialAgentManagementID, "Connector confirmation")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `
 INSERT INTO external_connections(id,account_id,provider,upstream_connection_id,status,identity_label,toolkit_slug) VALUES('connection_confirm_gmail','account_alice','gmail','upstream_confirm_gmail','active','alice@example.test','gmail');
 INSERT INTO external_connection_agent_grants(id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status) VALUES('grant_confirm_gmail','connection_confirm_gmail','tenant_acme','actor_acme_official','actor_acme_alice','active')`); err != nil {
		t.Fatal(err)
	}
	provider := &confirmationToolProvider{draftBody: "Draft body"}
	service := agentconnectedapps.New(env.pool, agentauth.New(env.pool), newFakeComposio(t).externalSources(t, env.pool, nil), provider)
	cards := typedcard.New(env.pool)
	cards.RegisterDecisionExecutor(typedcard.DecisionKindConnectorWrite, typedcard.DecisionExecutor{
		Run: func(ctx context.Context, decision typedcard.ClaimedDecision) (typedcard.DecisionResult, error) {
			var request typedcard.ConnectorWriteRequest
			if err := json.Unmarshal(decision.Request, &request); err != nil {
				return typedcard.DecisionResult{}, err
			}
			status, outcome, data := service.ExecuteConfirmed(ctx, decision.ID, decision.TenantID, decision.RequestedByActorID, request.ConnectionID, request.Action)
			return typedcard.DecisionResult{Status: status, Outcome: outcome, Data: data}, nil
		},
	})
	ctx := agentauth.WithTarget(t.Context(), "room", roomID)
	send := agentconnectedapps.ExecuteInput{
		ConnectionID: "connection_confirm_gmail", ToolSlug: "GMAIL_SEND_EMAIL", ToolVersion: "20261015_00",
		Arguments: map[string]any{"recipient_email": "bob@example.test", "subject": "Plan", "body": "<p>Hello</p>", "is_html": true},
	}
	submit := func(input agentconnectedapps.ExecuteInput, key string) typedcard.CreateResult {
		t.Helper()
		held, err := service.Execute(ctx, issued.AccessToken, input)
		if err != nil || held.Confirmation == nil {
			t.Fatalf("execute %s: result=%+v err=%v", input.ToolSlug, held, err)
		}
		prepared := *held.Confirmation
		hash := sha256.Sum256([]byte(roomID + prepared.Digest))
		result, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, key, hash[:], typedcard.DecisionCommand{
			DeciderActorID: "actor_acme_alice",
			ConnectorWrite: &typedcard.ConnectorWriteDecision{
				Request: typedcard.ConnectorWriteRequest{ConnectionID: prepared.Connection.ID, ActionDigest: prepared.Digest, Action: prepared.Action},
				View:    prepared.Card,
			},
		})
		if err != nil {
			t.Fatalf("create %s: %v", input.ToolSlug, err)
		}
		return result
	}
	cardVersion := func(result typedcard.CreateResult) int64 {
		t.Helper()
		var version int64
		if err := env.pool.QueryRow(t.Context(), `SELECT version FROM message_cards WHERE message_id=$1`, result.MessageID).Scan(&version); err != nil {
			t.Fatal(err)
		}
		return version
	}
	decideWith := func(result typedcard.CreateResult, decision, comment string) error {
		_, err := cards.DecideDecision(t.Context(), "account_alice", result.DecisionID,
			typedcard.DecisionAnswerCommand{ExpectedVersion: cardVersion(result), Decision: decision, Comment: comment})
		return err
	}
	decide := func(result typedcard.CreateResult, decision, comment string) {
		t.Helper()
		if err := decideWith(result, decision, comment); err != nil {
			t.Fatalf("decide %s: %v", decision, err)
		}
	}
	// run runs what the decision.run job runs.
	run := func(id string) typedcard.DecisionNotice {
		t.Helper()
		notice, err := cards.RunDecision(t.Context(), id)
		if err != nil {
			t.Fatal(err)
		}
		return notice
	}
	status := func(id string) string {
		var value string
		if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, id).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	notices := func() []string {
		rows, err := env.pool.Query(t.Context(), `SELECT body FROM messages WHERE room_id=$1 AND message_kind='agent_runtime' ORDER BY created_at`, roomID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var bodies []string
		for rows.Next() {
			var body string
			if err := rows.Scan(&body); err != nil {
				t.Fatal(err)
			}
			bodies = append(bodies, body)
		}
		return bodies
	}

	first := submit(send, "operation-1")
	if provider.sends != 0 {
		t.Fatalf("submitting ran the call %d times", provider.sends)
	}
	// An identical call reuses the pending card; a retried operation replays it.
	if again := submit(send, "operation-2"); again.DecisionID != first.DecisionID {
		t.Fatalf("identical call opened a second card: %s vs %s", again.DecisionID, first.DecisionID)
	}
	if replay := submit(send, "operation-1"); replay.MessageID != first.MessageID || replay.DecisionID != first.DecisionID {
		t.Fatalf("replayed operation opened a second card")
	}
	var title, format string
	if err := env.pool.QueryRow(t.Context(), `SELECT view->>'title', view->'message'->>'format' FROM decisions WHERE id=$1`, first.DecisionID).Scan(&title, &format); err != nil {
		t.Fatal(err)
	}
	if title != "Send an email to bob@example.test" || format != "html" {
		t.Fatalf("card title=%q format=%q", title, format)
	}

	// Two concurrent decisions on one card version: one is recorded, the
	// other conflicts, and the call runs once.
	errs := make(chan error, 2)
	for range 2 {
		go func() { errs <- decideWith(first, "approve", "") }()
	}
	var conflicts int
	for range 2 {
		if err := <-errs; errors.Is(err, typedcard.ErrConflict) {
			conflicts++
		} else if err != nil {
			t.Fatal(err)
		}
	}
	if conflicts != 1 {
		t.Fatalf("concurrent decisions: %d conflicts, want 1", conflicts)
	}
	if bodies := notices(); len(bodies) != 0 {
		t.Fatalf("approval told the Agent before the call ran: %v", bodies)
	}
	if notice := run(first.DecisionID); provider.sends != 1 || !strings.Contains(notice.Text, "TeamHub ran it") || status(first.DecisionID) != "succeeded" {
		t.Fatalf("approved call sends=%d status=%s notice=%q", provider.sends, status(first.DecisionID), notice.Text)
	}
	if bodies := notices(); len(bodies) != 1 || !strings.Contains(bodies[0], "TeamHub ran it") {
		t.Fatalf("Agent notices %v", bodies)
	}
	// A retried run job repeats at most the notice, never the call.
	if run(first.DecisionID); provider.sends != 1 || status(first.DecisionID) != "succeeded" {
		t.Fatalf("retried run sends=%d status=%s", provider.sends, status(first.DecisionID))
	}

	// A denial carries the reason to the Agent and never runs the call.
	send.Arguments["subject"] = "Second plan"
	denied := submit(send, "operation-3")
	decide(denied, "deny", "Wrong recipient")
	run(denied.DecisionID)
	if bodies := notices(); provider.sends != 1 || !strings.Contains(bodies[len(bodies)-1], "Reason: Wrong recipient") {
		t.Fatalf("denied call sends=%d notices=%v", provider.sends, bodies)
	}

	// An undecided card expires without running and can no longer be approved.
	send.Arguments["subject"] = "Third plan"
	stale := submit(send, "operation-4")
	if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, stale.DecisionID); err != nil {
		t.Fatal(err)
	}
	if err := decideWith(stale, "approve", ""); !errors.Is(err, typedcard.ErrConflict) {
		t.Fatalf("approving an expired card: %v", err)
	}
	if expired, _, err := cards.ExpireDecision(t.Context(), stale.DecisionID); err != nil || !expired {
		t.Fatalf("expire=%t err=%v", expired, err)
	}
	bodies := notices()
	if !strings.Contains(bodies[len(bodies)-1], "before the card expired") {
		t.Fatalf("expiry notices=%v", bodies)
	}
	// A retried expiry job finds the card already handed off and tells nobody again.
	if expired, _, err := cards.ExpireDecision(t.Context(), stale.DecisionID); err != nil || expired {
		t.Fatalf("retried expire=%t err=%v", expired, err)
	}
	if again := notices(); len(again) != len(bodies) {
		t.Fatalf("a retried expiry notified again: %v", again)
	}

	// A run that stopped midway ends unknown and is not run again: a connector
	// write may already have reached the provider.
	send.Arguments["subject"] = "Fourth plan"
	crashed := submit(send, "operation-5")
	decide(crashed, "approve", "")
	if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET status='executing' WHERE id=$1`, crashed.DecisionID); err != nil {
		t.Fatal(err)
	}
	if run(crashed.DecisionID); status(crashed.DecisionID) != "unknown" || provider.sends != 1 {
		t.Fatalf("interrupted run status=%s sends=%d", status(crashed.DecisionID), provider.sends)
	}

	// A draft send shows the draft TeamHub read and refuses a changed draft.
	draft := submit(agentconnectedapps.ExecuteInput{
		ConnectionID: "connection_confirm_gmail", ToolSlug: "GMAIL_SEND_DRAFT", ToolVersion: "20261015_00",
		Arguments: map[string]any{"draft_id": "draft-1"},
	}, "operation-6")
	var body string
	if err := env.pool.QueryRow(t.Context(), `SELECT view->'message'->>'body' FROM decisions WHERE id=$1`, draft.DecisionID).Scan(&body); err != nil {
		t.Fatal(err)
	}
	if body != "Draft body" {
		t.Fatalf("draft card body %q", body)
	}
	decide(draft, "approve", "")
	provider.draftBody = "Edited after the card"
	run(draft.DecisionID)
	if bodies := notices(); provider.sends != 1 || status(draft.DecisionID) != "failed" || !strings.Contains(bodies[len(bodies)-1], "draft changed") {
		t.Fatalf("changed draft sends=%d status=%s notices=%v", provider.sends, status(draft.DecisionID), bodies)
	}
}

// An idempotent kind declares Rerun: a run that stopped midway runs again on
// retry instead of ending unknown, and the result is recorded once.
func TestDecisionRerunsAnIdempotentKindAfterAnInterruptedRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newTaskWorkerEnv(t)
	roomID := createPrivateRoom(t, env, alice, "Agent change rerun", "agent-change-rerun")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent: %d %s", code, body)
	}
	cards := typedcard.New(env.pool)
	runs := 0
	cards.RegisterDecisionExecutor(typedcard.DecisionKindAgentChange, typedcard.DecisionExecutor{
		Rerun: true,
		Run: func(context.Context, typedcard.ClaimedDecision) (typedcard.DecisionResult, error) {
			runs++
			return typedcard.DecisionResult{Status: "succeeded", Data: map[string]string{"actor_id": "actor_acme_official"}}, nil
		},
	})
	hash := sha256.Sum256([]byte("rename"))
	created, err := cards.CreateDecision(t.Context(), roomID, acmeOfficialAgentManagementID, "rename", hash[:], typedcard.DecisionCommand{
		DeciderActorID: "actor_acme_alice",
		AgentChange: &typedcard.AgentChangeDecision{
			Request: typedcard.AgentChangeRequest{TargetActorID: "actor_acme_official", ExpectedRevision: 1, Change: map[string]string{"name": "Official Prime"}},
			View: typedcard.AgentChangeView{Action: "update", TargetActorID: "actor_acme_official", AgentName: "Official",
				Changes: []typedcard.AgentChange{{Field: "name", After: "Official Prime"}}},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	var version int64
	if err := env.pool.QueryRow(t.Context(), `SELECT version FROM message_cards WHERE message_id=$1`, created.MessageID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if _, err := cards.DecideDecision(t.Context(), "account_alice", created.DecisionID,
		typedcard.DecisionAnswerCommand{ExpectedVersion: version, Decision: "approve"}); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `UPDATE decisions SET status='executing' WHERE id=$1`, created.DecisionID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := cards.RunDecision(t.Context(), created.DecisionID); err != nil {
			t.Fatal(err)
		}
	}
	var status string
	if err := env.pool.QueryRow(t.Context(), `SELECT status FROM decisions WHERE id=$1`, created.DecisionID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || status != "succeeded" {
		t.Fatalf("interrupted idempotent run: runs=%d status=%s", runs, status)
	}
}

// confirmationToolProvider counts sends and serves one Gmail draft.
type confirmationToolProvider struct {
	sends     int
	draftBody string
}

func (p *confirmationToolProvider) SearchTools(context.Context, composio.ToolSearchRequest) ([]composio.Tool, error) {
	return nil, nil
}
func (p *confirmationToolProvider) GetConnectionStatusForToolkit(context.Context, string, string) (composio.ConnectionStatus, error) {
	return composio.ConnectionActive, nil
}
func (p *confirmationToolProvider) GetTool(_ context.Context, slug, version string) (composio.Tool, error) {
	var tool composio.Tool
	tool.Slug, tool.Version = slug, version
	tool.Toolkit.Slug = strings.ToLower(strings.SplitN(slug, "_", 2)[0])
	return tool, nil
}
func (p *confirmationToolProvider) ExecuteTool(_ context.Context, _, _, slug, _ string, _ map[string]any) (composio.ToolExecution, error) {
	if slug == "GMAIL_GET_DRAFT" {
		return composio.ToolExecution{Successful: true, Data: map[string]any{"id": "draft-1", "message": map[string]any{
			"payload": map[string]any{
				"mimeType": "text/plain",
				"headers":  []any{map[string]any{"name": "To", "value": "bob@example.test"}, map[string]any{"name": "Subject", "value": "Draft"}},
				"body":     map[string]any{"data": base64.RawURLEncoding.EncodeToString([]byte(p.draftBody))},
			},
		}}}, nil
	}
	p.sends++
	return composio.ToolExecution{Successful: true, Data: map[string]any{"id": "sent-1"}}, nil
}
