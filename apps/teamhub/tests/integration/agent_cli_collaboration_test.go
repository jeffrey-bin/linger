package integration_test

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdirectmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

func TestAgentCLIMessagePersistsAndReplaysWithoutRun(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	ctx := agentauth.WithTarget(t.Context(), "room", roomID)
	service := newAgentSendService(t, env.pool, agentauth.New(env.pool))
	input := agentSendInput("room:"+roomID, "agent-invocation-sha256:"+strings.Repeat("a", 64),
		agentsendmessage.PreparedSegment{Type: "text", Content: "Independent CLI message"})
	first, err := service.Send(ctx, issued.AccessToken, input)
	if err != nil || !first.Accepted || first.Replay {
		t.Fatalf("first independent write: result=%+v err=%v", first, err)
	}
	rotated, err := agentcredential.New(env.pool).IssueManaged(ctx, issued.AgentID, "rotated CLI")
	if err != nil {
		t.Fatal(err)
	}
	replay, err := service.Send(ctx, rotated.AccessToken, input)
	if err != nil || !replay.Replay || replay.MessageID != first.MessageID {
		t.Fatalf("credential rotation changed operation identity: result=%+v err=%v", replay, err)
	}
	input.Atomic.Segments[0].Content = "different payload"
	if _, err := service.Send(ctx, rotated.AccessToken, input); !errors.Is(err, agentsendmessage.ErrIdempotencyConflict) {
		t.Fatalf("reused operation accepted another payload: %v", err)
	}
	var messages, runs int
	err = env.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'),(SELECT count(*) FROM agent_local_runs)`, roomID).Scan(&messages, &runs)
	if err != nil || messages != 1 || runs != 0 {
		t.Fatalf("persisted effects: messages=%d runs=%d err=%v", messages, runs, err)
	}
}

// The CLI sends the Room Context from its configuration. A Room write without
// it, or from another Room's Context, is forbidden even when the Agent is a
// member of the target Room.
func TestAgentCLIRoomWritesRequireCallerRoomContext(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	otherRoomID := createPrivateRoom(t, env, alice, "Other Agent CLI Room", "agent-cli-other-room")
	if code, body := putRoomMember(t, env, alice, otherRoomID, "actor_acme_official", "member"); code != http.StatusOK {
		t.Fatalf("add Agent to %s: %d %s", otherRoomID, code, body)
	}
	t.Run("Room message", func(t *testing.T) {
		message := func(invocation string) map[string]any {
			return agentTextMessage("room:"+roomID, "agent-cli-room-context-"+invocation, "Room Context "+invocation)
		}
		for _, test := range []struct {
			name, invocation, contextKind, contextID string
		}{
			{name: "without a Room Context", invocation: "1"},
			{name: "from another Room Context", invocation: "2", contextKind: "room", contextID: otherRoomID},
		} {
			if code, body := commitAgentMessage(t, env, issued.AccessToken, test.contextKind, test.contextID, message(test.invocation)); code != http.StatusForbidden {
				t.Fatalf("Room message %s=%d %s", test.name, code, body)
			}
		}
		if n := countRows(t, env, `SELECT count(*) FROM messages WHERE room_id=$1 AND author_actor_id='actor_acme_official'`, roomID); n != 0 {
			t.Fatalf("forbidden Room messages persisted: %d", n)
		}
		if code, body := commitAgentMessage(t, env, issued.AccessToken, "room", roomID, message("3")); code != http.StatusOK {
			t.Fatalf("Room message from its own Room Context=%d %s", code, body)
		}
	})
}

