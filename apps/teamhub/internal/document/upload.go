package document

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
)

type UploadDocumentInput struct {
	AccountID, TenantID, IdempotencyKey       string
	ParentID                                  *string
	Filename, RepresentationFormat, MediaType string
	Content                                   io.Reader
}

type UploadDocumentResult struct {
	Document Document
	Replayed bool
}

type UploadDocumentContextInput struct {
	UploadDocumentInput
	Kind      string
	ContextID string
	TenantID  string
}

type uploadDocumentTarget struct {
	Kind, ContextID, TenantID string
}

const (
	uploadDocumentOperation     = "document.upload"
	uploadRoomDocumentOperation = "document.upload.room"
	uploadTaskDocumentOperation = "document.upload.task"
	uploadWikiDocumentOperation = "document.upload.wiki"
	uploadDocumentContextRoom   = "room"
	uploadDocumentContextTask   = "task"
	uploadDocumentContextWiki   = "wiki"
)

func (s *Service) Upload(
	ctx context.Context,
	input UploadDocumentInput,
) (result UploadDocumentResult, err error) {
	return s.upload(ctx, input, uploadDocumentTarget{})
}

func (s *Service) UploadToContext(
	ctx context.Context,
	input UploadDocumentContextInput,
) (UploadDocumentResult, error) {
	if (input.Kind != uploadDocumentContextRoom && input.Kind != uploadDocumentContextTask &&
		input.Kind != uploadDocumentContextWiki) ||
		(input.Kind == uploadDocumentContextWiki && (input.ContextID != "" || input.TenantID == "")) ||
		(input.Kind != uploadDocumentContextWiki && (input.ContextID == "" || input.TenantID != "")) ||
		(input.Kind != uploadDocumentContextWiki && input.ParentID != nil) {
		return UploadDocumentResult{}, ErrInvalidInput
	}
	return s.upload(ctx, input.UploadDocumentInput, uploadDocumentTarget{
		Kind: input.Kind, ContextID: input.ContextID, TenantID: input.TenantID,
	})
}

