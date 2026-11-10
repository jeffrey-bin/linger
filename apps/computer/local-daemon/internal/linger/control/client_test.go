package control

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"testing"
)

func TestCallReachesTheDaemonControlServer(t *testing.T) {
	directory := controlTestDirectory(t)
	server, err := New(directory, &fakeController{})
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	response, err := Call(context.Background(), directory, http.MethodGet, "/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	var envelope struct {
		OK   bool           `json:"ok"`
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(response.Body, &envelope); err != nil || response.Status != http.StatusOK || !envelope.OK || envelope.Data["launch_nonce"] != "nonce-1" {
		t.Fatalf("response=%+v err=%v", response, err)
	}
	response, err = Call(context.Background(), directory, http.MethodPost, "/services", json.RawMessage(`{"name":"preview","command":"python3","args":[],"cwd":"/tmp"}`))
	if err != nil || response.Status != http.StatusOK {
		t.Fatalf("service response=%+v err=%v", response, err)
	}
}

func TestCallWithoutADaemonIsUnavailable(t *testing.T) {
	if _, err := Call(context.Background(), t.TempDir(), http.MethodGet, "/status", nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err=%v", err)
	}
	if _, err := Call(context.Background(), t.TempDir(), http.MethodDelete, "/status", nil); err == nil {
		t.Fatal("invalid method accepted")
	}
}
