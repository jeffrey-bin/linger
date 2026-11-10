package agentdocument

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

// Errors returned by the Document Comment Tool.
var (
	ErrCommentToolForbidden  = errors.New("Document Comment Tool is forbidden")
	ErrCommentToolDependency = errors.New("Document Comment Tool dependency is unavailable")
)

type Segment struct {
	Type    string
	Content string
	ActorID string
}

type Author struct {
	DisplayName string
	Kind        string
}

type Comment struct {
	CommentID       string
	ParentCommentID string
	Author          Author
	Segments        []Segment
	CreatedAt       time.Time
}

type Selection struct {
	QuotedText    string
	ContextBefore string
	ContextAfter  string
}

type ThreadResult struct {
	ThreadID  string
	Selection Selection
	Comments  []Comment
}

type ReplyInput struct {
	ThreadID        string
	ParentCommentID string
	Segments        []Segment
	InvocationID    string
}

type ReplyResult struct {
	ThreadID  string
	CommentID string
	Replayed  bool
}

type ReplaceInput struct {
	ThreadID     string
	Replacement  string
	InvocationID string
}

type ReplaceResult struct {
	ThreadID              string
	Status                string
	Replayed              bool
	RevisionID            string
	HistoryEntryID        string
	ConflictReason        string
	Observation           string
	CurrentMarkdown       []byte
	CurrentMarkdownSHA256 string
}

type commentService interface {
	GetThreadForAgent(context.Context, string, string) (document.Thread, error)
	ReplyForAgent(context.Context, document.AgentReplyInput) (document.CommentResult, error)
}

type documentMutator interface {
	ApplyCommentTextReplacement(context.Context, document.ApplyCommentTextReplacementInput) (document.CommentTextReplacementResult, error)
}

// CommentTool lets an authorized Agent read and reply to Document Comment
// Threads and replace the text they anchor.
type CommentTool struct {
	contexts  contextAuthorizer
	comments  commentService
	documents documentMutator
}

// NewCommentTool returns a CommentTool over the given dependencies.
func NewCommentTool(contexts contextAuthorizer, comments commentService, documents documentMutator) *CommentTool {
	return &CommentTool{contexts: contexts, comments: comments, documents: documents}
}

// GetThread reads one Comment Thread of the authorized Document.
func (s *CommentTool) GetThread(
	ctx context.Context,
	token string,
	threadID string,
) (ThreadResult, error) {
	authorization, err := s.authorize(ctx, token, "get_document_comment_thread", threadID)
	if err != nil {
		return ThreadResult{}, err
	}
	thread, err := s.comments.GetThreadForAgent(ctx, authorization.AgentID, threadID)
	if err != nil {
		return ThreadResult{}, err
	}
	if thread.ID != threadID || thread.DocumentID != authorization.DocumentID ||
		thread.AnchorStatus != "attached" || thread.Resolved {
		return ThreadResult{}, ErrCommentToolForbidden
	}
	comments := make([]Comment, 0, len(thread.Comments))
	for _, source := range thread.Comments {
		if source.DeletedAt != nil {
			continue
		}
		segments := make([]Segment, len(source.Segments))
		for index, segment := range source.Segments {
			segments[index] = Segment{Type: segment.Type, Content: segment.Content, ActorID: segment.ActorID}
		}
		parentID := ""
		if source.ParentCommentID != nil {
			parentID = *source.ParentCommentID
		}
		comments = append(comments, Comment{
			CommentID: source.ID, ParentCommentID: parentID,
			Author:   Author{DisplayName: source.Author.DisplayName, Kind: source.Author.Kind},
			Segments: segments, CreatedAt: source.CreatedAt.UTC(),
		})
	}
	return ThreadResult{
		ThreadID: thread.ID,
		Selection: Selection{
			QuotedText: thread.Anchor.QuotedText, ContextBefore: thread.Anchor.ContextBefore,
			ContextAfter: thread.Anchor.ContextAfter,
		},
		Comments: comments}, nil
}

