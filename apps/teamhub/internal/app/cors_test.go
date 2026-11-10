package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestCORSAllowsConfiguredOriginAndPreflight(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.CORSAllowedOrigins = []string{"http://localhost:3000"}
	})}
	engine := gin.New()
	engine.Use(a.cors())
	engine.POST("/v0/messages", func(c *gin.Context) { c.Status(http.StatusCreated) })

	request := httptest.NewRequest(http.MethodOptions, "/v0/messages", nil)
	request.Header.Set("Origin", "http://localhost:3000")
	request.Header.Set("Access-Control-Request-Method", http.MethodPost)
	request.Header.Set(
		"Access-Control-Request-Headers",
		"content-type, idempotency-key, x-chunk-started-at-ms, x-chunk-duration-ms, x-chunk-sha256, x-chunk-size-bytes",
	)
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if response.Code != http.StatusNoContent {
		t.Fatalf("preflight status=%d want=%d", response.Code, http.StatusNoContent)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "http://localhost:3000" {
		t.Fatal("preflight did not allow configured origin")
	}
	if response.Header().Get("Access-Control-Allow-Credentials") != "true" {
		t.Fatal("preflight did not allow credentials")
	}
	for _, header := range []string{
		"X-Chunk-Started-At-Ms",
		"X-Chunk-Duration-Ms",
		"X-Chunk-SHA256",
		"X-Chunk-Size-Bytes",
	} {
		if !headerListContains(response.Header().Get("Access-Control-Allow-Headers"), header) {
			t.Fatalf("preflight did not allow Capture header %q", header)
		}
	}
}

func headerListContains(value, target string) bool {
	for _, candidate := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(candidate), target) {
			return true
		}
	}
	return false
}

func TestCORSAllowsArtifactRangePreflightAndExposesRangeMetadata(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{}
	engine := gin.New()
	engine.Use(a.cors())
	engine.GET("/v0/artifacts/:artifactID/content", func(c *gin.Context) {
		c.Header("Accept-Ranges", "bytes")
		c.Header("Content-Range", "bytes 0-3/8")
		c.Header("ETag", `"immutable-version"`)
		c.Status(http.StatusPartialContent)
	})

	origin := "http://10.0.0.5:31037"
	preflight := httptest.NewRequest(http.MethodOptions, "/v0/artifacts/artifact-1/content", nil)
	preflight.Header.Set("Origin", origin)
	preflight.Header.Set("Access-Control-Request-Method", http.MethodGet)
	preflight.Header.Set("Access-Control-Request-Headers", "range, if-range")
	preflightResponse := httptest.NewRecorder()
	engine.ServeHTTP(preflightResponse, preflight)

	if preflightResponse.Code != http.StatusNoContent {
		t.Fatalf("preflight status=%d want=%d", preflightResponse.Code, http.StatusNoContent)
	}
	for _, header := range []string{"Range", "If-Range"} {
		if !headerListContains(preflightResponse.Header().Get("Access-Control-Allow-Headers"), header) {
			t.Fatalf("preflight did not allow %s", header)
		}
	}

	request := httptest.NewRequest(http.MethodGet, "/v0/artifacts/artifact-1/content", nil)
	request.Header.Set("Origin", origin)
	request.Header.Set("Range", "bytes=0-3")
	request.Header.Set("If-Range", `"immutable-version"`)
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if response.Code != http.StatusPartialContent {
		t.Fatalf("range status=%d want=%d", response.Code, http.StatusPartialContent)
	}
	for _, header := range []string{"Accept-Ranges", "Content-Range", "ETag", "X-Content-SHA256"} {
		if !headerListContains(response.Header().Get("Access-Control-Expose-Headers"), header) {
			t.Fatalf("range response did not expose %s", header)
		}
	}
}

func TestCORSDoesNotAllowUnconfiguredOrigin(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.CORSAllowedOrigins = []string{"http://localhost:3000"}
	})}
	engine := gin.New()
	engine.Use(a.cors())
	engine.GET("/v0/session", func(c *gin.Context) { c.Status(http.StatusOK) })

	request := httptest.NewRequest(http.MethodGet, "/v0/session", nil)
	request.Header.Set("Origin", "http://evil.example.com")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("request status=%d want=%d", response.Code, http.StatusOK)
	}
	if response.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("unconfigured origin received CORS permission")
	}
}

func TestCORSAllowsPrivateNetworkOriginsOnAnyPort(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{}
	engine := gin.New()
	engine.Use(a.cors())
	engine.GET("/v0/session", func(c *gin.Context) { c.Status(http.StatusOK) })

	for _, origin := range []string{"http://localhost:5173", "http://127.0.0.2:4317", "http://10.0.0.5:3000", "http://10.0.0.8:8081", "http://172.16.1.5:4173", "http://[::1]:3000"} {
		request := httptest.NewRequest(http.MethodGet, "/v0/session", nil)
		request.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		engine.ServeHTTP(response, request)

		if response.Header().Get("Access-Control-Allow-Origin") != origin {
			t.Fatalf("origin %q was not allowed", origin)
		}
		if response.Header().Get("Access-Control-Allow-Credentials") != "true" {
			t.Fatalf("origin %q did not allow credentials", origin)
		}
	}
}
