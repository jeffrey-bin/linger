package agentdocument

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestGetThreadFiltersDeletedCommentsAndReturnsVisibleFields(t *testing.T) {
	deletedAt := time.Date(2030, 1, 2, 0, 0, 0, 0, time.UTC)
	createdAt := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	authorizer := &fakeContextAuthorizer{authorization: documentAuthorization()}
	comments := &fakeCommentService{thread: document.Thread{
		ID: "thread_1", DocumentID: "document_1", AnchorStatus: "attached",
		Anchor: document.Anchor{
			QuotedText: "selected", ContextBefore: "before", ContextAfter: "after",
		},
		Comments: []document.Comment{
			{
				ID: "comment_visible", Author: document.CommentActor{DisplayName: "Alice", Kind: "human"},
				Segments: []document.Segment{{Type: "text", Content: "Please revise"}}, CreatedAt: createdAt,
			},
			{
				ID: "comment_deleted", Author: document.CommentActor{DisplayName: "Bob", Kind: "human"},
				Segments: []document.Segment{{Type: "text", Content: "Deleted"}}, DeletedAt: &deletedAt,
			},
		},
	}}
	service := NewCommentTool(authorizer, comments, &fakeDocumentMutator{})

	result, err := service.GetThread(
		context.Background(), "token", "thread_1",
	)
	if err != nil {
		t.Fatalf("GetThread returned error: %v", err)
	}
	if len(result.Comments) != 1 || result.Comments[0].CommentID != "comment_visible" {
		t.Fatalf("visible comments = %#v", result.Comments)
	}
	if result.Selection.QuotedText != "selected" || result.Selection.ContextBefore != "before" || result.Selection.ContextAfter != "after" {
		t.Fatalf("selection = %#v", result.Selection)
	}
	if comments.agentID != "agent_1" || comments.threadID != "thread_1" {
		t.Fatalf("comment lookup authority = (%q, %q)", comments.agentID, comments.threadID)
	}
}

func TestReplaceTextInjectsDocumentAuthorityAndReturnsCommittedProjection(t *testing.T) {
	invocationID := "agent-invocation-sha256:" + strings.Repeat("a", 64)
	markdown := []byte("# Revised\n")
	digest := fmt.Sprintf("%x", sha256.Sum256(markdown))
	mutator := &fakeDocumentMutator{result: document.CommentTextReplacementResult{
		SemanticMutationResult: document.SemanticMutationResult{
			Status: document.SemanticMutationApplied, RevisionID: "revision_2", HistoryEntryID: "history_2",
		},
		CurrentMarkdown: markdown, CurrentMarkdownSHA256: digest,
	}}
	service := NewCommentTool(
		&fakeContextAuthorizer{authorization: documentAuthorization()},
		&fakeCommentService{thread: document.Thread{ID: "thread_1", DocumentID: "document_1", AnchorStatus: "attached"}},
		mutator,
	)

	result, err := service.ReplaceText(
		context.Background(), "token",
		ReplaceInput{ThreadID: "thread_1", Replacement: "Revised", InvocationID: invocationID},
	)
	if err != nil {
		t.Fatalf("ReplaceText returned error: %v", err)
	}
	if mutator.input.Principal == nil || mutator.input.Principal.AgentActorID != "actor_1" ||
		mutator.input.DocumentID != "document_1" ||
		mutator.input.ThreadID != "thread_1" ||
		mutator.input.SourceInvocationID != documentCommentOperationID("agent:actor_1:thread_1", "replace-text", invocationID) {
		t.Fatalf("mutation authority = %#v", mutator.input)
	}
	if result.Status != "applied" || result.RevisionID != "revision_2" || result.HistoryEntryID != "history_2" {
		t.Fatalf("replacement result = %#v", result)
	}
	if string(result.CurrentMarkdown) != string(markdown) || result.CurrentMarkdownSHA256 != digest {
		t.Fatalf("current projection = %q %q", result.CurrentMarkdown, result.CurrentMarkdownSHA256)
	}
	if result.Observation != "Document thread thread_1 updated" {
		t.Fatalf("observation = %q", result.Observation)
	}
}

