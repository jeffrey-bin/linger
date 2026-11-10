// Command linger-computer-daemon runs the resident Local Computer Daemon.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/computerconfig"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/daemon"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	lingercontrol "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localskills"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/permission"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localprocess "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/selfupdate"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

func main() {
	// Codex runs this for every PermissionRequest of a reviewed Run; it only
	// forwards the hook to the running Daemon.
	if len(os.Args) == 3 && os.Args[1] == "permission-hook" {
		os.Exit(permission.CodexRunHook(os.Stdin, os.Stdout, os.Stderr, os.Args[2]))
	}
	if handoff := recoverPendingUpgrade(os.Args[1:]); handoff != nil {
		if execErr := handoff.Exec(); execErr != nil {
			_, _ = fmt.Fprintln(os.Stderr, execErr)
			os.Exit(1)
		}
	}
	err := run(os.Args[1:])
	// run has returned, so its deferred shutdown (including instance lease
	// release) has completed. Replacing the image keeps the PID and process group.
	var handoff *selfupdate.Handoff
	if errors.As(err, &handoff) {
		if execErr := handoff.Exec(); execErr != nil {
			_, _ = fmt.Fprintln(os.Stderr, execErr)
			os.Exit(1)
		}
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// recoverPendingUpgrade settles an unconfirmed self-update before any daemon
// initialization that could fail, so a new bundle that cannot start does not
// crash-loop under its supervisor.
func recoverPendingUpgrade(args []string) *selfupdate.Handoff {
	if len(args) != 2 || args[0] != "--config" || args[1] == "" {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return nil //nolint:nilerr // without its own path the daemon has no install layout to recover
	}
	absoluteConfig, err := filepath.Abs(args[1])
	if err != nil {
		return nil //nolint:nilerr // an unresolvable config path leaves normal startup to report it
	}
	return selfupdate.RecoverAtStartup(selfupdate.Options{
		ReleaseVersion: transport.ReleaseVersion, GOOS: runtime.GOOS, Executable: executable,
		ConfigPath: absoluteConfig, Args: os.Args, Env: os.Environ(),
	})
}

func run(args []string) (resultErr error) {
	if handled, err := platformEntry(args); handled {
		return err
	}
	if len(args) != 2 || args[0] != "--config" || args[1] == "" {
		return errors.New("linger-computer-daemon requires --config <path>")
	}
	environment := computerconfig.ProcessEnvironment()
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	serviceCommand, err := boundServiceCommand(environment["LINGER_COMPUTER_SERVICE_COMMAND"], args[1], executable)
	if err != nil {
		return err
	}
	computer, err := computerconfig.Load(args[1], environment)
	if err != nil {
		return err
	}
	if err := privatefs.EnsureDir(computer.StateDirectory); err != nil {
		return err
	}
	instanceLease, err := lingercontrol.AcquireLease(context.Background(), computer.StateDirectory)
	if err != nil {
		return err
	}
	defer func() {
		releaseCtx, releaseCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer releaseCancel()
		resultErr = errors.Join(resultErr, instanceLease.Release(releaseCtx))
	}()
	managedToolsBin, err := prepareManagedToolsEnvironment(context.Background(), environment, executable)
	if err != nil {
		return err
	}
	operationTempBase := filepath.Join(computer.StateDirectory, "operation-tmp")
	if removed, bytesFreed, err := localworkspace.PruneOperationTemps(operationTempBase, slog.Default()); err != nil {
		return err
	} else if removed > 0 {
		slog.Info("pruned abandoned Operation temp directories", "removed", removed, "bytes_freed", bytesFreed)
	}
	providerEnvironment := runtimeProviderEnvironment(environment, computer.GatewayToken, computer.CodexAuthFile)
	discovered, err := provider.Discover(context.Background(), provider.DiscoveryOptions{
		ConfiguredPaths: computer.RuntimePaths,
		Runtimes:        computer.EnabledRuntimes,
		RuntimeHomeRoot: filepath.Join(computer.StateDirectory, "runtime-homes"),
		Environment:     providerEnvironment,
	})
	if err != nil {
		return err
	}
	logRuntimeDiagnostics(discovered.Diagnostics)
	diagnostics, err := provider.DiagnosticsJSON(discovered.Diagnostics)
	if err != nil {
		return err
	}
	registrationStore := registration.NewMemoryStore()
	// Revisions order this Computer's Runtime observations at the Gateway;
	// starting from the clock keeps them increasing across Daemon restarts.
	runtimeObservationRevision := uint64(time.Now().UnixMilli())
	assignmentStore := assignment.NewMemoryStore()
	cliCredentials, err := clicredential.Open(filepath.Join(computer.StateDirectory, "agent-cli-credentials"))
	if err != nil {
		return err
	}
	views, err := lingercontext.OpenViewStore(
		filepath.Join(computer.StateDirectory, "context-views.sqlite"),
		filepath.Join(computer.StateDirectory, "context-views"), nil,
	)
	if err != nil {
		return err
	}
	defer views.Close()
	if err := views.UseSharedTaskStorage(lingercontext.LocalSharedTaskStorage(filepath.Join(computer.StateDirectory, "task-workspaces"))); err != nil {
		return err
	}
	localSkills, err := localskills.Open(localskills.Options{
		HomeDirectory: environment["HOME"], CodexHome: environment["CODEX_HOME"], CurrentUID: os.Getuid(),
	})
	if err != nil {
		return err
	}
	managedServices, err := localprocess.NewManagedServiceRegistry(computer.StateDirectory, providerEnvironment)
	if err != nil {
		return err
	}
	providers, runtimes := providerInstallations(discovered, providerEnvironment)
	providerCatalog := lingercontext.NewProviderCatalog(providers)
	workspaceGrants := make(map[string]lingercontext.WorkspaceGrant)
	wireGrants := make([]map[string]any, 0, len(computer.WorkspaceGrants))
	for _, grant := range computer.WorkspaceGrants {
		workspaceGrants[grant.GrantID] = lingercontext.WorkspaceGrant{
			GrantID: grant.GrantID, TenantID: grant.TenantID, Path: grant.RootPath,
		}
		wireGrant := map[string]any{
			"grant_id": grant.GrantID, "tenant_id": grant.TenantID,
			"mode": grant.Mode, "scope": grant.Scope,
		}
		if grant.Label != "" {
			wireGrant["label"] = grant.Label
		}
		wireGrants = append(wireGrants, wireGrant)
	}
	encodedGrants, err := json.Marshal(wireGrants)
	if err != nil {
		return err
	}
	teamhubBin := installedTeamHubCLIBin()
	if computer.Desktop != nil && computer.Desktop.TeamHubCLIDirectory != "" {
		teamhubBin = computer.Desktop.TeamHubCLIDirectory
	}
	if managedToolsBin != "" {
		teamhubBin = managedToolsBin
	}
	resolver := lingercontext.ExecutionResolver{
		ServiceCommand: serviceCommand,
		TeamHubCLIBin:  teamhubBin,
		ProviderLookup: providerCatalog.Lookup, WorkspaceGrants: workspaceGrants, Views: views,
		CLICredentials: cliCredentials,
		RegistrationLookup: func(ctx context.Context, registrationID string) (lingercontext.RegistrationBinding, bool, error) {
			items, err := registrationStore.List(ctx)
			if err != nil {
				return lingercontext.RegistrationBinding{}, false, err
			}
			for _, item := range items {
				if item.RegistrationID == registrationID {
					return lingercontext.RegistrationBinding{
						RegistrationID: item.RegistrationID, TenantID: item.Key.TenantID,
						OwnerActorID: item.Key.OwnerActorID, ProviderType: item.Key.ProviderType,
						Status: item.Status,
					}, true, nil
				}
			}
			return lingercontext.RegistrationBinding{}, false, nil
		},
	}
	toolInstallation, err := localtools.Installed(executable)
	if err != nil {
		return err
	}
	var toolManager *localtools.Manager
	var toolBinder daemon.LocalToolBinder
	var piExtension string
	var browserConnections daemon.BrowserConnections
	owners := make([]daemon.ComputerOwner, 0, len(computer.Owners))
	for _, owner := range computer.Owners {
		owners = append(owners, daemon.ComputerOwner{TenantID: owner.TenantID, OwnerActorID: owner.OwnerActorID})
	}
	if toolInstallation != nil {
		cuaPath := toolInstallation.CuaPath
		if override := os.Getenv("LINGER_COMPUTER_CUA_PATH"); override != "" {
			cuaPath = override
		}
		toolManager, err = localtools.New(localtools.Options{
			StateDirectory: computer.StateDirectory, Environment: providerEnvironment,
			NodePath: toolInstallation.NodePath, PlaywrightEntry: toolInstallation.PlaywrightEntry, CuaPath: cuaPath,
		})
		if err != nil {
			return err
		}
		toolBinder, piExtension = toolManager, toolInstallation.PiExtension
		if runtime.GOOS == "darwin" {
			resolver.ToolGuide = localtools.MacToolGuide
		} else if runtime.GOOS == "linux" {
			resolver.ToolGuide = localtools.NativeLinuxToolGuide
		}
		if toolManager.ConnectsEverydayBrowser() {
			browserConnections = toolManager
		}
		defer func() { resultErr = errors.Join(resultErr, toolManager.Close()) }()
	}
	// The Desktop app owns stdio: stdin carries its hello and permission
	// answers, stdout the status lines and permission requests.
	var desktop *desktopChannel
	permissionOptions := localtools.ComputerPermissionOptions{Platform: runtime.GOOS, Desktop: computer.Desktop != nil}
	if computer.Desktop != nil {
		desktop = newDesktopChannel(os.Stdout)
		permissionOptions.Linger = desktop
	}
	if toolManager != nil {
		permissionOptions.Cua = toolManager
	}
	inventory := &runtimeInventory{
		computer: computer, rejected: provider.NewRejectedModels(runtimeCredentialFiles(providerEnvironment)),
		runtimes: runtimes, diagnostics: discovered.Diagnostics, revision: runtimeObservationRevision,
	}
	codexModelSessions := &provider.CodexSessions{Root: filepath.Join(computer.StateDirectory, "model-invoke", "codex-sessions")}
	localDaemon, err := daemon.New(daemon.Options{
		ComputerID: computer.ComputerID, DisplayName: computer.DisplayName,
		Capacity: computer.MaxConcurrentOperations, Runtimes: runtimes,
		EnabledRuntimes:    computer.EnabledRuntimes,
		RuntimeDiagnostics: diagnostics, WorkspaceGrants: encodedGrants,
		StateDirectory:      computer.StateDirectory,
		RuntimeHomeRoot:     filepath.Join(computer.StateDirectory, "runtime-homes"),
		RuntimeObservations: runtimeObservations(computer, discovered.Diagnostics, runtimeObservationRevision),
		OnModelUnavailable:  inventory.reject,
		ControlPlane:        transport.GatewayControlPlane{URL: computer.GatewayURL, BearerToken: computer.GatewayToken},
		IdentityStore:       transport.IdentityFileStore{Path: filepath.Join(computer.StateDirectory, "daemon-identity.json")},
		Executor: provider.Executor{
			TempBase: operationTempBase, RuntimeHomeRoot: filepath.Join(computer.StateDirectory, "runtime-homes"),
			CodexModelSessionHome: codexModelSessions.Home(),
			PiMCPExtension:        piExtension,
		}, OperationResolver: resolver,
		Ledger: daemon.NewMemoryLedger(), Registrations: registrationStore, Assignments: assignmentStore, ContextViews: views,
		LocalSkills: localSkills, LocalTools: toolBinder,
		BrowserConnections: browserConnections, Owners: owners,
		ComputerPermissions: localtools.NewComputerPermissions(permissionOptions),
		CLICredentials:      cliCredentials,
		ModelInvoker: provider.ModelInvoker{
			TempBase:         operationTempBase,
			ClaudeConfigRoot: filepath.Join(computer.StateDirectory, "model-invoke", "claude", ".claude"),
			CodexSessions:    codexModelSessions,
			RuntimeHomeRoot:  filepath.Join(computer.StateDirectory, "runtime-homes"),
			Lookup: func(ctx context.Context, runtimeType string) (provider.ModelInvokeRuntime, bool, error) {
				installed, ok, err := providerCatalog.Lookup(ctx, runtimeType)
				return provider.ModelInvokeRuntime{
					ExecutablePath: installed.ExecutablePath, Environment: installed.Environment, Version: installed.Version,
				}, ok, err
			},
		},
	})
	if err != nil {
		return err
	}
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, cancel := context.WithCancel(signalCtx)
	defer cancel()
	absoluteConfig, err := filepath.Abs(args[1])
	if err != nil {
		return err
	}
	// The Desktop app ships and updates its Daemon; an upgrade request only
	// shows as the upgrade-required Gateway state.
	var updates *selfupdate.Manager
	if computer.Desktop == nil {
		var stager selfupdate.Stager = selfupdate.ScriptStager{}
		if runtime.GOOS == "windows" {
			stager = selfupdate.WindowsStager{}
		}
		updates = selfupdate.New(selfupdate.Options{
			ReleaseVersion: transport.ReleaseVersion, GOOS: runtime.GOOS, Executable: executable, ComputerID: computer.ComputerID,
			ConfigPath: absoluteConfig, Args: os.Args, Env: os.Environ(),
			Admission: localDaemon, Stager: stager, Stop: cancel,
		})
		localDaemon.SetSelfUpdater(updates)
	}
	controller := &controlController{
		daemon: localDaemon, assignments: assignmentStore, diagnostics: discovered.Diagnostics,
		services: managedServices, computerID: computer.ComputerID,
		capacity:    computer.MaxConcurrentOperations,
		launchNonce: os.Getenv("LINGER_DAEMON_LAUNCH_NONCE"), cancel: cancel,
	}
	controlServer, err := lingercontrol.New(computer.StateDirectory, controller)
	if err != nil {
		return err
	}
	if err := controlServer.Start(); err != nil {
		return err
	}
	defer func() {
		closeCtx, closeCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer closeCancel()
		_ = controlServer.Close(closeCtx)
	}()
	if desktop != nil {
		go desktop.read(os.Stdin, controller.Shutdown)
		go reportDesktopStatus(ctx, desktop.encode, localDaemon, desktopStatusInterval)
	}
	inventory.start(ctx, localDaemon)
	monitorDone := make(chan error, 1)
	go func() {
		monitorDone <- provider.MonitorRuntimeDiagnostics(ctx, provider.RuntimeMonitorOptions{
			Initial: discovered,
			Discovery: provider.DiscoveryOptions{
				ConfiguredPaths: computer.RuntimePaths,
				Runtimes:        computer.EnabledRuntimes,
				RuntimeHomeRoot: filepath.Join(computer.StateDirectory, "runtime-homes"),
				Environment:     providerEnvironment,
			},
			RefreshInterval:       15 * time.Second,
			FullRefreshEveryTicks: 4,
			FullRefreshAllowed: func() bool {
				return localDaemon.ActiveOperationCount() == 0
			},
			RuntimeBusy: func() bool {
				return localDaemon.ActiveOperationCount() > 0
			},
			OnChanged: func(next provider.DiscoveryResult) error {
				logRuntimeDiagnostics(next.Diagnostics)
				nextProviders, nextRuntimes := providerInstallations(next, providerEnvironment)
				providerCatalog.Replace(nextProviders)
				controller.UpdateDiagnostics(next.Diagnostics)
				return inventory.publish(ctx, nextRuntimes, next.Diagnostics)
			},
			OnError: func(err error) {
				slog.Warn("Runtime diagnostic refresh failed", "error", err)
			},
		})
	}()
	daemonErr := localDaemon.Run(ctx)
	localDaemon.Drain()
	localDaemon.WaitForOperations()
	cancel()
	monitorErr := <-monitorDone
	if errors.Is(monitorErr, context.Canceled) {
		monitorErr = nil
	}
	var handoffErr error
	if updates != nil {
		handoffErr = updates.Handoff()
	}
	return errors.Join(daemonErr, monitorErr, handoffErr)
}

type controlController struct {
	daemon        *daemon.Daemon
	assignments   assignment.Store
	services      *localprocess.ManagedServiceRegistry
	diagnostics   []provider.RuntimeDiagnostic
	diagnosticsMu sync.RWMutex
	computerID    string
	capacity      *int
	launchNonce   string
	cancel        context.CancelFunc
}

func (c *controlController) Status(ctx context.Context) (map[string]any, error) {
	runners, err := c.assignments.List(ctx)
	if err != nil {
		return nil, err
	}
	activeRunners := 0
	for _, runner := range runners {
		if runner.State == "ready" {
			activeRunners++
		}
	}
	result := map[string]any{
		"pid": os.Getpid(), "computer_id": c.computerID, "state": "running", "daemon_version": transport.ReleaseVersion,
		"gateway_state":  c.daemon.GatewayState(),
		"reconciled":     c.daemon.Reconciled(),
		"active_runners": activeRunners, "active_operations": c.daemon.ActiveOperationCount(),
	}
	if c.capacity != nil {
		result["capacity"] = *c.capacity
	}
	if c.launchNonce != "" {
		result["launch_nonce"] = c.launchNonce
	}
	return result, nil
}

func (c *controlController) Runtimes(context.Context) (any, error) {
	c.diagnosticsMu.RLock()
	defer c.diagnosticsMu.RUnlock()
	return append([]provider.RuntimeDiagnostic(nil), c.diagnostics...), nil
}

func (c *controlController) UpdateDiagnostics(diagnostics []provider.RuntimeDiagnostic) {
	c.diagnosticsMu.Lock()
	c.diagnostics = append([]provider.RuntimeDiagnostic(nil), diagnostics...)
	c.diagnosticsMu.Unlock()
}

func (c *controlController) Runners(ctx context.Context) (any, error) {
	return c.assignments.List(ctx)
}

func (c *controlController) Runner(ctx context.Context, agentID string) (any, bool, error) {
	records, err := c.assignments.List(ctx)
	if err != nil {
		return nil, false, err
	}
	for _, record := range records {
		if record.AgentID == agentID && record.State != "removed" {
			return record, true, nil
		}
	}
	return nil, false, nil
}

func (c *controlController) StopRunner(ctx context.Context, agentID string) (any, bool, error) {
	value, found, err := c.Runner(ctx, agentID)
	if err != nil || !found {
		return nil, found, err
	}
	if err := c.daemon.StopAgentRunner(ctx, agentID); err != nil {
		return nil, false, err
	}
	record := value.(assignment.Record)
	return pausedRunnerResult(record), true, nil
}

func pausedRunnerResult(record assignment.Record) map[string]any {
	return map[string]any{
		"runner_id": record.RunnerID, "tenant_id": record.TenantID,
		"agent_id": record.AgentID, "state": "paused", "runner_revision": record.RunnerRevision,
	}
}

func (c *controlController) Services(ctx context.Context) (any, error) {
	return c.services.List(ctx)
}

func (c *controlController) StartService(ctx context.Context, input lingercontrol.ServiceStart) (any, bool, error) {
	service, err := c.services.Start(ctx, localprocess.ManagedServiceStart{
		Name: input.Name, Command: input.Command, Args: append([]string(nil), input.Args...), Cwd: input.Cwd,
	})
	return service, service != nil, err
}

func (c *controlController) StopService(ctx context.Context, name string) (any, bool, error) {
	service, err := c.services.Stop(ctx, name)
	return service, service != nil, err
}

func (c *controlController) Shutdown() {
	c.daemon.Drain()
	c.cancel()
}

func (c *controlController) ShutdownIfIdle() int {
	return c.daemon.DrainIfIdle()
}

// runtimeInventory publishes the discovered Runtimes to the Gateway without
// the models their current login refused.
type runtimeInventory struct {
	mu          sync.Mutex
	daemon      *daemon.Daemon
	ctx         context.Context
	computer    computerconfig.Config
	rejected    *provider.RejectedModels
	runtimes    []string
	diagnostics []provider.RuntimeDiagnostic
	revision    uint64
}

// start binds the running Daemon and makes expired refusals selectable again
// when the login file changes or the time limit passes.
func (i *runtimeInventory) start(ctx context.Context, localDaemon *daemon.Daemon) {
	i.mu.Lock()
	i.ctx, i.daemon = ctx, localDaemon
	i.mu.Unlock()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if i.rejected.Expire() {
					i.republish()
				}
			}
		}
	}()
}

