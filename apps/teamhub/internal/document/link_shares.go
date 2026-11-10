package document

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

var ErrLinkShareForbidden = errors.New("document link management forbidden")

// Exactly one identity is supplied by the authenticated HTTP adapter.
type LinkSharePrincipal struct{ AccountID, AgentID string }
type SetLinkShareInput struct {
	Principal        LinkSharePrincipal
	DocumentID, Role string
	ExpectedVersion  int64
	Reset            bool
}
type RevokeLinkShareInput struct {
	Principal       LinkSharePrincipal
	DocumentID      string
	ExpectedVersion int64
}
type LinkShare struct {
	ID, DocumentID, Role, Status, Token string
	Version                             int64
}
type LinkShareAccess struct {
	LinkID, TenantID, DocumentID, Role string
	Version                            int64
}

func (s *Service) GetLinkShare(ctx context.Context, principal LinkSharePrincipal, documentID string) (LinkShare, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return LinkShare{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, _, err := lockLinkShareManager(ctx, tx, principal, documentID); err != nil {
		return LinkShare{}, err
	}
	result, err := loadLinkShare(ctx, tx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkShare{}, ErrNotFound
	}
	if err != nil {
		return LinkShare{}, err
	}
	return result, tx.Commit(ctx)
}

func (s *Service) SetLinkShare(ctx context.Context, input SetLinkShareInput) (LinkShare, error) {
	if input.DocumentID == "" || !oneOf(input.Role, "viewer", "editor") || input.ExpectedVersion < 0 {
		return LinkShare{}, ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return LinkShare{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, err := lockLinkShareManager(ctx, tx, input.Principal, input.DocumentID)
	if err != nil {
		return LinkShare{}, err
	}
	current, err := loadLinkShare(ctx, tx, input.DocumentID)
	exists := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return LinkShare{}, err
	}
	if current.Version != input.ExpectedVersion {
		return LinkShare{}, ErrConflict
	}
	token := ""
	var digest []byte
	if !exists || input.Reset || current.Status == "revoked" {
		token = "doc_link_" + base64.RawURLEncoding.EncodeToString(randomLinkBytes())
		hashed := sha256.Sum256([]byte(token))
		digest = hashed[:]
	}
	if !exists {
		current.ID = "document_link_" + strings.ReplaceAll(uuid.NewString(), "-", "")
		_, err = tx.Exec(ctx, `UPDATE documents SET link_share_id=$2,link_share_token_sha256=$3,link_share_role=$4,
   link_share_status='active',link_share_version=1 WHERE id=$1 AND tenant_id=$5`, input.DocumentID, current.ID, digest, input.Role, tenantID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE documents SET link_share_role=$2,link_share_status='active',
   link_share_token_sha256=COALESCE($3,link_share_token_sha256),link_share_version=link_share_version+1 WHERE id=$1`, input.DocumentID, input.Role, digest)
	}
	if err != nil {
		return LinkShare{}, err
	}
	current.DocumentID, current.Role, current.Status, current.Token = input.DocumentID, input.Role, "active", token
	current.Version++
	if err := appendLinkShareEvent(ctx, tx, tenantID, actorID, current); err != nil {
		return LinkShare{}, err
	}
	return current, tx.Commit(ctx)
}

func (s *Service) RevokeLinkShare(ctx context.Context, input RevokeLinkShareInput) error {
	if input.DocumentID == "" || input.ExpectedVersion < 1 {
		return ErrInvalidInput
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	tenantID, actorID, err := lockLinkShareManager(ctx, tx, input.Principal, input.DocumentID)
	if err != nil {
		return err
	}
	current, err := loadLinkShare(ctx, tx, input.DocumentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if current.Version != input.ExpectedVersion {
		return ErrConflict
	}
	if current.Status == "revoked" {
		return tx.Commit(ctx)
	}
	if err := revokeLinkShare(ctx, tx, input.DocumentID); err != nil {
		return err
	}
	current.Version++
	current.Status = "revoked"
	if err := appendLinkShareEvent(ctx, tx, tenantID, actorID, current); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Resolving a capability does not create a Direct Grant. Every subsequent read
// or write must present and revalidate it, so revocation also stops prior users.
func (s *Service) ResolveLinkShare(ctx context.Context, token string) (LinkShareAccess, error) {
	digest, valid := linkTokenDigest(token)
	if !valid {
		return LinkShareAccess{}, ErrNotFound
	}
	var result LinkShareAccess
	err := s.pool.QueryRow(ctx, `SELECT link_share_id,tenant_id,id,link_share_role,link_share_version
  FROM documents WHERE link_share_token_sha256=$1 AND link_share_status='active' AND status='active'`, digest).Scan(
		&result.LinkID, &result.TenantID, &result.DocumentID, &result.Role, &result.Version)
	if errors.Is(err, pgx.ErrNoRows) {
		return LinkShareAccess{}, ErrNotFound
	}
	return result, err
}

func linkTokenDigest(token string) ([]byte, bool) {
	if len(token) != 52 || !strings.HasPrefix(token, "doc_link_") {
		return nil, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(token, "doc_link_"))
	if err != nil || len(decoded) != 32 {
		return nil, false
	}
	digest := sha256.Sum256([]byte(token))
	return digest[:], true
}

func lockLinkShareManager(ctx context.Context, tx pgx.Tx, principal LinkSharePrincipal, documentID string) (string, string, error) {
	if (principal.AccountID == "") == (principal.AgentID == "") {
		return "", "", ErrInvalidInput
	}
	var tenantID string
	if err := tx.QueryRow(ctx, `SELECT tenant_id FROM documents WHERE id=$1 AND status='active' FOR UPDATE`, documentID).Scan(&tenantID); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrNotFound
		}
		return "", "", err
	}
	var actorID, role string
	if principal.AccountID != "" {
		value, err := get(ctx, tx, principal.AccountID, documentID)
		if err != nil {
			return "", "", err
		}
		role = value.AccessV2.ContentRole
		actorID, err = resolveActiveHumanActorTx(ctx, tx, principal.AccountID, tenantID)
		if err != nil {
			return "", "", err
		}
	} else {
		err := tx.QueryRow(ctx, `SELECT actor_id,content_role FROM resolve_agent_document_access_v2($1,$2) WHERE tenant_id=$3 AND can_read`, principal.AgentID, documentID, tenantID).Scan(&actorID, &role)
		if errors.Is(err, pgx.ErrNoRows) {
			return "", "", ErrNotFound
		}
		if err != nil {
			return "", "", err
		}
	}
	if !oneOf(role, "owner", "manager") {
		return "", "", ErrLinkShareForbidden
	}
	return tenantID, actorID, nil
}

// loadLinkShare reads the Document's link share under the Document row lock;
// pgx.ErrNoRows means no link was ever created.
func loadLinkShare(ctx context.Context, tx pgx.Tx, documentID string) (LinkShare, error) {
	var result LinkShare
	err := tx.QueryRow(ctx, `SELECT link_share_id,id,link_share_role,link_share_status,link_share_version
  FROM documents WHERE id=$1 AND link_share_id IS NOT NULL FOR NO KEY UPDATE`, documentID).Scan(&result.ID, &result.DocumentID, &result.Role, &result.Status, &result.Version)
	return result, err
}

func revokeLinkShare(ctx context.Context, tx pgx.Tx, documentID string) error {
	_, err := tx.Exec(ctx, `UPDATE documents SET link_share_status='revoked',link_share_version=link_share_version+1 WHERE id=$1`, documentID)
	return err
}

func revokeDocumentLinkForTrash(ctx context.Context, tx pgx.Tx, tenantID, documentID, actorID string) error {
	current, err := loadLinkShare(ctx, tx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if current.Status == "revoked" {
		return nil
	}
	if err := revokeLinkShare(ctx, tx, documentID); err != nil {
		return err
	}
	current.Status, current.Version = "revoked", current.Version+1
	return appendLinkShareEvent(ctx, tx, tenantID, actorID, current)
}

func appendLinkShareEvent(ctx context.Context, tx pgx.Tx, tenantID, actorID string, link LinkShare) error {
	return appendDocumentEvent(ctx, tx, tenantID, link.DocumentID, actorID,
		stableCreateID("document_link_event_", link.ID, strconv.FormatInt(link.Version, 10)),
		"link_share", link.ID, "document.link_share.updated")
}
func randomLinkBytes() []byte {
	value := make([]byte, 32)
	// crypto/rand.Read either fills the buffer or terminates the process on Go 1.24+.
	_, _ = rand.Read(value)
	return value
}
