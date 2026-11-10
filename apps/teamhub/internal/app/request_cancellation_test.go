package app

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestInternalErrorOnlySuppressesCanceledRequest(t *testing.T) {
	testCanceledRequestErrorBoundary(t, func(a *App, c *gin.Context, err error) { a.internalError(c, "test handler", err) })
}

func TestDocumentErrorOnlySuppressesCanceledRequest(t *testing.T) {
	testCanceledRequestErrorBoundary(t, func(a *App, c *gin.Context, err error) {
		if !a.writeUnifiedDocumentError(c, "list Room Documents", err) {
			t.Fatal("error not handled")
		}
	})
}

func testCanceledRequestErrorBoundary(t *testing.T, handle func(*App, *gin.Context, error)) {
	t.Helper()
	for _, tc := range []struct {
		name               string
		canceled, deadline bool
		err                error
		quiet              bool
	}{
		{"canceled", true, false, context.Canceled, true},
		{"wrapped", true, false, fmt.Errorf("query: %w", context.Canceled), true},
		{"joined cancellations", true, false, errors.Join(context.Canceled, context.Canceled), true},
		{"dependency canceled while request live", false, false, context.Canceled, false},
		{"deadline", false, true, context.DeadlineExceeded, false},
		{"mixed failure", true, false, errors.Join(context.Canceled, errors.New("database unavailable")), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tc.canceled {
				cancel()
			}
			if tc.deadline {
				var stop context.CancelFunc
				ctx, stop = context.WithDeadline(t.Context(), time.Now().Add(-time.Second))
				defer stop()
			}
			var logs bytes.Buffer
			a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(http.MethodPost, "/v0/test?secret=hidden", nil).WithContext(ctx)
			c.Set("request_id", "test-request")
			handle(a, c, tc.err)
			if tc.quiet {
				if c.Writer.Written() || !c.IsAborted() || !c.GetBool("request_canceled") {
					t.Fatalf("canceled request wrote response: %s", response.Body.String())
				}
				if !strings.Contains(logs.String(), `"level":"INFO"`) || !strings.Contains(logs.String(), `"outcome":"request_canceled"`) {
					t.Fatalf("missing cancellation outcome: %s", logs.String())
				}
			} else if response.Code != http.StatusInternalServerError || !strings.Contains(logs.String(), `"level":"ERROR"`) {
				t.Fatalf("real error hidden: %d %s", response.Code, logs.String())
			}
			if strings.Contains(logs.String(), "hidden") {
				t.Fatal("query string leaked")
			}
		})
	}
}

func TestRequestContextDoesNotLogCanceledRequestAsHTTP200(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	engine := gin.New()
	engine.Use(a.requestContext())
	engine.GET("/v0/test", func(c *gin.Context) { a.internalError(c, "test handler", context.Canceled) })
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v0/test", nil).WithContext(ctx))
	if response.Body.Len() != 0 {
		t.Fatalf("unexpected body: %s", response.Body.String())
	}
	if strings.Count(logs.String(), `"outcome":"request_canceled"`) != 2 || strings.Contains(logs.String(), `"status":200`) {
		t.Fatalf("cancellation logged as success: %s", logs.String())
	}
}
