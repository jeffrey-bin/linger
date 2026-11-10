package document

import (
	"context"
	"encoding/hex"
	"errors"
	"fmt"
	"os"

	"github.com/jackc/pgx/v5"
)

type AgentFileEntry struct {
	DocumentID, Name, VersionID, Role string
	VersionNumber                     int
	Editable, ReadOnly, SharedWithMe  bool
}
type AgentFileDownload struct {
	AgentFileEntry
	LatestDownloadContent
	RepresentationFormat string
	NotModified          bool
}

// ListAgentFiles lists every active Document the Agent reads, which is every
// Document its Human reads. sharedOnly keeps the Documents someone shared
// with the Agent, which a share asks it to look at.
func (s *Service) ListAgentFiles(ctx context.Context, tenantID, agentID, afterID string, limit int, sharedOnly bool) ([]AgentFileEntry, error) {
	if tenantID == "" || agentID == "" || limit < 1 || limit > 500 {
		return nil, ErrInvalidInput
	}
	rows, err := s.pool.Query(ctx, `WITH registration AS MATERIALIZED (
    SELECT tenant_id,actor_id
    FROM agent_registrations
    WHERE tenant_id=$1 AND agent_management_id=$2 AND status='active'
  )
  SELECT document.id,COALESCE(version.filename,document.title),COALESCE(version.id,''),
         COALESCE(version.version_number,0),agent_access.content_role,agent_access.can_write,
         document.format='blocknote'
           OR EXISTS(SELECT 1 FROM document_bodies WHERE document_id=document.id)
           OR document.native_import_status IS NOT NULL,
         shared.shared
  FROM registration
  JOIN documents document ON document.tenant_id=registration.tenant_id
  JOIN LATERAL resolve_agent_document_access_v2($2,document.id) agent_access
    ON agent_access.tenant_id=document.tenant_id AND agent_access.can_read
  LEFT JOIN document_versions version ON version.id=document.current_version_id
  CROSS JOIN LATERAL (
    SELECT EXISTS(SELECT 1 FROM document_direct_collaborators collaborator
      WHERE collaborator.document_id=document.id AND collaborator.tenant_id=document.tenant_id
        AND collaborator.target_actor_id=registration.actor_id AND collaborator.status='active') shared
  ) shared
  WHERE document.id>$3 AND document.status='active' AND (NOT $5 OR shared.shared)
  ORDER BY document.id LIMIT $4`, tenantID, agentID, afterID, limit, sharedOnly)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]AgentFileEntry, 0)
	for rows.Next() {
		var entry AgentFileEntry
		if err := rows.Scan(&entry.DocumentID, &entry.Name, &entry.VersionID,
			&entry.VersionNumber, &entry.Role, &entry.Editable, &entry.ReadOnly,
			&entry.SharedWithMe); err != nil {
			return nil, err
		}
		result = append(result, entry)
	}
	return result, rows.Err()
}

func (d AgentFileDownload) CacheTag() string {
	if d.ReadOnly {
		return ""
	}
	return fmt.Sprintf("\"%s:%s\"", d.VersionID, d.SHA256)
}

func (s *Service) DownloadAgentFileAs(ctx context.Context, tenantID, agentID, documentID, format string) (AgentFileDownload, error) {
	return s.DownloadAgentFileConditional(ctx, tenantID, agentID, documentID, format, "")
}

func (s *Service) DownloadAgentFileConditional(ctx context.Context, tenantID, agentID, documentID, format, ifNoneMatch string) (AgentFileDownload, error) {
	if format != "markdown" && format != "html" && format != "blocks" {
		return AgentFileDownload{}, ErrInvalidInput
	}
	return s.readLatestAgentDownload(ctx, func() (AgentFileDownload, error) {
		return s.downloadAgentFile(ctx, tenantID, agentID, documentID, format, ifNoneMatch)
	})
}

// Rendering never preserves authority from the pre-render read. Every retry
// starts a fresh transaction to read current permission and the latest Draft.
func (s *Service) readLatestAgentDownload(ctx context.Context, read func() (AgentFileDownload, error)) (AgentFileDownload, error) {
	for attempt := 0; attempt < 3; attempt++ {
		result, err := read()
		var miss *latestProjectionReadMiss
		if !errors.As(err, &miss) {
			return result, err
		}
		if _, err := s.ensureLatestProjection(ctx, miss.tenantID, miss.candidate); err != nil {
			return AgentFileDownload{}, err
		}
	}
	return AgentFileDownload{}, ErrLatestProjectionNotReady
}

