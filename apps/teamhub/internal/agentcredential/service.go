// Package agentcredential authenticates durable Agent identities independently
// of their execution transport, Context, or Run lifecycle.
package agentcredential

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalid = errors.New("Agent access credential is invalid")
var ErrForbidden = errors.New("Agent access credential operation is forbidden")

type Principal struct {
	CredentialID, TenantID, AgentActorID, AgentID, AgentType string
	UserArtifactOwnerActorID, SponsorActorID                 string
	// Authenticated requests retain the presented token hash across delayed work.
	// Principals restored from persisted operation receipts intentionally have no
	// bearer hash: their domain admission, not the original token, is replayed.
	tokenHash []byte
}

type principalKey struct{}

func WithPrincipal(ctx context.Context, principal Principal) context.Context {
	return context.WithValue(ctx, principalKey{}, principal)
}

func PrincipalFromContext(ctx context.Context) (Principal, bool) {
	principal, ok := ctx.Value(principalKey{}).(Principal)
	return principal, ok && principal.CredentialID != ""
}

// LiveSQL is the predicate that keeps a credential valid, for queries that
// join agent_access_credentials as credential with the Agent's active
// agent_registrations row as registration. A Computer credential lasts until
// the placement it was issued for changes; an in-process credential lasts
// until its expiry. Revocation sets expires_at.
const LiveSQL = `(credential.expires_at IS NULL OR credential.expires_at>clock_timestamp())
 AND (credential.assignment_revision IS NULL OR credential.assignment_revision=registration.assignment_revision)`

// RevalidateInTx checks the durable credential again at the business commit,
// after computations or uploads that ran outside the transaction.
func RevalidateInTx(ctx context.Context, tx interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, principal Principal) error {
	var valid bool
	err := tx.QueryRow(ctx, `SELECT true FROM agent_access_credentials credential JOIN agent_registrations registration
 ON registration.actor_id=credential.agent_actor_id AND registration.tenant_id=credential.tenant_id
 AND registration.agent_management_id=credential.agent_management_id AND registration.status='active'
 WHERE credential.id=$1 AND credential.tenant_id=$2 AND credential.agent_actor_id=$3
 AND credential.agent_management_id=$4
 AND `+LiveSQL+` AND ($5::bytea IS NULL OR credential.token_hash=$5)
 FOR SHARE OF credential,registration`, principal.CredentialID, principal.TenantID, principal.AgentActorID, principal.AgentID, principal.tokenHash).Scan(&valid)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInvalid
	}
	return err
}

type Issued struct {
	CredentialID string `json:"credential_id"`
	AccessToken  string `json:"access_token"`
	AgentID      string `json:"agent_id"`
	TenantID     string `json:"tenant_id"`
}

type Service struct{ pool *pgxpool.Pool }

func New(pool *pgxpool.Pool) *Service { return &Service{pool: pool} }

// ExpectedPlacement is the Computer and workspace grant the Runner Gateway
// installs a credential on. Issuance refuses a placement the registration no
// longer names, so a Computer the Agent moved away from cannot obtain a token.
type ExpectedPlacement struct {
	ComputerID       string
	WorkspaceGrantID string
}

// maxInProcessTTL bounds every credential that no placement binds, so an
// in-process caller can never create a token that only deletion ends.
const maxInProcessTTL = 48 * time.Hour

// IssueManaged issues a credential that no placement binds, for in-process
// callers such as fixtures. It expires like any in-process credential. The
// Runner Gateway's HTTP contract always names a placement and uses
// EnsureManagedForPlacement.
func (s *Service) IssueManaged(ctx context.Context, agentID, label string) (Issued, error) {
	return s.IssueManagedFor(ctx, agentID, label, maxInProcessTTL)
}

// IssueManagedFor issues a credential for an in-process caller that acts as
// the Agent for a short while, such as a live voice call writing a canvas.
func (s *Service) IssueManagedFor(ctx context.Context, agentID, label string, ttl time.Duration) (Issued, error) {
	if ttl <= 0 || ttl > maxInProcessTTL {
		return Issued{}, ErrInvalid
	}
	issued, _, err := s.issueManaged(ctx, agentID, label, nil, nil, ttl)
	return issued, err
}

