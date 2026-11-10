package app

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
)

// A template copy whose Agent is not active and an app listener say why they
// refuse, instead of claiming a concurrent edit; a real revision conflict still
// reports the conflict.
func TestRoutineErrorsNameAnUnavailableTemplateAgent(t *testing.T) {
	for _, tc := range []struct {
		name    string
		err     error
		web     string
		mcpCode string
	}{
		{"template Agent unavailable", reminder.ErrTemplateAgentUnavailable, "ROUTINE_AGENT_UNAVAILABLE", "agent_configuration_updating"},
		{"app listener", reminder.ErrAppListener, "ROUTINE_APP_LISTENER", "invalid_request"},
		{"revision conflict", reminder.ErrConflict, "CONFLICT", "version_conflict"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wrapped := fmt.Errorf("run Routine: %w", tc.err)
			a := &App{}
			web := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(web)
			c.Request = httptest.NewRequest(http.MethodPost, "/v0/routines/routine_1/run", nil)
			c.Set("request_id", "routine-error-test")
			a.writeReminderError(c, "run Routine", wrapped)
			if web.Code != http.StatusConflict || !strings.Contains(web.Body.String(), `"code":"`+tc.web+`"`) {
				t.Fatalf("web: %d %s, want 409 %s", web.Code, web.Body.String(), tc.web)
			}
			mcp := httptest.NewRecorder()
			c, _ = gin.CreateTestContext(mcp)
			c.Request = httptest.NewRequest(http.MethodPost, "/routines/run", nil)
			c.Set("request_id", "routine-error-test")
			a.writeAgentRoutineError(c, wrapped)
			if mcp.Code != http.StatusConflict || !strings.Contains(mcp.Body.String(), `"code":"`+tc.mcpCode+`"`) {
				t.Fatalf("mcp: %d %s, want 409 %s", mcp.Code, mcp.Body.String(), tc.mcpCode)
			}
		})
	}
}
