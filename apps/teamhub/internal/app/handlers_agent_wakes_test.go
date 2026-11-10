package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
)

type serviceWakeRecorder struct {
	*httptest.ResponseRecorder
	flushed chan struct{}
}

func (recorder *serviceWakeRecorder) Flush() {
	recorder.ResponseRecorder.Flush()
	select {
	case recorder.flushed <- struct{}{}:
	default:
	}
}

func TestStreamAgentWakes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	broker := realtime.NewBroker(4)
	app := &App{
		broker:      broker,
		streamsDone: context.Background(),
		cfg: config.ForTest(func(c *config.Config) {
			c.SSEHeartbeatInterval = time.Hour
		}),
	}
	recorder := &serviceWakeRecorder{
		ResponseRecorder: httptest.NewRecorder(),
		flushed:          make(chan struct{}, 4),
	}
	requestContext, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/v0/agent-runtime/wakes", nil).WithContext(requestContext)
	ginContext, _ := gin.CreateTestContext(recorder)
	ginContext.Request = request
	done := make(chan struct{})
	go func() {
		defer close(done)
		app.streamAgentWakes(ginContext)
	}()

	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("initial reconcile event was not flushed")
	}
	broker.Publish(realtime.Event{Topic: realtime.AgentInboxWakeTopic, Kind: realtime.RunQueuedKind, ContextKey: "context-1"})
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("queued Run event was not flushed")
	}
	broker.Publish(realtime.Event{Topic: realtime.AgentInboxWakeTopic, Kind: realtime.RunSteeredKind, ContextKey: "context-2"})
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("steer event was not flushed")
	}
	broker.Publish(realtime.Event{Topic: realtime.AgentInboxWakeTopic, Kind: "context.changed", ContextKey: "context-1", Revision: 12})
	select {
	case <-recorder.flushed:
	case <-time.After(time.Second):
		t.Fatal("Context refresh event was not flushed")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("Context wake stream did not stop")
	}

	body := recorder.Body.String()
	if !strings.Contains(body, `event: context.changed`) || !strings.Contains(body, `data: {"context_key":"context-1","state_revision":"12"}`) {
		t.Fatalf("missing Context refresh=%q", body)
	}
	if !strings.Contains(body, "event: reconcile") || !strings.Contains(body, "data: {}") {
		t.Fatalf("missing reconcile event: %q", body)
	}
	if !strings.Contains(body, "event: run.queued\ndata: {\"context_key\":\"context-1\"}") ||
		!strings.Contains(body, "event: run.steered\ndata: {\"context_key\":\"context-2\"}") {
		t.Fatalf("missing run hints: %q", body)
	}
}
