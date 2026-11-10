package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"regexp"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

type SemanticMutationStatus string

var semanticBlockIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

const (
	SemanticMutationApplied    SemanticMutationStatus = "applied"
	SemanticMutationConflicted SemanticMutationStatus = "conflicted"
)

type ApplySemanticMutationInput struct {
	Principal                                     *agentcredential.Principal
	TargetKind, TargetID                          string
	DocumentID, SourceInvocationID, SchemaVersion string
	ExpectedRevisionID                            string
	SemanticChange                                json.RawMessage
}

type SemanticMutationResult struct {
	SemanticMutationID, RevisionID, HistoryEntryID, ConflictReason string
	Status                                                         SemanticMutationStatus
	Replayed                                                       bool
}

// semanticAdmission is what the transaction that authorizes a semantic
// mutation learns before the Runtime applies it.
type semanticAdmission struct {
	MutationID, TenantID, DocumentID, AgentActorID, CurrentTitle string
	ExpectedSeq                                                  *int64
	AllowedAssetIDs                                              []string
}

const semanticMutationOperation = "document.semantic_mutation"

// ApplySemanticMutation applies an Agent's semantic change to a native
// Document: TeamHub authorizes it, the Runtime applies and saves it, and
// TeamHub records the History point and the replay in the transaction that
// authorized it. The Runtime being unavailable fails the request; the Agent
// retries.
func (s *Service) ApplySemanticMutation(
	ctx context.Context,
	input ApplySemanticMutationInput,
) (SemanticMutationResult, error) {
	canonical, requestHash, err := validateSemanticMutationInput(input)
	if err != nil || s == nil || s.pool == nil {
		return SemanticMutationResult{}, ErrInvalidInput
	}
	if s.runtime == nil {
		return SemanticMutationResult{}, ErrRuntimeUnavailable
	}
	input.SemanticChange = canonical
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return SemanticMutationResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	key := idempotency.AgentKey(input.Principal.AgentActorID, semanticMutationOperation, input.SourceInvocationID)
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return SemanticMutationResult{}, err
	}
	if replay, found, err := semanticMutationReplay(ctx, tx, key, requestHash[:]); err != nil || found {
		return replay, err
	}
	admission, err := admitPrincipalSemanticAuthority(ctx, tx, input)
	if err != nil {
		return SemanticMutationResult{}, err
	}
	admission.MutationID = stableHistoryID("document_semantic_mutation_", admission.AgentActorID, 0, input.SourceInvocationID)
	applied, err := s.runtime.Apply(ctx, ApplyRequest{
		DocumentID: admission.DocumentID, OperationID: admission.MutationID,
		ActorID: admission.AgentActorID, ExpectedSeq: admission.ExpectedSeq,
		Semantic: &SemanticChange{
			SchemaVersion: input.SchemaVersion, CurrentTitle: admission.CurrentTitle,
			AllowedAssetIDs: admission.AllowedAssetIDs, Operations: input.SemanticChange,
		},
	})
	if err != nil {
		return SemanticMutationResult{}, err
	}
	if !applied.Applied && applied.ConflictReason == "stale_head" {
		return SemanticMutationResult{}, ErrVersionConflict
	}
	if !applied.Applied {
		// A conflict changed nothing; a retry evaluates the body again.
		return SemanticMutationResult{
			SemanticMutationID: admission.MutationID, Status: SemanticMutationConflicted,
			ConflictReason: applied.ConflictReason,
		}, nil
	}
	if applied.Title == "" || len(applied.Title) > 255 {
		return SemanticMutationResult{}, ErrRuntimeResultInvalid
	}
	if applied.Title != admission.CurrentTitle {
		if err := setDocumentTitleTx(ctx, tx, admission.TenantID, admission.DocumentID,
			admission.AgentActorID, applied.Title); err != nil {
			return SemanticMutationResult{}, err
		}
	}
	historyID, err := recordHistoryPointTx(ctx, tx, admission.DocumentID, "agent_edit")
	if err != nil {
		return SemanticMutationResult{}, err
	}
	result := SemanticMutationResult{
		SemanticMutationID: admission.MutationID, Status: SemanticMutationApplied,
		RevisionID: historyID, HistoryEntryID: historyID,
	}
	body, err := json.Marshal(result)
	if err != nil {
		return SemanticMutationResult{}, err
	}
	if err := idempotency.Save(ctx, tx, key, requestHash[:], idempotency.Record{
		ResourceID: admission.DocumentID, Status: 200, Body: body,
		CredentialID: input.Principal.CredentialID,
	}); err != nil {
		return SemanticMutationResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return SemanticMutationResult{}, err
	}
	return result, nil
}

