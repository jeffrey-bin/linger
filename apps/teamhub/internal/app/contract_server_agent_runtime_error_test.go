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

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
)

func TestAgentRuntimeInboxAuthorizationDoesNotFenceContext(t *testing.T) {
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"Inbox authorization", agentruntimestate.ErrInboxNotAuthorized, 403, "INBOX_NOT_AUTHORIZED"},
		{"Context lease or identity", agentruntimestate.ErrFenced, 409, "CONTEXT_FENCED"},
		{"real fence wins", errors.Join(agentruntimestate.ErrInboxNotAuthorized, agentruntimestate.ErrFenced), 409, "CONTEXT_FENCED"},
		{"selection race", agentruntimestate.ErrConflict, 409, "AGENT_RUNTIME_CONFLICT"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(response)
			c.Request = httptest.NewRequest(http.MethodPost, "/inbox-notifications", nil)
			c.Set("request_id", "inbox-authorization-test")
			a := &App{}
			a.writeAgentRuntimeStateError(c, "accept Inbox notification", fmt.Errorf("recheck: %w", tc.err))
			if response.Code != tc.status || !strings.Contains(response.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("error classification: %d %s, want %d %s", response.Code, response.Body.String(), tc.status, tc.code)
			}
		})
	}
}

func TestAgentRuntimeStateRequestCancellation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		canceled bool
		deadline bool
		err      error
		quiet    bool
	}{
		{"request canceled", true, false, context.Canceled, true},
		{"wrapped cancellation", true, false, fmt.Errorf("update: %w", context.Canceled), true},
		{"live request dependency canceled", false, false, context.Canceled, false},
		{"deadline", false, true, context.DeadlineExceeded, false},
		{"failure during cancellation", true, false, errors.New("database unavailable"), false},
		{"joined failure", true, false, errors.Join(context.Canceled, errors.New("database unavailable")), false},
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
			c.Request = httptest.NewRequest(http.MethodPost, "/heartbeat?secret=hidden", nil).WithContext(ctx)
			c.Set("request_id", "request-test")
			if !a.writeAgentRuntimeStateError(c, "touch Local Computer", tc.err) {
				t.Fatal("error not handled")
			}
			if tc.quiet {
				if c.Writer.Written() || response.Body.Len() != 0 {
					t.Fatalf("canceled request wrote response: %s", response.Body.String())
				}
				if !strings.Contains(logs.String(), `"level":"INFO"`) || !strings.Contains(logs.String(), `"request_id":"request-test"`) {
					t.Fatalf("missing cancellation diagnostic: %s", logs.String())
				}
			} else if response.Code != 500 || !strings.Contains(logs.String(), `"level":"ERROR"`) {
				t.Fatalf("real failure hidden: %d %s", response.Code, logs.String())
			}
			if strings.Contains(logs.String(), "hidden") {
				t.Fatal("request query leaked")
			}
		})
	}
}
