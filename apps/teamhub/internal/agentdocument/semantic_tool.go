package agentdocument

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

const (
	semanticMutationTool = "apply_document_semantic_mutation"
)

// Errors returned by SemanticTool.
var (
	ErrSemanticForbidden  = errors.New("Document semantic mutation is forbidden")
	ErrSemanticDependency = errors.New("Document semantic mutation dependency is unavailable")
)

// SemanticInput is one Agent semantic Document mutation request.
type SemanticInput struct {
	DocumentID     string
	InvocationID   string
	SchemaVersion  string
	SemanticChange json.RawMessage
}

// SemanticResult reports the applied semantic mutation.
type SemanticResult struct {
	document.SemanticMutationResult
}

type semanticMutator interface {
	ApplySemanticMutation(context.Context, document.ApplySemanticMutationInput) (document.SemanticMutationResult, error)
}

// SemanticTool lets an authorized Agent apply a semantic Document mutation.
type SemanticTool struct {
	contexts  contextAuthorizer
	documents semanticMutator
}

// NewSemanticTool returns a SemanticTool over the given dependencies.
func NewSemanticTool(contexts contextAuthorizer, documents semanticMutator) *SemanticTool {
	return &SemanticTool{contexts: contexts, documents: documents}
}

// Apply authorizes the Agent and applies the semantic mutation.
func (s *SemanticTool) Apply(
	ctx context.Context,
	token string,
	input SemanticInput,
) (SemanticResult, error) {
	if s == nil || s.contexts == nil || s.documents == nil {
		return SemanticResult{}, ErrSemanticDependency
	}
	if input.DocumentID == "" ||
		(input.DocumentID != "" && !validAuthorityID(input.DocumentID)) ||
		!validInvocationID(input.InvocationID) || input.SchemaVersion != "blocknote-semantic-v1" ||
		len(input.SemanticChange) == 0 || len(input.SemanticChange) > 262144 {
		return SemanticResult{}, document.ErrInvalidInput
	}
	authorization, err := s.contexts.Authorize(
		ctx, token, semanticMutationTool,
	)
	if err != nil {
		return SemanticResult{}, err
	}

	documentID := input.DocumentID
	if authorization.Target.Kind == "document" {
		if authorization.DocumentID == "" {
			return SemanticResult{}, ErrSemanticForbidden
		}
		if documentID != "" && documentID != authorization.DocumentID {
			return SemanticResult{}, ErrSemanticForbidden
		}
		documentID = authorization.DocumentID
	}
	target := agentauth.TargetFromContext(ctx)
	mutation, err := s.documents.ApplySemanticMutation(ctx, document.ApplySemanticMutationInput{
		Principal: authorization.Principal, TargetKind: target.Kind, TargetID: target.ID,
		DocumentID:         documentID,
		SourceInvocationID: input.InvocationID,
		SchemaVersion:      input.SchemaVersion,
		SemanticChange:     input.SemanticChange,
	})
	if err != nil {
		return SemanticResult{}, err
	}
	if !validMutationResult(mutation) {
		return SemanticResult{}, ErrSemanticDependency
	}
	return SemanticResult{
		SemanticMutationResult: mutation,
	}, nil
}

func validAuthorityID(value string) bool {
	if len(value) < 1 || len(value) > 128 || !asciiAlphaNumeric(value[0]) {
		return false
	}
	for index := 1; index < len(value); index++ {
		if !asciiAlphaNumeric(value[index]) && value[index] != '_' && value[index] != '-' {
			return false
		}
	}
	return true
}

func asciiAlphaNumeric(value byte) bool {
	return value >= '0' && value <= '9' || value >= 'A' && value <= 'Z' || value >= 'a' && value <= 'z'
}

func validMutationResult(result document.SemanticMutationResult) bool {
	if result.SemanticMutationID == "" {
		return false
	}
	switch result.Status {
	case document.SemanticMutationApplied:
		return result.RevisionID != "" && result.HistoryEntryID != "" && result.ConflictReason == ""
	case document.SemanticMutationConflicted:
		return result.RevisionID == "" && result.HistoryEntryID == "" && result.ConflictReason != ""
	default:
		return false
	}
}
