package integration_test

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/memoryclient"
)

// Real cross-process acceptance: no substitutes for waiting, publication/outbox,
// projection, graph construction, snapshot loading, jobs, or index transactions.
func TestWikiMemoryRequestBudget(t *testing.T) {
	serialIntegrationTest(t, serialSubprocess)
	if os.Getenv("TEAMHUB_MEMORY_REQUEST_BUDGET") != "1" {
		t.Skip("explicit TeamHub + memory process acceptance")
	}
	generator := &recordingWikiCandidateGenerator{}
	f := newUnifiedWikiDispatchCase(t, "request-budget", generator, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
	databaseURL := f.pool.Config().ConnString()
	// Publication and download must use the same private object store.
	if err := os.CopyFS(f.objectRoot, os.DirFS(prepareTemplateAppCatalog(t, f.pool))); err != nil {
		t.Fatal(err)
	}
	application, err := newTestApp(t.Context(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "test_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.ArtifactStorageRoot = f.objectRoot
		c.ArtifactMaxBytes = 1 << 20
	}), skipping(app.SkillInstall), skipping(app.PersonalWikiJobs), skipping(app.JobQueue))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	var mu sync.Mutex
	counts := map[string]int{}
	var pendingRefreshID string
	badUA := 0
	reset := func() { mu.Lock(); defer mu.Unlock(); counts = map[string]int{}; badUA = 0 }
	mux := http.NewServeMux()
	mux.HandleFunc("/test/publish", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var request struct {
			MemoryURL string `json:"memory_url"`
			Revision  int    `json:"revision"`
		}
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			http.Error(w, "bad fixture request", http.StatusBadRequest)
			return
		}
		updater, err := memoryclient.New(request.MemoryURL, "budget-callback-fixture")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		pages := make([]document.WikiPageCandidate, 123)
		for i := range pages {
			version := 0
			if i < 2 {
				version = request.Revision
			}
			pages[i] = document.WikiPageCandidate{PageKey: fmt.Sprintf("page-%03d.md", i), Markdown: []byte(fmt.Sprintf("# Page %d\n\nRevision %d.\n", i, version))}
		}
		generator.mu.Lock()
		generator.response = document.WikiCandidateGenerationResult{Pages: pages}
		generator.mu.Unlock()
		refreshID := f.admission.ID
		if request.Revision > 0 {
			mu.Lock()
			refreshID = pendingRefreshID
			mu.Unlock()
			if refreshID == "" {
				http.Error(w, "no frozen pending refresh", http.StatusConflict)
				return
			}
		}
		dispatcher, err := document.NewWikiRefreshDispatcher(f.pool, f.objects, generator, f.service, document.WikiRefreshDispatchOptions{GenerationTimeout: time.Hour, MaxAttempts: 3})
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if worked, err := deliverWikiAttempt(t, f.pool, dispatcher, refreshID); err != nil || !worked {
			http.Error(w, fmt.Sprintf("dispatch: %v worked=%v", err, worked), http.StatusInternalServerError)
			return
		}
		if err := drainDocumentJobs(r.Context(), f.pool, f.service, updater); err != nil {
			var pending []byte
			_ = f.pool.QueryRow(r.Context(), `SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'state',state,'scheduled_at',scheduled_at,'errors',errors)),'[]'::jsonb) FROM river_job WHERE kind LIKE 'document.%' AND state IN ('available','pending','retryable','running','scheduled')`).Scan(&pending)
			http.Error(w, fmt.Sprintf("%v: %s", err, pending), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/test/stale", func(w http.ResponseWriter, r *http.Request) {
		// Admit work before waiting, then publish that work at virtual second 80.
		// Do not change sources after admission: the candidate belongs to this
		// frozen refresh, and a later source mutation would keep it stale.
		reconciled, err := indexWikiSession(r.Context(), f.db, f.service, "budget", "changed source")
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		mu.Lock()
		pendingRefreshID = reconciled.Refresh.ID
		mu.Unlock()
		reset()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/test/counts", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		_ = json.NewEncoder(w).Encode(map[string]any{"counts": counts, "bad_ua": badUA})
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		recorder := httptest.NewRecorder()
		application.Handler().ServeHTTP(recorder, r)
		// Filter before accounting: unrelated host probes never enter these counters.
		if r.Method == http.MethodGet && len(r.URL.Path) >= len("/v0/personal-wikis/actor_human_a/") && r.URL.Path[:len("/v0/personal-wikis/actor_human_a/")] == "/v0/personal-wikis/actor_human_a/" && r.Header.Get("Authorization") == "Bearer "+teamHubInternalToken {
			kind := "body"
			if r.URL.Path == "/v0/personal-wikis/actor_human_a/document-revision" {
				kind = "manifest"
			}
			mu.Lock()
			counts[fmt.Sprintf("%s_%d", kind, recorder.Code)]++
			if r.UserAgent() != "linger-memory/budget-test" {
				badUA++
			}
			mu.Unlock()
		}
		for key, values := range recorder.Header() {
			w.Header()[key] = values
		}
		w.WriteHeader(recorder.Code)
		_, _ = w.Write(recorder.Body.Bytes())
	})
	server := httptest.NewServer(mux)
	registerIntegrationServerCleanup(t, server)
	directory, err := filepath.Abs("../../../node-services")
	if err != nil {
		t.Fatal(err)
	}
	command := exec.CommandContext(t.Context(), "node", "--import", "tsx", "tests/memory/wiki-request-budget-process.ts")
	command.Dir = directory
	command.Env = append(os.Environ(), "TEAMHUB_DATABASE_URL="+databaseURL, "TEAMHUB_BASE_URL="+server.URL, "LINGER_SECRET_SEED="+integrationSecretSeed, "APP_VERSION=budget-test")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("memory acceptance: %v\n%s", err, output)
	}
	// Validators never bypass authorization or conceal freshness/failure changes.
	get := func(token, validator string) (*http.Response, []byte) {
		t.Helper()
		request, _ := http.NewRequest(http.MethodGet, server.URL+"/v0/personal-wikis/actor_human_a/document-revision", nil)
		request.Header.Set("Authorization", "Bearer "+token)
		if validator != "" {
			request.Header.Set("If-None-Match", validator)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		if err := response.Body.Close(); err != nil {
			t.Fatal(err)
		}
		if err != nil {
			t.Fatal(err)
		}
		return response, body
	}
	initial, _ := get(teamHubInternalToken, "")
	etag := initial.Header.Get("ETag")
	if initial.StatusCode != http.StatusOK || etag == "" {
		t.Fatalf("unconditional response: %v", initial.StatusCode)
	}
	cached, body := get(teamHubInternalToken, `W/`+etag+`, "other"`)
	if cached.StatusCode != http.StatusNotModified || len(body) != 0 || cached.Header.Get("ETag") != etag || cached.Header.Get("Cache-Control") != "private, no-cache" {
		t.Fatalf("conditional response: %d %s", cached.StatusCode, body)
	}
	denied, _ := get("invalid", etag)
	if denied.StatusCode != http.StatusUnauthorized {
		t.Fatalf("authorization bypassed: %d", denied.StatusCode)
	}
	late, err := indexWikiSession(t.Context(), f.db, f.service, "late", "late evidence")
	if err != nil {
		t.Fatal(err)
	}
	stale, body := get(teamHubInternalToken, etag)
	if stale.StatusCode != http.StatusOK || stale.Header.Get("ETag") == etag || !strings.Contains(string(body), `"is_current":false`) {
		t.Fatalf("freshness hidden: %d %s", stale.StatusCode, body)
	}
	beforeFailure, _ := get(teamHubInternalToken, "")
	if _, err := f.pool.Exec(t.Context(), `UPDATE document_wiki_refreshes SET status='failed',outcome='failed' WHERE id=$1`, late.Refresh.ID); err != nil {
		t.Fatal(err)
	}
	failed, body := get(teamHubInternalToken, beforeFailure.Header.Get("ETag"))
	if failed.StatusCode != http.StatusOK || !strings.Contains(string(body), `"wiki_state":"failed"`) {
		t.Fatalf("failure hidden: %d %s", failed.StatusCode, body)
	}

	t.Logf("%s", output)
}
