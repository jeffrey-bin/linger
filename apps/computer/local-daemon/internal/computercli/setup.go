package computercli

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const setupLockName = "setup.lock"

type setupOptions struct {
	callbackTimeout time.Duration
	codexAuthFile   string
	configPath      string
	displayName     string
	gatewayURL      string
	maxRunsSet      bool
	maxRuns         *int
	// serverToken is a connection token generated on the Computers page; empty
	// means browser authorization.
	serverToken     string
	runtimePaths    map[string]string
	enabledRuntimes []string
	stateDirectory  string
	webURL          string
}

type setupResult struct {
	computerID string
	configPath string
	tenantID   string
	warnings   []string
}

type setupDeps struct {
	environment   map[string]string
	homeDirectory string
	httpClient    *http.Client
	openBrowser   func(url string) error
	startDaemon   func(ctx context.Context, configPath string) error
	// stopExistingDaemon reports whether a running Daemon was stopped.
	stopExistingDaemon func(ctx context.Context, configPath string, ifIdle bool) (bool, error)
}

type normalizedSetup struct {
	setupOptions
	token                *serverToken
	managedWorkspacePath string
}

// runComputerSetup authorizes this Computer, saves its credential and starts
// the Daemon, restarting one that still held the previous credential.
func runComputerSetup(ctx context.Context, options setupOptions, deps setupDeps) (setupResult, error) {
	normalized, err := normalizeSetupOptions(options, deps)
	if err != nil {
		return setupResult{}, err
	}
	if err := prepareStateDestinations(normalized); err != nil {
		return setupResult{}, err
	}
	lock, acquired, err := privatefs.AcquireLock(filepath.Join(normalized.stateDirectory, setupLockName))
	if err != nil {
		return setupResult{}, err
	}
	if !acquired {
		return setupResult{}, errors.New("Another Local Computer setup is active")
	}
	defer privatefs.ReleaseLock(lock)
	listeners := &listenerGroup{}
	defer waitForListeners(listeners)
	return runExclusiveSetup(ctx, normalized, deps, listeners)
}

func waitForListeners(listeners *listenerGroup) {
	done := make(chan struct{})
	go func() { listeners.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(callbackAnswerWindow + 5*time.Second):
	}
}

func runExclusiveSetup(ctx context.Context, normalized normalizedSetup, deps setupDeps, listeners *listenerGroup) (setupResult, error) {
	if !normalized.maxRunsSet {
		existing, err := readExistingMaxConcurrentOperations(normalized.configPath)
		if err != nil {
			return setupResult{}, err
		}
		if existing != nil {
			normalized.maxRunsSet, normalized.maxRuns = true, existing
		}
	}
	existingComputerID := ""
	if normalized.token == nil {
		var err error
		if existingComputerID, err = readExistingComputerID(normalized.configPath); err != nil {
			return setupResult{}, err
		}
	}
	pendingRenewalPath := filepath.Join(normalized.stateDirectory, "pending-credential-renewal.json")
	var recovered *credentialBundle
	if existingComputerID != "" {
		var err error
		if recovered, err = readPendingRenewal(pendingRenewalPath, existingComputerID); err != nil {
			return setupResult{}, err
		}
	}
	enrollment := enrollmentDeps{httpClient: deps.httpClient, openBrowser: deps.openBrowser, listeners: listeners}
	enrollmentOptions := enrollmentOptions{
		callbackTimeout: normalized.callbackTimeout, displayName: normalized.displayName,
		existingComputerID: existingComputerID, gatewayURL: normalized.gatewayURL,
		serverToken: normalized.token, webURL: normalized.webURL,
	}
	var issued *acquisition
	var bundle credentialBundle
	var replacement *pruneTarget
	existingDaemonStopped := false
	if recovered != nil {
		bundle = *recovered
	} else {
		var err error
		issued, err = obtainComputerCredential(ctx, enrollmentOptions, enrollment)
		var required *replacementRequiredError
		switch {
		case errors.As(err, &required) && existingComputerID != "":
			target, inspectErr := inspectPruneTarget(normalized.configPath)
			if inspectErr != nil {
				required.failBrowser()
				return setupResult{}, inspectErr
			}
			replacement = &target
			if existingDaemonStopped, err = deps.stopExistingDaemon(ctx, normalized.configPath, true); err != nil {
				required.failBrowser()
				return setupResult{}, wrapError(categoryDaemonLifecycle, "Unable to stop the existing Computer before switching accounts: "+err.Error(), err)
			}
			continued := false
			enrollment.openBrowser = func(target string) error {
				continued = true
				required.continueInBrowser(target)
				return nil
			}
			enrollmentOptions.existingComputerID = ""
			if issued, err = obtainComputerCredential(ctx, enrollmentOptions, enrollment); err != nil {
				if !continued {
					required.failBrowser()
				}
				if existingDaemonStopped {
					return setupResult{}, restartAfterReplacementFailure(ctx, normalized.configPath, deps, err)
				}
				return setupResult{}, err
			}
			existingComputerID = ""
		case errors.As(err, &required):
			required.failBrowser()
			return setupResult{}, err
		case err != nil:
			return setupResult{}, err
		}
		bundle = issued.bundle
	}
	result, err := commitSetup(ctx, normalized, deps, bundle, existingComputerID, recovered != nil, replacement, existingDaemonStopped, pendingRenewalPath, issued)
	if err != nil && issued != nil {
		issued.fail()
	}
	return result, err
}

