package agentdocument

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

type fakeMutator struct {
	apply func(context.Context, document.ApplySemanticMutationInput) (document.SemanticMutationResult, error)
}

func (f fakeMutator) ApplySemanticMutation(ctx context.Context, input document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
	return f.apply(ctx, input)
}

func TestApplyBindsStablePrincipalAndCanonicalResult(t *testing.T) {
	change := json.RawMessage(`[{"kind":"set_title","title":"Canonical"}]`)
	invocationID := "agent-invocation-sha256:" + strings.Repeat("a", 64)
	authorizer := fakeAuthorizer{authorize: func(_ context.Context, token, toolName string) (agentauth.Authorization, error) {
		if token != "th_agent_token" || toolName != semanticMutationTool {
			t.Fatalf("unexpected authorization token=%q tool=%q", token, toolName)
		}
		return agentauth.Authorization{
			Principal:         &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"},
			ParticipantTaskID: "task_1", Target: agentauth.Target{Kind: "task", ID: "task_1"},
		}, nil
	}}
	mutator := fakeMutator{apply: func(_ context.Context, input document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
		if input.Principal == nil || input.Principal.AgentID != "agent" ||
			input.DocumentID != "document_plan" || input.SourceInvocationID != invocationID ||
			input.SchemaVersion != "blocknote-semantic-v1" || string(input.SemanticChange) != string(change) {
			t.Fatalf("unexpected semantic mutation input: %+v", input)
		}
		return document.SemanticMutationResult{
			SemanticMutationID: "mutation_1", Status: document.SemanticMutationApplied,
			RevisionID: "revision_2", HistoryEntryID: "history_2", Replayed: true,
		}, nil
	}}
	result, err := NewSemanticTool(authorizer, mutator).Apply(context.Background(), "th_agent_token", SemanticInput{
		DocumentID:   "document_plan",
		InvocationID: invocationID, SchemaVersion: "blocknote-semantic-v1", SemanticChange: change,
	})
	if err != nil || result.SemanticMutationID != "mutation_1" || !result.Replayed {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestApplyAllowsRoomTargetWithoutExecution(t *testing.T) {
	called := false
	service := NewSemanticTool(fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
		return agentauth.Authorization{Principal: &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"}, RoomID: "room_1", Target: agentauth.Target{Kind: "room", ID: "room_1"}}, nil
	}}, fakeMutator{apply: func(_ context.Context, input document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
		if input.DocumentID != "document_private" {
			t.Fatalf("unexpected target %+v", input)
		}
		called = true
		return document.SemanticMutationResult{SemanticMutationID: "mutation_room", Status: document.SemanticMutationApplied, RevisionID: "revision_room", HistoryEntryID: "history_room"}, nil
	}})
	result, err := service.Apply(context.Background(), "token", SemanticInput{DocumentID: "document_private", InvocationID: "agent-invocation-sha256:" + strings.Repeat("d", 64), SchemaVersion: "blocknote-semantic-v1", SemanticChange: json.RawMessage(`[{"kind":"set_title","title":"Room"}]`)})
	if err != nil || !called || result.SemanticMutationID != "mutation_room" {
		t.Fatalf("result=%+v called=%v error=%v", result, called, err)
	}
}

func TestApplyBindsDocumentContextToAuthorizedCanonicalDocument(t *testing.T) {
	invocationID := "agent-invocation-sha256:" + strings.Repeat("e", 64)
	service := NewSemanticTool(fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
		return agentauth.Authorization{
			Principal:  &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"},
			DocumentID: "document_authorized", Target: agentauth.Target{Kind: "document", ID: "document_authorized"},
		}, nil
	}}, fakeMutator{apply: func(_ context.Context, input document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
		if input.DocumentID != "document_authorized" || input.SourceInvocationID != invocationID {
			t.Fatalf("unexpected Document Context mutation input: %+v", input)
		}
		return document.SemanticMutationResult{
			SemanticMutationID: "mutation_document", Status: document.SemanticMutationApplied,
			RevisionID: "revision_document", HistoryEntryID: "history_document",
		}, nil
	}})

	result, err := service.Apply(context.Background(), "token", SemanticInput{
		DocumentID:     "document_authorized",
		InvocationID:   invocationID,
		SchemaVersion:  "blocknote-semantic-v1",
		SemanticChange: json.RawMessage(`[{"kind":"set_title","title":"Document"}]`),
	})
	if err != nil || result.SemanticMutationID != "mutation_document" {
		t.Fatalf("result=%+v error=%v", result, err)
	}
}