func TestReplyUsesStableDocumentInvocationIdempotency(t *testing.T) {
	invocationID := "agent-invocation-sha256:" + strings.Repeat("b", 64)
	comments := &fakeCommentService{thread: document.Thread{ID: "thread_1", DocumentID: "document_1", AnchorStatus: "attached"}, reply: document.CommentResult{
		Comment: document.Comment{ID: "comment_reply"}, Replay: true,
	}}
	service := NewCommentTool(
		&fakeContextAuthorizer{authorization: documentAuthorization()},
		comments,
		&fakeDocumentMutator{},
	)

	result, err := service.Reply(
		context.Background(), "token", ReplyInput{
			ThreadID: "thread_1", InvocationID: invocationID,
			Segments: []Segment{{Type: "text", Content: "Updated"}},
		},
	)
	if err != nil {
		t.Fatalf("Reply returned error: %v", err)
	}
	if comments.replyInput.IdempotencyKey != documentCommentOperationID("agent:actor_1:thread_1", "reply", invocationID) {
		t.Fatalf("reply idempotency key = %q", comments.replyInput.IdempotencyKey)
	}
	if result.CommentID != "comment_reply" || !result.Replayed {
		t.Fatalf("reply result = %#v", result)
	}
}

func TestDocumentCommentOperationIDSeparatesAgentAndRequestIdentities(t *testing.T) {
	firstInvocationID := "agent-invocation-sha256:" + strings.Repeat("c", 64)
	secondInvocationID := "agent-invocation-sha256:" + strings.Repeat("d", 64)
	first := documentCommentOperationID("agent:actor_1:thread_1", "reply", firstInvocationID)
	if first != documentCommentOperationID("agent:actor_1:thread_1", "reply", firstInvocationID) {
		t.Fatal("the same request did not produce a stable operation identity")
	}
	if first == documentCommentOperationID("agent:actor_1:thread_1", "reply", secondInvocationID) {
		t.Fatal("different requests from one Agent shared an operation identity")
	}
	if first == documentCommentOperationID("agent:actor_2:thread_1", "reply", firstInvocationID) {
		t.Fatal("the same request across Agents shared an operation identity")
	}
}

func TestDocumentCommentWritesRejectNonCanonicalInvocationID(t *testing.T) {
	service := NewCommentTool(
		&fakeContextAuthorizer{authorization: documentAuthorization()},
		&fakeCommentService{thread: document.Thread{ID: "thread_1", DocumentID: "document_1", AnchorStatus: "attached"}},
		&fakeDocumentMutator{},
	)
	if _, err := service.Reply(context.Background(), "token", ReplyInput{
		ThreadID: "thread_1", InvocationID: "legacy-invocation",
		Segments: []Segment{{Type: "text", Content: "Updated"}},
	}); !errors.Is(err, document.ErrCommentInvalidInput) {
		t.Fatalf("Reply error = %v, want ErrInvalidInput", err)
	}
	if _, err := service.ReplaceText(context.Background(), "token", ReplaceInput{
		ThreadID: "thread_1", InvocationID: "legacy-invocation", Replacement: "Updated",
	}); !errors.Is(err, document.ErrInvalidInput) {
		t.Fatalf("ReplaceText error = %v, want ErrInvalidInput", err)
	}
}

func documentAuthorization() agentauth.Authorization {
	return agentauth.Authorization{
		Principal:  &agentcredential.Principal{CredentialID: "credential_1", AgentID: "agent_1", AgentActorID: "actor_1", TenantID: "tenant_1"},
		DocumentID: "document_1", Target: agentauth.Target{Kind: "document", ID: "document_1"},
	}
}

type fakeContextAuthorizer struct {
	authorization agentauth.Authorization
	err           error
}

func (f *fakeContextAuthorizer) Authorize(
	context.Context, string, string,
) (agentauth.Authorization, error) {
	return f.authorization, f.err
}

type fakeCommentService struct {
	thread     document.Thread
	reply      document.CommentResult
	replyInput document.AgentReplyInput
	err        error
	agentID    string
	threadID   string
}

func (f *fakeCommentService) GetThreadForAgent(_ context.Context, agentID, threadID string) (document.Thread, error) {
	f.agentID, f.threadID = agentID, threadID
	return f.thread, f.err
}

func (f *fakeCommentService) ReplyForAgent(_ context.Context, input document.AgentReplyInput) (document.CommentResult, error) {
	f.replyInput = input
	return f.reply, f.err
}

type fakeDocumentMutator struct {
	input  document.ApplyCommentTextReplacementInput
	result document.CommentTextReplacementResult
	err    error
}

func (f *fakeDocumentMutator) ApplyCommentTextReplacement(
	_ context.Context,
	input document.ApplyCommentTextReplacementInput,
) (document.CommentTextReplacementResult, error) {
	f.input = input
	return f.result, f.err
}