func commitSetup(ctx context.Context, normalized normalizedSetup, deps setupDeps, bundle credentialBundle, existingComputerID string, recovered bool, replacement *pruneTarget, existingDaemonStopped bool, pendingRenewalPath string, issued *acquisition) (setupResult, error) {
	var leftovers []string
	if replacement != nil {
		var err error
		if leftovers, err = replacement.pruneDuringSetup(); err != nil {
			if existingDaemonStopped {
				return setupResult{}, restartAfterReplacementFailure(ctx, normalized.configPath, deps, err)
			}
			return setupResult{}, err
		}
	}
	if existingComputerID != "" && bundle.ComputerID != existingComputerID {
		return setupResult{}, newError(categoryCredential, "TeamHub returned a different Computer identity during renewal")
	}
	if existingComputerID != "" && !recovered {
		if err := persistPendingRenewal(pendingRenewalPath, bundle); err != nil {
			return setupResult{}, err
		}
	}
	if issued != nil {
		issued.progress("starting-daemon")
	}
	result, err := commitCredentialBundle(ctx, normalized, deps, bundle, existingComputerID != "" || replacement != nil, existingDaemonStopped)
	if err != nil {
		return setupResult{}, err
	}
	if existingComputerID != "" {
		if err := os.Remove(pendingRenewalPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return setupResult{}, err
		}
	}
	if issued != nil {
		issued.complete()
	}
	for _, path := range leftovers {
		result.warnings = append(result.warnings, "Some files of the previous account are open in another program and were left in "+path+"; close that program and delete the folder to free the space.")
	}
	return result, nil
}

func restartAfterReplacementFailure(ctx context.Context, configPath string, deps setupDeps, original error) error {
	if err := deps.startDaemon(ctx, configPath); err != nil {
		return wrapError(categoryDaemonLifecycle, "Account switch failed and the previous Computer could not be restarted: "+err.Error(), original)
	}
	return original
}

func readPendingRenewal(path, expectedComputerID string) (*credentialBundle, error) {
	encoded, found, err := readOptionalOwnerFile(path, false)
	if err != nil || !found {
		return nil, err
	}
	var value map[string]any
	if json.Unmarshal(encoded, &value) != nil {
		return nil, newError(categoryCredential, "Pending Local Computer credential renewal is invalid")
	}
	bundle, err := parseCredentialBundle(value)
	var expired *credentialExpiredError
	if errors.As(err, &expired) {
		if expired.computerID != expectedComputerID {
			return nil, pendingRenewalIdentityError()
		}
		return nil, removeIfPresent(path)
	}
	if err != nil {
		return nil, err
	}
	if bundle.ComputerID != expectedComputerID {
		return nil, pendingRenewalIdentityError()
	}
	return &bundle, nil
}

