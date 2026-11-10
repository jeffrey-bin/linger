package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// ReplaceAgentDocumentBody reuses native mutation admission, transaction and history.
// The CLI's download revision is an additional precondition, never an authority.
type ReplaceAgentDocumentBodyInput struct {
	Principal                                       *agentcredential.Principal
	DocumentID, BaseRevisionID, OperationID, Format string
	Content                                         io.Reader
}
type ReplaceAgentDocumentBodyResult struct {
	SemanticMutationResult
	SHA256 string
}

func (s *Service) ReplaceAgentDocumentBody(ctx context.Context, input ReplaceAgentDocumentBodyInput) (ReplaceAgentDocumentBodyResult, error) {
	if s == nil || s.pool == nil || input.Content == nil || input.Principal == nil || input.DocumentID == "" || input.BaseRevisionID == "" || len(input.OperationID) < 8 || len(input.OperationID) > 128 {
		return ReplaceAgentDocumentBodyResult{}, ErrInvalidInput
	}
	content, err := io.ReadAll(io.LimitReader(input.Content, (1<<20)+1))
	if err != nil {
		return ReplaceAgentDocumentBodyResult{}, err
	}
	if len(content) == 0 || len(content) > 1<<20 || !utf8.Valid(content) {
		return ReplaceAgentDocumentBodyResult{}, ErrInvalidInput
	}
	var operation any
	switch input.Format {
	case "", "html":
		operation = map[string]string{"kind": "replace_body_html", "html": string(content)}
	case "blocks":
		var parsed struct {
			SchemaVersion int              `json:"schema_version"`
			Blocks        []map[string]any `json:"blocks"`
		}
		decoder := json.NewDecoder(bytes.NewReader(content))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&parsed); err != nil || parsed.SchemaVersion != 1 || !validSemanticBlocks(parsed.Blocks, true) {
			return ReplaceAgentDocumentBodyResult{}, ErrInvalidInput
		}
		if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
			return ReplaceAgentDocumentBodyResult{}, ErrInvalidInput
		}
		operation = map[string]any{"kind": "replace_body_blocks", "blocks": parsed.Blocks}
	default:
		return ReplaceAgentDocumentBodyResult{}, ErrInvalidInput
	}
	change, err := json.Marshal([]any{operation})
	if err != nil {
		return ReplaceAgentDocumentBodyResult{}, err
	}
	result, err := s.ApplySemanticMutation(ctx, ApplySemanticMutationInput{
		Principal: input.Principal, TargetKind: "document", TargetID: input.DocumentID, DocumentID: input.DocumentID,
		SourceInvocationID: "cli-replace:" + input.OperationID, SchemaVersion: "blocknote-semantic-v1",
		ExpectedRevisionID: input.BaseRevisionID, SemanticChange: change,
	})
	if err != nil {
		return ReplaceAgentDocumentBodyResult{}, err
	}
	if result.Status == SemanticMutationConflicted {
		return ReplaceAgentDocumentBodyResult{}, ErrVersionConflict
	}
	digest := sha256.Sum256(content)
	return ReplaceAgentDocumentBodyResult{SemanticMutationResult: result, SHA256: hex.EncodeToString(digest[:])}, nil
}
