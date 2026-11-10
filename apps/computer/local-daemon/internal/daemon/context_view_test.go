package daemon

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// testViewContent is a fake Agent Service content route. Manifests answer at
// once; a file request waits for hold, when one is set.
type testViewContent struct {
	server    *httptest.Server
	mu        sync.Mutex
	manifests map[string][]byte
	files     map[string][]byte
	hold      func(*http.Request, string) bool
}

func newTestViewContent(t *testing.T) *testViewContent {
	t.Helper()
	content := &testViewContent{manifests: map[string][]byte{}, files: map[string][]byte{}}
	content.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		resource := strings.TrimPrefix(request.URL.Path, "/content/")
		content.mu.Lock()
		var body []byte
		var ok bool
		digest, isFile := strings.CutPrefix(resource, "files/")
		if isFile {
			body, ok = content.files[digest]
		} else if digest, found := strings.CutPrefix(resource, "views/"); found {
			body, ok = content.manifests[digest]
		}
		hold := content.hold
		content.mu.Unlock()
		if !ok {
			http.NotFound(writer, request)
			return
		}
		if isFile && hold != nil && !hold(request, string(body)) {
			return
		}
		_, _ = writer.Write(body)
	}))
	t.Cleanup(content.server.Close)
	return content
}

func (c *testViewContent) url() string { return c.server.URL + "/content" }

// mapping maps one read-only file whose content is body.
func (c *testViewContent) mapping(name, body string) lingercontext.Mapping {
	sum := sha256.Sum256([]byte(body))
	digest := hex.EncodeToString(sum[:])
	c.mu.Lock()
	c.files[digest] = []byte(body)
	c.mu.Unlock()
	return lingercontext.Mapping{
		Kind: "memory", TargetPath: "memory", Access: "read_only",
		Files: []lingercontext.FileInput{{RelativePath: name, MediaType: "text/plain", SizeBytes: int64(len(body)), SHA256: digest}},
	}
}

// publish serves the View of the command's Context and returns its reference.
func (c *testViewContent) publish(t *testing.T, command protocol.Command, mappings ...lingercontext.Mapping) json.RawMessage {
	t.Helper()
	if mappings == nil {
		mappings = []lingercontext.Mapping{}
	}
	body, err := json.Marshal(map[string]any{
		"version": 1, "execution_context_key": command.ExecutionContextKey,
		"runtime_instance_id": command.RuntimeInstanceID, "mappings": mappings, "skills": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	digest := hex.EncodeToString(sum[:])
	c.mu.Lock()
	c.manifests[digest] = body
	c.mu.Unlock()
	return mustJSON(lingercontext.ViewRef{ViewDigest: digest})
}

func openTestViews(t *testing.T) *lingercontext.ViewStore {
	t.Helper()
	state := t.TempDir()
	views, err := lingercontext.OpenViewStore(filepath.Join(state, "context.sqlite"), filepath.Join(state, "views"), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = views.Close()
		// Context workspaces hold read-only files that TempDir cleanup cannot remove.
		_ = filepath.Walk(state, func(path string, _ os.FileInfo, err error) error {
			if err == nil {
				_ = os.Chmod(path, 0o700)
			}
			return nil
		})
	})
	return views
}

// readyTestContextView returns a store whose Context of the command is already
// at the returned View, so the Daemon fetches nothing for it.
func readyTestContextView(t *testing.T, command protocol.Command) (*lingercontext.ViewStore, json.RawMessage) {
	t.Helper()
	views := openTestViews(t)
	content := newTestViewContent(t)
	ref := content.publish(t, command)
	var view lingercontext.ViewRef
	if err := json.Unmarshal(ref, &view); err != nil {
		t.Fatal(err)
	}
	if _, err := views.Ensure(context.Background(), lingercontext.ViewRequest{
		TenantID: command.TenantID, RunnerID: command.RunnerID, AgentID: command.AgentID,
		WorkspaceGrantID: command.WorkspaceGrantID, ExecutionContextKey: command.ExecutionContextKey,
		RuntimeInstanceID: command.RuntimeInstanceID, ViewDigest: view.ViewDigest,
	}, lingercontext.ContentSource{ContentURL: content.url()}); err != nil {
		t.Fatal(err)
	}
	return views, ref
}

func TestContextViewFailureNamesWhetherARetryCanPass(t *testing.T) {
	for _, scenario := range []struct {
		err       error
		code      string
		retryable bool
	}{
		{lingercontext.ErrInputDownloadUnavailable, "CONTEXT_VIEW_FAILED", true},
		{lingercontext.ErrProjectionRecoveryRequired, "CONTEXT_RECOVERY_REQUIRED", false},
		{lingercontext.ErrSkillPackageUnavailable, "SKILL_PACKAGE_UNAVAILABLE", false},
		{lingercontext.ErrContextConflict, "CONTEXT_VIEW_FAILED", false},
	} {
		failure := contextViewFailure(scenario.err)
		if failure["code"] != scenario.code || failure["retryable"] != scenario.retryable {
			t.Fatalf("%v: failure=%v", scenario.err, failure)
		}
	}
}

// A Skill package download hands the archive on only when TeamHub answered
// with one; a Web host's SPA page fails with its route and response type.
func TestSkillPackageFetcherAcceptsOnlyAZIPArchive(t *testing.T) {
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	if _, err := writer.Create("SKILL.md"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct {
		name, contentType string
		body              []byte
		failure           string
	}{
		{"archive", "application/zip", archive.Bytes(), ""},
		{"spa page", "text/html", []byte("<!doctype html><html></html>"), "returned HTTP 200 text/html, not a ZIP archive"},
		{"mislabeled page", "application/zip", []byte("<!doctype html>"), "returned HTTP 200 application/zip, not a ZIP archive"},
		{"unlabeled archive", "", archive.Bytes(), "returned HTTP 200 no Content-Type, not a ZIP archive"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
				if request.URL.Path != "/api/agent/v1/skills/packages/manifest-1" || request.Header.Get("Authorization") != "Bearer "+cliRunTestToken {
					http.NotFound(writer, request)
					return
				}
				writer.Header()["Content-Type"] = []string{scenario.contentType}
				_, _ = writer.Write(scenario.body)
			}))
			defer server.Close()
			credentials := seededCLICredentials(t)
			profile := clicredential.Profile{URL: server.URL, TenantID: "tenant-1", AgentID: "agent-1"}
			if _, err := credentials.Put("tenant-1", "agent-1", profile, cliRunTestToken, 2); err != nil {
				t.Fatal(err)
			}
			body, err := (&Daemon{cliCredentials: credentials}).skillPackageFetcher("tenant-1", "agent-1")(t.Context(), "manifest-1")
			if scenario.failure != "" {
				route := server.URL + "/api/agent/v1/skills/packages/manifest-1"
				if err == nil || !strings.Contains(err.Error(), route) || !strings.Contains(err.Error(), scenario.failure) {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			defer body.Close()
			if received, err := io.ReadAll(body); err != nil || !bytes.Equal(received, archive.Bytes()) {
				t.Fatalf("archive = %d bytes, err = %v", len(received), err)
			}
		})
	}
}