func pendingRenewalIdentityError() error {
	return newError(categoryCredential, "Pending Local Computer credential renewal has a different Computer identity")
}

func persistPendingRenewal(path string, bundle credentialBundle) error {
	encoded, err := json.Marshal(bundle)
	if err != nil {
		return err
	}
	return atomicWriteOwnerFile(path, append(encoded, '\n'))
}

// stagedConfig is the config file setup writes, in its key order.
type stagedConfig struct {
	// runner_id is the Computer ID key the Daemon config parser reads.
	RunnerID                string            `json:"runner_id"`
	CredentialExpiresAt     string            `json:"credential_expires_at"`
	DisplayName             string            `json:"display_name"`
	Gateway                 stagedGateway     `json:"gateway"`
	MaxConcurrentOperations *int              `json:"max_concurrent_operations,omitempty"`
	StateDirectory          string            `json:"state_directory"`
	Codex                   *stagedCodex      `json:"codex,omitempty"`
	RuntimePaths            map[string]string `json:"runtime_paths"`
	EnabledRuntimes         []string          `json:"enabled_runtimes,omitempty"`
	WorkspaceGrants         []stagedGrant     `json:"workspace_grants"`
}

type stagedGateway struct {
	URL       string `json:"url"`
	TokenFile string `json:"token_file"`
}

type stagedCodex struct {
	AuthFile string `json:"auth_file"`
}

type stagedGrant struct {
	GrantID  string `json:"grant_id"`
	Label    string `json:"label"`
	TenantID string `json:"tenant_id"`
	RootPath string `json:"root_path"`
	Mode     string `json:"mode"`
	Scope    string `json:"scope"`
}

func commitCredentialBundle(ctx context.Context, normalized normalizedSetup, deps setupDeps, bundle credentialBundle, renewing, existingDaemonStopped bool) (setupResult, error) {
	config, revisionDirectory, err := stageSetup(normalized, bundle)
	if err != nil {
		return setupResult{}, err
	}
	previous, hadPrevious, err := readOptionalOwnerFile(normalized.configPath, true)
	if err != nil {
		return setupResult{}, err
	}
	stoppedExisting := false
	committed := false
	setupErr := func() error {
		if err := atomicWriteOwnerFile(normalized.configPath, config); err != nil {
			return err
		}
		committed = true
		if !existingDaemonStopped {
			stopped, err := deps.stopExistingDaemon(ctx, normalized.configPath, false)
			if err != nil {
				return err
			}
			stoppedExisting = stopped
		}
		return deps.startDaemon(ctx, normalized.configPath)
	}()
	if setupErr != nil {
		var failure *cliError
		if !errors.As(setupErr, &failure) {
			setupErr = wrapError(categoryDaemonLifecycle, setupErr.Error(), setupErr)
		}
		if renewing && committed {
			return setupResult{}, setupErr
		}
		return setupResult{}, rollbackSetup(ctx, normalized.configPath, previous, hadPrevious, revisionDirectory, stoppedExisting, deps, setupErr)
	}
	result := setupResult{computerID: bundle.ComputerID, configPath: normalized.configPath, tenantID: bundle.TenantID}
	if hadPrevious {
		result.warnings = removePreviousSetupRevision(previous, revisionDirectory)
	}
	return result, nil
}

