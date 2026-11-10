package app

import (
	"net/http"
	"regexp"

	"github.com/gin-gonic/gin"
)

var idempotencyKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`)

func (a *App) requireIdempotencyKey(c *gin.Context) (string, bool) {
	key := c.GetHeader("Idempotency-Key")
	if !idempotencyKeyPattern.MatchString(key) {
		a.writeError(c, http.StatusBadRequest, "INVALID_IDEMPOTENCY_KEY", "a valid Idempotency-Key is required")
		return "", false
	}
	return key, true
}
