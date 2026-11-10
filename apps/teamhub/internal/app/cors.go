package app

import (
	"net"
	"net/http"
	"net/url"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func (a *App) cors() gin.HandlerFunc {
	allowed := make(map[string]struct{}, len(a.cfg.CORSAllowedOrigins))
	for _, origin := range a.cfg.CORSAllowedOrigins {
		allowed[origin] = struct{}{}
	}
	return func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin == "" {
			c.Next()
			return
		}
		canonicalOrigins, err := config.ParseCORSAllowedOrigins(origin)
		if err != nil || len(canonicalOrigins) != 1 {
			c.Next()
			return
		}
		_, explicitlyAllowed := allowed[canonicalOrigins[0]]
		if !explicitlyAllowed && !isPrivateNetworkOrigin(canonicalOrigins[0]) {
			c.Next()
			return
		}
		// CORS with credentials cannot use a wildcard; only the verified exact Origin is reflected, and Vary
		// stops shared caches from reusing one Origin's allowed response for another Origin.
		c.Header("Access-Control-Allow-Origin", origin)
		c.Header("Access-Control-Allow-Credentials", "true")
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header(
			"Access-Control-Allow-Headers",
			"Content-Type, Idempotency-Key, If-Range, Range, X-Request-ID, X-Chunk-Started-At-Ms, X-Chunk-Duration-Ms, X-Chunk-SHA256, X-Chunk-Size-Bytes",
		)
		c.Header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, ETag, X-Content-SHA256, Idempotent-Replay, Retry-After, X-Request-ID")
		c.Header("Access-Control-Max-Age", "600")
		c.Header("Vary", "Origin")
		if c.Request.Method == http.MethodOptions {
			c.Status(http.StatusNoContent)
			c.Abort()
			return
		}
		c.Next()
	}
}

func isPrivateNetworkOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil {
		return false
	}
	hostname := parsed.Hostname()
	if hostname == "localhost" {
		return true
	}
	ip := net.ParseIP(hostname)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
}