func stageSetup(normalized normalizedSetup, bundle credentialBundle) ([]byte, string, error) {
	revisions := filepath.Join(filepath.Dir(normalized.configPath), "setup-revisions")
	if err := ensureOwnedDirectory(revisions); err != nil {
		return nil, "", err
	}
	revisionDirectory := filepath.Join(revisions, uuid.NewString())
	if err := os.Mkdir(revisionDirectory, 0o700); err != nil {
		return nil, "", err
	}
	credentialPath := filepath.Join(revisionDirectory, "runner-token")
	digest := sha256.Sum256([]byte(normalized.managedWorkspacePath))
	config := stagedConfig{
		RunnerID: bundle.ComputerID, CredentialExpiresAt: bundle.CredentialExpiresAt,
		DisplayName:    normalized.displayName,
		Gateway:        stagedGateway{URL: bundle.GatewayURL, TokenFile: credentialPath},
		StateDirectory: normalized.stateDirectory, RuntimePaths: normalized.runtimePaths,
		EnabledRuntimes: normalized.enabledRuntimes,
		WorkspaceGrants: []stagedGrant{{
			GrantID: "grant-" + hex.EncodeToString(digest[:])[:24], Label: "Linger managed workspace",
			TenantID: bundle.TenantID, RootPath: normalized.managedWorkspacePath, Mode: "workspace-write", Scope: "owner",
		}},
	}
	if normalized.maxRuns != nil {
		config.MaxConcurrentOperations = normalized.maxRuns
	}
	if normalized.codexAuthFile != "" {
		config.Codex = &stagedCodex{AuthFile: normalized.codexAuthFile}
	}
	encoded := []byte(marshalReport(config))
	for _, file := range []struct {
		name string
		data []byte
	}{
		{"runner-token", []byte(bundle.GatewayToken)},
		{"computer-id", []byte(bundle.ComputerID + "\n")},
		{"computer.json", encoded},
	} {
		if err := atomicWriteOwnerFile(filepath.Join(revisionDirectory, file.name), file.data); err != nil {
			_ = os.RemoveAll(revisionDirectory)
			return nil, "", err
		}
	}
	return encoded, revisionDirectory, nil
}

func rollbackSetup(ctx context.Context, configPath string, previous []byte, hadPrevious bool, revisionDirectory string, stoppedExisting bool, deps setupDeps, setupErr error) error {
	var rollbackErrors []error
	if hadPrevious {
		if err := atomicWriteOwnerFile(configPath, previous); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		}
	} else if err := removeIfPresent(configPath); err != nil {
		rollbackErrors = append(rollbackErrors, err)
	}
	if err := os.RemoveAll(revisionDirectory); err != nil {
		rollbackErrors = append(rollbackErrors, err)
	}
	if stoppedExisting && hadPrevious {
		if err := deps.startDaemon(ctx, configPath); err != nil {
			rollbackErrors = append(rollbackErrors, err)
		}
	}
	if len(rollbackErrors) > 0 {
		return wrapError(categoryInternal, "Local Computer setup failed and rollback was incomplete", errors.Join(append([]error{setupErr}, rollbackErrors...)...))
	}
	return setupErr
}

func removePreviousSetupRevision(previous []byte, currentRevision string) []string {
	err := func() error {
		var value struct {
			Gateway struct {
				TokenFile string `json:"token_file"`
			} `json:"gateway"`
		}
		decoded := json.Unmarshal(previous, &value) == nil
		if !decoded || !filepath.IsAbs(value.Gateway.TokenFile) {
			return nil
		}
		previousRevision := filepath.Dir(value.Gateway.TokenFile)
		if previousRevision == currentRevision || filepath.Dir(previousRevision) != filepath.Dir(currentRevision) {
			return nil
		}
		if err := privatefs.CheckPath(previousRevision, "directory", false); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return err
			}
			return errors.New("Previous setup revision is unsafe")
		}
		return os.RemoveAll(previousRevision)
	}()
	if err != nil {
		return []string{"Previous setup credential could not be removed: " + err.Error()}
	}
	return nil
}

