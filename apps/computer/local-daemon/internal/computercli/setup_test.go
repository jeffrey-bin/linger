package computercli

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const fixtureGatewayToken = "sr1.eyJydW5uZXJfaWQiOiJ4In0.signature-padding-to-length"

type exchangeServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests []map[string]string
	paths    []string
	status   int
	bundle   map[string]any
}

func newExchangeServer(t *testing.T, computerID string) *exchangeServer {
	t.Helper()
	server := &exchangeServer{status: http.StatusOK, bundle: credentialFixture(computerID)}
	server.Server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(request.Body).Decode(&body)
		server.mu.Lock()
		server.requests = append(server.requests, body)
		server.paths = append(server.paths, request.URL.Path)
		status, bundle := server.status, server.bundle
		server.mu.Unlock()
		writer.WriteHeader(status)
		_ = json.NewEncoder(writer).Encode(bundle)
	}))
	t.Cleanup(server.Close)
	return server
}

func credentialFixture(computerID string) map[string]any {
	return map[string]any{
		"computer_id": computerID, "tenant_id": "tenant-acme", "credential_expires_at": "2099-01-01T00:00:00Z",
		"gateway_token": fixtureGatewayToken, "gateway_url": "wss://agent.example.test/v1/runner-gateway",
	}
}

type setupFixture struct {
	root    string
	options setupOptions
	deps    setupDeps
	events  []string
	browser *url.URL
	final   chan *http.Response
}

func newSetupFixture(t *testing.T, server *exchangeServer) *setupFixture {
	t.Helper()
	root := t.TempDir()
	data := filepath.Join(root, "data")
	f := &setupFixture{root: root, final: make(chan *http.Response, 1)}
	f.options = setupOptions{
		configPath: filepath.Join(data, "config.json"), stateDirectory: filepath.Join(data, "state"),
		webURL: server.URL, displayName: "Alice's Mac", callbackTimeout: 10 * time.Second,
	}
	f.deps = setupDeps{
		environment: map[string]string{}, homeDirectory: filepath.Join(root, "home"), httpClient: newExchangeClient(),
		openBrowser: func(target string) error {
			f.events = append(f.events, "browser")
			parsed, err := url.Parse(target)
			if err != nil {
				return err
			}
			f.browser = parsed
			go f.followBrowser(t, parsed, "c"+strings.Repeat("c", 42), "enrollment-1")
			return nil
		},
		startDaemon: func(context.Context, string) error { f.events = append(f.events, "start"); return nil },
		stopExistingDaemon: func(context.Context, string, bool) (bool, error) {
			f.events = append(f.events, "stop")
			return false, nil
		},
	}
	return f
}

