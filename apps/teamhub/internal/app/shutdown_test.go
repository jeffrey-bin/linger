package app

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestDrainingReadinessAndBoundedWorkerCleanup(t *testing.T) {
	stopped := make(chan struct{})
	application := &App{stopStreams: func() {}, stopWorkers: func() { close(stopped) }}
	application.workerWG.Add(1)
	application.BeginDrain()
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("request_id", "shutdown-test")
	c.Request = httptest.NewRequest(http.MethodGet, "/readyz", nil)
	application.readyz(c)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready=%d", recorder.Code)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := application.CloseContext(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close error=%v", err)
	}
	select {
	case <-stopped:
	default:
		t.Fatal("worker not canceled")
	}
	select {
	case <-application.closeDone:
		t.Fatal("cleanup completed with active worker")
	default:
	}
	application.workerWG.Done()
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	if err := application.CloseContext(ctx2); err != nil {
		t.Fatal(err)
	}
}