func (i *runtimeInventory) publish(ctx context.Context, runtimes []string, diagnostics []provider.RuntimeDiagnostic) error {
	i.mu.Lock()
	defer i.mu.Unlock()
	i.runtimes, i.diagnostics = runtimes, diagnostics
	return i.publishLocked(ctx)
}

func (i *runtimeInventory) publishLocked(ctx context.Context) error {
	if i.daemon == nil {
		return nil
	}
	visible := i.rejected.Filter(i.diagnostics)
	encoded, err := provider.DiagnosticsJSON(visible)
	if err != nil {
		return err
	}
	i.revision++
	return i.daemon.UpdateRuntimeInventory(ctx, i.runtimes, encoded, runtimeObservations(i.computer, visible, i.revision))
}

// reject runs on the Operation terminal path, so it publishes asynchronously.
func (i *runtimeInventory) reject(runtimeType, modelID string) {
	i.rejected.Reject(runtimeType, modelID)
	slog.Info("runner.runtime_model.rejected", "runtime_type", runtimeType, "model", modelID)
	go i.republish()
}

func (i *runtimeInventory) republish() {
	i.mu.Lock()
	defer i.mu.Unlock()
	if i.ctx == nil {
		return
	}
	if err := i.publishLocked(i.ctx); err != nil {
		slog.Warn("Runtime model catalog refresh failed", "error", err)
	}
}

