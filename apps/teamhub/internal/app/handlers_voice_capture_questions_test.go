package app

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
)

// Invalid input and an unconfigured Gateway stop before any database read.
func TestVoiceCaptureQuestionsRejectBeforeStorage(t *testing.T) {
	for _, test := range []struct {
		name, method, body string
		handle             func(*App, *gin.Context)
		status             int
		code               string
	}{
		{"blank question", http.MethodPost, `{"question":"   "}`,
			func(a *App, c *gin.Context) { a.askVoiceCaptureQuestion(c, "capture-1") }, http.StatusBadRequest, "INVALID_REQUEST"},
		{"long question", http.MethodPost, `{"question":"` + strings.Repeat("€", 1001) + `"}`,
			func(a *App, c *gin.Context) { a.askVoiceCaptureQuestion(c, "capture-1") }, http.StatusBadRequest, "INVALID_REQUEST"},
		{"no Gateway", http.MethodPost, `{"question":"What is the budget?"}`,
			func(a *App, c *gin.Context) { a.askVoiceCaptureQuestion(c, "capture-1") }, http.StatusServiceUnavailable, "SERVICE_UNAVAILABLE"},
	} {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(response)
			ctx.Set("request_id", "request-test")
			ctx.Request = httptest.NewRequest(test.method, "/v0/voice-captures/capture-1/x", strings.NewReader(test.body))
			ctx.Request.Header.Set("Content-Type", "application/json")
			test.handle(&App{}, ctx)
			if response.Code != test.status || !strings.Contains(response.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s want %d %s", response.Code, response.Body.String(), test.status, test.code)
			}
		})
	}
}

func TestVoiceCaptureQuestionModelShowsTaskRequests(t *testing.T) {
	answer, err := voice.VoiceCaptureQuestionModel(store.VoiceCaptureQuestion{ID: "q1", Kind: "answer", Answer: "500k", Sources: []byte("[]")})
	if err != nil || answer.Kind != "answer" || answer.TaskTitle != nil || answer.SentMessageId != nil {
		t.Fatalf("answer=%+v err=%v", answer, err)
	}
	pending, _ := voice.VoiceCaptureQuestionModel(store.VoiceCaptureQuestion{ID: "q2", Kind: "task", TaskTitle: "Email Lena", Sources: []byte("[]")})
	if pending.Kind != "task" || pending.TaskTitle == nil || *pending.TaskTitle != "Email Lena" || pending.SentMessageId != nil {
		t.Fatalf("pending=%+v", pending)
	}
	sent, _ := voice.VoiceCaptureQuestionModel(store.VoiceCaptureQuestion{
		ID: "q3", Kind: "task", TaskTitle: "Email Lena", Sources: []byte("[]"),
		SentMessageID: pgtype.Text{String: "message_1", Valid: true},
	})
	if sent.SentMessageId == nil || *sent.SentMessageId != "message_1" {
		t.Fatalf("sent=%+v", sent)
	}
}