func (s *Service) downloadAgentFile(ctx context.Context, tenantID, agentID, documentID, format, ifNoneMatch string) (AgentFileDownload, error) {
	if tenantID == "" || agentID == "" || documentID == "" {
		return AgentFileDownload{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return AgentFileDownload{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var role string
	err = tx.QueryRow(ctx, `SELECT content_role FROM resolve_agent_document_access_v2($1,$2) WHERE tenant_id=$3 AND can_read`, agentID, documentID, tenantID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentFileDownload{}, ErrNotFound
	}
	if err != nil {
		return AgentFileDownload{}, err
	}
	return s.downloadAuthorizedFile(ctx, tx, tenantID, documentID, role, format, ifNoneMatch, "agent")
}

func (s *Service) DownloadLinkFile(ctx context.Context, token string) (AgentFileDownload, error) {
	return s.readLatestAgentDownload(ctx, func() (AgentFileDownload, error) {
		return s.downloadLinkFile(ctx, token)
	})
}

func (s *Service) downloadLinkFile(ctx context.Context, token string) (AgentFileDownload, error) {
	digest, valid := linkTokenDigest(token)
	if !valid {
		return AgentFileDownload{}, ErrNotFound
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead})
	if err != nil {
		return AgentFileDownload{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var tenantID, documentID, role string
	err = tx.QueryRow(ctx, `SELECT tenant_id,id,link_share_role FROM documents WHERE link_share_token_sha256=$1 AND link_share_status='active'`, digest).Scan(&tenantID, &documentID, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return AgentFileDownload{}, ErrNotFound
	}
	if err != nil {
		return AgentFileDownload{}, err
	}
	return s.downloadAuthorizedFile(ctx, tx, tenantID, documentID, role, "markdown", "", "share")
}

func (s *Service) downloadAuthorizedFile(ctx context.Context, tx pgx.Tx, tenantID, documentID, role, format, ifNoneMatch string, reader string) (AgentFileDownload, error) {
	result := AgentFileDownload{AgentFileEntry: AgentFileEntry{DocumentID: documentID, Role: role}}
	var native, importing bool
	var versionID *string
	err := tx.QueryRow(ctx, `SELECT title,current_version_id,format,format='blocknote' OR EXISTS(SELECT 1 FROM document_bodies WHERE document_id=documents.id),
 native_import_status IS NOT NULL
  FROM documents WHERE id=$1 AND tenant_id=$2 AND status='active'`, documentID, tenantID).Scan(&result.Name, &versionID, &result.RepresentationFormat, &native, &importing)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, ErrNotFound
	}
	if err != nil {
		return result, err
	}
	// This flag marks a native export that cannot be round-tripped as bytes.
	// Mutable roles are checked again by TeamHub at publication time.
	result.ReadOnly = native || importing
	if native {
		if result.VersionID, err = bodyRevisionTx(ctx, tx, documentID); err != nil {
			return result, err
		}
		err = tx.QueryRow(ctx, `SELECT projection.revision_id,projection.filename,projection.media_type,projection.content_object_id,projection.sha256,projection.size_bytes
   FROM document_latest_projections projection WHERE projection.document_id=$1 AND projection.tenant_id=$2
   AND projection.representation_format=$3 AND projection.revision_id=$4`, documentID, tenantID, format, result.VersionID).Scan(&result.VersionID, &result.Filename, &result.MediaType, &result.ObjectKey, &result.SHA256, &result.SizeBytes)
		if errors.Is(err, pgx.ErrNoRows) {
			observeLatestRead(ctx, reader, format, "miss", documentID, result.VersionID)
			if err := tx.Commit(ctx); err != nil {
				return result, err
			}
			if s.runtime == nil {
				return result, ErrRuntimeUnavailable
			}
			return result, &latestProjectionReadMiss{tenantID: tenantID, candidate: latestProjectionCandidate{documentID: documentID, revisionID: result.VersionID, representationFormat: format}}
		}
	} else {
		if format != "markdown" {
			return result, ErrInvalidInput
		}
		if versionID == nil {
			return result, ErrRevisionUnavailable
		}
		result.VersionID = *versionID
		err = tx.QueryRow(ctx, `SELECT filename,media_type,content_object_id,sha256,size_bytes,version_number FROM document_versions WHERE id=$1 AND document_id=$2 AND tenant_id=$3`, *versionID, documentID, tenantID).Scan(&result.Filename, &result.MediaType, &result.ObjectKey, &result.SHA256, &result.SizeBytes, &result.VersionNumber)
	}
	if err != nil {
		return result, err
	}
	result.Name = result.Filename
	if err := tx.Commit(ctx); err != nil {
		return result, err
	}
	// The transaction above remains authoritative for current access and version.
	if !result.ReadOnly && ifNoneMatch != "" && ifNoneMatch == result.CacheTag() {
		result.NotModified = true
		return result, nil
	}
	if s.objects == nil {
		return result, ErrObjectStoreUnavailable
	}
	object, err := s.objects.Head(ctx, result.ObjectKey)
	missing := errors.Is(err, os.ErrNotExist)
	invalid := err == nil && (object.Key != result.ObjectKey || object.Size != result.SizeBytes || hex.EncodeToString(object.SHA256[:]) != result.SHA256)
	if native && (missing || invalid) {
		observeLatestRead(ctx, reader, format, "miss", documentID, result.VersionID)
		if invalidateErr := s.invalidateLatestProjection(ctx, tenantID, documentID, result.VersionID, format, result.LatestDownloadContent); invalidateErr != nil {
			return result, errors.Join(ErrObjectStoreUnavailable, invalidateErr)
		}
		return result, &latestProjectionReadMiss{tenantID: tenantID, candidate: latestProjectionCandidate{documentID: documentID, revisionID: result.VersionID, representationFormat: format}}
	}
	if err != nil || invalid {
		if native {
			observeLatestRead(ctx, reader, format, "error", documentID, result.VersionID)
		}
		return result, errors.Join(ErrObjectStoreUnavailable, err)
	}
	if native {
		observeLatestRead(ctx, reader, format, "hit", documentID, result.VersionID)
	}
	return result, nil
}