// EnsureManagedForPlacement makes sure the Agent's Computer holds the one
// credential bound to the Agent's current Runtime Assignment. When heldSHA256
// is the token hash of that live credential, nothing is issued and current is
// true. Otherwise it issues a new one and revokes every earlier placement
// credential of the Agent, including a held one TeamHub no longer accepts.
// Moving the Agent to another Computer, Runtime or workspace grant
// invalidates the credential in the transaction that changes the
// registration row, and deleting the Agent invalidates it with the
// registration; it does not expire otherwise.
func (s *Service) EnsureManagedForPlacement(ctx context.Context, agentID, label string, expected ExpectedPlacement, heldSHA256 []byte) (issued Issued, current bool, err error) {
	if expected.ComputerID == "" || expected.WorkspaceGrantID == "" || (heldSHA256 != nil && len(heldSHA256) != sha256.Size) {
		return Issued{}, false, ErrInvalid
	}
	return s.issueManaged(ctx, agentID, label, &expected, heldSHA256, 0)
}

// RevokeAgent ends every credential of the Agent at once, for an operator
// who suspects a leak. The Agent's Computer receives a new credential when the
// Runner Gateway next checks what it holds, at its next connection.
func (s *Service) RevokeAgent(ctx context.Context, agentID string) (int64, error) {
	if s == nil || s.pool == nil || agentID == "" {
		return 0, ErrInvalid
	}
	tag, err := s.pool.Exec(ctx, `UPDATE agent_access_credentials SET expires_at=clock_timestamp()
 WHERE agent_management_id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp())`, agentID)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// issueManaged binds the credential to the current assignment when a
// placement is expected, and gives it an expiry when ttl is positive.
func (s *Service) issueManaged(ctx context.Context, agentID, label string, expected *ExpectedPlacement, heldSHA256 []byte, ttl time.Duration) (Issued, bool, error) {
	if s == nil || s.pool == nil || agentID == "" || label == "" || len(label) > 128 || !utf8.ValidString(label) {
		return Issued{}, false, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Issued{}, false, err
	}
	defer tx.Rollback(ctx)
	// The shared registration lock orders issuance with Agent deactivation and
	// with a placement move, which commits its new assignment under this lock.
	var actorID, tenantID, computerID, workspaceGrantID string
	var assignmentRevision int64
	err = tx.QueryRow(ctx, `SELECT actor_id,tenant_id,COALESCE(computer_id,''),COALESCE(workspace_grant_id,''),assignment_revision
 FROM agent_registrations WHERE agent_management_id=$1 AND status='active' FOR SHARE`, agentID).Scan(
		&actorID, &tenantID, &computerID, &workspaceGrantID, &assignmentRevision)
	if errors.Is(err, pgx.ErrNoRows) {
		return Issued{}, false, ErrForbidden
	}
	if err != nil {
		return Issued{}, false, err
	}
	var boundRevision *int64
	if expected != nil {
		if expected.ComputerID != computerID || expected.WorkspaceGrantID != workspaceGrantID {
			return Issued{}, false, ErrForbidden
		}
		boundRevision = &assignmentRevision
		if heldSHA256 != nil {
			var live bool
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_access_credentials
 WHERE agent_management_id=$1 AND tenant_id=$2 AND assignment_revision=$3 AND expires_at IS NULL AND token_hash=$4)`,
				agentID, tenantID, assignmentRevision, heldSHA256).Scan(&live)
			if err != nil {
				return Issued{}, false, err
			}
			if live {
				return Issued{AgentID: agentID, TenantID: tenantID}, true, nil
			}
		}
		if _, err = tx.Exec(ctx, `UPDATE agent_access_credentials SET expires_at=clock_timestamp()
 WHERE agent_management_id=$1 AND tenant_id=$2 AND assignment_revision IS NOT NULL AND expires_at IS NULL`, agentID, tenantID); err != nil {
			return Issued{}, false, err
		}
	}
	token, digest, err := newToken()
	if err != nil {
		return Issued{}, false, err
	}
	id, err := newCredentialID()
	if err != nil {
		return Issued{}, false, err
	}
	var ttlSeconds *float64
	if ttl > 0 {
		seconds := ttl.Seconds()
		ttlSeconds = &seconds
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_access_credentials(id,token_hash,tenant_id,agent_actor_id,agent_management_id,label,assignment_revision,expires_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+make_interval(secs=>$8::double precision))`,
		id, digest, tenantID, actorID, agentID, label, boundRevision, ttlSeconds); err != nil {
		return Issued{}, false, err
	}
	if err = tx.Commit(ctx); err != nil {
		return Issued{}, false, err
	}
	return Issued{CredentialID: id, AccessToken: token, AgentID: agentID, TenantID: tenantID}, false, nil
}

func Authenticate(ctx context.Context, pool *pgxpool.Pool, token string) (Principal, error) {
	if pool == nil {
		return Principal{}, ErrInvalid
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Principal{}, err
	}
	defer tx.Rollback(ctx)
	principal, err := AuthenticateInTx(ctx, tx, token)
	if err != nil {
		return Principal{}, err
	}
	return principal, tx.Commit(ctx)
}

// The shared row locks keep Agent deactivation ordered with a business
// transaction that authorizes and commits using this principal.
func AuthenticateInTx(ctx context.Context, tx pgx.Tx, token string) (Principal, error) {
	if tx == nil || !ValidToken(token) {
		return Principal{}, ErrInvalid
	}
	digest := sha256.Sum256([]byte(token))
	var p Principal
	err := tx.QueryRow(ctx, `SELECT credential.id,registration.tenant_id,registration.actor_id,
 registration.agent_management_id,registration.agent_type,COALESCE(registration.user_artifact_owner_actor_id,''),
 registration.created_by_actor_id
 FROM agent_access_credentials credential JOIN agent_registrations registration
 ON registration.actor_id=credential.agent_actor_id AND registration.tenant_id=credential.tenant_id
 AND registration.agent_management_id=credential.agent_management_id AND registration.status='active'
 WHERE credential.token_hash=$1 AND `+LiveSQL+`
 FOR SHARE OF credential,registration`, digest[:]).Scan(
		&p.CredentialID, &p.TenantID, &p.AgentActorID, &p.AgentID, &p.AgentType, &p.UserArtifactOwnerActorID, &p.SponsorActorID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Principal{}, ErrInvalid
	}
	if err != nil {
		return Principal{}, err
	}
	p.tokenHash = append([]byte(nil), digest[:]...)
	if err := validateExpectedIdentity(ctx, p); err != nil {
		return Principal{}, err
	}
	return p, nil
}

func ValidToken(token string) bool {
	if !strings.HasPrefix(token, "th_agent_") || len(token) != 52 {
		return false
	}
	value, err := base64.RawURLEncoding.DecodeString(token[9:])
	return err == nil && len(value) == 32 && base64.RawURLEncoding.EncodeToString(value) == token[9:]
}
func newToken() (string, []byte, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", nil, err
	}
	token := "th_agent_" + base64.RawURLEncoding.EncodeToString(raw[:])
	digest := sha256.Sum256([]byte(token))
	return token, digest[:], nil
}

func newCredentialID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return "agent_credential_" + hex.EncodeToString(raw[:]), nil
}

type expectedIdentityKey struct{}
type expectedIdentity struct{ TenantID, AgentID string }

func WithExpectedIdentity(ctx context.Context, tenantID, agentID string) context.Context {
	return context.WithValue(ctx, expectedIdentityKey{}, expectedIdentity{tenantID, agentID})
}
func validateExpectedIdentity(ctx context.Context, p Principal) error {
	expected, _ := ctx.Value(expectedIdentityKey{}).(expectedIdentity)
	if (expected.TenantID != "" && expected.TenantID != p.TenantID) || (expected.AgentID != "" && expected.AgentID != p.AgentID) {
		return ErrForbidden
	}
	return nil
}

// Authenticate resolves a live Agent credential to its Principal.
func (s *Service) Authenticate(ctx context.Context, token string) (Principal, error) {
	return Authenticate(ctx, s.pool, token)
}
