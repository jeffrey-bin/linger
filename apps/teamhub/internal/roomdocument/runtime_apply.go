package roomdocument

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

const applyTimeout = 30 * time.Second

// Apply asks the Runtime to apply one authorized change to a Document's body
// and waits until the body is saved and broadcast, or the change conflicted.
func (r *HTTPRuntime) Apply(ctx context.Context, input document.ApplyRequest) (document.ApplyResult, error) {
	if !validDocumentSessionID(input.DocumentID) || !validDocumentSessionID(input.OperationID) ||
		!validDocumentSessionID(input.ActorID) || (input.ExpectedSeq != nil && *input.ExpectedSeq < 0) {
		return document.ApplyResult{}, ErrInvalidState
	}
	change, err := wireDocumentChange(input)
	if err != nil {
		return document.ApplyResult{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, applyTimeout)
	defer cancel()
	response, err := r.client.ApplyDocumentChange(ctx, input.DocumentID, nodeservicesinternal.ApplyDocumentChangeRequest{
		OperationId: input.OperationID, ActorId: input.ActorID,
		ExpectedSeq: input.ExpectedSeq, Change: change,
	})
	if err != nil {
		return document.ApplyResult{}, fmt.Errorf("%w: call Document Runtime apply: %w", ErrRuntimeUnavailable, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return document.ApplyResult{}, runtimeFailure(response)
	}
	var result nodeservicesinternal.ApplyDocumentChangeResult
	if err := decodeRuntimeResponse(response.Body, &result); err != nil {
		return document.ApplyResult{}, err
	}
	return validateApplyResult(result)
}

func wireDocumentChange(input document.ApplyRequest) (nodeservicesinternal.DocumentChange, error) {
	var change nodeservicesinternal.DocumentChange
	var err error
	switch {
	case input.Semantic != nil && input.Restore == nil && input.CommentAnchor == nil:
		var operations nodeservicesinternal.DocumentSemanticOperations
		decoder := json.NewDecoder(bytes.NewReader(input.Semantic.Operations))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&operations) != nil || rejectTrailingJSON(decoder) != nil ||
			len(operations) < 1 || len(operations) > 64 ||
			!validReferenceIDs(input.Semantic.AllowedAssetIDs) {
			return change, ErrInvalidState
		}
		err = change.FromSemanticDocumentChange(nodeservicesinternal.SemanticDocumentChange{
			Kind: "semantic", SchemaVersion: input.Semantic.SchemaVersion,
			CurrentTitle:            input.Semantic.CurrentTitle,
			AllowedDocumentAssetIds: append([]string{}, input.Semantic.AllowedAssetIDs...),
			Operations:              operations,
		})
	case input.Restore != nil && input.Semantic == nil && input.CommentAnchor == nil:
		if len(input.Restore.TargetStateBytes) > 32<<20 {
			return change, ErrInvalidState
		}
		err = change.FromRestoreDocumentChange(nodeservicesinternal.RestoreDocumentChange{
			Kind:                   "restore",
			TargetStateBytes:       base64.StdEncoding.EncodeToString(input.Restore.TargetStateBytes),
			TargetStateBytesSha256: bytesHash(input.Restore.TargetStateBytes),
		})
	case input.CommentAnchor != nil && input.Semantic == nil && input.Restore == nil:
		anchor := input.CommentAnchor
		err = change.FromCommentAnchorDocumentChange(nodeservicesinternal.CommentAnchorDocumentChange{
			Kind: "comment_anchor", ThreadId: anchor.ThreadID, QuotedText: anchor.QuotedText,
			BlockId: anchor.BlockID, ContextBefore: anchor.ContextBefore, ContextAfter: anchor.ContextAfter,
		})
	default:
		return change, ErrInvalidState
	}
	return change, err
}

func validateApplyResult(result nodeservicesinternal.ApplyDocumentChangeResult) (document.ApplyResult, error) {
	discriminator, err := result.Discriminator()
	if err != nil {
		return document.ApplyResult{}, ErrInvalidState
	}
	switch discriminator {
	case "conflicted":
		conflict, err := result.AsConflictedDocumentChangeResult()
		if err != nil || !conflict.Reason.Valid() {
			return document.ApplyResult{}, ErrInvalidState
		}
		return document.ApplyResult{ConflictReason: string(conflict.Reason)}, nil
	case "applied":
		applied, err := result.AsAppliedDocumentChangeResult()
		references := applied.CompleteReferences
		if err != nil || applied.Seq < 1 || !sha256Pattern.MatchString(applied.StateHash) ||
			len(applied.Title) > 255 || !validReferenceIDs(references.DocumentAssetIds) ||
			!validReferenceIDs(references.DocumentThreadIds) ||
			len(references.DocumentAssetIds)+len(references.DocumentThreadIds) > 4096 {
			return document.ApplyResult{}, ErrInvalidState
		}
		return document.ApplyResult{
			Applied: true, Seq: applied.Seq, StateHash: applied.StateHash, Title: applied.Title,
			CompleteAssetIDs:  slices.Clone(references.DocumentAssetIds),
			CompleteThreadIDs: slices.Clone(references.DocumentThreadIds),
		}, nil
	}
	return document.ApplyResult{}, ErrInvalidState
}
