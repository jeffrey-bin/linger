package account

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

var ErrInvalidPasswordChange = errors.New("invalid password change")
var ErrInvalidCurrentPassword = errors.New("incorrect current password")
var ErrInactiveSession = errors.New("inactive session")

const passwordChangeWindow = 10 * time.Minute
const passwordChangeLimit = 5

type PasswordChange struct {
	AccountID       string
	SessionID       string
	CurrentPassword string
	NewPassword     string
}

func validPasswordChange(input PasswordChange) bool {
	return input.AccountID != "" && input.SessionID != "" && input.CurrentPassword != "" && len(input.CurrentPassword) <= PasswordMaxBytes && ValidNewPassword(input.NewPassword)
}

// ChangePassword serializes with login and set-password on the Account row, then
// locks and rechecks the authenticated Session. Never reverse this lock order.
func (l *Lifecycle) ChangePassword(ctx context.Context, input PasswordChange) error {
	if !validPasswordChange(input) {
		return ErrInvalidPasswordChange
	}
	tx, err := l.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var passwordHash string
	var windowStarted *time.Time
	var attempts *int
	err = tx.QueryRow(ctx, `select password_hash,password_change_window_started_at,password_change_attempts from accounts where id=$1 for update`, input.AccountID).Scan(&passwordHash, &windowStarted, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInactiveSession
	}
	if err != nil {
		return err
	}
	// Lock before checking time: a Session may expire or be revoked while waiting.
	var expiresAt time.Time
	var revokedAt *time.Time
	err = tx.QueryRow(ctx, `select expires_at,revoked_at from auth_sessions where id=$1 and account_id=$2 for update`, input.SessionID, input.AccountID).Scan(&expiresAt, &revokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrInactiveSession
	}
	if err != nil {
		return err
	}
	var now time.Time
	if err := tx.QueryRow(ctx, `select clock_timestamp()`).Scan(&now); err != nil {
		return err
	}
	if revokedAt != nil || !expiresAt.After(now) {
		return ErrInactiveSession
	}

	// PostgreSQL is the shared rate-limit authority. The window lives on the
	// locked Account row. Invalid passwords commit the attempt without touching
	// the credential or Sessions; operational errors roll back.
	windowStart, used := now, 0
	if windowStarted != nil && windowStarted.Add(passwordChangeWindow).After(now) {
		if *attempts >= passwordChangeLimit {
			return &RateLimitError{RetryAfter: windowStarted.Add(passwordChangeWindow).Sub(now)}
		}
		windowStart, used = *windowStarted, *attempts
	}
	if _, err := tx.Exec(ctx, `update accounts set password_change_window_started_at=$2,password_change_attempts=$3 where id=$1`, input.AccountID, windowStart, used+1); err != nil {
		return err
	}
	verified, err := VerifyPassword(input.CurrentPassword, passwordHash)
	if err != nil {
		return err
	}
	if !verified {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return ErrInvalidCurrentPassword
	}
	replacement, err := HashPassword(input.NewPassword)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `update accounts set password_hash=$2 where id=$1`, input.AccountID, replacement); err != nil {
		return err
	}
	// Reuse the existing revocation reason so old running versions understand it.
	if _, err := tx.Exec(ctx, `update auth_sessions set revoked_at=clock_timestamp(),revoked_reason='password_reset'
 where account_id=$1 and id<>$2 and revoked_at is null`, input.AccountID, input.SessionID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
