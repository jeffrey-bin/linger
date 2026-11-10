package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestMessageReadTimingsRequestLog(t *testing.T) {
	for _, outcome := range []string{"success", "failed", "canceled", "unrelated"} {
		t.Run(outcome, func(t *testing.T) {
			var logs bytes.Buffer
			a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			engine := gin.New()
			engine.Use(a.requestContext())
			engine.GET("/v0/test", func(c *gin.Context) {
				if outcome != "unrelated" {
					timings := startMessageReadTimings(c)
					timings.last = time.Now().Add(-time.Millisecond)
					timings.Stage("authorize")
					if outcome == "success" {
						timings.fields["message_count"] = 2
						timings.fields["thread_count"] = 1
						timings.Stage("threads")
					}
				}
				switch outcome {
				case "failed":
					c.Status(http.StatusInternalServerError)
				case "canceled":
					c.Set("request_canceled", true)
				default:
					c.JSON(http.StatusOK, gin.H{"body": "private-message"})
				}
			})
			request := httptest.NewRequest(http.MethodGet, "/v0/test?cursor=private-cursor", nil)
			request.Header.Set("X-Request-ID", "timings-request")
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			var record map[string]any
			if err := json.Unmarshal(logs.Bytes(), &record); err != nil {
				t.Fatal(err)
			}
			if record["request_id"] != "timings-request" || response.Header().Get("X-Request-ID") != "timings-request" {
				t.Fatalf("request correlation lost: %v", record)
			}
			fields, hasTimings := record["message_read"].(map[string]any)
			if hasTimings != (outcome != "unrelated") {
				t.Fatalf("unexpected timings: %v", record)
			}
			if hasTimings && fields["authorize_ms"].(float64) < 1 {
				t.Fatalf("missing elapsed time: %v", fields)
			}
			if outcome == "success" && (fields["message_count"] != float64(2) || fields["thread_count"] != float64(1) || fields["threads_ms"] == nil) {
				t.Fatalf("missing stage/count: %v", fields)
			}
			if outcome == "canceled" && (record["outcome"] != "request_canceled" || record["status"] != nil) {
				t.Fatalf("cancellation logged as success: %v", record)
			}
			if outcome == "failed" && record["status"] != float64(http.StatusInternalServerError) {
				t.Fatalf("failure logged as success: %v", record)
			}
			if strings.Contains(logs.String(), "private-") {
				t.Fatalf("private data leaked: %s", logs.String())
			}
		})
	}
}
