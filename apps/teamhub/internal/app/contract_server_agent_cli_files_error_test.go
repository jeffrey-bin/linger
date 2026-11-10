package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestAgentCLIFileErrorReportsOutagesWithoutRetryHint(t *testing.T) {
	for _, scenario := range []struct {
		name string
		err  error
	}{
		{"object service outage", document.ErrObjectStoreUnavailable},
		{"serialization exhausted", &pgconn.PgError{Code: "40001", Message: "private-body-token"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(response)
			ctx.Request = httptest.NewRequest(http.MethodGet, "/api/agent/v1/files/document_a/content", nil)
			a := &App{logger: slog.New(slog.NewJSONHandler(&bytes.Buffer{}, nil))}
			if !a.writeAgentCLIFileError(ctx, scenario.err) || response.Code != http.StatusServiceUnavailable {
				t.Fatalf("response status=%d body=%s", response.Code, response.Body)
			}
			var envelope struct {
				Error struct{ Code, Message string }
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil || envelope.Error.Code != "unavailable" {
				t.Fatalf("response error=%v envelope=%+v", err, envelope)
			}
			if response.Header().Get("Retry-After") != "" || strings.Contains(response.Body.String(), "private-body-token") {
				t.Fatalf("outage response header=%v body=%s", response.Header(), response.Body)
			}
		})
	}
}

func TestLatestDownloadErrorsAreRetryableWithoutContent(t *testing.T) {
	for _, human := range []bool{true, false} {
		response := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(response)
		ctx.Request = httptest.NewRequest(http.MethodGet, "/downloads", nil)
		ctx.Set("request_id", "latest-request")
		a := &App{logger: slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))}
		if human {
			a.writeUnifiedDocumentError(ctx, "download latest", document.ErrLatestProjectionNotReady)
		} else {
			a.writeAgentCLIFileError(ctx, document.ErrLatestProjectionNotReady)
		}
		if response.Code != http.StatusAccepted || response.Header().Get("Retry-After") != "1" || response.Header().Get("Cache-Control") != "private, no-store" {
			t.Fatalf("human=%t status=%d headers=%v body=%s", human, response.Code, response.Header(), response.Body)
		}
		if !strings.Contains(response.Body.String(), "retry") || strings.Contains(response.Body.String(), "sharing_conflict") || response.Header().Get("X-Content-Sha256") != "" {
			t.Fatalf("latest response=%s headers=%v", response.Body, response.Header())
		}
	}
}
