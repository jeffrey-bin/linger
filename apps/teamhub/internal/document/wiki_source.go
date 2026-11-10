package document

import (
	"bytes"
	"context"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
)

// Imported mail feeds the Wiki without becoming pages the Human wrote, so it
// stays out of the owned and unfiled lists. This condition expects a
// documents row aliased document.
const excludeWikiSourceItemsSQL = `
 AND NOT EXISTS (
   SELECT 1 FROM wiki_source_items item
   WHERE item.tenant_id=document.tenant_id AND item.document_id=document.id
 )`

// UpsertWikiSourceInput is one imported mail message.
type UpsertWikiSourceInput struct {
	TenantID, OwnerActorID, SourceKey, Filename string
	Content                                     []byte
}

type UpsertWikiSourceResult struct {
	DocumentID, VersionID, WikiID string
	Changed                       bool
}

// Mail sources keep these stable ID prefixes, so a message keeps its
// Document and Binding identity across Versions.
const (
	mailSourceDocumentPrefix = "document_onboarding_wiki_"
	mailSourceVersionPrefix  = "document_version_onboarding_"
	mailSourceBindingPrefix  = "document_binding_onboarding_wiki_"
)

// UpsertMailWikiSource stores one imported mail message as an internal
// Markdown Document bound to the Human's Personal Wiki, creating the Wiki root
// when the mail arrives first.
func (s *Service) UpsertMailWikiSource(
	ctx context.Context,
	input UpsertWikiSourceInput,
) (result UpsertWikiSourceResult, err error) {
	input.SourceKey = strings.TrimSpace(input.SourceKey)
	input.Filename = strings.TrimSpace(input.Filename)
	if s == nil || s.pool == nil || s.objects == nil || input.TenantID == "" || input.OwnerActorID == "" ||
		input.SourceKey == "" || len(input.SourceKey) > 255 || input.Filename == "" || len(input.Filename) > 255 ||
		len(input.Content) == 0 || len(input.Content) > 16<<20 || strings.ContainsAny(input.Filename, "/\\\x00") {
		return UpsertWikiSourceResult{}, ErrInvalidInput
	}
	object, putErr := s.objects.Put(ctx, bytes.NewReader(input.Content))
	if putErr != nil {
		return UpsertWikiSourceResult{}, errors.Join(ErrObjectStoreUnavailable, putErr)
	}
	keepObject := false
	defer func() {
		if !keepObject {
			if cleanupErr := artifactstore.DeleteDetached(ctx, s.objects, object.Key); cleanupErr != nil {
				err = errors.Join(err, cleanupErr)
			}
		}
	}()
	for attempt := 0; attempt < documentTransactionAttempts; attempt++ {
		result, err = s.upsertMailWikiSourceOnce(ctx, input, object)
		if err == nil {
			keepObject = result.Changed
			return result, nil
		}
		if !isRetryableDocumentTransactionError(err) ||
			attempt == documentTransactionAttempts-1 || ctx.Err() != nil {
			return result, err
		}
	}
	return result, err
}

