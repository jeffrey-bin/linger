package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"time"

	"github.com/jackc/pgx/v5"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
)

type HistoryEntry struct {
	ID, DocumentID, RevisionID, Trigger string
	PersistedSeq                        int64
	CreatedBy                           Actor
	Contributors                        []Actor
	CreatedAt                           time.Time
}

type ListHistoryInput struct {
	AccountID, DocumentID, Cursor string
	Limit                         int
}

type CreateHistoryCheckpointInput struct {
	AccountID, DocumentID string
}

type HistoryCheckpoint struct {
	ID, DocumentID, Status string
	TargetPersistedSeq     int64
	HistoryEntry           HistoryEntry
}

type HistoryRestoreStatus string

// History restore outcomes.
const (
	HistoryRestoreRestored       HistoryRestoreStatus = "restored"
	HistoryRestoreAlreadyCurrent HistoryRestoreStatus = "already_current"
)

type RestoreHistoryEntryInput struct {
	AccountID, DocumentID, HistoryEntryID string
}

type HistoryRestoreResult struct {
	Status       HistoryRestoreStatus
	HistoryEntry HistoryEntry
}

type HistoryAsset struct {
	AssetID   string `json:"asset_id"`
	SHA256    string `json:"sha256"`
	SizeBytes int64  `json:"size_bytes"`
}

type HistoryContent struct {
	HistoryEntry                           HistoryEntry
	StateBytes, StateVector                []byte
	StateBytesSHA256, FullStateFingerprint string
	AssetManifest                          []HistoryAsset
}

