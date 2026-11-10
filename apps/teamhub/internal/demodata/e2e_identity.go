package demodata

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
)

var e2eRunIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,63}$`)

type E2EIdentityConfig struct {
	Enabled     bool
	RunID       string
	Email       string
	Password    string
	DisplayName string
}

type E2EIdentity struct {
	AccountID string
	TenantID  string
	ActorID   string
}

func SeedE2EIdentity(ctx context.Context, databaseURL string, config E2EIdentityConfig) (E2EIdentity, error) {
	if err := validateE2EIdentityConfig(config); err != nil {
		return E2EIdentity{}, err
	}
	config.Email = strings.ToLower(strings.TrimSpace(config.Email))
	config.DisplayName = strings.TrimSpace(config.DisplayName)
	result := e2eIdentityForRun(config.RunID)

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return E2EIdentity{}, err
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		return E2EIdentity{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, "select pg_advisory_xact_lock(hashtextextended($1, 0))", "e2e-identity:"+config.RunID); err != nil {
		return E2EIdentity{}, err
	}

	existing, err := existingE2EIdentity(ctx, tx, result, config)
	if err != nil {
		return E2EIdentity{}, err
	}
	if existing {
		return result, tx.Commit(ctx)
	}

	passwordHash, err := account.HashPassword(config.Password)
	if err != nil {
		return E2EIdentity{}, fmt.Errorf("hash E2E identity password: %w", err)
	}
	now := time.Now().UTC()
	if _, err := tx.Exec(ctx, `insert into accounts(id,email,password_hash,created_at)
		values($1,$2,$3,$4)`, result.AccountID, config.Email, passwordHash, now); err != nil {
		return E2EIdentity{}, fmt.Errorf("create E2E account: %w", err)
	}
	if _, err := tx.Exec(ctx, `insert into actors(id,tenant_id,kind,display_name,account_id,created_at)
		values($1,$2,'human',$3,$4,$5)`, result.ActorID, result.TenantID, config.DisplayName, result.AccountID, now); err != nil {
		return E2EIdentity{}, fmt.Errorf("create E2E Human actor: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return E2EIdentity{}, err
	}
	return result, nil
}

func validateE2EIdentityConfig(config E2EIdentityConfig) error {
	if !config.Enabled {
		return errors.New("E2E identity provisioning is disabled")
	}
	if !e2eRunIDPattern.MatchString(config.RunID) {
		return errors.New("E2E identity run ID must contain only lowercase letters, digits, and hyphens")
	}
	email := strings.ToLower(strings.TrimSpace(config.Email))
	parsed, err := mail.ParseAddress(email)
	if err != nil || parsed.Address != email || len(email) > 320 {
		return errors.New("E2E identity email is invalid")
	}
	if !account.ValidNewPassword(config.Password) {
		return errors.New("E2E identity password length is invalid")
	}
	displayName := strings.TrimSpace(config.DisplayName)
	if displayName == "" || len(displayName) > 100 {
		return errors.New("E2E identity display name is invalid")
	}
	return nil
}

func e2eIdentityForRun(runID string) E2EIdentity {
	digest := sha256.Sum256([]byte(runID))
	suffix := hex.EncodeToString(digest[:10])
	return E2EIdentity{
		AccountID: "account_e2e_" + suffix,
		TenantID:  "tenant_e2e_" + suffix,
		ActorID:   "actor_e2e_" + suffix,
	}
}

func existingE2EIdentity(ctx context.Context, tx pgx.Tx, result E2EIdentity, config E2EIdentityConfig) (bool, error) {
	var email, passwordHash, tenantID, actorID, actorDisplayName string
	err := tx.QueryRow(ctx, `
		select account.email,account.password_hash,actor.tenant_id,actor.id,actor.display_name
		from accounts account
		join actors actor on actor.account_id=account.id and actor.tenant_id=$2 and actor.kind='human'
		where account.id=$1 and actor.id=$3`, result.AccountID, result.TenantID, result.ActorID).
		Scan(&email, &passwordHash, &tenantID, &actorID, &actorDisplayName)
	if errors.Is(err, pgx.ErrNoRows) {
		var conflict bool
		if err := tx.QueryRow(ctx, `select exists(
			select 1 from accounts where id=$1 or lower(email)=lower($4)
			union all select 1 from actors where tenant_id=$2
			union all select 1 from actors where id=$3
		)`, result.AccountID, result.TenantID, result.ActorID, config.Email).Scan(&conflict); err != nil {
			return false, err
		}
		if conflict {
			return false, errors.New("E2E identity conflicts with existing data")
		}
		return false, nil
	}
	if err != nil {
		return false, err
	}
	verified, err := account.VerifyPassword(config.Password, passwordHash)
	if err != nil {
		return false, err
	}
	if !strings.EqualFold(email, config.Email) || tenantID != result.TenantID || actorID != result.ActorID || actorDisplayName != config.DisplayName || !verified {
		return false, errors.New("E2E identity conflicts with existing data")
	}
	return true, nil
}
