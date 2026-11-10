package account

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// ErrStaleCredentials reports that the Account's password changed, or the
// Account disappeared, after the caller verified the password.
var ErrStaleCredentials = errors.New("verified credentials are stale")

var sessionMaxLifetime = pgtype.Interval{Microseconds: config.SessionMaxLifetime.Microseconds(), Valid: true}

// Sessions stores browser Sessions by token digest; the raw token never
// reaches the database.
type Sessions struct {
	pool    *pgxpool.Pool
	queries *store.Queries
}

// NewSessions builds the Session store.
func NewSessions(pool *pgxpool.Pool) *Sessions {
	return &Sessions{pool: pool, queries: store.New(pool)}
}

// AccountByEmail reads the Account a sign-in names. It reports
// pgx.ErrNoRows for an unknown address.
func (s *Sessions) AccountByEmail(ctx context.Context, email string) (store.GetAccountByEmailRow, error) {
	return s.queries.GetAccountByEmail(ctx, email)
}

// Create starts a Session for an Account whose password hash the caller
// verified. It locks the Account row and reports ErrStaleCredentials when the
// hash changed since the unlocked read.
func (s *Sessions) Create(ctx context.Context, accountID, verifiedHash string, digest []byte, expiresAt time.Time) (store.CreateSessionRow, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return store.CreateSessionRow{}, fmt.Errorf("begin login: %w", err)
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	currentHash, err := queries.LockAccountPasswordHash(ctx, accountID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && currentHash != verifiedHash) {
		return store.CreateSessionRow{}, ErrStaleCredentials
	}
	if err != nil {
		return store.CreateSessionRow{}, fmt.Errorf("lock account: %w", err)
	}
	created, err := queries.CreateSession(ctx, store.CreateSessionParams{
		ID: idgen.New("session"), AccountID: accountID, TokenHash: digest,
		ExpiresAt:   pgtype.Timestamptz{Time: expiresAt, Valid: true},
		MaxLifetime: sessionMaxLifetime,
	})
	if err != nil {
		return store.CreateSessionRow{}, fmt.Errorf("create session: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return store.CreateSessionRow{}, fmt.Errorf("commit login: %w", err)
	}
	return created, nil
}

// Active reads the live Session of a token digest. It reports pgx.ErrNoRows
// for an expired, revoked or unknown token.
func (s *Sessions) Active(ctx context.Context, digest []byte) (store.GetActiveSessionRow, error) {
	return s.queries.GetActiveSession(ctx, digest)
}

// Revoke ends the Session of a token digest.
func (s *Sessions) Revoke(ctx context.Context, digest []byte) error {
	return s.queries.RevokeSession(ctx, digest)
}

// Renew extends an idle Session by ttl at most once per renewal interval and
// rereads it, because a logout or password reset may have raced the update.
// It reports pgx.ErrNoRows when the Session is no longer live.
func (s *Sessions) Renew(ctx context.Context, digest []byte, ttl time.Duration) (store.GetActiveSessionRow, error) {
	_, err := s.queries.RenewSession(ctx, store.RenewSessionParams{
		TokenHash:       digest,
		IdleTtl:         pgtype.Interval{Microseconds: ttl.Microseconds(), Valid: true},
		RenewalInterval: pgtype.Interval{Microseconds: min(5*time.Minute, ttl/10).Microseconds(), Valid: true},
		MaxLifetime:     sessionMaxLifetime,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return store.GetActiveSessionRow{}, fmt.Errorf("renew session: %w", err)
	}
	session, err := s.queries.GetActiveSession(ctx, digest)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return store.GetActiveSessionRow{}, fmt.Errorf("load renewed session: %w", err)
	}
	return session, err
}

// Actors lists the Actors of an Account.
func (s *Sessions) Actors(ctx context.Context, accountID string) ([]store.Actor, error) {
	return s.queries.ListActorsForAccount(ctx, pgtype.Text{String: accountID, Valid: true})
}