func (s *Service) ListHistory(ctx context.Context, input ListHistoryInput) (Page[HistoryEntry], error) {
	if input.AccountID == "" || input.DocumentID == "" || input.Limit < 1 || input.Limit > 100 {
		return Page[HistoryEntry]{}, ErrInvalidInput
	}
	cursor, err := decodeCursor(input.Cursor, "history", input.AccountID, input.DocumentID)
	if err != nil {
		return Page[HistoryEntry]{}, err
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Page[HistoryEntry]{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := get(ctx, tx, input.AccountID, input.DocumentID); err != nil {
		return Page[HistoryEntry]{}, err
	}
	items, err := listHistoryEntries(ctx, tx, input.DocumentID, cursor, input.Limit+1)
	if err != nil {
		return Page[HistoryEntry]{}, err
	}
	page := Page[HistoryEntry]{Items: items}
	if len(items) > input.Limit {
		page.HasMore = true
		page.Items = items[:input.Limit]
		last := page.Items[len(page.Items)-1]
		page.NextCursor, err = encodeCursor(cursorState{
			Kind: "history", PrincipalHash: principalHash(input.AccountID), Filter: input.DocumentID,
			Updated: last.CreatedAt, ID: last.ID,
		})
		if err != nil {
			return Page[HistoryEntry]{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Page[HistoryEntry]{}, err
	}
	return page, nil
}

func (s *Service) GetHistoryContent(ctx context.Context, accountID, historyEntryID string) (HistoryContent, error) {
	if accountID == "" || historyEntryID == "" {
		return HistoryContent{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return HistoryContent{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var documentID string
	if err := tx.QueryRow(ctx, `SELECT document_id FROM document_revisions
		WHERE id=$1 AND history_trigger IS NOT NULL`, historyEntryID).Scan(&documentID); errors.Is(err, pgx.ErrNoRows) {
		return HistoryContent{}, ErrNotFound
	} else if err != nil {
		return HistoryContent{}, err
	}
	if _, err := get(ctx, tx, accountID, documentID); err != nil {
		return HistoryContent{}, err
	}
	entry, err := getHistoryEntry(ctx, tx, documentID, historyEntryID)
	if err != nil {
		return HistoryContent{}, err
	}
	var content HistoryContent
	var manifestJSON []byte
	err = tx.QueryRow(ctx, `SELECT revision.state_bytes,revision.state_bytes_sha256,
		revision.state_vector,revision.full_state_fingerprint,revision.asset_manifest
		FROM document_revisions revision
		WHERE revision.id=$1 AND revision.state_status='available'`,
		entry.RevisionID).Scan(
		&content.StateBytes, &content.StateBytesSHA256, &content.StateVector,
		&content.FullStateFingerprint, &manifestJSON,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return HistoryContent{}, ErrRevisionUnavailable
	}
	if err != nil {
		return HistoryContent{}, err
	}
	if documentBytesHash(content.StateBytes) != content.StateBytesSHA256 {
		return HistoryContent{}, ErrRevisionUnavailable
	}
	content.AssetManifest, err = decodeHistoryAssetManifest(manifestJSON)
	if err != nil {
		return HistoryContent{}, ErrRevisionUnavailable
	}
	if err := verifyHistoryAssets(ctx, tx, entry.DocumentID, content.AssetManifest); err != nil {
		return HistoryContent{}, err
	}
	content.HistoryEntry = entry
	if err := tx.Commit(ctx); err != nil {
		return HistoryContent{}, err
	}
	return content, nil
}

func decodeHistoryAssetManifest(value []byte) ([]HistoryAsset, error) {
	decoder := json.NewDecoder(bytes.NewReader(value))
	decoder.DisallowUnknownFields()
	var manifest []HistoryAsset
	if err := decoder.Decode(&manifest); err != nil {
		return nil, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return nil, ErrRevisionUnavailable
	}
	if manifest == nil || len(manifest) > 10000 {
		return nil, ErrRevisionUnavailable
	}
	seen := make(map[string]struct{}, len(manifest))
	for _, asset := range manifest {
		decoded, err := hex.DecodeString(asset.SHA256)
		if asset.AssetID == "" || asset.SizeBytes < 0 || err != nil || len(decoded) != sha256.Size ||
			hex.EncodeToString(decoded) != asset.SHA256 {
			return nil, ErrRevisionUnavailable
		}
		if _, duplicate := seen[asset.AssetID]; duplicate {
			return nil, ErrRevisionUnavailable
		}
		seen[asset.AssetID] = struct{}{}
	}
	return manifest, nil
}

func verifyHistoryAssets(ctx context.Context, tx pgx.Tx, documentID string, manifest []HistoryAsset) error {
	for _, asset := range manifest {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM document_assets
			WHERE id=$1 AND document_id=$2 AND sha256=$3 AND size_bytes=$4 AND status='available')`,
			asset.AssetID, documentID, asset.SHA256, asset.SizeBytes).Scan(&exists); err != nil {
			return err
		}
		if !exists {
			return ErrRevisionUnavailable
		}
	}
	return nil
}

// CreateHistoryCheckpoint records a manual History point of the body's
// current state. The checkpoint is the History Entry of that state, so a
// second checkpoint of an unchanged body returns the same entry.
func (s *Service) CreateHistoryCheckpoint(ctx context.Context, input CreateHistoryCheckpointInput) (HistoryCheckpoint, error) {
	if input.AccountID == "" || input.DocumentID == "" {
		return HistoryCheckpoint{}, ErrInvalidInput
	}
	// Read committed: the point also clears the body row's editors, which the
	// Runtime updates on every save, so a serializable checkpoint taken while
	// someone types would fail to serialize.
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return HistoryCheckpoint{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	documentValue, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return HistoryCheckpoint{}, err
	}
	if !documentValue.Capabilities.Write || documentValue.DraftCapability != "write" {
		return HistoryCheckpoint{}, ErrNotFound
	}
	entryID, err := recordHistoryPointTx(ctx, tx, input.DocumentID, "manual")
	if err != nil {
		return HistoryCheckpoint{}, err
	}
	result, err := getHistoryCheckpoint(ctx, tx, input.AccountID, entryID)
	if err != nil {
		return HistoryCheckpoint{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return HistoryCheckpoint{}, err
	}
	return result, nil
}

// RestoreHistoryEntry restores a History Entry's state through the Runtime,
// which replaces the online body and broadcasts it, and then records the
// restored state as a History point. Restoring the current state again
// reports it already current.
func (s *Service) RestoreHistoryEntry(ctx context.Context, input RestoreHistoryEntryInput) (HistoryRestoreResult, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.HistoryEntryID == "" {
		return HistoryRestoreResult{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return HistoryRestoreResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	documentValue, err := get(ctx, tx, input.AccountID, input.DocumentID)
	if err != nil {
		return HistoryRestoreResult{}, err
	}
	if !documentValue.Capabilities.Write || documentValue.DraftCapability != "write" {
		return HistoryRestoreResult{}, ErrNotFound
	}
	entry, err := getHistoryEntry(ctx, tx, input.DocumentID, input.HistoryEntryID)
	if err != nil {
		return HistoryRestoreResult{}, err
	}
	var current *string
	if err := tx.QueryRow(ctx, `SELECT current_document_revision_id($1)`, input.DocumentID).Scan(&current); err != nil {
		return HistoryRestoreResult{}, err
	}
	if current != nil && *current == entry.RevisionID {
		return HistoryRestoreResult{Status: HistoryRestoreAlreadyCurrent, HistoryEntry: entry}, tx.Commit(ctx)
	}
	if s.runtime == nil {
		return HistoryRestoreResult{}, ErrRuntimeUnavailable
	}
	actorID, err := resolveActiveHumanActorTx(ctx, tx, input.AccountID, documentValue.TenantID)
	if err != nil {
		return HistoryRestoreResult{}, err
	}
	var targetStateBytes []byte
	if err := tx.QueryRow(ctx, `SELECT state_bytes FROM document_revisions
		WHERE id=$1 AND document_id=$2 AND state_status='available'`,
		entry.RevisionID, input.DocumentID).Scan(&targetStateBytes); errors.Is(err, pgx.ErrNoRows) {
		return HistoryRestoreResult{}, ErrNotFound
	} else if err != nil {
		return HistoryRestoreResult{}, err
	}
	if _, err := s.runtime.Apply(ctx, ApplyRequest{
		DocumentID: input.DocumentID, ActorID: actorID,
		OperationID: idgen.New("document_history_restore"),
		Restore:     &RestoreChange{TargetStateBytes: targetStateBytes},
	}); err != nil {
		return HistoryRestoreResult{}, err
	}
	resultEntryID, err := recordHistoryPointTx(ctx, tx, input.DocumentID, "restore")
	if err != nil {
		return HistoryRestoreResult{}, err
	}
	resultEntry, err := getHistoryEntry(ctx, tx, input.DocumentID, resultEntryID)
	if err != nil {
		return HistoryRestoreResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return HistoryRestoreResult{}, err
	}
	return HistoryRestoreResult{Status: HistoryRestoreRestored, HistoryEntry: resultEntry}, nil
}

// historyEntrySelectSQL reads History points, which are Revisions with a
// trigger. The creation body at sequence 0 is not a point of its own.
const historyEntrySelectSQL = `SELECT revision.id,revision.document_id,revision.persisted_seq,
		revision.history_trigger,revision.history_recorded_at,revision.history_contributor_ids,
		creator.id,creator.tenant_id,creator.kind,creator.display_name
	FROM document_revisions revision
	JOIN actors creator ON creator.id=revision.created_by_actor_id AND creator.tenant_id=revision.tenant_id
	WHERE revision.document_id=$1 AND revision.history_trigger IS NOT NULL
	  AND NOT (revision.history_trigger='idle' AND revision.persisted_seq=0)`

func listHistoryEntries(ctx context.Context, tx pgx.Tx, documentID string, cursor *cursorState, limit int) ([]HistoryEntry, error) {
	var cursorSeq, cursorCreated, cursorID any
	if cursor != nil {
		var persistedSeq int64
		if err := tx.QueryRow(ctx, `SELECT persisted_seq FROM document_revisions
			WHERE document_id=$1 AND id=$2 AND history_trigger IS NOT NULL`,
			documentID, cursor.ID).Scan(&persistedSeq); errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrInvalidInput
		} else if err != nil {
			return nil, err
		}
		cursorSeq = persistedSeq
		cursorCreated, cursorID = cursor.Updated, cursor.ID
	}
	return queryHistoryEntries(ctx, tx, historyEntrySelectSQL+`
		  AND ($2::bigint IS NULL OR
		       (revision.persisted_seq,revision.history_recorded_at,revision.id)<($2,$3,$4))
		ORDER BY revision.persisted_seq DESC,revision.history_recorded_at DESC,revision.id DESC
		LIMIT $5`, documentID, cursorSeq, cursorCreated, cursorID, limit)
}

func getHistoryEntry(ctx context.Context, tx pgx.Tx, documentID, historyEntryID string) (HistoryEntry, error) {
	items, err := queryHistoryEntries(ctx, tx, historyEntrySelectSQL+` AND revision.id=$2`, documentID, historyEntryID)
	if err != nil {
		return HistoryEntry{}, err
	}
	if len(items) == 0 {
		return HistoryEntry{}, ErrNotFound
	}
	return items[0], nil
}

func queryHistoryEntries(ctx context.Context, tx pgx.Tx, query string, args ...any) ([]HistoryEntry, error) {
	rows, err := tx.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	var items []HistoryEntry
	var contributorIDs [][]string
	for rows.Next() {
		var item HistoryEntry
		var ids []string
		if err := rows.Scan(&item.ID, &item.DocumentID, &item.PersistedSeq,
			&item.Trigger, &item.CreatedAt, &ids, &item.CreatedBy.ID, &item.CreatedBy.TenantID,
			&item.CreatedBy.Kind, &item.CreatedBy.DisplayName); err != nil {
			rows.Close()
			return nil, err
		}
		item.RevisionID = item.ID
		items = append(items, item)
		contributorIDs = append(contributorIDs, ids)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for index := range items {
		items[index].Contributors, err = listHistoryContributors(ctx, tx, items[index].CreatedBy.TenantID,
			contributorIDs[index])
		if err != nil {
			return nil, err
		}
	}
	return items, nil
}

func listHistoryContributors(ctx context.Context, tx pgx.Tx, tenantID string, actorIDs []string) ([]Actor, error) {
	rows, err := tx.Query(ctx, `
		SELECT actor.id,actor.tenant_id,actor.kind,actor.display_name
		FROM actors actor
		WHERE actor.tenant_id=$1 AND actor.id=ANY($2::text[]) ORDER BY actor.id
	`, tenantID, actorIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]Actor, 0, len(actorIDs))
	for rows.Next() {
		var actor Actor
		if err := rows.Scan(&actor.ID, &actor.TenantID, &actor.Kind, &actor.DisplayName); err != nil {
			return nil, err
		}
		items = append(items, actor)
	}
	return items, rows.Err()
}

// getHistoryCheckpoint returns a checkpoint, which is a History Entry the
// caller's tenant can see.
func getHistoryCheckpoint(ctx context.Context, tx pgx.Tx, accountID, entryID string) (HistoryCheckpoint, error) {
	var documentID string
	err := tx.QueryRow(ctx, `
		SELECT revision.document_id FROM document_revisions revision
		JOIN actors principal ON principal.account_id=$1 AND principal.kind='human'
		                     AND principal.tenant_id=revision.tenant_id
		WHERE revision.id=$2 AND revision.history_trigger IS NOT NULL
	`, accountID, entryID).Scan(&documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return HistoryCheckpoint{}, ErrNotFound
	}
	if err != nil {
		return HistoryCheckpoint{}, err
	}
	entry, err := getHistoryEntry(ctx, tx, documentID, entryID)
	if err != nil {
		return HistoryCheckpoint{}, err
	}
	return HistoryCheckpoint{
		ID: entry.ID, DocumentID: documentID, Status: "completed",
		TargetPersistedSeq: entry.PersistedSeq, HistoryEntry: entry,
	}, nil
}

func (s *Service) restoreAssetManifest(
	ctx context.Context, tx pgx.Tx, tenantID, documentID string, assetIDs []string,
) ([]byte, error) {
	rows, err := tx.Query(ctx, `SELECT id,sha256,size_bytes FROM document_assets
		WHERE tenant_id=$1 AND document_id=$2 AND id=ANY($3::text[]) AND status='available'
		ORDER BY id FOR SHARE`, tenantID, documentID, assetIDs)
	if err != nil {
		return nil, err
	}
	type manifestEntry struct {
		AssetID   string `json:"asset_id"`
		SHA256    string `json:"sha256"`
		SizeBytes int64  `json:"size_bytes"`
	}
	manifest := make([]manifestEntry, 0, len(assetIDs))
	for rows.Next() {
		var entry manifestEntry
		if err := rows.Scan(&entry.AssetID, &entry.SHA256, &entry.SizeBytes); err != nil {
			rows.Close()
			return nil, err
		}
		manifest = append(manifest, entry)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(manifest) != len(assetIDs) {
		return nil, ErrInvalidInput
	}
	return json.Marshal(manifest)
}