// runtimeCredentialFiles names the login files that identify each Runtime's
// account. A Claude login kept in the macOS keychain has no file; its
// refusals expire by time only.
func runtimeCredentialFiles(environment map[string]string) map[string]string {
	codexHome := environment["CODEX_HOME"]
	if codexHome == "" {
		codexHome = filepath.Join(environment["HOME"], ".codex")
	}
	claudeHome := environment["CLAUDE_CONFIG_DIR"]
	if claudeHome == "" {
		claudeHome = filepath.Join(environment["HOME"], ".claude")
	}
	return map[string]string{
		"codex":  filepath.Join(codexHome, "auth.json"),
		"claude": filepath.Join(claudeHome, ".credentials.json"),
	}
}

func runtimeObservations(computer computerconfig.Config, diagnostics []provider.RuntimeDiagnostic, revision uint64) []transport.RegistrationObservation {
	result := make([]transport.RegistrationObservation, 0, len(computer.Owners)*len(diagnostics))
	for _, owner := range computer.Owners {
		for _, diagnostic := range diagnostics {
			status := "unavailable"
			capabilities := []string{}
			if diagnostic.Status == "ready" || diagnostic.Status == "authentication_required" {
				status = "online"
				capabilities = []string{"turn"}
			}
			encoded, _ := json.Marshal(diagnostic)
			result = append(result, transport.RegistrationObservation{
				TenantID: owner.TenantID, OwnerActorID: owner.OwnerActorID,
				ProviderType: diagnostic.Type, Status: status, Revision: revision,
				Capabilities: capabilities, RuntimeDiagnostics: encoded,
			})
		}
	}
	return result
}

