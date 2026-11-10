package control

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"runtime"
	"sync/atomic"
	"testing"
)

type fakeController struct {
	active   int
	shutdown atomic.Bool
	called   atomic.Bool
}

func (c *fakeController) Status(context.Context) (map[string]any, error) {
	c.called.Store(true)
	return map[string]any{"state": "running", "launch_nonce": "nonce-1", "active_operations": c.active}, nil
}

func controlTestDirectory(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if runtime.GOOS == "windows" {
		lease, err := AcquireLease(context.Background(), directory)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := lease.Release(context.Background()); err != nil {
				t.Error(err)
			}
		})
	}
	return directory
}
func (c *fakeController) Runtimes(context.Context) (any, error) { return []any{}, nil }
func (c *fakeController) Runners(context.Context) (any, error)  { return []any{}, nil }
func (c *fakeController) Runner(context.Context, string) (any, bool, error) {
	return map[string]any{"agent_id": "agent-1"}, true, nil
}
func (c *fakeController) StopRunner(context.Context, string) (any, bool, error) {
	return map[string]any{"agent_id": "agent-1", "state": "stopped"}, true, nil
}
func (c *fakeController) Services(context.Context) (any, error) { return []any{}, nil }
func (c *fakeController) StartService(_ context.Context, input ServiceStart) (any, bool, error) {
	return map[string]any{"name": input.Name, "pid": 42, "state": "running"}, true, nil
}
func (c *fakeController) StopService(context.Context, string) (any, bool, error) {
	return map[string]any{"name": "preview", "pid": 42, "state": "running"}, true, nil
}
func (c *fakeController) Shutdown()           { c.shutdown.Store(true) }
func (c *fakeController) ShutdownIfIdle() int { return c.active }

func TestServerSpeaksNodeControlClientEnvelope(t *testing.T) {
	controller := &fakeController{}
	server, err := New(controlTestDirectory(t), controller)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	client := localHTTPClient(server.socketPath)
	response, err := client.Get("http://unix/status")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var envelope struct {
		Version int            `json:"version"`
		OK      bool           `json:"ok"`
		Data    map[string]any `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil {
		t.Fatal(err)
	}
	if !envelope.OK || envelope.Version != 1 || envelope.Data["launch_nonce"] != "nonce-1" {
		t.Fatalf("envelope=%+v", envelope)
	}
}

func TestShutdownIfIdleRejectsActiveOperations(t *testing.T) {
	controller := &fakeController{active: 1}
	server, err := New(controlTestDirectory(t), controller)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	request, _ := http.NewRequest(http.MethodPost, "http://unix/shutdown-if-idle", nil)
	response, err := localHTTPClient(server.socketPath).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusConflict || controller.shutdown.Load() {
		t.Fatalf("status=%d shutdown=%v", response.StatusCode, controller.shutdown.Load())
	}
}

func TestServerRoutesManagedServiceLifecycle(t *testing.T) {
	server, err := New(controlTestDirectory(t), &fakeController{})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	client := localHTTPClient(server.socketPath)
	request, _ := http.NewRequest(http.MethodPost, "http://unix/services", bytes.NewBufferString(`{"name":"preview","command":"/bin/sh","args":["-c","exit 0"],"cwd":"/tmp"}`))
	request.Header.Set("content-type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var envelope struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.NewDecoder(response.Body).Decode(&envelope); err != nil || !envelope.OK || envelope.Data["name"] != "preview" {
		t.Fatalf("service start envelope = %+v err=%v", envelope, err)
	}
	stop, _ := http.NewRequest(http.MethodPost, "http://unix/services/preview/stop", nil)
	if response, err := client.Do(stop); err != nil || response.StatusCode != http.StatusOK {
		t.Fatalf("service stop status = %+v err=%v", response, err)
	} else {
		_ = response.Body.Close()
	}
}