func TestAgentCLICollaborationUsesCurrentBusinessRoleWithoutInvocation(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, issued, roomID := newAgentCLIIdentity(t)
	ctx := agentauth.WithTarget(t.Context(), "room", roomID)
	contexts := agentauth.New(env.pool)
	t.Run("Task creation originates only in the caller's Room Context", func(t *testing.T) {
		authority, err := contexts.Authorize(ctx, issued.AccessToken, "create_task")
		if err != nil || authority.RoomID != roomID {
			t.Fatalf("Room Context Task authority=%+v %v", authority, err)
		}
		for _, target := range []agentauth.Target{{}, {Kind: "room", ID: "room_missing"}, {Kind: "task", ID: "task_private"}} {
			targetCtx := t.Context()
			if target.Kind != "" {
				targetCtx = agentauth.WithTarget(targetCtx, target.Kind, target.ID)
			}
			if _, err := contexts.Authorize(targetCtx, issued.AccessToken, "create_task"); !errors.Is(err, agentauth.ErrForbidden) {
				t.Fatalf("target %+v granted Task creation authority: %v", target, err)
			}
		}
	})
	t.Run("private Sponsor delivery from a selected Room", func(t *testing.T) {
		service := agentdirectmessage.New(env.pool, contexts)
		input := agentdirectmessage.Input{InvocationID: "agent-invocation-sha256:" + strings.Repeat("b", 64), Messages: []string{"Private fixture note"}}
		result, err := service.Send(ctx, issued.AccessToken, input)
		if err != nil || !result.Accepted || len(result.MessageIDs) != 1 {
			t.Fatalf("independent private message: %+v %v", result, err)
		}
		replay, err := service.Send(ctx, issued.AccessToken, input)
		if err != nil || !replay.Replay || replay.MessageIDs[0] != result.MessageIDs[0] {
			t.Fatalf("private replay: %+v %v", replay, err)
		}
	})
	if _, err := env.pool.Exec(ctx, `UPDATE agent_registrations SET agent_type='anotherme',receives_all_messages=true,represented_human_actor_id='actor_acme_alice' WHERE actor_id='actor_acme_official'`); err != nil {
		t.Fatal(err)
	}
	t.Run("discover currently accessible Agents", func(t *testing.T) {
		service := agentcreationapproval.New(env.pool, contexts, typedcard.New(env.pool))
		_, err := service.ListAvailableAgents(ctx, issued.AccessToken, "", 100)
		if err != nil {
			t.Fatal(err)
		}
	})
	t.Run("Room approval is persisted before Human decision", func(t *testing.T) {
		service := agentcreationapproval.New(env.pool, contexts, typedcard.New(env.pool))
		segments := []messagecreation.Segment{{Type: "text", Content: "Independent Room approval"}}
		input := agentcreationapproval.Input{RequestKind: "room_creation", InvocationID: "agent-invocation-sha256:" + strings.Repeat("c", 64),
			RoomCaller:    &agentcreationapproval.RoomCallerInput{Name: "CLI pending room", MemberIDs: []string{"actor_acme_alice", "actor_acme_official"}, InitialMessageSegments: segments},
			RoomEffective: &agentcreationapproval.RoomEffectivePayload{Name: "CLI pending room", MemberIDs: []string{"actor_acme_alice", "actor_acme_official"}, InitialMessageSegments: segments},
		}
		result, err := service.Submit(ctx, issued.AccessToken, input)
		if err != nil || result.CreationApprovalRequestID == "" {
			t.Fatalf("room approval: %+v %v", result, err)
		}
		replay, err := service.Submit(ctx, issued.AccessToken, input)
		if err != nil || !replay.Replay || replay.CreationApprovalRequestID != result.CreationApprovalRequestID {
			t.Fatalf("room replay: %+v %v", replay, err)
		}
		if n := countRows(t, env, `SELECT count(*) FROM rooms WHERE name='CLI pending room'`); n != 0 {
			t.Fatalf("created %d rooms before approval", n)
		}
	})
	if n := countRows(t, env, `SELECT count(*) FROM agent_local_runs`); n != 0 {
		t.Fatalf("created %d lifecycle records", n)
	}
}

// The Room's Humans never see the Agent-only team.md announcement, so each
// publication also appends team_md.published to the Room event stream they read.
func TestAgentTeamMdPublicationAppendsRoomEvent(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, issued, roomID := newAgentCLIIdentity(t)
	seedPersonalKnowledgeAgent(t, env.pool, "team_md", acmeTenant, "actor_acme_alice", "general")
	if code, body := putRoomMember(t, env, alice, roomID, "actor_pk_team_md", "member"); code != http.StatusOK {
		t.Fatalf("add team member: %d %s", code, body)
	}
	before, _ := humanRoomEventsAfter(t, env, alice, roomID, 0)
	service := newAgentSendService(t, env.pool, agentauth.New(env.pool))
	result, err := service.CreateTeamMd(agentauth.WithTarget(t.Context(), "room", roomID), issued.AccessToken, agentsendmessage.CreateTeamMdInput{
		InvocationID: "agent-invocation-sha256:" + strings.Repeat("d", 64),
		Content: `---
collaborate_pattern: fan-out-and-synthesize
---

## Task Goal

Compare two vendors.

## Orchestrator

- Coordinator
  - ID: actor_acme_official

## Team Member

- Researcher
  - ID: actor_pk_team_md
  - Report to: Coordinator
  - Receive from: Coordinator
`,
	})
	if err != nil || result.Revision != 1 {
		t.Fatalf("publish team.md: result=%+v err=%v", result, err)
	}
	page, body := humanRoomEventsAfter(t, env, alice, roomID, before.LatestRoomSeq)
	type publishedPayload struct {
		Kind     string `json:"kind"`
		Revision int64  `json:"revision"`
	}
	var published []publishedPayload
	for _, event := range page.Items {
		if event.EventType == "team_md.published" {
			var payload publishedPayload
			decode(t, event.Payload, &payload)
			published = append(published, payload)
		}
	}
	if len(published) != 1 || published[0] != (publishedPayload{Kind: "team_md.published", Revision: 1}) {
		t.Fatalf("team_md.published events=%+v page=%s", published, body)
	}
}