func semanticMutationReplay(ctx context.Context, tx pgx.Tx, key idempotency.Key, requestHash []byte,
) (SemanticMutationResult, bool, error) {
	record, found, err := idempotency.Lookup(ctx, tx, key, requestHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return SemanticMutationResult{}, false, ErrIdempotencyConflict
	}
	if err != nil || !found {
		return SemanticMutationResult{}, false, err
	}
	var result SemanticMutationResult
	if err := json.Unmarshal(record.Body, &result); err != nil {
		return SemanticMutationResult{}, false, err
	}
	result.Replayed = true
	return result, true, nil
}

func validateSemanticMutationInput(input ApplySemanticMutationInput) (json.RawMessage, [sha256.Size]byte, error) {
	var zero [sha256.Size]byte
	if input.Principal == nil || input.SourceInvocationID == "" || input.DocumentID == "" ||
		len(input.SourceInvocationID) > 255 || input.SchemaVersion != "blocknote-semantic-v1" ||
		len(input.SemanticChange) == 0 || len(input.SemanticChange) > semanticInputLimit(input) {
		return nil, zero, ErrInvalidInput
	}
	var operations []json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(input.SemanticChange))
	if err := decoder.Decode(&operations); err != nil || len(operations) < 1 || len(operations) > 64 {
		return nil, zero, ErrInvalidInput
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, zero, ErrInvalidInput
	}
	for _, operation := range operations {
		var kind struct {
			Kind string `json:"kind"`
		}
		// Pre-check only: a malformed operation leaves kind empty and is rejected by the full decode below.
		_ = json.Unmarshal(operation, &kind)
		if kind.Kind == "edit_document" && (len(operations) != 1 || input.DocumentID == "") {
			return nil, zero, ErrInvalidInput
		}
		if (kind.Kind == "replace_body_html" || kind.Kind == "replace_body_blocks") && (input.ExpectedRevisionID == "" || len(operations) != 1) {
			return nil, zero, ErrInvalidInput
		}
		if err := validateSemanticOperation(operation); err != nil {
			return nil, zero, err
		}
	}
	canonical, err := json.Marshal(operations)
	if err != nil || len(canonical) > semanticInputLimit(input) {
		return nil, zero, ErrInvalidInput
	}
	hash := sha256.New()
	requestContext := "agent:" + input.Principal.AgentActorID + ":" + input.TargetKind + ":" + input.TargetID
	_, _ = hash.Write([]byte(requestContext + "\x00" + input.DocumentID + "\x00" + input.SchemaVersion + "\x00"))
	if input.ExpectedRevisionID != "" {
		_, _ = hash.Write([]byte(input.ExpectedRevisionID + "\x00"))
	}
	_, _ = hash.Write(canonical)
	var requestHash [sha256.Size]byte
	copy(requestHash[:], hash.Sum(nil))
	return canonical, requestHash, nil
}

func semanticInputLimit(input ApplySemanticMutationInput) int {
	if input.ExpectedRevisionID != "" {
		return 8 << 20
	}
	return 262144
}

