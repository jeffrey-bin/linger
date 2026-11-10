package agentdocument

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type fakeCreator struct {
	create func(context.Context, document.CreateAgentDocumentInput) (document.CreateAgentDocumentResult, error)
}

func (f fakeCreator) CreateAgentDocument(ctx context.Context, input document.CreateAgentDocumentInput) (document.CreateAgentDocumentResult, error) {
	return f.create(ctx, input)
}

func TestCreateBindsStablePrincipalAndCanonicalResult(t *testing.T) {
	invocationID := "agent-invocation-sha256:" + strings.Repeat("a", 64)
	authorizer := fakeAuthorizer{authorize: func(_ context.Context, token, tool string) (agentauth.Authorization, error) {
		if token != "th_agent_token" || tool != createDocumentTool {
			t.Fatalf("authorization token=%q tool=%q", token, tool)
		}
		return agentauth.Authorization{
			Principal:         &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"},
			ParticipantTaskID: "task_1", Target: agentauth.Target{Kind: "task", ID: "task_1"},
		}, nil
	}}
	creator := fakeCreator{create: func(_ context.Context, input document.CreateAgentDocumentInput) (document.CreateAgentDocumentResult, error) {
		if input.Principal == nil || input.Principal.AgentID != "agent" ||
			input.SourceInvocationID != invocationID || input.Title != "Created" || input.Markdown != "# Body\n" {
			t.Fatalf("create input=%+v", input)
		}
		return document.CreateAgentDocumentResult{
			DocumentID: "document_1", RevisionID: "revision_1", Replayed: true,
		}, nil
	}}
	result, err := NewCreateTool(authorizer, creator).Create(context.Background(), "th_agent_token", CreateInput{
		InvocationID: invocationID,
		Title:        "Created", Markdown: "# Body\n",
	})
	if err != nil || result.DocumentID != "document_1" || result.RevisionID != "revision_1" ||
		!result.Replayed {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestCreateRejectsUnknownResult(t *testing.T) {
	called := false
	creator := fakeCreator{create: func(context.Context, document.CreateAgentDocumentInput) (document.CreateAgentDocumentResult, error) {
		called = true
		return document.CreateAgentDocumentResult{}, nil
	}}
	service := NewCreateTool(fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
		return agentauth.Authorization{
			Principal:         &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"},
			ParticipantTaskID: "task_1", Target: agentauth.Target{Kind: "task", ID: "task_1"},
		}, nil
	}}, creator)
	_, err := service.Create(context.Background(), "token", CreateInput{
		InvocationID: "agent-invocation-sha256:" + strings.Repeat("c", 64),
		Title:        "Created", Markdown: "body",
	})
	if !errors.Is(err, ErrCreateDependency) || !called {
		t.Fatalf("unknown result error=%v called=%v", err, called)
	}
}

func TestCreateAllowsRoomTargetWithoutExecution(t *testing.T) {
	called := false
	service := NewCreateTool(fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
		return agentauth.Authorization{Principal: &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"}, RoomID: "room_1", Target: agentauth.Target{Kind: "room", ID: "room_1"}}, nil
	}}, fakeCreator{create: func(context.Context, document.CreateAgentDocumentInput) (document.CreateAgentDocumentResult, error) {
		called = true
		return document.CreateAgentDocumentResult{DocumentID: "document_room", RevisionID: "revision_room"}, nil
	}})
	result, err := service.Create(context.Background(), "token", CreateInput{InvocationID: "agent-invocation-sha256:" + strings.Repeat("d", 64), Title: "Room", Markdown: "# Room"})
	if err != nil || !called || result.DocumentID != "document_room" {
		t.Fatalf("result=%+v called=%v error=%v", result, called, err)
	}
}
