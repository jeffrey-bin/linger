// Document previews are short-lived signed URLs for My Documents files. A URL
// names the account, the entry Document Version, and its expiry; every request
// resolves the path against the entry's current folder and re-checks read
// access. A URL cannot be revoked before it expires.

package document

import (
	"context"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
)

const (
	// PreviewLinkTTL is how long a preview URL works.
	PreviewLinkTTL     = 10 * time.Minute
	previewTokenDomain = "teamhub/document-preview/v1"
	// maxPreviewDepth bounds the folder levels one request path may walk.
	maxPreviewDepth = 64
)

// Errors returned by PreviewService.
var (
	ErrInvalidPath     = errors.New("document preview path is invalid")
	ErrPreviewNotFound = errors.New("document preview was not found")
)

// PreviewService signs and resolves Document preview URLs.
type PreviewService struct {
	pool         *pgxpool.Pool
	objects      artifactstore.ObjectStore
	publicOrigin string
	key          []byte
	now          func() time.Time
}

// PreviewLink is a signed preview URL and its expiry.
type PreviewLink struct {
	PreviewURL string
	ExpiresAt  time.Time
}

// File is one previewed file's stored content.
type File struct {
	Filename  string
	MediaType string
	ObjectKey string
	SHA256    string
	SizeBytes int64
}

// previewToken is what a preview URL signs.
type previewToken struct {
	AccountID string `json:"a"`
	VersionID string `json:"v"`
	ExpiresAt int64  `json:"e"`
}

// previewEntry is the previewed Document Version and the folder its siblings
// resolve against. placementID is nil when the account sees the Document
// without a My Documents placement; then only the entry is served.
type previewEntry struct {
	tenantID, principalActorID, documentID string
	placementID, folderID                  *string
	file                                   File
}

// NewPreviewService returns a PreviewService that signs with key.
func NewPreviewService(pool *pgxpool.Pool, objects artifactstore.ObjectStore, publicOrigin string, key []byte) *PreviewService {
	return &PreviewService{
		pool: pool, objects: objects, publicOrigin: strings.TrimRight(publicOrigin, "/"),
		key: key, now: time.Now,
	}
}