func TestApplyRejectsDocumentContextWithoutCanonicalDocument(t *testing.T) {
	called := false
	service := NewSemanticTool(fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
		return agentauth.Authorization{
			Principal: &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"},
			Target:    agentauth.Target{Kind: "document"},
		}, nil
	}}, fakeMutator{apply: func(context.Context, document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
		called = true
		return document.SemanticMutationResult{}, nil
	}})

	_, err := service.Apply(context.Background(), "token", SemanticInput{
		DocumentID:     "document_authorized",
		InvocationID:   "agent-invocation-sha256:" + strings.Repeat("f", 64),
		SchemaVersion:  "blocknote-semantic-v1",
		SemanticChange: json.RawMessage(`[{"kind":"set_title","title":"Document"}]`),
	})
	if !errors.Is(err, ErrSemanticForbidden) || called {
		t.Fatalf("error=%v mutation_called=%v", err, called)
	}
}

func TestApplyFailsClosedForRevokedCredentialAndUnknownResult(t *testing.T) {
	mutator := fakeMutator{apply: func(context.Context, document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
		return document.SemanticMutationResult{SemanticMutationID: "mutation_1"}, nil
	}}
	for _, test := range []struct {
		name       string
		authorizer fakeAuthorizer
		want       error
	}{
		{
			name: "revoked credential",
			authorizer: fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
				return agentauth.Authorization{}, agentcredential.ErrInvalid
			}},
			want: agentcredential.ErrInvalid,
		},
		{
			name: "unknown canonical result",
			authorizer: fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
				return agentauth.Authorization{
					Principal:         &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"},
					ParticipantTaskID: "task_1", Target: agentauth.Target{Kind: "task", ID: "task_1"},
				}, nil
			}},
			want: ErrSemanticDependency,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := NewSemanticTool(test.authorizer, mutator).Apply(context.Background(), "th_agent_token", SemanticInput{
				DocumentID:   "document_plan",
				InvocationID: "agent-invocation-sha256:" + strings.Repeat("c", 64), SchemaVersion: "blocknote-semantic-v1",
				SemanticChange: json.RawMessage(`[{"kind":"set_title","title":"x"}]`),
			})
			if !errors.Is(err, test.want) {
				t.Fatalf("error=%v want=%v", err, test.want)
			}
		})
	}
}

func TestApplyStableAgentHasNoExecutionPrerequisite(t *testing.T) {
	principal := &agentcredential.Principal{CredentialID: "credential", AgentID: "agent", AgentActorID: "actor", TenantID: "tenant"}
	service := NewSemanticTool(fakeAuthorizer{authorize: func(context.Context, string, string) (agentauth.Authorization, error) {
		return agentauth.Authorization{Principal: principal, DocumentID: "doc", Target: agentauth.Target{Kind: "document", ID: "doc"}}, nil
	}}, fakeMutator{apply: func(_ context.Context, input document.ApplySemanticMutationInput) (document.SemanticMutationResult, error) {
		if input.Principal != principal {
			t.Fatalf("execution prerequisite: %+v", input)
		}
		return document.SemanticMutationResult{SemanticMutationID: "mutation", Status: document.SemanticMutationApplied, RevisionID: "revision", HistoryEntryID: "history"}, nil
	}})
	_, err := service.Apply(agentauth.WithTarget(t.Context(), "document", "doc"), "th_agent_credential", SemanticInput{DocumentID: "doc", InvocationID: "agent-invocation-sha256:" + strings.Repeat("a", 64), SchemaVersion: "blocknote-semantic-v1", SemanticChange: json.RawMessage(`[{"kind":"set_title","title":"New"}]`)})
	if err != nil {
		t.Fatal(err)
	}
}