// A start brings its Context to the named View before admission, and a View
// it cannot get fails only that Operation.
func TestOperationStartFetchesItsViewAndFailsAloneWithoutIt(t *testing.T) {
	device, err := transport.GenerateIdentity()
	if err != nil {
		t.Fatal(err)
	}
	content := newTestViewContent(t)
	views := openTestViews(t)
	stream := &fakeStream{}
	d, err := newTestDaemon(t, Options{
		ComputerID: "computer-1", ControlPlane: fakeControlPlane{stream: stream}, IdentityStore: fakeStore{value: device},
		OperationResolver: fakeOperationResolver{}, ContextViews: views, Executor: provider.Executor{NewBackend: func(string, native.Profile) (native.Runtime, error) {
			return completingBackend{}, nil
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	d.daemonID = device.DaemonID
	contentURL := content.url()
	d.contentURL.Store(&contentURL)

	missing := daemonOperationStart("operation-missing", "agent-1")
	missing.ContextViewRef = mustJSON(lingercontext.ViewRef{ViewDigest: strings.Repeat("b", 64)})
	if err := d.handleOperationStart(t.Context(), stream, missing); err != nil {
		t.Fatal("a missing View failed the connection:", err)
	}
	start := daemonOperationStart("operation-ready", "agent-2")
	start.ContextViewRef = content.publish(t, start, content.mapping("note.md", "remember this\n"))
	if err := d.handleOperationStart(t.Context(), stream, start); err != nil {
		t.Fatal(err)
	}
	d.WaitForOperations()
	var failed, accepted bool
	for _, event := range stream.snapshotEvents() {
		switch {
		case event.Type == protocol.EventOperationFailed && event.OperationID == missing.OperationID:
			failed = strings.Contains(string(event.Payload), `"retryable":true`)
		case event.Type == protocol.EventOperationAccepted && event.OperationID == start.OperationID:
			accepted = true
		}
	}
	if !failed || !accepted {
		t.Fatalf("failed=%v accepted=%v events=%s", failed, accepted, describeEvents(stream.snapshotEvents()))
	}
	var ref lingercontext.ViewRef
	if err := json.Unmarshal(start.ContextViewRef, &ref); err != nil {
		t.Fatal(err)
	}
	record, err := views.CurrentView(t.Context(), start.ExecutionContextKey, ref.ViewDigest)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(filepath.Join(record.WorkspacePath, "memory", "note.md")); err != nil || string(got) != "remember this\n" {
		t.Fatalf("projected file=%q err=%v", got, err)
	}
	if _, err := views.CurrentView(t.Context(), missing.ExecutionContextKey, ""); err == nil {
		t.Fatal("the missing View was recorded")
	}
}
