package document

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// CollaborationCredential is a signed connection token for one Document. The
// Document Runtime verifies it when the connection opens; no row records it.
type CollaborationCredential struct {
	DocumentID, CollaborationCredential string
	ExpiresAt                           time.Time
}

type IssueCollaborationCredentialInput struct {
	AccountID, DocumentID string
	ExpiresAt             time.Time
}

// ConfigureConnectionTokens sets the key that signs Document connection
// tokens. TeamHub and the Document Runtime derive it from LINGER_SECRET_SEED
// with the same label, so the Runtime verifies every token itself.
func (s *Service) ConfigureConnectionTokens(key string) {
	s.connectionTokenKey = []byte(key)
}

func (s *Service) IssueCollaborationCredential(
	ctx context.Context,
	input IssueCollaborationCredentialInput,
) (CollaborationCredential, error) {
	return s.issueCollaborationCredential(ctx, input, "write")
}

func (s *Service) IssueReadCollaborationCredential(
	ctx context.Context,
	input IssueCollaborationCredentialInput,
) (CollaborationCredential, error) {
	return s.issueCollaborationCredential(ctx, input, "read")
}

func (s *Service) issueCollaborationCredential(
	ctx context.Context,
	input IssueCollaborationCredentialInput,
	accessMode string,
) (CollaborationCredential, error) {
	if input.AccountID == "" || input.DocumentID == "" || input.ExpiresAt.IsZero() {
		return CollaborationCredential{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return CollaborationCredential{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	credential, err := s.issueCollaborationCredentialTx(ctx, tx, input, accessMode, nil)
	if err != nil {
		return CollaborationCredential{}, err
	}
	return credential, tx.Commit(ctx)
}

// issueCollaborationCredentialTx reads the permission count before it checks
// access. A permission change that commits after the read increments the
// count, so the token no longer opens a connection; one that committed before
// it is already visible to the access check.
func (s *Service) issueCollaborationCredentialTx(ctx context.Context, tx pgx.Tx,
	input IssueCollaborationCredentialInput, accessMode string, value *Document,
) (CollaborationCredential, error) {
	var tenantID, actorID, status, format string
	var permissionCount int64
	var databaseNow time.Time
	if value != nil {
		tenantID, actorID, status, format, databaseNow = value.TenantID, value.currentActorID, value.Status, value.Format, value.readAt
		if err := tx.QueryRow(ctx, `SELECT permission_count FROM document_permission_counts WHERE document_id=$1`,
			input.DocumentID).Scan(&permissionCount); err != nil {
			return CollaborationCredential{}, err
		}
	} else {
		err := tx.QueryRow(ctx, `SELECT document.tenant_id,actor.id,document.status,document.format,
			permission.permission_count,clock_timestamp()
		FROM documents document
		JOIN document_permission_counts permission ON permission.document_id=document.id
		JOIN actors actor ON actor.tenant_id=document.tenant_id AND actor.account_id=$1
		 AND actor.kind='human'
		WHERE document.id=$2
		FOR NO KEY UPDATE OF document`, input.AccountID, input.DocumentID).Scan(
			&tenantID, &actorID, &status, &format, &permissionCount, &databaseNow,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return CollaborationCredential{}, ErrNotFound
		}
		if err != nil {
			return CollaborationCredential{}, err
		}
	}
	if status != "active" || format != "blocknote" {
		return CollaborationCredential{}, ErrNotFound
	}
	access, err := currentActorAccess(ctx, tx, tenantID, input.DocumentID, actorID)
	if err != nil {
		return CollaborationCredential{}, err
	}
	if !access.CanRead || (accessMode == "write" && !access.CanWrite) {
		return CollaborationCredential{}, ErrNotFound
	}
	if !input.ExpiresAt.After(databaseNow) {
		return CollaborationCredential{}, ErrInvalidInput
	}
	token, err := signConnectionToken(s.connectionTokenKey, ConnectionTokenClaims{
		SessionID: "document_session_" + uuid.NewString(), DocumentID: input.DocumentID,
		ActorID: actorID, Mode: accessMode, ExpiresAtMillis: input.ExpiresAt.UnixMilli(),
		PermissionCount: permissionCount,
	})
	if err != nil {
		return CollaborationCredential{}, err
	}
	return CollaborationCredential{
		DocumentID: input.DocumentID, CollaborationCredential: token,
		ExpiresAt: input.ExpiresAt,
	}, nil
}
