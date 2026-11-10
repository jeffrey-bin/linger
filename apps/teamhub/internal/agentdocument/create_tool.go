package agentdocument

import (
	"context"
	"errors"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

const (
	createDocumentTool = "create_document"
)

// Errors returned by CreateTool.
var (
	ErrCreateForbidden  = errors.New("Document creation is forbidden")
	ErrCreateDependency = errors.New("Document creation dependency is unavailable")
)

// CreateInput is one Agent Document creation request.
type CreateInput struct {
	InvocationID    string
	Title, Markdown string
}

// CreateResult reports the created Document.
type CreateResult struct {
	document.CreateAgentDocumentResult
}

type documentCreator interface {
	CreateAgentDocument(context.Context, document.CreateAgentDocumentInput) (document.CreateAgentDocumentResult, error)
}

// CreateTool lets an authorized Agent create a Document from Markdown.
type CreateTool struct {
	contexts  contextAuthorizer
	documents documentCreator
}

// NewCreateTool returns a CreateTool over the given dependencies.
func NewCreateTool(contexts contextAuthorizer, documents documentCreator) *CreateTool {
	return &CreateTool{contexts: contexts, documents: documents}
}

// Create authorizes the Agent and creates the Document.
func (s *CreateTool) Create(
	ctx context.Context,
	token string,
	input CreateInput,
) (CreateResult, error) {
	if s == nil || s.contexts == nil || s.documents == nil {
		return CreateResult{}, ErrCreateDependency
	}
	if !validInvocationID(input.InvocationID) ||
		!utf8.ValidString(input.Title) || len(input.Title) < 1 || len(input.Title) > 255 ||
		!utf8.ValidString(input.Markdown) || len(input.Markdown) > 1048576 {
		return CreateResult{}, document.ErrInvalidInput
	}
	authorization, err := s.contexts.Authorize(
		ctx, token, createDocumentTool,
	)
	if err != nil {
		return CreateResult{}, err
	}

	target := agentauth.TargetFromContext(ctx)
	created, err := s.documents.CreateAgentDocument(ctx, document.CreateAgentDocumentInput{
		Principal: authorization.Principal, TargetKind: target.Kind, TargetID: target.ID,
		SourceInvocationID: input.InvocationID, Title: input.Title, Markdown: input.Markdown,
	})
	if err != nil {
		return CreateResult{}, err
	}
	if created.DocumentID == "" || created.RevisionID == "" {
		return CreateResult{}, ErrCreateDependency
	}
	return CreateResult{
		CreateAgentDocumentResult: created,
	}, nil
}