func validateSemanticOperation(value json.RawMessage) error {
	var discriminator struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(value, &discriminator); err != nil {
		return ErrInvalidInput
	}
	switch discriminator.Kind {
	case "edit_document":
		return validateNativeEditOperation(value)
	case "replace_body_blocks":
		var operation struct {
			Kind   string           `json:"kind"`
			Blocks []map[string]any `json:"blocks"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil || !validSemanticBlocks(operation.Blocks, true) {
			return ErrInvalidInput
		}
		blocks, err := json.Marshal(operation.Blocks)
		if err != nil || len(blocks) > 1<<20 {
			return ErrInvalidInput
		}
	case "replace_body_html":
		var operation struct {
			Kind string `json:"kind"`
			HTML string `json:"html"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil || len(operation.HTML) == 0 || len(operation.HTML) > 1<<20 {
			return ErrInvalidInput
		}
	case "set_title":
		var operation struct {
			Kind  string `json:"kind"`
			Title string `json:"title"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil ||
			operation.Kind != "set_title" || len(operation.Title) < 1 || len(operation.Title) > 255 {
			return ErrInvalidInput
		}
	case "append_blocks":
		var operation struct {
			Kind   string           `json:"kind"`
			Blocks []map[string]any `json:"blocks"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil || !validSemanticBlocks(operation.Blocks, true) {
			return ErrInvalidInput
		}
	case "insert_blocks":
		var operation struct {
			Kind          string           `json:"kind"`
			Position      string           `json:"position"`
			StableBlockID string           `json:"stable_block_id"`
			Blocks        []map[string]any `json:"blocks"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil ||
			operation.Kind != "insert_blocks" || (operation.Position != "before" && operation.Position != "after") ||
			!validSemanticReferenceID(operation.StableBlockID) || !validSemanticBlocks(operation.Blocks, true) {
			return ErrInvalidInput
		}
	case "replace_blocks":
		var operation struct {
			Kind           string           `json:"kind"`
			StableBlockIDs []string         `json:"stable_block_ids"`
			Blocks         []map[string]any `json:"blocks"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil ||
			operation.Kind != "replace_blocks" || !validSemanticReferenceIDs(operation.StableBlockIDs) ||
			!validSemanticBlocks(operation.Blocks, false) {
			return ErrInvalidInput
		}
	case "update_block":
		var operation struct {
			Kind          string         `json:"kind"`
			StableBlockID string         `json:"stable_block_id"`
			Block         map[string]any `json:"block"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil ||
			operation.Kind != "update_block" || !validSemanticReferenceID(operation.StableBlockID) || !validSemanticBlocks([]map[string]any{operation.Block}, true) {
			return ErrInvalidInput
		}
	case "delete_blocks":
		var operation struct {
			Kind           string   `json:"kind"`
			StableBlockIDs []string `json:"stable_block_ids"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil ||
			operation.Kind != "delete_blocks" || !validSemanticReferenceIDs(operation.StableBlockIDs) {
			return ErrInvalidInput
		}
	case "replace_comment_text":
		var operation struct {
			Kind        string `json:"kind"`
			ThreadID    string `json:"thread_id"`
			Replacement string `json:"replacement"`
		}
		if err := decodeStrictSemanticOperation(value, &operation); err != nil ||
			operation.Kind != "replace_comment_text" || !validSemanticReferenceID(operation.ThreadID) ||
			len(operation.Replacement) < 1 || len(operation.Replacement) > 50000 {
			return ErrInvalidInput
		}
	default:
		return ErrInvalidInput
	}
	return nil
}

func decodeStrictSemanticOperation(value []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return ErrInvalidInput
	}
	return nil
}

func validSemanticReferenceID(value string) bool {
	return len(value) >= 1 && len(value) <= 255
}

func validSemanticReferenceIDs(values []string) bool {
	if len(values) < 1 || len(values) > 2048 {
		return false
	}
	for _, value := range values {
		if !validSemanticReferenceID(value) {
			return false
		}
	}
	return true
}

func validSemanticBlocks(blocks []map[string]any, requireNonempty bool) bool {
	if blocks == nil || len(blocks) > 2048 || (requireNonempty && len(blocks) == 0) {
		return false
	}
	pending := append([]map[string]any{}, blocks...)
	seen := make(map[string]bool)
	for len(pending) > 0 {
		block := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		id, ok := block["id"].(string)
		if !ok || !semanticBlockIDPattern.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
		if children, exists := block["children"]; exists {
			items, ok := children.([]any)
			if !ok {
				return false
			}
			for _, item := range items {
				child, ok := item.(map[string]any)
				if !ok {
					return false
				}
				pending = append(pending, child)
			}
		}
	}
	return true
}

// semanticChangeAsset returns the Asset a single image or file edit places,
// and whether it must be an image.
func semanticChangeAsset(change json.RawMessage) (string, bool) {
	var operations []json.RawMessage
	if json.Unmarshal(change, &operations) != nil || len(operations) != 1 {
		return "", false
	}
	return nativeEditAsset(operations[0])
}

func isDocumentSerializationFailure(err error) bool {
	var postgresError *pgconn.PgError
	return errors.As(err, &postgresError) && postgresError.Code == "40001"
}