func providerInstallations(discovered provider.DiscoveryResult, environment map[string]string) (map[string]lingercontext.ProviderInstallation, []string) {
	providers := make(map[string]lingercontext.ProviderInstallation, len(discovered.Installations))
	runtimes := make([]string, 0, len(discovered.Installations))
	for runtimeType, diagnostic := range discovered.Installations {
		runtimeEnvironment := maps.Clone(environment)
		if diagnostic.ExecutionPath != "" {
			if runtimeEnvironment == nil {
				runtimeEnvironment = make(map[string]string)
			}
			runtimeEnvironment["PATH"] = diagnostic.ExecutionPath
		}
		contextWindows := make(map[string]int, len(diagnostic.Models))
		for _, model := range diagnostic.Models {
			if model.ContextWindow > 0 {
				contextWindows[model.ID] = model.ContextWindow
			}
		}
		providers[runtimeType] = lingercontext.ProviderInstallation{
			Type: runtimeType, ExecutablePath: diagnostic.ExecutablePath, EntryPath: diagnostic.EntryPath,
			Environment: runtimeEnvironment, Version: diagnostic.Version, ContextWindows: contextWindows,
		}
		runtimes = append(runtimes, runtimeType)
	}
	sort.Strings(runtimes)
	return providers, runtimes
}