// Reply appends an Agent reply to a Comment Thread.
func (s *CommentTool) Reply(
	ctx context.Context,
	token string,
	input ReplyInput,
) (ReplyResult, error) {
	if s == nil || s.comments == nil || !validInvocationID(input.InvocationID) || len(input.Segments) == 0 {
		return ReplyResult{}, document.ErrCommentInvalidInput
	}
	authorization, err := s.authorize(ctx, token, "reply_document_comment", input.ThreadID)
	if err != nil {
		return ReplyResult{}, err
	}
	segments := make([]document.Segment, len(input.Segments))
	for index, segment := range input.Segments {
		segments[index] = document.Segment{Type: segment.Type, Content: segment.Content, ActorID: segment.ActorID}
	}
	var parent *string
	if input.ParentCommentID != "" {
		parent = &input.ParentCommentID
	}
	ctx = agentcredential.WithPrincipal(ctx, *authorization.Principal)

	result, err := s.comments.ReplyForAgent(ctx, document.AgentReplyInput{
		AgentManagementID: authorization.AgentID, ThreadID: input.ThreadID,
		IdempotencyKey: documentCommentOperationID(
			commentOperationScope(authorization, input.ThreadID), "reply", input.InvocationID,
		), ParentCommentID: parent, Segments: segments,
	})
	if err != nil {
		return ReplyResult{}, err
	}
	return ReplyResult{
		ThreadID: input.ThreadID, CommentID: result.Comment.ID, Replayed: result.Replay,
	}, nil
}

// ReplaceText replaces the text a Comment Thread anchors.
func (s *CommentTool) ReplaceText(
	ctx context.Context,
	token string,
	input ReplaceInput,
) (ReplaceResult, error) {
	if s == nil || s.documents == nil || !validInvocationID(input.InvocationID) ||
		len(input.Replacement) < 1 || len(input.Replacement) > 50000 {
		return ReplaceResult{}, document.ErrInvalidInput
	}
	authorization, err := s.authorize(ctx, token, "replace_document_comment_text", input.ThreadID)
	if err != nil {
		return ReplaceResult{}, err
	}
	mutation, err := s.documents.ApplyCommentTextReplacement(ctx, document.ApplyCommentTextReplacementInput{
		Principal:  authorization.Principal,
		DocumentID: authorization.DocumentID, ThreadID: input.ThreadID,
		SourceInvocationID: documentCommentOperationID(
			commentOperationScope(authorization, input.ThreadID), "replace-text", input.InvocationID,
		), Replacement: input.Replacement,
	})
	if err != nil {
		return ReplaceResult{}, err
	}
	result := ReplaceResult{
		ThreadID: input.ThreadID, Status: string(mutation.Status), Replayed: mutation.Replayed,
		RevisionID: mutation.RevisionID, HistoryEntryID: mutation.HistoryEntryID,
		ConflictReason:        mutation.ConflictReason,
		CurrentMarkdown:       append([]byte(nil), mutation.CurrentMarkdown...),
		CurrentMarkdownSHA256: mutation.CurrentMarkdownSHA256,
	}
	if mutation.Status == document.SemanticMutationApplied {
		result.Observation = "Document thread " + input.ThreadID + " updated"
	} else {
		result.Observation = "Document thread " + input.ThreadID + " was not updated"
	}
	return result, nil
}

func documentCommentOperationID(localRunID, operation, invocationID string) string {
	digest := sha256.Sum256([]byte(localRunID + "\x00" + operation + "\x00" + invocationID))
	return "document-comment-invocation-sha256:" + hex.EncodeToString(digest[:])
}

func (s *CommentTool) authorize(
	ctx context.Context,
	token string,
	toolName, threadID string,
) (agentauth.Authorization, error) {
	if s == nil || s.contexts == nil || s.comments == nil || threadID == "" {
		return agentauth.Authorization{}, ErrCommentToolDependency
	}
	authorization, err := s.contexts.Authorize(ctx, token, toolName)
	if err != nil {
		return agentauth.Authorization{}, err
	}

	thread, err := s.comments.GetThreadForAgent(ctx, authorization.AgentID, threadID)
	if err != nil {
		return agentauth.Authorization{}, err
	}
	if thread.DocumentID != authorization.DocumentID || thread.AnchorStatus != "attached" || thread.Resolved {
		return agentauth.Authorization{}, ErrCommentToolForbidden
	}
	return authorization, nil

}

func commentOperationScope(a agentauth.Authorization, threadID string) string {

	return "agent:" + a.Principal.AgentActorID + ":" + threadID

}
