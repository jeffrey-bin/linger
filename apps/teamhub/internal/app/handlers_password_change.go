package app

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func (a *App) changePassword(c *gin.Context) {
	principal := currentPrincipal(c)
	var request httpapi.PasswordChangeRequest
	if err := decodeJSON(c, &request); err != nil || request.CurrentPassword == nil || request.NewPassword == nil {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "password change fields are invalid")
		return
	}
	if !account.ValidNewPassword(*request.NewPassword) {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", fmt.Sprintf("Password must be between %d and %d bytes", account.PasswordMinBytes, account.PasswordMaxBytes))
		return
	}
	// Take the hash permit before the transaction locks the Account row. Login
	// returns its permit before it locks the row, so the two never wait on each other.
	release, err := a.passwordHashes.Acquire(c.Request.Context())
	if err == nil {
		err = a.accounts.ChangePassword(c.Request.Context(), account.PasswordChange{
			AccountID: principal.Session.AccountID, SessionID: principal.Session.ID,
			CurrentPassword: *request.CurrentPassword, NewPassword: *request.NewPassword,
		})
		release()
	}
	outcome := "changed"
	var limited *account.RateLimitError
	switch {
	case errors.Is(err, account.ErrHashBusy):
		outcome = "hash_busy"
		writeRetryAfter(c, time.Second)
		a.writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "too many password checks are in progress; try again")
	case errors.Is(err, account.ErrInvalidPasswordChange):
		outcome = "invalid_request"
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "password change fields are invalid")
	case errors.Is(err, account.ErrInvalidCurrentPassword):
		outcome = "invalid_current_password"
		a.writeError(c, http.StatusBadRequest, "INVALID_CURRENT_PASSWORD", "current password is incorrect")
	case errors.Is(err, account.ErrInactiveSession):
		outcome = "inactive_session"
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication is invalid or expired")
	case errors.As(err, &limited):
		outcome = "rate_limited"
		writeRetryAfter(c, limited.RetryAfter)
		a.writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "wait before changing the password again")
	case err != nil:
		outcome = "failed"
		// Database errors may contain row values. Do not log raw errors or credentials.
		a.writeError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "an unexpected error occurred")
	default:
		c.Status(http.StatusNoContent)
	}
	a.logger.Info("account password change", "account_id", principal.Session.AccountID, "session_id", principal.Session.ID, "outcome", outcome)
}