func (s *Service) upsertMailWikiSourceOnce(
	ctx context.Context,
	input UpsertWikiSourceInput,
	object artifactstore.Object,
) (UpsertWikiSourceResult, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return UpsertWikiSourceResult{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var human bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM actors
		WHERE id=$2 AND tenant_id=$1 AND kind='human')`, input.TenantID, input.OwnerActorID).Scan(&human); err != nil {
		return UpsertWikiSourceResult{}, err
	}
	if !human {
		return UpsertWikiSourceResult{}, ErrNotFound
	}
	wikiID, err := EnsurePersonalWikiRoot(ctx, tx, input.TenantID, input.OwnerActorID)
	if err != nil {
		return UpsertWikiSourceResult{}, err
	}
	result, err := upsertWikiSourceItemInTransaction(ctx, tx, wikiID, input, object)
	if err != nil {
		return UpsertWikiSourceResult{}, err
	}
	return result, tx.Commit(ctx)
}

// upsertWikiSourceItemInTransaction writes one mail source: an internal
// Markdown Document whose current Version holds the message, its Wiki source
// Binding, and its wiki_source_items row. The caller has found the Wiki; the
// source gets no personal Placement, so it stays out of My pages.
func upsertWikiSourceItemInTransaction(
	ctx context.Context,
	tx pgx.Tx,
	wikiID string,
	input UpsertWikiSourceInput,
	object artifactstore.Object,
) (UpsertWikiSourceResult, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
		"wiki-source|mail|"+input.TenantID+"|"+input.OwnerActorID+"|"+input.SourceKey); err != nil {
		return UpsertWikiSourceResult{}, err
	}
	hash := hex.EncodeToString(object.SHA256[:])
	var documentID, versionID, existingHash string
	lookupErr := tx.QueryRow(ctx, `SELECT document_id,document_version_id,content_sha256
		FROM wiki_source_items
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND source_key=$3 FOR UPDATE`,
		input.TenantID, input.OwnerActorID, input.SourceKey).Scan(&documentID, &versionID, &existingHash)
	if lookupErr != nil && !errors.Is(lookupErr, pgx.ErrNoRows) {
		return UpsertWikiSourceResult{}, lookupErr
	}
	if lookupErr == nil && existingHash == hash {
		if err := ensureWikiSourceBinding(ctx, tx, mailSourceBindingPrefix, input.TenantID, input.OwnerActorID, wikiID, documentID); err != nil {
			return UpsertWikiSourceResult{}, err
		}
		return UpsertWikiSourceResult{DocumentID: documentID, VersionID: versionID, WikiID: wikiID}, nil
	}
	if errors.Is(lookupErr, pgx.ErrNoRows) {
		documentID = stableCreateID(mailSourceDocumentPrefix, input.TenantID, input.OwnerActorID, input.SourceKey)
		versionID = stableCreateID(mailSourceVersionPrefix, documentID, "1", hash)
		if _, err := tx.Exec(ctx, `INSERT INTO documents(
			id,tenant_id,title,format,owner_actor_id,owner_actor_kind,
			creator_actor_id,creator_actor_kind,status
		) VALUES($1,$2,$3,'markdown',$4,'human',$4,'human','active')`, documentID,
			input.TenantID, input.Filename, input.OwnerActorID); err != nil {
			return UpsertWikiSourceResult{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
			id,tenant_id,document_id,version_number,filename,representation_format,
			media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id
		) VALUES($1,$2,$3,1,$4,'markdown','text/markdown',$5,$6,$7,'ordinary_upload',$8)`,
			versionID, input.TenantID, documentID, input.Filename, object.Size, hash, object.Key, input.OwnerActorID); err != nil {
			return UpsertWikiSourceResult{}, err
		}
		if command, err := tx.Exec(ctx, `UPDATE documents
			SET current_version_id=$2,updated_at=GREATEST(updated_at,clock_timestamp())
			WHERE id=$1 AND tenant_id=$3 AND current_version_id IS NULL`, documentID, versionID, input.TenantID); err != nil {
			return UpsertWikiSourceResult{}, err
		} else if command.RowsAffected() != 1 {
			return UpsertWikiSourceResult{}, ErrVersionConflict
		}
		if err := ensureWikiSourceBinding(ctx, tx, mailSourceBindingPrefix, input.TenantID, input.OwnerActorID, wikiID, documentID); err != nil {
			return UpsertWikiSourceResult{}, err
		}
		if err := appendLifecycleEvent(ctx, tx, input.TenantID, documentID, input.OwnerActorID, versionID, "document_version", "document.created"); err != nil {
			return UpsertWikiSourceResult{}, err
		}
		if _, err := tx.Exec(ctx, `INSERT INTO wiki_source_items(
			tenant_id,owner_actor_id,source_key,content_sha256,document_id,document_version_id
		) VALUES($1,$2,$3,$4,$5,$6)`, input.TenantID, input.OwnerActorID, input.SourceKey,
			hash, documentID, versionID); err != nil {
			return UpsertWikiSourceResult{}, err
		}
		return UpsertWikiSourceResult{DocumentID: documentID, VersionID: versionID, WikiID: wikiID, Changed: true}, nil
	}
	var versionNumber int
	if err := tx.QueryRow(ctx, `SELECT version_number FROM document_versions
		WHERE id=$1 AND tenant_id=$2 AND document_id=$3`, versionID, input.TenantID, documentID).Scan(&versionNumber); err != nil {
		return UpsertWikiSourceResult{}, err
	}
	nextVersionID := stableCreateID(mailSourceVersionPrefix, documentID, strconv.Itoa(versionNumber+1), hash)
	if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,
		media_type,size_bytes,sha256,content_object_id,source,created_by_actor_id,base_version_id
	) VALUES($1,$2,$3,$4,$5,'markdown','text/markdown',$6,$7,$8,'replacement_upload',$9,$10)`,
		nextVersionID, input.TenantID, documentID, versionNumber+1, input.Filename, object.Size, hash, object.Key, input.OwnerActorID, versionID); err != nil {
		return UpsertWikiSourceResult{}, err
	}
	if command, err := tx.Exec(ctx, `UPDATE documents SET current_version_id=$2,title=$5,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$3 AND current_version_id=$4 AND status='active'`,
		documentID, nextVersionID, input.TenantID, versionID, input.Filename); err != nil {
		return UpsertWikiSourceResult{}, err
	} else if command.RowsAffected() != 1 {
		return UpsertWikiSourceResult{}, ErrVersionConflict
	}
	if err := ensureWikiSourceBinding(ctx, tx, mailSourceBindingPrefix, input.TenantID, input.OwnerActorID, wikiID, documentID); err != nil {
		return UpsertWikiSourceResult{}, err
	}
	if err := appendLifecycleEvent(ctx, tx, input.TenantID, documentID, input.OwnerActorID, nextVersionID, "document_version", "document.version_created"); err != nil {
		return UpsertWikiSourceResult{}, err
	}
	if command, err := tx.Exec(ctx, `UPDATE wiki_source_items
		SET content_sha256=$4,document_version_id=$5,updated_at=clock_timestamp()
		WHERE tenant_id=$1 AND owner_actor_id=$2 AND source_key=$3
		  AND document_id=$6 AND document_version_id=$7`,
		input.TenantID, input.OwnerActorID, input.SourceKey, hash, nextVersionID, documentID, versionID); err != nil {
		return UpsertWikiSourceResult{}, err
	} else if command.RowsAffected() != 1 {
		return UpsertWikiSourceResult{}, ErrVersionConflict
	}
	return UpsertWikiSourceResult{DocumentID: documentID, VersionID: nextVersionID, WikiID: wikiID, Changed: true}, nil
}

func ensureWikiSourceBinding(ctx context.Context, tx pgx.Tx, prefix, tenantID, actorID, wikiID, documentID string) error {
	bindingID := stableCreateID(prefix, documentID, wikiID)
	changed, err := upsertTypedBinding(ctx, tx, tenantID, documentID, bindingID, "wiki_source", wikiID, "editor")
	if err != nil || !changed {
		return err
	}
	if err := invalidateBindingAccess(ctx, tx, tenantID, documentID, "wiki_source", wikiID); err != nil {
		return err
	}
	return AppendBindingUpdatedEvents(ctx, tx, tenantID, actorID, bindingID, []string{documentID})
}