// Create signs a preview URL for a Document Version the account can read.
func (s *PreviewService) Create(ctx context.Context, accountID, documentVersionID string) (PreviewLink, error) {
	if s == nil || s.pool == nil || s.objects == nil || len(s.key) == 0 || accountID == "" || documentVersionID == "" {
		return PreviewLink{}, ErrPreviewNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return PreviewLink{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	entry, err := loadPreviewEntry(ctx, tx, accountID, documentVersionID)
	if err != nil {
		return PreviewLink{}, err
	}
	if canonical, pathErr := canonicalRequestPath("/" + entry.file.Filename); pathErr != nil || canonical != entry.file.Filename {
		return PreviewLink{}, ErrInvalidPath
	}
	if err := s.verifyObject(ctx, entry.file); err != nil {
		return PreviewLink{}, err
	}
	expiresAt := s.now().UTC().Add(PreviewLinkTTL).Truncate(time.Second)
	token, err := secretbox.Sign(s.key, previewTokenDomain, previewToken{
		AccountID: accountID, VersionID: documentVersionID, ExpiresAt: expiresAt.Unix(),
	})
	if err != nil {
		return PreviewLink{}, err
	}
	return PreviewLink{
		PreviewURL: s.publicOrigin + "/v0/document-previews/" + token + "/" + url.PathEscape(entry.file.Filename),
		ExpiresAt:  expiresAt,
	}, nil
}

// Resolve serves the entry at its signed Version and any other path at the
// current Version of the readable Document placed there, relative to the
// entry's folder.
func (s *PreviewService) Resolve(ctx context.Context, token, requestPath string) (File, error) {
	if s == nil || s.pool == nil || s.objects == nil {
		return File{}, ErrPreviewNotFound
	}
	signed, ok := s.verifyToken(token)
	if !ok {
		return File{}, ErrPreviewNotFound
	}
	canonicalPath, err := canonicalRequestPath(requestPath)
	if err != nil {
		return File{}, ErrPreviewNotFound
	}
	segments := strings.Split(canonicalPath, "/")
	if len(segments) > maxPreviewDepth {
		return File{}, ErrPreviewNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return File{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	entry, err := loadPreviewEntry(ctx, tx, signed.AccountID, signed.VersionID)
	if err != nil {
		return File{}, err
	}
	file := entry.file
	if canonicalPath != entry.file.Filename {
		if entry.placementID == nil {
			return File{}, ErrPreviewNotFound
		}
		if file, err = resolvePreviewSibling(ctx, tx, signed.AccountID, entry, segments); err != nil {
			return File{}, err
		}
	}
	if err := s.verifyObject(ctx, file); err != nil {
		return File{}, err
	}
	return file, nil
}

func loadPreviewEntry(ctx context.Context, tx pgx.Tx, accountID, documentVersionID string) (previewEntry, error) {
	var entry previewEntry
	err := tx.QueryRow(ctx, `
		SELECT version.tenant_id,principal.id,version.document_id,
			version.filename,version.media_type,version.size_bytes,version.sha256,
			version.content_object_id,placement.id,placement.parent_id
		FROM document_versions version
		JOIN documents document ON document.id=version.document_id
			AND document.tenant_id=version.tenant_id AND document.status='active'
		JOIN actors principal ON principal.account_id=$2 AND principal.kind='human'
			AND principal.tenant_id=document.tenant_id
		LEFT JOIN document_placements placement ON placement.document_id=document.id
			AND placement.tenant_id=document.tenant_id AND placement.scope_kind='personal'
			AND placement.owner_human_actor_id=principal.id
			AND placement.node_kind='document' AND placement.deleted_at IS NULL
		WHERE version.id=$1
	`, documentVersionID, accountID).Scan(
		&entry.tenantID, &entry.principalActorID, &entry.documentID,
		&entry.file.Filename, &entry.file.MediaType, &entry.file.SizeBytes,
		&entry.file.SHA256, &entry.file.ObjectKey, &entry.placementID, &entry.folderID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return previewEntry{}, ErrPreviewNotFound
	}
	if err != nil {
		return previewEntry{}, err
	}
	readable, err := CanReadInTx(ctx, tx, accountID, entry.documentID)
	if err != nil {
		return previewEntry{}, err
	}
	if !readable {
		return previewEntry{}, ErrPreviewNotFound
	}
	return entry, nil
}

// resolvePreviewSibling walks the folder names below the entry's folder and
// returns the first readable Document, by placement ID, whose current Version
// file name matches the last segment.
func resolvePreviewSibling(ctx context.Context, tx pgx.Tx, accountID string, entry previewEntry, segments []string) (File, error) {
	rows, err := tx.Query(ctx, `
		WITH RECURSIVE folder AS (
			SELECT $3::text AS id,1 AS depth
			UNION ALL
			SELECT child.id,folder.depth+1
			FROM folder
			JOIN document_placements child ON child.tenant_id=$1
				AND child.owner_human_actor_id=$2 AND child.scope_kind='personal'
				AND child.node_kind='folder' AND child.deleted_at IS NULL
				AND child.parent_id IS NOT DISTINCT FROM folder.id
				AND child.name=($4::text[])[folder.depth]
			WHERE folder.depth<cardinality($4::text[])
		)
		SELECT document.id,version.filename,version.media_type,version.size_bytes,
			version.sha256,version.content_object_id
		FROM folder
		JOIN document_placements placement ON placement.tenant_id=$1
			AND placement.owner_human_actor_id=$2 AND placement.scope_kind='personal'
			AND placement.node_kind='document' AND placement.deleted_at IS NULL
			AND placement.parent_id IS NOT DISTINCT FROM folder.id AND placement.id<>$5
		JOIN documents document ON document.id=placement.document_id
			AND document.tenant_id=placement.tenant_id AND document.status='active'
		JOIN document_versions version ON version.id=document.current_version_id
			AND version.document_id=document.id AND version.tenant_id=document.tenant_id
		WHERE folder.depth=cardinality($4::text[])
			AND version.filename=($4::text[])[cardinality($4::text[])]
		ORDER BY placement.id
	`, entry.tenantID, entry.principalActorID, entry.folderID, segments, *entry.placementID)
	if err != nil {
		return File{}, err
	}
	type candidate struct {
		documentID string
		file       File
	}
	var candidates []candidate
	for rows.Next() {
		var found candidate
		if err := rows.Scan(&found.documentID, &found.file.Filename, &found.file.MediaType,
			&found.file.SizeBytes, &found.file.SHA256, &found.file.ObjectKey); err != nil {
			rows.Close()
			return File{}, err
		}
		candidates = append(candidates, found)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return File{}, err
	}
	for _, found := range candidates {
		readable, err := CanReadInTx(ctx, tx, accountID, found.documentID)
		if err != nil {
			return File{}, err
		}
		if readable {
			return found.file, nil
		}
	}
	return File{}, ErrPreviewNotFound
}

func (s *PreviewService) verifyToken(token string) (previewToken, bool) {
	var signed previewToken
	if !secretbox.Verify(s.key, previewTokenDomain, token, &signed) || signed.AccountID == "" ||
		signed.VersionID == "" || s.now().Unix() >= signed.ExpiresAt {
		return previewToken{}, false
	}
	return signed, true
}

func (s *PreviewService) verifyObject(ctx context.Context, file File) error {
	object, err := s.objects.Head(ctx, file.ObjectKey)
	if err != nil || object.Key != file.ObjectKey || object.Size != file.SizeBytes ||
		hex.EncodeToString(object.SHA256[:]) != file.SHA256 {
		return ErrPreviewNotFound
	}
	return nil
}

func canonicalRequestPath(requestPath string) (string, error) {
	trimmed := strings.TrimPrefix(requestPath, "/")
	if trimmed == "" || strings.ContainsAny(trimmed, "\\\x00%") {
		return "", ErrInvalidPath
	}
	segments := strings.Split(trimmed, "/")
	for _, segment := range segments {
		if segment == "" || segment == "." || segment == ".." {
			return "", ErrInvalidPath
		}
	}
	return trimmed, nil
}
