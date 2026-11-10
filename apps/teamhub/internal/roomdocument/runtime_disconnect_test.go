package roomdocument

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHTTPRuntimeDisconnectNamesTheDocumentAndActor(t *testing.T) {
	var requests []map[string]any
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/v1/documents/document_disconnect/disconnect" ||
			request.Header.Get("Authorization") != "Bearer runtime-secret" {
			t.Fatalf("invalid disconnect request %s %s", request.Method, request.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		requests = append(requests, body)
		return &http.Response{StatusCode: http.StatusNoContent, Body: io.NopCloser(strings.NewReader("")),
			Header: make(http.Header), Request: request}, nil
	})}
	runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", client)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Disconnect(context.Background(), "document_disconnect", ""); err != nil {
		t.Fatal(err)
	}
	if err := runtime.Disconnect(context.Background(), "document_disconnect", "actor_revoked"); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 2 || len(requests[0]) != 0 || requests[1]["actor_id"] != "actor_revoked" {
		t.Fatalf("disconnect bodies=%v", requests)
	}
	if err := runtime.Disconnect(context.Background(), "not a document", ""); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("invalid Document ID error=%v", err)
	}
}

func TestHTTPRuntimeDisconnectReportsRuntimeFailure(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		body := `{"code":"runtime_unavailable","message":"busy","retryable":true}`
		return &http.Response{StatusCode: http.StatusServiceUnavailable, Body: io.NopCloser(strings.NewReader(body)),
			Header: http.Header{"Content-Type": []string{"application/json"}}, Request: request}, nil
	})}
	runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", client)
	if err != nil {
		t.Fatal(err)
	}
	if err := runtime.Disconnect(context.Background(), "document_disconnect", ""); err == nil {
		t.Fatal("a failed disconnect reported success")
	}
}