func normalizeSetupOptions(options setupOptions, deps setupDeps) (normalizedSetup, error) {
	if !filepath.IsAbs(options.configPath) || !filepath.IsAbs(options.stateDirectory) {
		return normalizedSetup{}, newError(categoryConfiguration, "Local Computer paths must be absolute")
	}
	if name := strings.TrimSpace(options.displayName); name == "" || len([]rune(name)) > 120 {
		return normalizedSetup{}, newError(categoryConfiguration, "Local Computer display name is invalid")
	}
	normalized := normalizedSetup{setupOptions: options}
	if options.serverToken != "" {
		token, err := parseServerToken(options.serverToken)
		if err != nil {
			return normalizedSetup{}, err
		}
		existing, err := readExistingComputerID(options.configPath)
		if err != nil {
			return normalizedSetup{}, err
		}
		if existing != "" && existing != token.ComputerID {
			return normalizedSetup{}, newError(categoryCredential, "This machine already has a different Computer identity. Use its existing setup or an isolated installation; the server token was not exchanged.")
		}
		normalized.token = token
		normalized.webURL = token.Origin
	}
	webURL, err := requireWebOrigin(normalized.webURL)
	if err != nil {
		return normalizedSetup{}, err
	}
	normalized.webURL = webURL
	if normalized.callbackTimeout == 0 {
		normalized.callbackTimeout = 5 * time.Minute
	}
	if options.enabledRuntimes != nil && !validRuntimeSelection(options.enabledRuntimes) {
		return normalizedSetup{}, newError(categoryConfiguration, "enabled_runtimes must be a nonempty unique supported Runtime subset")
	}
	if normalized.codexAuthFile == "" && (options.enabledRuntimes == nil || slices.Contains(options.enabledRuntimes, "codex")) {
		if normalized.codexAuthFile, err = discoverDefaultCodexAuthFile(deps.environment, deps.homeDirectory); err != nil {
			return normalizedSetup{}, err
		}
	}
	if normalized.codexAuthFile != "" {
		if err := checkOwnedFile(normalized.codexAuthFile); err != nil {
			return normalizedSetup{}, err
		}
	}
	if normalized.runtimePaths == nil {
		normalized.runtimePaths = map[string]string{}
	}
	for _, executable := range normalized.runtimePaths {
		if !filepath.IsAbs(executable) {
			return normalizedSetup{}, newError(categoryConfiguration, "Runtime overrides must be absolute executable paths")
		}
	}
	if options.gatewayURL != "" {
		if err := validateGatewayURL(options.gatewayURL); err != nil {
			return normalizedSetup{}, err
		}
	}
	if options.maxRuns != nil && (*options.maxRuns < 1 || *options.maxRuns > 100) {
		return normalizedSetup{}, newError(categoryConfiguration, "Maximum concurrent runs must be between 1 and 100")
	}
	normalized.displayName = strings.TrimSpace(options.displayName)
	if normalized.token != nil {
		normalized.displayName = strings.TrimSpace(normalized.token.DisplayName)
	}
	normalized.managedWorkspacePath = filepath.Join(options.stateDirectory, "workspaces")
	return normalized, nil
}

func discoverDefaultCodexAuthFile(environment map[string]string, homeDirectory string) (string, error) {
	codexHome := strings.TrimSpace(environment["CODEX_HOME"])
	if codexHome != "" && !filepath.IsAbs(codexHome) {
		return "", newError(categoryConfiguration, "CODEX_HOME must be an absolute path")
	}
	if codexHome == "" {
		codexHome = filepath.Join(homeDirectory, ".codex")
	}
	authFile := filepath.Join(codexHome, "auth.json")
	if _, err := os.Lstat(authFile); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	return authFile, nil
}

// requireWebOrigin accepts only an HTTP(S) origin and returns it normalized.
func requireWebOrigin(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" {
		return "", newError(categoryConfiguration, "Linger Web URL is invalid")
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || (parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" {
		return "", newError(categoryConfiguration, "Linger Web URL must be an HTTP origin")
	}
	return strings.ToLower(parsed.Scheme) + "://" + strings.ToLower(parsed.Host), nil
}

func prepareStateDestinations(normalized normalizedSetup) error {
	if err := ensureOwnedDirectory(filepath.Dir(normalized.configPath)); err != nil {
		return err
	}
	if err := checkSafeDestination(normalized.configPath); err != nil {
		return err
	}
	if err := ensureOwnedDirectory(normalized.stateDirectory); err != nil {
		return err
	}
	return ensureOwnedDirectory(normalized.managedWorkspacePath)
}

func ensureOwnedDirectory(directory string) error {
	if err := privatefs.EnsureDir(directory); err != nil {
		return wrapError(categoryConfiguration, "Local Computer state directory is unsafe", err)
	}
	return nil
}

// checkOwnedFile requires a regular single-link file this user owns.
func checkOwnedFile(path string) error {
	err := privatefs.CheckPath(path, "file", false)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return err
	}
	return wrapError(categoryConfiguration, "Local Computer state file is unsafe", err)
}

