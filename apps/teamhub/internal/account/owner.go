package account

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidOwner = errors.New("owner email or password is invalid")
var ErrAccountNotFound = errors.New("account does not exist")

// ExistingAccountError reports that create-owner found the deployment's
// Account under another email.
type ExistingAccountError struct {
	Email string
}

func (e *ExistingAccountError) Error() string {
	return fmt.Sprintf("account %s already exists and a deployment has one Account; "+
		"use that email (OWNER_EMAIL for pnpm dev), or reset its password with set-password", e.Email)
}

// CreateDeploymentOwner provisions the deployment's only Account with its Human
// Actor in a new Space ID. Its Another Me is created when the Human's Computer
// first comes online. An existing Account with this email is left
// unchanged and reported with created=false, so repeated installs never reset
// a password; an Account under another email is refused with
// ExistingAccountError.
func CreateDeploymentOwner(ctx context.Context, pool *pgxpool.Pool, email, password string) (bool, error) {
	return createOwner(ctx, pool, email, password, true)
}

// CreateOwner provisions an owner Account like CreateDeploymentOwner but
// allows other Accounts, so tests can add owners to a database that already
// has one. Demo and E2E seeding insert their Accounts directly.
func CreateOwner(ctx context.Context, pool *pgxpool.Pool, email, password string) (bool, error) {
	return createOwner(ctx, pool, email, password, false)
}

func createOwner(ctx context.Context, pool *pgxpool.Pool, email, password string, onlyAccount bool) (bool, error) {
	email, err := normalizeEmail(email)
	if err != nil || !ValidNewPassword(password) {
		return false, ErrInvalidOwner
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	// One fixed key serializes every owner creation, so the check for another
	// Account and the insert cannot interleave with a concurrent run.
	if _, err := tx.Exec(ctx, "select pg_advisory_xact_lock(hashtextextended('owner-account', 0))"); err != nil {
		return false, err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from accounts where lower(email)=lower($1))`, email).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	if onlyAccount {
		var other string
		err := tx.QueryRow(ctx, `select email from accounts order by created_at, id limit 1`).Scan(&other)
		if err == nil {
			return false, &ExistingAccountError{Email: other}
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return false, err
		}
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return false, fmt.Errorf("hash password: %w", err)
	}
	if err := provisionOwner(ctx, tx, email, passwordHash, time.Now().UTC()); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

func provisionOwner(ctx context.Context, tx pgx.Tx, email, passwordHash string, now time.Time) error {
	name := email[:strings.IndexByte(email, '@')]
	ids := map[string]string{}
	for _, prefix := range []string{"account", "tenant", "actor"} {
		id, err := newRandomID(prefix)
		if err != nil {
			return err
		}
		ids[prefix] = id
	}
	if _, err := tx.Exec(ctx, `insert into accounts(id,email,password_hash,created_at)
		values($1,$2,$3,$4)`, ids["account"], email, passwordHash, now); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `insert into actors(id,tenant_id,kind,display_name,account_id,created_at)
		values($1,$2,'human',$3,$4,$5)`, ids["actor"], ids["tenant"], name, ids["account"], now)
	return err
}

// SetPassword replaces an Account password from the operator command line and
// revokes the Account's sessions. It is the reset path for a forgotten password.
func SetPassword(ctx context.Context, pool *pgxpool.Pool, email, password string) error {
	email, err := normalizeEmail(email)
	if err != nil || !ValidNewPassword(password) {
		return ErrInvalidOwner
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return fmt.Errorf("hash password: %w", err)
	}
	tx, err := pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	now := time.Now().UTC()
	var accountID string
	err = tx.QueryRow(ctx, "update accounts set password_hash=$2 where lower(email)=lower($1) returning id", email, passwordHash).Scan(&accountID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrAccountNotFound
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update auth_sessions set revoked_at=$2,revoked_reason='password_reset'
		where account_id=$1 and revoked_at is null`, accountID, now); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
