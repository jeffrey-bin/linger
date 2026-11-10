package document

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

type CommentTextReplacementResult struct {
	SemanticMutationResult
	CurrentMarkdown       []byte
	CurrentMarkdownSHA256 string
}

type ApplyCommentTextReplacementInput struct {
	Principal          *agentcredential.Principal
	DocumentID         string
	ThreadID           string
	SourceInvocationID string
	Replacement        string
}

// ApplyCommentTextReplacement resolves the current Document entirely on the
// server, then uses the ordinary semantic mutation pipeline so Revision,
// History, idempotency, and Draft-head conflict handling remain atomic.
func (s *Service) ApplyCommentTextReplacement(
	ctx context.Context,
	input ApplyCommentTextReplacementInput,
) (CommentTextReplacementResult, error) {
	if s == nil || s.pool == nil || input.Principal == nil || input.DocumentID == "" || input.ThreadID == "" ||
		input.SourceInvocationID == "" || len(input.Replacement) < 1 || len(input.Replacement) > 50000 {
		return CommentTextReplacementResult{}, ErrInvalidInput
	}
	var authorized bool
	err := s.pool.QueryRow(ctx, `SELECT true FROM room_document_comment_threads WHERE id=$1 AND document_id=$2 AND tenant_id=$3 AND anchor_status='attached' AND resolved_at IS NULL`, input.ThreadID, input.DocumentID, input.Principal.TenantID).Scan(&authorized)
	if errors.Is(err, pgx.ErrNoRows) {
		return CommentTextReplacementResult{}, ErrNotFound
	}
	if err != nil {
		return CommentTextReplacementResult{}, err
	}
	semanticChange, err := json.Marshal([]map[string]string{{
		"kind": "replace_comment_text", "thread_id": input.ThreadID,
		"replacement": input.Replacement,
	}})
	if err != nil {
		return CommentTextReplacementResult{}, err
	}
	mutation, err := s.ApplySemanticMutation(ctx, ApplySemanticMutationInput{
		Principal: input.Principal, TargetKind: "document", TargetID: input.DocumentID,
		DocumentID: input.DocumentID, SourceInvocationID: input.SourceInvocationID,
		SchemaVersion: "blocknote-semantic-v1", SemanticChange: semanticChange,
	})
	if err != nil || mutation.Status != SemanticMutationApplied {
		return CommentTextReplacementResult{SemanticMutationResult: mutation}, err
	}
	markdown, digest, err := s.renderRevisionMarkdown(
		ctx, input.DocumentID, mutation.RevisionID,
	)
	if err != nil {
		return CommentTextReplacementResult{}, err
	}
	return CommentTextReplacementResult{
		SemanticMutationResult: mutation,
		CurrentMarkdown:        markdown, CurrentMarkdownSHA256: digest,
	}, nil
}

func (s *Service) renderRevisionMarkdown(
	ctx context.Context,
	documentID, revisionID string,
) ([]byte, string, error) {
	if s == nil || s.pool == nil || s.runtime == nil || documentID == "" || revisionID == "" {
		return nil, "", ErrInvalidInput
	}
	var plan revisionInputPlan
	var manifestJSON []byte
	err := s.pool.QueryRow(ctx, `SELECT revision.tenant_id,revision.document_id,revision.id,
		revision.persisted_seq,revision.state_vector,revision.full_state_fingerprint,
		revision.state_bytes,revision.state_bytes_sha256,revision.asset_manifest,
		revision.thread_manifest
		FROM document_revisions revision
		JOIN documents document ON document.id=revision.document_id
		 AND document.tenant_id=revision.tenant_id AND document.status='active'
		WHERE revision.document_id=$1 AND revision.id=$2 AND revision.state_status='available'`,
		documentID, revisionID).Scan(
		&plan.TenantID, &plan.DocumentID, &plan.RevisionID, &plan.PersistedSeq,
		&plan.StateVector, &plan.FullStateFingerprint, &plan.StateBytes,
		&plan.StateBytesSHA256, &manifestJSON, &plan.ThreadIDs,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrRevisionUnavailable
	}
	if err != nil {
		return nil, "", err
	}
	if documentBytesHash(plan.StateBytes) != plan.StateBytesSHA256 {
		return nil, "", ErrRevisionUnavailable
	}
	manifest, err := decodeHistoryAssetManifest(manifestJSON)
	if err != nil {
		return nil, "", ErrRevisionUnavailable
	}
	slices.SortFunc(manifest, func(left, right HistoryAsset) int {
		return strings.Compare(left.AssetID, right.AssetID)
	})
	for _, item := range manifest {
		var asset ExportAsset
		err := s.pool.QueryRow(ctx, `SELECT id,filename,media_type,sha256,size_bytes
			FROM document_assets WHERE id=$1 AND tenant_id=$2 AND document_id=$3
			 AND sha256=$4 AND size_bytes=$5 AND status='available'`, item.AssetID,
			plan.TenantID, plan.DocumentID, item.SHA256, item.SizeBytes).Scan(
			&asset.ID, &asset.Filename, &asset.MediaType, &asset.SHA256, &asset.SizeBytes)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, "", ErrRevisionUnavailable
		}
		if err != nil {
			return nil, "", err
		}
		plan.Assets = append(plan.Assets, asset)
	}
	if plan.Assets == nil {
		plan.Assets = []ExportAsset{}
	}
	if plan.ThreadIDs == nil {
		plan.ThreadIDs = []string{}
	}
	assetIDs := make([]string, len(plan.Assets))
	for index := range plan.Assets {
		assetIDs[index] = plan.Assets[index].ID
	}
	result, err := s.runtime.Export(ctx, ExportRuntimeRequest{
		RevisionID: revisionID, RepresentationFormat: "markdown",
		StateBytes: plan.StateBytes, StateBytesSHA256: plan.StateBytesSHA256,
		StateVector: plan.StateVector, FullStateFingerprint: plan.FullStateFingerprint,
		StateHashVersion: 1, AssetManifest: plan.Assets, CompleteAssetIDs: assetIDs,
		CompleteThreadIDs: plan.ThreadIDs, Warnings: []string{},
	})
	if err != nil {
		return nil, "", errors.Join(ErrRuntimeUnavailable, err)
	}
	if !validExportRuntimeResult("markdown", assetIDs, plan.ThreadIDs, result) || !utf8.Valid(result.Bytes) {
		return nil, "", ErrRevisionUnavailable
	}
	digest := sha256.Sum256(result.Bytes)
	return result.Bytes, hex.EncodeToString(digest[:]), nil
}

// revisionInputPlan is one exact Revision rendered to latest Markdown.
type revisionInputPlan struct {
	TenantID, DocumentID, RevisionID       string
	PersistedSeq                           int64
	StateBytes, StateVector                []byte
	StateBytesSHA256, FullStateFingerprint string
	Assets                                 []ExportAsset
	ThreadIDs                              []string
}