// followBrowser plays the browser: it returns to the callback and then
// follows the waiting page until setup settles it.
func (f *setupFixture) followBrowser(t *testing.T, authorization *url.URL, code, enrollmentID string) {
	redirect, err := url.Parse(authorization.Query().Get("redirect_uri"))
	if err != nil {
		t.Error(err)
		return
	}
	state := authorization.Query().Get("state")
	query := url.Values{"code": {code}, "enrollment_id": {enrollmentID}, "state": {state}}
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Get(redirect.String() + "?" + query.Encode())
	if err != nil {
		t.Error(err)
		return
	}
	_ = response.Body.Close()
	// Like the pending page: poll progress in place, then load the final page.
	base := redirect.Scheme + "://" + redirect.Host
	for range 400 {
		response, err := client.Get(base + "/callback/progress?state=" + url.QueryEscape(state))
		if err != nil {
			f.final <- nil
			return
		}
		var progress struct{ Done bool }
		err = json.NewDecoder(response.Body).Decode(&progress)
		_ = response.Body.Close()
		if err != nil {
			f.final <- nil
			return
		}
		if progress.Done {
			final, err := client.Get(base + "/callback/status?state=" + url.QueryEscape(state))
			if err != nil {
				final = nil
			} else {
				_ = final.Body.Close()
			}
			f.final <- final
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	f.final <- nil
}

func TestBrowserEnrollmentPersistsOwnerOnlyStateAndStartsTheDaemon(t *testing.T) {
	server := newExchangeServer(t, "runner-server-issued")
	f := newSetupFixture(t, server)
	result, err := runComputerSetup(context.Background(), f.options, f.deps)
	if err != nil {
		t.Fatal(err)
	}
	if result.computerID != "runner-server-issued" || result.tenantID != "tenant-acme" || result.configPath != f.options.configPath {
		t.Fatalf("result=%+v", result)
	}
	if strings.Join(f.events, ",") != "browser,stop,start" {
		t.Fatalf("events=%v", f.events)
	}
	query := f.browser.Query()
	if f.browser.Path != "/connect-computer" || len(query.Get("code_challenge")) != 43 || query.Get("display_name") != "Alice's Mac" || query.Has("computer_id") {
		t.Fatalf("authorization URL=%s", f.browser)
	}
	final := <-f.final
	if final == nil || final.StatusCode != http.StatusOK || final.Header.Get("Location") != "" {
		t.Fatalf("final browser response=%+v", final)
	}
	request := server.requests[0]
	if server.paths[0] != "/v0/local-computer-enrollments/enrollment-1/exchange" || request["authorization_code"] != strings.Repeat("c", 43) ||
		len(request["code_verifier"]) != 43 || request["redirect_uri"] != query.Get("redirect_uri") {
		t.Fatalf("exchange=%v %v", server.paths, request)
	}
	encoded, err := privatefs.ReadFile(f.options.configPath, 0)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	if err := json.Unmarshal(encoded, &config); err != nil {
		t.Fatal(err)
	}
	gateway := config["gateway"].(map[string]any)
	token, err := privatefs.ReadFile(gateway["token_file"].(string), 0)
	if err != nil || string(token) != fixtureGatewayToken {
		t.Fatalf("token=%q err=%v", token, err)
	}
	if strings.Contains(string(encoded), fixtureGatewayToken) {
		t.Fatal("config contains the Gateway credential")
	}
	if _, ok := config["max_concurrent_operations"]; ok {
		t.Fatal("unconfigured run limit persisted")
	}
	grant := config["workspace_grants"].([]any)[0].(map[string]any)
	if config["runner_id"] != "runner-server-issued" || config["credential_expires_at"] != "2099-01-01T00:00:00Z" || config["display_name"] != "Alice's Mac" ||
		config["state_directory"] != f.options.stateDirectory || gateway["url"] != "wss://agent.example.test/v1/runner-gateway" ||
		grant["label"] != "Linger managed workspace" || grant["root_path"] != filepath.Join(f.options.stateDirectory, "workspaces") ||
		grant["scope"] != "owner" || grant["mode"] != "workspace-write" || grant["tenant_id"] != "tenant-acme" || !strings.HasPrefix(grant["grant_id"].(string), "grant-") {
		t.Fatalf("config=%s", encoded)
	}
	if !strings.HasPrefix(string(encoded), "{\n  \"runner_id\": \"runner-server-issued\",\n  \"credential_expires_at\"") {
		t.Fatalf("config layout=%s", encoded)
	}
	for _, path := range []string{f.options.configPath, gateway["token_file"].(string), filepath.Join(filepath.Dir(gateway["token_file"].(string)), "computer-id")} {
		if runtime.GOOS == "windows" {
			if err := privatefs.CheckPath(path, "file", true); err != nil {
				t.Fatalf("%s private ACL: %v", path, err)
			}
			continue
		}
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("%s mode=%v err=%v", path, info, err)
		}
	}
	for _, path := range []string{filepath.Dir(f.options.configPath), filepath.Join(f.options.stateDirectory, "workspaces")} {
		if runtime.GOOS == "windows" {
			if err := privatefs.CheckPath(path, "directory", true); err != nil {
				t.Fatalf("%s private ACL: %v", path, err)
			}
			continue
		}
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("%s mode=%v err=%v", path, info, err)
		}
	}
}

