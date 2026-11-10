package roomdocument

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
)

func TestHTTPRuntimeImportContract(t *testing.T) {
	stateBytes := []byte{1, 2, 3, 4}
	digest := sha256.Sum256(stateBytes)
	validResponse := `{"state_bytes":"` + base64.StdEncoding.EncodeToString(stateBytes) +
		`","bytes_sha256":"` + hex.EncodeToString(digest[:]) +
		`","state_vector":"AA==","state_hash":"` + hex.EncodeToString(digest[:]) +
		`","state_hash_version":1,"complete_references":{"document_asset_ids":[],"document_thread_ids":[]},"warnings":[]}`

	for name, responseBody := range map[string]string{
		"trailing JSON":    validResponse + `{}`,
		"wrong bytes hash": strings.Replace(validResponse, hex.EncodeToString(digest[:]), strings.Repeat("b", 64), 1),
		"wrong state hash": strings.Replace(validResponse, `"state_hash":"`+hex.EncodeToString(digest[:])+`"`, `"state_hash":"`+strings.Repeat("c", 64)+`"`, 1),
		"unknown response": strings.Replace(validResponse, `"warnings":[]`, `"warnings":[],"unknown":true`, 1),
		"null references":  strings.Replace(validResponse, `{"document_asset_ids":[],"document_thread_ids":[]}`, `{"document_asset_ids":null,"document_thread_ids":[]}`, 1),
		"null warnings":    strings.Replace(validResponse, `"warnings":[]`, `"warnings":null`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Header.Get("Authorization") != "Bearer runtime-secret" {
					t.Fatal("Runtime request omitted the service bearer credential")
				}
				deadline, ok := request.Context().Deadline()
				if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > importTimeout {
					t.Fatalf("Runtime request deadline=%v ok=%v", deadline, ok)
				}
				return &http.Response{
					StatusCode: http.StatusOK,
					Body:       io.NopCloser(strings.NewReader(responseBody)),
					Header:     make(http.Header),
					Request:    request,
				}, nil
			})}
			runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", client)
			if err != nil {
				t.Fatal(err)
			}
			_, err = runtime.Import(context.Background(), document.ImportRequest{
				OperationID: "9b5be123-4fd2-4a47-a98d-548879f3fc78", SourceKind: "blank",
			})
			if !errors.Is(err, ErrInvalidState) {
				t.Fatalf("Import invalid response error=%v, want ErrInvalidState", err)
			}
		})
	}
}

func TestHTTPRuntimeMapsTransportFailureToUnavailable(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("runtime offline")
	})}
	runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", client)
	if err != nil {
		t.Fatal(err)
	}
	_, err = runtime.Import(context.Background(), document.ImportRequest{
		OperationID: "9b5be123-4fd2-4a47-a98d-548879f3fc78", SourceKind: "blank",
	})
	if !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("Import transport error=%v, want ErrRuntimeUnavailable", err)
	}
}

func TestHTTPRuntimeDefaultClientDefersToOperationDeadlines(t *testing.T) {
	runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	client, ok := runtime.client.Client.(*http.Client)
	if !ok {
		t.Fatalf("default Runtime client type=%T, want *http.Client", runtime.client.Client)
	}
	if client.Timeout != 0 {
		t.Fatalf("default Runtime client timeout=%s, want operation-scoped deadline", client.Timeout)
	}
}

func TestNewHTTPRuntimeRejectsNonOriginURL(t *testing.T) {
	for _, baseURL := range []string{
		"runtime.example.test",
		"ftp://runtime.example.test",
		"https://runtime.example.test/internal",
		"https://runtime.example.test?target=other",
		"https://user:secret@runtime.example.test",
	} {
		if _, err := NewHTTPRuntime(baseURL, "runtime-secret", nil); err == nil {
			t.Fatalf("NewHTTPRuntime accepted %q", baseURL)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func TestHTTPRuntimeApplyReportsUnavailableRuntimeAndTypedResults(t *testing.T) {
	semantic := document.ApplyRequest{
		DocumentID: "document_apply", OperationID: "operation_apply", ActorID: "actor_agent",
		Semantic: &document.SemanticChange{
			SchemaVersion: "blocknote-semantic-v1", CurrentTitle: "Title", AllowedAssetIDs: []string{},
			Operations: []byte(`[{"kind":"set_title","title":"After"}]`),
		},
	}
	offline := &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("runtime offline")
	})}
	runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", offline)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runtime.Apply(context.Background(), semantic); !errors.Is(err, document.ErrRuntimeUnavailable) {
		t.Fatalf("Apply with the Runtime down error=%v, want ErrRuntimeUnavailable", err)
	}

	for name, test := range map[string]struct {
		status int
		body   string
		check  func(document.ApplyResult, error) bool
	}{
		"applied": {http.StatusOK,
			`{"status":"applied","seq":4,"state_hash":"` + strings.Repeat("a", 64) +
				`","title":"After","complete_references":{"document_asset_ids":[],"document_thread_ids":[]}}`,
			func(result document.ApplyResult, err error) bool {
				return err == nil && result.Applied && result.Seq == 4 && result.Title == "After"
			}},
		"conflicted": {http.StatusOK, `{"status":"conflicted","reason":"stale_head"}`,
			func(result document.ApplyResult, err error) bool {
				return err == nil && !result.Applied && result.ConflictReason == "stale_head"
			}},
		"missing Document": {http.StatusNotFound, `{"code":"not_found","message":"gone","retryable":false}`,
			func(_ document.ApplyResult, err error) bool { return errors.Is(err, document.ErrNotFound) }},
		"rejected change": {http.StatusUnprocessableEntity,
			`{"code":"validation_failed","message":"bad","retryable":false}`,
			func(_ document.ApplyResult, err error) bool { return errors.Is(err, document.ErrInvalidInput) }},
		"unavailable Runtime": {http.StatusServiceUnavailable,
			`{"code":"runtime_unavailable","message":"busy","retryable":true}`,
			func(_ document.ApplyResult, err error) bool {
				return errors.Is(err, document.ErrRuntimeUnavailable)
			}},
	} {
		t.Run(name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.URL.Path != "/internal/v1/documents/document_apply/apply" {
					t.Fatalf("Apply path=%s", request.URL.Path)
				}
				return &http.Response{
					StatusCode: test.status, Body: io.NopCloser(strings.NewReader(test.body)),
					Header: make(http.Header), Request: request,
				}, nil
			})}
			runtime, err := NewHTTPRuntime("https://runtime.example.test", "runtime-secret", client)
			if err != nil {
				t.Fatal(err)
			}
			result, err := runtime.Apply(context.Background(), semantic)
			if !test.check(result, err) {
				t.Fatalf("Apply result=%+v error=%v", result, err)
			}
		})
	}
}
