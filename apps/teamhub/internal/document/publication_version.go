package document

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// commitAgentFileVersion creates one published Document with its first
// Version. Callers own current authority, target locks, replay and transaction
// commit.
func commitAgentFileVersion(ctx context.Context, tx pgx.Tx, p agentcredential.Principal, sourceInvocationID string,
	item publishedFile,
) error {
	if _, err := tx.Exec(ctx, `INSERT INTO documents(
		id,tenant_id,title,format,owner_actor_id,owner_actor_kind,creator_actor_id,
		creator_actor_kind,status
	) VALUES($1,$2,$3,$4,$5,'agent',$5,'agent','active')`,
		item.DocumentID, p.TenantID, item.Filename, item.RepresentationFormat, p.AgentActorID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `INSERT INTO document_versions(
		id,tenant_id,document_id,version_number,filename,representation_format,media_type,
		size_bytes,sha256,content_object_id,source,created_by_actor_id,source_invocation_id
	) VALUES($1,$2,$3,1,$4,$5,$6,$7,$8,$9,'agent_publication',$10,$11)`,
		item.VersionID, p.TenantID, item.DocumentID, item.Filename,
		item.RepresentationFormat, item.File.MediaType, item.File.SizeBytes, item.File.SHA256, item.File.ObjectKey,
		p.AgentActorID, sourceInvocationID); err != nil {
		return err
	}
	command, err := tx.Exec(ctx, `UPDATE documents
		SET current_version_id=$2,updated_at=GREATEST(updated_at,clock_timestamp())
		WHERE id=$1 AND tenant_id=$3 AND status='active' AND current_version_id IS NULL`,
		item.DocumentID, item.VersionID, p.TenantID)
	if err != nil {
		return err
	}
	if command.RowsAffected() != 1 {
		return ErrVersionConflict
	}
	return nil
}

// Every published Document installs the same Manager Binding.
func bindPublishedDocument(ctx context.Context, tx pgx.Tx, tenantID, documentID, bindingID, kind, contextID string) error {
	_, err := upsertTypedBinding(ctx, tx, tenantID, documentID, bindingID, kind, contextID, "manager")
	return err
}