func TestSetupPersistsRuntimeScopeAndRunLimitBeforeTheFirstStart(t *testing.T) {
	server := newExchangeServer(t, "runner-selected")
	f := newSetupFixture(t, server)
	f.options.enabledRuntimes = []string{"codex"}
	f.options.maxRunsSet, f.options.maxRuns = true, new(3)
	f.deps.startDaemon = func(_ context.Context, configPath string) error {
		encoded, err := os.ReadFile(configPath)
		if err != nil {
			return err
		}
		var config map[string]any
		_ = json.Unmarshal(encoded, &config)
		if runtimes, _ := config["enabled_runtimes"].([]any); len(runtimes) != 1 || runtimes[0] != "codex" || config["max_concurrent_operations"] != float64(3) {
			return errors.New("scope missing at start: " + string(encoded))
		}
		return nil
	}
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err != nil {
		t.Fatal(err)
	}
	// A later login without a limit keeps the configured one.
	f.options.maxRunsSet, f.options.maxRuns = false, nil
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err != nil {
		t.Fatal(err)
	}
}

func TestSetupRenewsTheExistingComputerIdentity(t *testing.T) {
	server := newExchangeServer(t, "runner-existing")
	f := newSetupFixture(t, server)
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err != nil {
		t.Fatal(err)
	}
	firstRevision := filepath.Dir(gatewayTokenFile(t, f.options.configPath))
	<-f.final
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err != nil {
		t.Fatal(err)
	}
	if f.browser.Query().Get("computer_id") != "runner-existing" {
		t.Fatalf("renewal URL=%s", f.browser)
	}
	if _, err := os.Stat(firstRevision); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("previous revision remains: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.options.stateDirectory, "pending-credential-renewal.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("pending renewal remains: %v", err)
	}
	server.bundle = credentialFixture("runner-other")
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || err.Error() != "TeamHub returned a different Computer identity during renewal" {
		t.Fatalf("different identity err=%v", err)
	}
}

func gatewayTokenFile(t *testing.T, configPath string) string {
	t.Helper()
	encoded, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config struct {
		Gateway struct {
			TokenFile string `json:"token_file"`
		} `json:"gateway"`
	}
	if err := json.Unmarshal(encoded, &config); err != nil {
		t.Fatal(err)
	}
	return config.Gateway.TokenFile
}

