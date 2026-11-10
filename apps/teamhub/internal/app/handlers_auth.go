package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// login checks the client address's failure count, verifies the password with
// a hash permit and no database lock, and only then locks the Account row
// briefly to recheck the verified hash and create the Session.
func (a *App) login(c *gin.Context) {
	var request httpapi.LoginRequest
	if err := decodeJSON(c, &request); err != nil || request.Password == nil || len(*request.Password) == 0 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "email and password are required")
		return
	}
	if len(*request.Password) > account.PasswordMaxBytes {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", fmt.Sprintf("password must be at most %d bytes", account.PasswordMaxBytes))
		return
	}
	identifier := strings.TrimSpace(request.Identifier)
	if identifier == "" || len(identifier) > 320 {
		a.writeError(c, http.StatusBadRequest, "INVALID_REQUEST", "email and password are required")
		return
	}
	address := c.GetString(clientAddressKey)
	if wait := a.loginFailures.retryAfter(address); wait > 0 {
		writeRetryAfter(c, wait)
		a.writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "too many failed sign-in attempts; try again later")
		return
	}
	ctx := c.Request.Context()
	accountRow, err := a.sessions.AccountByEmail(ctx, identifier)
	found := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		a.internalError(c, "load account", err)
		return
	}
	release, err := a.passwordHashes.Acquire(ctx)
	if errors.Is(err, account.ErrHashBusy) {
		writeRetryAfter(c, time.Second)
		a.writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "too many password checks are in progress; try again")
		return
	}
	if err != nil {
		a.internalError(c, "acquire login hash permit", err)
		return
	}
	verified := false
	if found {
		verified, _ = a.verifyPassword(*request.Password, accountRow.PasswordHash)
	} else {
		// Run one Argon2id computation with default parameters for a nonexistent account, so login timing does not reveal whether the account exists.
		_, _ = account.HashPassword(*request.Password)
	}
	release()
	if !verified {
		a.loginFailures.fail(address)
		a.writeError(c, http.StatusUnauthorized, "INVALID_CREDENTIALS", "email or password is incorrect")
		return
	}
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		a.internalError(c, "generate session token", err)
		return
	}
	expiresAt := time.Now().UTC().Add(a.cfg.SessionTTL)
	// The database stores only the token digest; the random raw token is returned to the client only in an HttpOnly Cookie.
	created, err := a.sessions.Create(ctx, accountRow.ID, accountRow.PasswordHash, tokenDigest(token), expiresAt)
	if errors.Is(err, account.ErrStaleCredentials) {
		// A password changed since the unlocked read means the verified one is stale.
		a.loginFailures.fail(address)
		a.writeError(c, http.StatusUnauthorized, "INVALID_CREDENTIALS", "email or password is incorrect")
		return
	}
	if err != nil {
		a.internalError(c, "create session", err)
		return
	}
	a.loginFailures.succeed(address)
	session := store.GetActiveSessionRow{
		ID: created.ID, AccountID: accountRow.ID, CreatedAt: created.CreatedAt,
		ExpiresAt: created.ExpiresAt, Email: accountRow.Email, AccountCreatedAt: accountRow.CreatedAt,
	}
	a.writeAuthenticatedSession(c, http.StatusOK, session, token)
}

func writeRetryAfter(c *gin.Context, wait time.Duration) {
	c.Header("Retry-After", strconv.Itoa(max(1, int(math.Ceil(wait.Seconds())))))
}

func (a *App) writeAuthenticatedSession(c *gin.Context, status int, session store.GetActiveSessionRow, token []byte) {
	model, err := a.sessionModel(c.Request.Context(), session)
	if err != nil {
		a.internalError(c, "resolve session identity", err)
		return
	}
	expiresAt := session.ExpiresAt.Time
	a.setSessionCookie(c, token, expiresAt)
	c.JSON(status, model)
}

func (a *App) setSessionCookie(c *gin.Context, token []byte, expiresAt time.Time) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name: a.cfg.CookieName, Value: hex.EncodeToString(token), Path: "/",
		Expires: expiresAt, MaxAge: max(1, int(time.Until(expiresAt).Seconds())), HttpOnly: true,
		Secure: a.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
}

func (a *App) logout(c *gin.Context) {
	if value, err := c.Cookie(a.cfg.CookieName); err == nil {
		if token, decodeErr := hex.DecodeString(value); decodeErr == nil && len(token) == 32 {
			if err := a.sessions.Revoke(c.Request.Context(), tokenDigest(token)); err != nil {
				a.internalError(c, "revoke session", err)
				return
			}
		}
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name: a.cfg.CookieName, Value: "", Path: "/", MaxAge: -1,
		Expires: time.Unix(1, 0), HttpOnly: true, Secure: a.cfg.CookieSecure, SameSite: http.SameSiteLaxMode,
	})
	c.Status(http.StatusNoContent)
}

// Only explicit foreground activity renews a Session; reads and stream heartbeats do not.
func (a *App) renewSession(c *gin.Context) {
	principal := currentPrincipal(c)
	session, err := a.sessions.Renew(c.Request.Context(), principal.Token, a.cfg.SessionTTL)
	if errors.Is(err, pgx.ErrNoRows) {
		a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication is invalid or expired")
		return
	}
	if err != nil {
		a.internalError(c, "renew session", err)
		return
	}
	value, _ := c.Cookie(a.cfg.CookieName)
	token, _ := hex.DecodeString(value)
	c.Header("Cache-Control", "no-store")
	a.writeAuthenticatedSession(c, http.StatusOK, session, token)
}

func (a *App) getSession(c *gin.Context) {
	model, err := a.sessionModel(c.Request.Context(), currentPrincipal(c).Session)
	if err != nil {
		a.internalError(c, "resolve session", err)
		return
	}
	c.JSON(http.StatusOK, model)
}

func (a *App) getCurrentIdentity(c *gin.Context) {
	model, err := a.identity(c.Request.Context(), currentPrincipal(c).Session)
	if err != nil {
		a.internalError(c, "resolve identity", err)
		return
	}
	c.JSON(http.StatusOK, model)
}

func decodeJSON(c *gin.Context, target any) error {
	return decodeStrictJSON(http.MaxBytesReader(c.Writer, c.Request.Body, 1<<20), target, "request body must contain one JSON object")
}

func decodeStrictJSON(reader io.Reader, target any, multipleValueMessage string) error {
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New(multipleValueMessage)
	}
	return nil
}

func (a *App) internalError(c *gin.Context, action string, err error) {
	requestID, _ := c.Get("request_id")
	// A client disconnect is expected only if the request itself was canceled
	// and every error cause is cancellation. Keep mixed failures visible.
	if c.Request.Context().Err() == context.Canceled && onlyRuntimeCancellation(err) {
		a.logger.Info(action, "request_id", requestID, "outcome", "request_canceled")
		c.Set("request_canceled", true)
		c.Abort()
		return
	}
	a.logger.Error(action, "request_id", requestID, "error", err)
	a.writeError(c, http.StatusInternalServerError, "INTERNAL_ERROR", "an unexpected error occurred")
}
