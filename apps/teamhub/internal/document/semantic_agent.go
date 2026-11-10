package document

import (
	"context"
	"errors"
	"slices"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
)

// admitPrincipalSemanticAuthority checks that the Agent may still write the
// Document and collects what the Runtime needs: the title, the body's Assets
// plus the one an image edit places, and the sequence an expected Revision
// pins. It locks nothing the Runtime's save waits for.
func admitPrincipalSemanticAuthority(ctx context.Context, tx pgx.Tx, input ApplySemanticMutationInput) (semanticAdmission, error) {
	var a semanticAdmission
	p := input.Principal
	if p == nil || agentcredential.RevalidateInTx(ctx, tx, *p) != nil {
		return a, ErrNotFound
	}
	writable, err := principalSemanticStillWritable(ctx, tx, p.CredentialID, p.TenantID, p.AgentActorID, input.DocumentID)
	if err != nil {
		return a, err
	}
	if !writable {
		return a, ErrNotFound
	}
	a.TenantID, a.AgentActorID, a.DocumentID = p.TenantID, p.AgentActorID, input.DocumentID
	var bodyAssetIDs []string
	err = tx.QueryRow(ctx, `SELECT document.title,body.asset_ids
		FROM documents document JOIN document_bodies body ON body.document_id=document.id
		WHERE document.id=$1 AND document.tenant_id=$2 AND document.status='active' AND document.format='blocknote'`,
		input.DocumentID, p.TenantID).Scan(&a.CurrentTitle, &bodyAssetIDs)
	if errors.Is(err, pgx.ErrNoRows) {
		return a, ErrNotFound
	}
	if err != nil {
		return a, err
	}
	// An image or file edit may also place one new Asset of this Document; an
	// image edit only an image.
	if assetID, image := semanticChangeAsset(input.SemanticChange); assetID != "" {
		var mediaType string
		err := tx.QueryRow(ctx, `SELECT media_type FROM document_assets
			WHERE id=$1 AND tenant_id=$2 AND document_id=$3 AND status='available'`,
			assetID, p.TenantID, input.DocumentID).Scan(&mediaType)
		if errors.Is(err, pgx.ErrNoRows) && slices.Contains(bodyAssetIDs, assetID) {
			mediaType = ""
		} else if errors.Is(err, pgx.ErrNoRows) {
			return a, ErrInvalidInput
		} else if err != nil {
			return a, err
		}
		if image && mediaType != "" && !strings.HasPrefix(mediaType, "image/") {
			return a, ErrInvalidInput
		}
		if !slices.Contains(bodyAssetIDs, assetID) {
			bodyAssetIDs = append(bodyAssetIDs, assetID)
		}
	}
	rows, err := tx.Query(ctx, `SELECT id FROM document_assets
		WHERE tenant_id=$1 AND document_id=$2 AND status='available' AND id=ANY($3::text[])
		ORDER BY id COLLATE "C"`, p.TenantID, input.DocumentID, bodyAssetIDs)
	if err != nil {
		return a, err
	}
	if a.AllowedAssetIDs, err = pgx.CollectRows(rows, pgx.RowTo[string]); err != nil {
		return a, err
	}
	if input.ExpectedRevisionID != "" {
		var seq int64
		err := tx.QueryRow(ctx, `SELECT persisted_seq FROM document_revisions
			WHERE id=$1 AND document_id=$2`, input.ExpectedRevisionID, input.DocumentID).Scan(&seq)
		if errors.Is(err, pgx.ErrNoRows) {
			return a, ErrVersionConflict
		}
		if err != nil {
			return a, err
		}
		a.ExpectedSeq = &seq
	}
	return a, nil
}

func principalSemanticStillWritable(ctx context.Context, tx pgx.Tx, credentialID, tenantID, actorID, documentID string) (bool, error) {
	var p agentcredential.Principal
	err := tx.QueryRow(ctx, `SELECT credential.id,credential.tenant_id,credential.agent_actor_id,credential.agent_management_id FROM agent_access_credentials credential
 JOIN agent_registrations registration ON registration.actor_id=credential.agent_actor_id AND registration.tenant_id=credential.tenant_id
 AND registration.agent_management_id=credential.agent_management_id AND registration.status='active'
 WHERE credential.id=$1 AND credential.tenant_id=$2 AND credential.agent_actor_id=$3 AND `+agentcredential.LiveSQL+`
 FOR SHARE OF credential,registration`, credentialID, tenantID, actorID).Scan(&p.CredentialID, &p.TenantID, &p.AgentActorID, &p.AgentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var writable bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM resolve_agent_document_access_v2($1,$2) access JOIN documents document
 ON document.id=$2 AND document.tenant_id=access.tenant_id AND document.status='active' WHERE access.can_write AND access.tenant_id=$3)`, p.AgentID, documentID, tenantID).Scan(&writable)
	return writable, err
}

func principalCreationAuthority(ctx context.Context, tx pgx.Tx, input CreateAgentDocumentInput) (agentDocumentCreationAuthority, error) {
	var a agentDocumentCreationAuthority
	p := input.Principal
	if p == nil || agentcredential.RevalidateInTx(ctx, tx, *p) != nil {
		return a, ErrNotFound
	}
	var allowed bool
	if input.TargetKind == "room" {
		err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM active_room_members member JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id AND room.deletion_started_at IS NULL WHERE member.actor_id=$1 AND member.tenant_id=$2 AND member.room_id=$3)`, p.AgentActorID, p.TenantID, input.TargetID).Scan(&allowed)
		if err != nil {
			return a, err
		}
		a.ContextKind = "meta"
	}
	if !allowed {
		return a, ErrNotFound
	}
	a.TenantID, a.AgentActorID, a.ManagementID, a.ContextID = p.TenantID, p.AgentActorID, p.AgentID, input.TargetID
	return a, nil
}