func installedTeamHubCLIBin() string {
	executable, err := os.Executable()
	if err != nil {
		return ""
	}
	return installedTeamHubCLIBinAt(executable)
}

func installedTeamHubCLIBinAt(executable string) string {
	directory := filepath.Clean(filepath.Join(filepath.Dir(executable), "..", "cli"))
	entry := "teamhub"
	if runtime.GOOS == "windows" {
		entry += ".exe"
	}
	info, err := os.Stat(filepath.Join(directory, entry))
	if err != nil || !info.Mode().IsRegular() || (runtime.GOOS != "windows" && info.Mode().Perm()&0o111 == 0) {
		return ""
	}
	return directory
}

func runtimeProviderEnvironment(source map[string]string, gatewayToken, codexAuthFile string) map[string]string {
	result := computerconfig.RuntimeEnvironment(source, gatewayToken)
	if codexAuthFile != "" {
		result["CODEX_HOME"] = filepath.Dir(codexAuthFile)
	}
	return result
}

// Only the local CLI supplies this command. Keep it out of Runtime
// environment and wire payloads; expose the bound argv as developer guidance.
// The command is always [CLI, --config, <config>]. A Daemon started by a
// self-update handoff from a release whose CLI this bundle no longer ships
// gets a command naming a missing program; it binds its own bundle's CLI
// instead, so Agents never receive a command that cannot run.
func boundServiceCommand(encoded, configPath, executable string) ([]string, error) {
	if encoded == "" {
		return nil, nil
	}
	var command []string
	if len(encoded) > 32768 || json.Unmarshal([]byte(encoded), &command) != nil || len(command) < 3 {
		return nil, errors.New("invalid bound Computer service command")
	}
	absoluteConfig, err := filepath.Abs(configPath)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(command[0]) || command[len(command)-2] != "--config" || command[len(command)-1] != absoluteConfig {
		return nil, errors.New("Computer service command does not target this configuration")
	}
	for _, arg := range command {
		if strings.ContainsRune(arg, '\x00') {
			return nil, errors.New("invalid Computer service argument")
		}
	}
	if len(command) == 3 && regularFile(command[0]) {
		return command, nil
	}
	bundled := filepath.Join(filepath.Dir(executable), "..", "cli", "linger-computer")
	if runtime.GOOS == "windows" {
		bundled += ".exe"
	}
	if !regularFile(bundled) {
		return nil, errors.New("Computer service command names a missing program")
	}
	return []string{filepath.Clean(bundled), "--config", absoluteConfig}, nil
}

func regularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// logRuntimeDiagnostics records which Runtime executables were found, so a
// Computer whose Agents cannot run shows the reason in its daemon log.
func logRuntimeDiagnostics(diagnostics []provider.RuntimeDiagnostic) {
	for _, diagnostic := range diagnostics {
		attributes := []any{"type", diagnostic.Type, "status", diagnostic.Status, "version", diagnostic.Version,
			"executable", diagnostic.ExecutablePath, "models", len(diagnostic.Models)}
		if diagnostic.Error != nil {
			attributes = append(attributes, "code", diagnostic.Error.Code, "error", redact.Text(diagnostic.Error.Message))
		}
		slog.Info("runtime.diagnostic", attributes...)
	}
}