func checkSafeDestination(path string) error {
	if err := checkOwnedFile(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// readOptionalOwnerFile reads a file this user owns; ownerOnly also requires
// that no other user can read it.
func readOptionalOwnerFile(path string, anyMode bool) ([]byte, bool, error) {
	var data []byte
	var err error
	if anyMode {
		if err = checkOwnedFile(path); err == nil {
			data, err = os.ReadFile(path)
		}
	} else {
		data, err = privatefs.ReadFile(path, maxConfigBytes)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			err = wrapError(categoryConfiguration, "Local Computer state file is unsafe", err)
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	return data, err == nil, err
}

func readExistingComputerID(configPath string) (string, error) {
	encoded, found, err := readOptionalOwnerFile(configPath, true)
	if err != nil || !found {
		return "", err
	}
	var decoded any
	if json.Unmarshal(encoded, &decoded) != nil {
		return "", newError(categoryConfiguration, "Computer config is not valid JSON")
	}
	value, ok := decoded.(map[string]any)
	if !ok {
		return "", newError(categoryConfiguration, "Computer config must be an object")
	}
	computerID := stringField(value, "runner_id")
	if !idPattern.MatchString(computerID) {
		return "", newError(categoryConfiguration, "Existing Computer ID is invalid")
	}
	return computerID, nil
}

func readExistingMaxConcurrentOperations(configPath string) (*int, error) {
	encoded, found, err := readOptionalOwnerFile(configPath, true)
	if err != nil || !found {
		return nil, err
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(encoded, &value) != nil {
		return nil, newError(categoryConfiguration, "Existing Computer config is invalid")
	}
	raw, present := value["max_concurrent_operations"]
	if !present {
		return nil, nil
	}
	var maximum int
	if json.Unmarshal(raw, &maximum) != nil || maximum < 1 || maximum > 100 {
		return nil, newError(categoryConfiguration, "Existing maximum concurrent runs must be between 1 and 100")
	}
	return &maximum, nil
}

func atomicWriteOwnerFile(path string, data []byte) error {
	if err := checkSafeDestination(path); err != nil {
		return err
	}
	return privatefs.WriteFile(path, data, false)
}

func removeIfPresent(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// stopConfiguredDaemon stops the Daemon of an existing config and reports
// whether one was running.
func stopConfiguredDaemon(ctx context.Context, configPath string, ifIdle bool, environment map[string]string, newClient func(string) controlClient) (bool, error) {
	if _, err := os.Lstat(configPath); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	stateDirectory, err := loadStateDirectory(configPath)
	if err != nil {
		return false, err
	}
	client := newClient(stateDirectory)
	status, err := client.Status(ctx)
	if err != nil {
		return false, nil //nolint:nilerr // an unreachable Daemon is not running for setup's purpose
	}
	pid, ok := status.integer("pid")
	if !ok || pid < 1 {
		return false, errors.New("Existing Computer daemon has an invalid PID")
	}
	if _, err := loadFullConfig(configPath, environment); err != nil {
		return false, err
	}
	if ifIdle {
		_, err = client.ShutdownIfIdle(ctx)
	} else {
		_, err = client.Shutdown(ctx)
	}
	if err != nil {
		return false, err
	}
	return true, waitUntilDaemonStops(ctx, client, pid)
}

// openBrowser opens url in the user's browser and always prints it.
func openBrowser(output io.Writer, goos string, environment map[string]string) func(string) error {
	return func(target string) error {
		_, _ = fmt.Fprintf(output, "If the browser does not open, visit:\n%s\n", target)
		var command *exec.Cmd
		switch goos {
		case "darwin":
			command = exec.Command("open", target)
		case "linux":
			command = exec.Command("xdg-open", target)
		case "windows":
			systemRoot := environment["SYSTEMROOT"]
			if systemRoot == "" {
				systemRoot = `C:\Windows`
			}
			command = exec.Command(filepath.Join(systemRoot, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", target)
		default:
			return errors.New("Automatic browser setup is unsupported on this platform")
		}
		if err := command.Start(); err != nil {
			return err
		}
		go func() { _ = command.Wait() }()
		return nil
	}
}

func newExchangeClient() *http.Client {
	return &http.Client{CheckRedirect: noRedirects}
}
