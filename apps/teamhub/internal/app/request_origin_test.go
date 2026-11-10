package app

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestRequestOriginLogs(t *testing.T) {
	for _, code := range []int{200, 304, 401, 499} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			var logs bytes.Buffer
			a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			engine := gin.New()
			engine.Use(a.requestContext())
			engine.GET("/test", func(c *gin.Context) {
				if code == 499 {
					a.internalError(c, "test", context.Canceled)
				} else {
					c.Status(code)
				}
			})
			request := httptest.NewRequest(http.MethodGet, "/test?token=hidden", nil)
			request.RemoteAddr = "[2001:db8::1]:8080"
			request.Header.Set("User-Agent", "memory\x01\n"+strings.Repeat("x", 600))
			request.Header.Set("X-Forwarded-For", "203.0.113.1")
			request.Header.Set("Traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
			request.Header.Set("Authorization", "Bearer hidden")
			request.Header.Set("Cookie", "hidden")
			request.Header.Set("Baggage", "hidden")
			if code == 499 {
				ctx, cancel := context.WithCancel(request.Context())
				cancel()
				request = request.WithContext(ctx)
			}
			engine.ServeHTTP(httptest.NewRecorder(), request)
			lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
			var entry map[string]any
			if err := json.Unmarshal([]byte(lines[len(lines)-1]), &entry); err != nil {
				t.Fatal(err)
			}
			if entry["peer_ip"] != "2001:db8::1" || entry["client_ip"] != "2001:db8::1" || entry["traceparent"] != request.Header.Get("Traceparent") {
				t.Fatalf("origin fields: %v", entry)
			}
			ua, ok := entry["user_agent"].(string)
			if !ok || len(ua) > 512 || strings.ContainsAny(ua, "\x01\n") {
				t.Fatalf("unsafe UA: %q", ua)
			}
			if strings.Contains(logs.String(), "hidden") {
				t.Fatal("secret leaked")
			}
		})
	}
}

func TestRequestOriginTrustedProxyChain(t *testing.T) {
	for _, tc := range []struct{ peer, forwarded, want string }{
		{"10.0.0.1:80", "198.51.100.1, 10.1.0.1", "198.51.100.1"},
		{"10.0.0.1:80", "198.51.100.1, 203.0.113.1", "203.0.113.1"},
		{"[::1]:80", "2001:db8::5, ::1", "2001:db8::5"},
		{"10.0.0.1:80", "bad, 10.1.0.1", "10.0.0.1"},
		{"10.0.0.1:80", strings.Repeat("1", 9000), "10.0.0.1"},
	} {
		var logs bytes.Buffer
		a := &App{cfg: config.ForTest(func(c *config.Config) {
			c.TrustedProxies = []string{"10.0.0.0/8", "::1/128"}
		}), logger: slog.New(slog.NewJSONHandler(&logs, nil))}
		engine := gin.New()
		engine.Use(a.requestContext())
		engine.GET("/test", func(c *gin.Context) { c.Status(200) })
		r := httptest.NewRequest(http.MethodGet, "/test", nil)
		r.RemoteAddr = tc.peer
		r.Header.Set("X-Forwarded-For", tc.forwarded)
		r.Header.Set("Traceparent", "00-"+strings.Repeat("0", 32)+"-2222222222222222-01")
		engine.ServeHTTP(httptest.NewRecorder(), r)
		var entry map[string]any
		if err := json.Unmarshal(logs.Bytes(), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["client_ip"] != tc.want || entry["traceparent"] != "" {
			t.Fatalf("origin fields: %v", entry)
		}
	}
}
