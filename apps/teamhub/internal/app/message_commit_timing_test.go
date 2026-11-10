package app

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
)

func TestRecordMessageCommitTiming(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Run("records a valid probe after commit", func(t *testing.T) {
		var logs bytes.Buffer
		a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
		response := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(response)
		context.Request = httptest.NewRequest(http.MethodPost, "/v0/rooms/room-latency/messages", nil)
		context.Request.Header.Set("X-Linger-Latency-ID", "latency-warm-1-12345678")
		context.Params = gin.Params{{Key: "roomId", Value: "room-latency"}}

		a.recordMessageCommitTiming(context)

		committedAt := response.Header().Get("X-Linger-Message-Commit-Unix-Ms")
		if _, err := strconv.ParseInt(committedAt, 10, 64); err != nil {
			t.Fatalf("commit timestamp %q is not an integer: %v", committedAt, err)
		}
		var record map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &record); err != nil {
			t.Fatalf("decode log: %v", err)
		}
		if record["msg"] != "local_agent_ingress.message_committed" ||
			record["correlation_id"] != "latency-warm-1-12345678" ||
			record["room_id"] != "room-latency" {
			t.Fatalf("unexpected record: %v", record)
		}
	})

	t.Run("ignores unstructured values", func(t *testing.T) {
		response := httptest.NewRecorder()
		context, _ := gin.CreateTestContext(response)
		context.Request = httptest.NewRequest(http.MethodPost, "/v0/rooms/room-latency/messages", nil)
		context.Request.Header.Set("X-Linger-Latency-ID", "invalid value with spaces")

		(&App{}).recordMessageCommitTiming(context)

		if got := response.Header().Get("X-Linger-Message-Commit-Unix-Ms"); got != "" {
			t.Fatalf("unexpected commit timestamp %q", got)
		}
	})
}

func TestRecordAgentMessageCommitTiming(t *testing.T) {
	for _, replay := range []bool{false, true} {
		var logs bytes.Buffer
		a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/api/agent/v1/messages/commit", nil)
		a.recordAgentMessageCommitTiming(c, "invocation-1", agentsendmessage.Result{InboxID: "room:room-1", MessageID: "message-1", Replay: replay})
		var event map[string]any
		if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &event); err != nil {
			t.Fatal(err)
		}
		code := "committed"
		if replay {
			code = "replayed"
		}
		if event["msg"] != "room.message_committed" || event["message_id"] != "message-1" || event["inbox_id"] != "room:room-1" || event["invocation_id"] != "invocation-1" || event["result"] != code || event["observed_at_unix_ms"] == nil || len(event) != 8 {
			t.Fatalf("unexpected commit log: %v", event)
		}
	}
}