func (s *Service) upload(
	ctx context.Context,
	input UploadDocumentInput,
	target uploadDocumentTarget,
) (result UploadDocumentResult, err error) {
	if target.Kind == "" {
		target.TenantID = strings.TrimSpace(input.TenantID)
	}
	input.Filename = strings.TrimSpace(input.Filename)
	input.RepresentationFormat = strings.TrimSpace(input.RepresentationFormat)
	input.MediaType = strings.TrimSpace(input.MediaType)
	if input.AccountID == "" || len(input.IdempotencyKey) < 8 || len(input.IdempotencyKey) > 128 ||
		input.Content == nil || input.Filename == "" || len(input.Filename) > 255 ||
		input.RepresentationFormat == "" || len(input.RepresentationFormat) > 120 ||
		input.MediaType == "" || len(input.MediaType) > 255 ||
		(input.ParentID != nil && *input.ParentID == "") || (target.Kind == "" && target.TenantID == "") {
		return UploadDocumentResult{}, ErrInvalidInput
	}
	preflightTenantID, _, preflightContextID, preflightErr := resolveUploadOwner(
		ctx, s.pool, input.AccountID, input.ParentID, target,
	)
	if preflightErr != nil {
		return UploadDocumentResult{}, preflightErr
	}
	target.TenantID = preflightTenantID
	if target.Kind != "" {
		target.ContextID = preflightContextID
	}
	// Wiki sources are frozen exact Versions. Native BlockNote conversion would
	// leave current_version_id empty, so refresh would treat a new .md upload as
	// already_latest and skip generation.
	native := input.RepresentationFormat == "markdown" &&
		target.Kind != uploadDocumentContextWiki
	markdownImport := false
	if native {
		source, readErr := io.ReadAll(io.LimitReader(input.Content, MaxImportBytes+1))
		if readErr != nil || len(source) > MaxImportBytes || !utf8.Valid(source) {
			return UploadDocumentResult{}, ErrInvalidInput
		}
		prepared, prepareErr := PrepareImport(source)
		if prepareErr != nil {
			return UploadDocumentResult{}, markdownError(prepareErr)
		}
		markdownImport = len(prepared.Assets) > 0
		native = !markdownImport
		input.Content = bytes.NewReader(source)
	}
	var object artifactstore.Object
	var computed ImportedState
	if native {
		source, readErr := io.ReadAll(io.LimitReader(input.Content, (16<<20)+1))
		if readErr != nil || len(source) > 16<<20 || !utf8.Valid(source) {
			return UploadDocumentResult{}, ErrInvalidInput
		}
		object.Size = int64(len(source))
		object.SHA256 = sha256.Sum256(source)
		requestHash := uploadDocumentRequestHash(input, target, object)
		if replay, found, replayErr := s.lookupUploadReplay(ctx, input, uploadOperation(target.Kind), requestHash); replayErr != nil || found {
			return replay, replayErr
		}
		if s.runtime == nil {
			return UploadDocumentResult{}, ErrRuntimeUnavailable
		}
		contentSHA256 := hex.EncodeToString(object.SHA256[:])
		materializationID := uuid.NewSHA1(uuid.NameSpaceOID, []byte(strings.Join([]string{
			input.AccountID, target.TenantID, uploadOperation(target.Kind), target.ContextID,
			input.IdempotencyKey, input.RepresentationFormat, contentSHA256,
		}, "\x00"))).String()
		var materializeErr error
		computed, materializeErr = s.runtime.Import(ctx, ImportRequest{
			OperationID: materializationID, SourceKind: importMarkdown, SourceBytes: source,
		})
		if materializeErr != nil {
			return UploadDocumentResult{}, materializeErr
		}
		if !validBlankMaterialization(computed) {
			return UploadDocumentResult{}, ErrRuntimeResultInvalid
		}
		if budgetErr := requireStateBundleBudget(
			computed.StateBytes,
			computed.StateVector,
			computed.CompleteAssetIDs,
			computed.CompleteThreadIDs,
		); budgetErr != nil {
			return UploadDocumentResult{}, budgetErr
		}
	} else {
		if s.objects == nil {
			return UploadDocumentResult{}, ErrObjectStoreUnavailable
		}
		var putErr error
		object, putErr = s.objects.Put(ctx, input.Content)
		if putErr != nil {
			return UploadDocumentResult{}, errors.Join(ErrObjectStoreUnavailable, putErr)
		}
		if object.Key == "" || len(object.Key) > 255 || object.Size < 0 {
			if cleanupErr := artifactstore.DeleteDetached(ctx, s.objects, object.Key); cleanupErr != nil {
				return UploadDocumentResult{}, errors.Join(ErrObjectStoreUnavailable, cleanupErr)
			}
			return UploadDocumentResult{}, ErrObjectStoreUnavailable
		}
	}
	keepObject := false
	defer func() {
		if keepObject {
			return
		}
		if object.Key != "" {
			if cleanupErr := artifactstore.DeleteDetached(ctx, s.objects, object.Key); cleanupErr != nil {
				err = errors.Join(err, cleanupErr)
			}
		}
	}()

	operation := uploadOperation(target.Kind)
	requestHash := uploadDocumentRequestHash(input, target, object)
	connection, unlockUploader, lockErr := s.lockUploader(ctx, input.AccountID)
	if lockErr != nil {
		return UploadDocumentResult{}, lockErr
	}
	commitUpload := func() (committed UploadDocumentResult, created bool, err error) {
		tx, beginErr := connection.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
		if beginErr != nil {
			return UploadDocumentResult{}, false, beginErr
		}
		defer func() { _ = tx.Rollback(ctx) }()
		if lockErr := idempotency.Lock(ctx, tx, idempotency.AccountKey(input.AccountID, operation, input.IdempotencyKey)); lockErr != nil {
			return UploadDocumentResult{}, false, lockErr
		}
		var tenantID, actorID string
		if target.Kind != "" {
			var resolvedContextID string
			tenantID, actorID, resolvedContextID, err = resolveUploadOwner(
				ctx, tx, input.AccountID, input.ParentID, target,
			)
			if err == nil && target.Kind == uploadDocumentContextWiki {
				// Uploading a Human's first source creates the Wiki root.
				resolvedContextID, err = EnsurePersonalWikiRoot(ctx, tx, tenantID, actorID)
			}
			if err != nil {
				return UploadDocumentResult{}, false, err
			}
			target.ContextID = resolvedContextID
		}
		if replay, found, replayErr := lookupUploadReplayTx(ctx, tx, input, operation, requestHash); replayErr != nil || found {
			if replayErr != nil {
				return UploadDocumentResult{}, false, replayErr
			}
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return UploadDocumentResult{}, false, commitErr
			}
			return replay, false, nil
		}
		if target.Kind == "" {
			var ownerErr error
			tenantID, actorID, _, ownerErr = resolveUploadOwner(ctx, tx, input.AccountID, input.ParentID, target)
			if ownerErr != nil {
				return UploadDocumentResult{}, false, ownerErr
			}
		}
		if input.ParentID != nil {
			if _, parentErr := getPersonalPlacement(ctx, tx, input.AccountID, *input.ParentID, true); parentErr != nil {
				return UploadDocumentResult{}, false, parentErr
			}
		}
		documentID, versionID := uploadDocumentIdentity(actorID, target.Kind, input.IdempotencyKey, object.SHA256)
		documentFormat := input.RepresentationFormat
		documentTitle := input.Filename
		var nativeFormat any
		if native {
			documentFormat = "blocknote"
			nativeFormat = input.RepresentationFormat
			extension := filepath.Ext(input.Filename)
			if base := strings.TrimSuffix(input.Filename, extension); base != "" {
				documentTitle = base
			}
		}
		if _, insertErr := tx.Exec(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,native_representation_format,owner_actor_id,owner_actor_kind,creator_actor_id,
			creator_actor_kind,status
		) VALUES($1,$2,$3,$4,$5,$6,'human',$6,'human','active')`, documentID, tenantID,
			documentTitle, documentFormat, nativeFormat, actorID); insertErr != nil {
			return UploadDocumentResult{}, false, insertErr
		}
		resourceID, resourceKind := versionID, "document_version"
		if native {
			revisionID := stableCreateID("document_revision_", documentID, hex.EncodeToString(object.SHA256[:]))
			assetManifest, marshalErr := json.Marshal([]any{})
			if marshalErr != nil {
				return UploadDocumentResult{}, false, marshalErr
			}
			if _, insertErr := tx.Exec(ctx, `INSERT INTO document_revisions(
				id,tenant_id,document_id,persisted_seq,state_vector,full_state_fingerprint,
				state_status,state_bytes,state_bytes_sha256,asset_manifest,thread_manifest,created_by_actor_id
			) VALUES($1,$2,$3,0,$4,$5,'available',$6,$7,$8,$9,$10)`, revisionID, tenantID,
				documentID, computed.StateVector, computed.FullStateFingerprint, computed.StateBytes,
				computed.StateBytesSHA256, assetManifest, computed.CompleteThreadIDs, actorID); insertErr != nil {
				return UploadDocumentResult{}, false, insertErr
			}
			if insertErr := insertBodyTx(ctx, tx, documentID, computed.StateBytes, computed.StateVector,
				nil, computed.CompleteThreadIDs, actorID); insertErr != nil {
				return UploadDocumentResult{}, false, insertErr
			}
			resourceID, resourceKind = documentID, "document"
		} else if _, insertErr := tx.Exec(ctx, `INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,media_type,
			size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'ordinary_upload',$10)`, versionID, tenantID,
			documentID, input.Filename, input.RepresentationFormat, input.MediaType, object.Size,
			hex.EncodeToString(object.SHA256[:]), object.Key, actorID); insertErr != nil {
			return UploadDocumentResult{}, false, insertErr
		}
		if markdownImport {
			if insertErr := startNativeImportTx(ctx, tx, tenantID, documentID, versionID, false); insertErr != nil {
				return UploadDocumentResult{}, false, insertErr
			}
			if insertErr := enqueueNativeImportMigrationTx(ctx, tx, documentID); insertErr != nil {
				return UploadDocumentResult{}, false, insertErr
			}
		}
		if !native {
			command, updateErr := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2,updated_at=GREATEST(updated_at,clock_timestamp())
			WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`, documentID, versionID, tenantID)
			if updateErr != nil {
				return UploadDocumentResult{}, false, updateErr
			}
			if command.RowsAffected() != 1 {
				return UploadDocumentResult{}, false, ErrConflict
			}
		}
		if insertErr := insertPersonalDocumentPlacement(
			ctx, tx, tenantID, actorID, documentID, input.ParentID,
		); insertErr != nil {
			return UploadDocumentResult{}, false, insertErr
		}
		if target.Kind != "" {
			bindingKind := target.Kind
			var roomID, workItemID, wikiID any
			switch target.Kind {
			case uploadDocumentContextRoom:
				roomID = target.ContextID
			case uploadDocumentContextTask:
				workItemID = target.ContextID
			case uploadDocumentContextWiki:
				wikiID = target.ContextID
				bindingKind = "wiki_source"
			}
			bindingID := stableCreateID("document_binding_", documentID, bindingKind, target.ContextID)
			if _, insertErr := tx.Exec(ctx, `INSERT INTO document_context_bindings(
				id,tenant_id,document_id,binding_kind,room_id,work_item_id,wiki_id,status
			) VALUES($1,$2,$3,$4,$5,$6,$7,'active')`, bindingID, tenantID, documentID,
				bindingKind, roomID, workItemID, wikiID); insertErr != nil {
				return UploadDocumentResult{}, false, insertErr
			}
		}
		if eventErr := appendLifecycleEvent(ctx, tx, tenantID, documentID, actorID, resourceID, resourceKind, "document.created"); eventErr != nil {
			return UploadDocumentResult{}, false, eventErr
		}
		if insertErr := idempotency.Save(ctx, tx, idempotency.AccountKey(input.AccountID, operation, input.IdempotencyKey), requestHash[:], idempotency.Record{ResourceID: documentID, Status: 201, Body: []byte{}}); insertErr != nil {
			return UploadDocumentResult{}, false, insertErr
		}
		value, getErr := get(ctx, tx, input.AccountID, documentID)
		if getErr != nil {
			return UploadDocumentResult{}, false, getErr
		}
		if commitErr := tx.Commit(ctx); commitErr != nil {
			return UploadDocumentResult{}, true, commitErr
		}
		return UploadDocumentResult{Document: value}, true, nil
	}
	// Uploads by different people that touch the same rows can still fail
	// serializable validation. The transaction has no side effect before commit,
	// so it runs again.
	var committed UploadDocumentResult
	var created bool
	for attempt := 0; attempt < 3; attempt++ {
		committed, created, err = commitUpload()
		if !isDocumentSerializationFailure(err) {
			break
		}
	}
	unlockUploader()
	// A failed commit may still have stored the Version that references the
	// object, so only a serialization failure, which always rolls back, drops it.
	keepObject = created && !native && !isDocumentSerializationFailure(err)
	if err != nil {
		return UploadDocumentResult{}, err
	}
	if !created {
		return committed, nil
	}
	documentID := committed.Document.ID
	if markdownImport {
		worker := NewNativeImportMigrationWorker(s)
		if worked, migrateErr := worker.RunDocument(ctx, documentID); worked && migrateErr == nil {
			if updated, getErr := s.Get(ctx, input.AccountID, documentID); getErr == nil {
				return UploadDocumentResult{Document: updated}, nil
			}
		}
	}
	return committed, nil
}