func TestSetupRemovesFreshStateWhenTheFirstStartFails(t *testing.T) {
	server := newExchangeServer(t, "runner-fresh")
	f := newSetupFixture(t, server)
	f.deps.startDaemon = func(context.Context, string) error { return errors.New("daemon did not start") }
	_, err := runComputerSetup(context.Background(), f.options, f.deps)
	if failure := asCLIError(err); failure.category != categoryDaemonLifecycle || failure.message != "daemon did not start" {
		t.Fatalf("err=%v", err)
	}
	if _, err := os.Stat(f.options.configPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("config remains: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(filepath.Dir(f.options.configPath), "setup-revisions"))
	if len(entries) != 0 {
		t.Fatalf("revisions remain: %v", entries)
	}
	if final := <-f.final; final == nil || final.StatusCode != http.StatusInternalServerError {
		t.Fatalf("browser was not told setup failed: %+v", final)
	}
}

func TestSetupRejectsAConcurrentSetup(t *testing.T) {
	server := newExchangeServer(t, "runner-locked")
	f := newSetupFixture(t, server)
	if err := privatefs.EnsureDir(f.options.stateDirectory); err != nil {
		t.Fatal(err)
	}
	lock, acquired, err := privatefs.AcquireLock(filepath.Join(f.options.stateDirectory, setupLockName))
	if err != nil || !acquired {
		t.Fatalf("lock=%v err=%v", acquired, err)
	}
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || err.Error() != "Another Local Computer setup is active" {
		t.Fatalf("err=%v", err)
	}
	privatefs.ReleaseLock(lock)
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err != nil {
		t.Fatal(err)
	}
}

func TestSetupRejectsUnsafeDestinationsAndOrigins(t *testing.T) {
	server := newExchangeServer(t, "runner-unsafe")
	f := newSetupFixture(t, server)
	t.Run("symlink destination", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("Windows ordinary-user coverage uses TestWindowsSetupRejectsPrecreatedFileSymlink")
		}
		linked := newSetupFixture(t, server)
		if err := os.MkdirAll(filepath.Dir(linked.options.configPath), 0o700); err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(linked.root, "elsewhere.json")
		writeFile(t, target, "{}")
		if err := os.Symlink(target, linked.options.configPath); err != nil {
			t.Fatal(err)
		}
		if _, err := runComputerSetup(context.Background(), linked.options, linked.deps); asCLIError(err).message != "Local Computer state file is unsafe" {
			t.Fatalf("symlink err=%v", err)
		}
	})
	if err := os.MkdirAll(filepath.Dir(f.options.configPath), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, origin := range []string{"ftp://app.example.test", "https://app.example.test/path", "https://user:pass@app.example.test", "not a url"} {
		if _, err := requireWebOrigin(origin); err == nil {
			t.Fatalf("%s accepted", origin)
		}
	}
	if origin, err := requireWebOrigin("http://app.example.test:8080/"); err != nil || origin != "http://app.example.test:8080" {
		t.Fatalf("origin=%q err=%v", origin, err)
	}
	f.options.gatewayURL = "wss://other.example.test/v1/runner-gateway"
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || err.Error() != "Configured Gateway URL does not match the TeamHub-issued credential" {
		t.Fatalf("gateway override err=%v", err)
	}
}

func serverTokenFixture(origin string, expires time.Time, overrides map[string]string) string {
	value := map[string]string{
		"origin": origin, "display_name": "Server 117", "enrollment_id": "enrollment-9", "computer_id": "runner-server",
		"tenant_id": "tenant-acme", "authorization_code": strings.Repeat("a", 43), "code_verifier": strings.Repeat("v", 43),
		"expires_at": expires.UTC().Format(time.RFC3339),
	}
	for key, override := range overrides {
		value[key] = override
	}
	encoded, _ := json.Marshal(value)
	return serverTokenPrefix + base64.RawURLEncoding.EncodeToString(encoded)
}

func TestServerTokenSetupExchangesWithoutABrowser(t *testing.T) {
	server := newExchangeServer(t, "runner-server")
	f := newSetupFixture(t, server)
	f.deps.openBrowser = func(string) error { t.Fatal("token setup opened a browser"); return nil }
	f.options.webURL = "https://ignored.example.test"
	f.options.serverToken = serverTokenFixture(server.URL, time.Now().Add(time.Hour), nil)
	result, err := runComputerSetup(context.Background(), f.options, f.deps)
	if err != nil {
		t.Fatal(err)
	}
	if result.computerID != "runner-server" || server.requests[0]["redirect_uri"] != "http://127.0.0.1:9/callback" || server.requests[0]["code_verifier"] != strings.Repeat("v", 43) {
		t.Fatalf("result=%+v exchange=%v", result, server.requests)
	}
	encoded, _ := os.ReadFile(f.options.configPath)
	if !strings.Contains(string(encoded), `"display_name": "Server 117"`) {
		t.Fatalf("config=%s", encoded)
	}

	server.status = http.StatusBadGateway
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || !strings.HasPrefix(err.Error(), "Server token exchange failed or its result is uncertain.") {
		t.Fatalf("lost exchange err=%v", err)
	}
	server.status = http.StatusOK
	server.bundle = credentialFixture("runner-server")
	server.bundle["tenant_id"] = "tenant-other"
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || err.Error() != "Server token exchange returned a different Computer or workspace" {
		t.Fatalf("tenant mismatch err=%v", err)
	}
	f.options.serverToken = serverTokenFixture(server.URL, time.Now().Add(time.Hour), map[string]string{"computer_id": "runner-elsewhere"})
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || !strings.HasPrefix(err.Error(), "This machine already has a different Computer identity.") {
		t.Fatalf("identity err=%v", err)
	}
}

func TestServerTokenValidation(t *testing.T) {
	server := newExchangeServer(t, "runner-server")
	f := newSetupFixture(t, server)
	before := len(server.requests)
	f.options.serverToken = serverTokenFixture(server.URL, time.Now().Add(-time.Minute), nil)
	if _, err := runComputerSetup(context.Background(), f.options, f.deps); err == nil || err.Error() != "Server connection token has expired; generate a new token in Computers" {
		t.Fatalf("expired err=%v", err)
	}
	for _, token := range []string{
		`{"computer_id":"runner-server"}`,
		serverTokenPrefix + "!!!",
		serverTokenFixture(server.URL+"/path", time.Now().Add(time.Hour), nil),
		serverTokenFixture(server.URL, time.Now().Add(time.Hour), map[string]string{"code_verifier": "short"}),
		serverTokenFixture(server.URL, time.Now().Add(time.Hour), map[string]string{"display_name": " "}),
	} {
		if _, err := parseServerToken(token); err == nil || err.Error() != "Invalid server connection token" {
			t.Fatalf("%s err=%v", token, err)
		}
	}
	if len(server.requests) != before {
		t.Fatal("invalid tokens were exchanged")
	}
}

func TestCallbackListenerRejectsWrongStateAndHost(t *testing.T) {
	group := &listenerGroup{}
	callback, err := startCallbackListener("expected-state", time.Second, group)
	if err != nil {
		t.Fatal(err)
	}
	defer callback.fail()
	for _, target := range []string{
		callback.redirectURI + "?code=" + strings.Repeat("c", 43) + "&enrollment_id=e1&state=wrong",
		callback.redirectURI + "?code=short&enrollment_id=e1&state=expected-state",
		callback.redirectURI + "?code=" + strings.Repeat("c", 43) + "&enrollment_id=e1&state=expected-state&extra=1",
	} {
		response, err := http.Get(target)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("%s status=%d", target, response.StatusCode)
		}
	}
	request, _ := http.NewRequest(http.MethodGet, callback.redirectURI+"?code="+strings.Repeat("c", 43)+"&enrollment_id=e1&state=expected-state", nil)
	request.Host = "localhost"
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("wrong host status=%d", response.StatusCode)
	}
	response, err = http.Get(callback.redirectURI + "?code=" + strings.Repeat("c", 43) + "&enrollment_id=e1&state=expected-state")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	result, err := callback.wait(context.Background())
	if err != nil || result.kind != "authorization" || result.enrollmentID != "e1" {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}

func TestCredentialBundleValidation(t *testing.T) {
	valid := credentialFixture("runner-1")
	if _, err := parseCredentialBundle(valid); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"extra key":     func(value map[string]any) { value["extra"] = "x" },
		"short token":   func(value map[string]any) { value["gateway_token"] = "short" },
		"spaced token":  func(value map[string]any) { value["gateway_token"] = strings.Repeat("x", 40) + " y" },
		"bad gateway":   func(value map[string]any) { value["gateway_url"] = "https://agent.example.test" },
		"bad tenant id": func(value map[string]any) { value["tenant_id"] = "-tenant" },
	} {
		value := credentialFixture("runner-1")
		mutate(value)
		if _, err := parseCredentialBundle(value); err == nil {
			t.Fatalf("%s accepted", name)
		}
	}
	expired := credentialFixture("runner-1")
	expired["credential_expires_at"] = "2020-01-01T00:00:00Z"
	var expiredErr *credentialExpiredError
	if _, err := parseCredentialBundle(expired); !errors.As(err, &expiredErr) || expiredErr.computerID != "runner-1" {
		t.Fatalf("expired err=%v", err)
	}
}