// lockUploader runs one account's uploads one after another. The session lock
// is taken before the serializable snapshot, so a queued upload sees the rows
// of the one before it instead of failing serializable validation.
func (s *Service) lockUploader(ctx context.Context, accountID string) (*pgxpool.Conn, func(), error) {
	connection, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, nil, err
	}
	if _, err := connection.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended('document-upload:' || $1,0))`, accountID); err != nil {
		discardPoolConnection(connection)
		return nil, nil, err
	}
	return connection, func() {
		unlockContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var unlocked bool
		if err := connection.QueryRow(unlockContext, `SELECT pg_advisory_unlock(
			hashtextextended('document-upload:' || $1,0)
		)`, accountID).Scan(&unlocked); err != nil || !unlocked {
			discardPoolConnection(connection)
			return
		}
		connection.Release()
	}, nil
}

func (s *Service) lookupUploadReplay(
	ctx context.Context,
	input UploadDocumentInput,
	operation string,
	requestHash [sha256.Size]byte,
) (UploadDocumentResult, bool, error) {
	record, found, err := lookupCommandRecord(ctx, s.pool, input.AccountID, operation, input.IdempotencyKey, requestHash[:])
	if err != nil || !found {
		return UploadDocumentResult{}, false, err
	}
	documentID := record.ResourceID
	value, err := s.Get(ctx, input.AccountID, documentID)
	return UploadDocumentResult{Document: value, Replayed: true}, true, err
}

func lookupUploadReplayTx(
	ctx context.Context,
	tx pgx.Tx,
	input UploadDocumentInput,
	operation string,
	requestHash [sha256.Size]byte,
) (UploadDocumentResult, bool, error) {
	record, found, err := lookupCommandRecord(ctx, tx, input.AccountID, operation, input.IdempotencyKey, requestHash[:])
	if err != nil || !found {
		return UploadDocumentResult{}, false, err
	}
	documentID := record.ResourceID
	value, err := get(ctx, tx, input.AccountID, documentID)
	return UploadDocumentResult{Document: value, Replayed: true}, true, err
}

func uploadDocumentRequestHash(
	input UploadDocumentInput,
	target uploadDocumentTarget,
	object artifactstore.Object,
) [sha256.Size]byte {
	parentID := ""
	if input.ParentID != nil {
		parentID = *input.ParentID
	}
	return sha256.Sum256([]byte(strings.Join([]string{
		target.Kind, target.ContextID, target.TenantID, parentID,
		input.Filename, input.RepresentationFormat, input.MediaType,
		hex.EncodeToString(object.SHA256[:]), strconv.FormatInt(object.Size, 10),
	}, "\x00")))
}

func uploadOperation(kind string) string {
	switch kind {
	case uploadDocumentContextRoom:
		return uploadRoomDocumentOperation
	case uploadDocumentContextTask:
		return uploadTaskDocumentOperation
	case uploadDocumentContextWiki:
		return uploadWikiDocumentOperation
	default:
		return uploadDocumentOperation
	}
}

func uploadDocumentIdentity(
	actorID, contextKind, idempotencyKey string,
	contentSHA256 [sha256.Size]byte,
) (documentID, versionID string) {
	documentID = stableCreateID("document_", actorID, uploadOperation(contextKind), idempotencyKey)
	versionID = stableCreateID("document_version_", documentID, hex.EncodeToString(contentSHA256[:]))
	return documentID, versionID
}

func resolveUploadOwner(
	ctx context.Context,
	tx uploadOwnerQuerier,
	accountID string,
	parentID *string,
	target uploadDocumentTarget,
) (string, string, string, error) {
	if target.Kind == "" {
		tenantID, actorID, err := resolveCreateOwner(ctx, tx, accountID, target.TenantID, parentID, "")
		return tenantID, actorID, "", err
	}
	var tenantID, actorID, contextID string
	var err error
	switch target.Kind {
	case uploadDocumentContextRoom:
		err = tx.QueryRow(ctx, `SELECT room.tenant_id,actor.id,room.id
			FROM rooms room
			JOIN actors actor ON actor.tenant_id=room.tenant_id
			 AND actor.account_id=$2 AND actor.kind='human'
			JOIN room_members member ON member.room_id=room.id AND member.actor_id=actor.id
			WHERE room.id=$1 AND room.deletion_started_at IS NULL
			FOR KEY SHARE OF room,member`, target.ContextID, accountID).Scan(&tenantID, &actorID, &contextID)
	case uploadDocumentContextTask:
		err = tx.QueryRow(ctx, `SELECT item.tenant_id,actor.id,item.id
			FROM work_items item
			JOIN actors actor ON actor.tenant_id=item.tenant_id
			 AND actor.account_id=$2 AND actor.kind='human'
				WHERE item.id=$1 AND item.archived_at IS NULL AND item.state<>'resolved'
				FOR KEY SHARE OF item`, target.ContextID, accountID).Scan(&tenantID, &actorID, &contextID)
	case uploadDocumentContextWiki:
		// The Human's Wiki is implied by the tenant, so the request hash does
		// not depend on whether its root exists; the upload transaction
		// creates the root and binds the source to it.
		err = tx.QueryRow(ctx, `SELECT actor.tenant_id,actor.id FROM actors actor
			WHERE actor.tenant_id=$1 AND actor.account_id=$2 AND actor.kind='human'`,
			target.TenantID, accountID).Scan(&tenantID, &actorID)
	default:
		return "", "", "", ErrInvalidInput
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", ErrNotFound
	}
	if err != nil {
		return "", "", "", err
	}
	if parentID != nil {
		var placementID string
		placementErr := tx.QueryRow(ctx, `SELECT id FROM document_placements
			WHERE id=$1 AND tenant_id=$2 AND owner_human_actor_id=$3
			  AND scope_kind='personal' AND node_kind='folder' AND deleted_at IS NULL
			FOR UPDATE`, *parentID, tenantID, actorID).Scan(&placementID)
		if errors.Is(placementErr, pgx.ErrNoRows) {
			return "", "", "", ErrNotFound
		}
		if placementErr != nil {
			return "", "", "", placementErr
		}
	}
	return tenantID, actorID, contextID, nil
}

type uploadOwnerQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}
