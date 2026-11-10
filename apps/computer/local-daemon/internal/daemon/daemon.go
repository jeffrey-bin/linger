package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/assignment"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

// SelfUpdater receives the Gateway signals that drive a Computer self-upgrade.
type SelfUpdater interface {
	WelcomeAccepted(ctx context.Context, target *protocol.TargetRelease)
	// ConnectionStarted reports a new connection attempt.
	ConnectionStarted()
	// ConnectionFailed reports a connection that ended before runner.welcome.
	ConnectionFailed(err error, failure transport.ConnectionFailure)
}

type Options struct {
	ControlPlane        transport.ControlPlane
	IdentityStore       transport.IdentityStore
	Executor            provider.Executor
	Ledger              OperationLedgerStore
	Registrations       registration.Store
	Assignments         assignment.Store
	ContextViews        *lingercontext.ViewStore
	LocalSkills         LocalSkillCatalog
	LocalTools          LocalToolBinder
	BrowserConnections  BrowserConnections
	ComputerPermissions ComputerPermissions
	Owners              []ComputerOwner
	CLICredentials      *clicredential.Store
	ComputerID          string
	OperationResolver   OperationResolver
	RetryDelay          func(attempt int) time.Duration
	DisplayName         string
	Capacity            *int
	Runtimes            []string
	EnabledRuntimes     []string
	RuntimeDiagnostics  json.RawMessage
	WorkspaceGrants     json.RawMessage
	StateDirectory      string
	RuntimeHomeRoot     string
	RuntimeObservations []transport.RegistrationObservation
	// OnModelUnavailable learns that the Runtime login refused a model, so
	// the Computer can stop offering it.
	OnModelUnavailable func(runtimeType, modelID string)
	// ModelInvoker runs model invocations; nil answers each with runtime_unavailable.
	ModelInvoker ModelInvoker
}

type OperationResolver interface {
	Resolve(context.Context, protocol.Command, json.RawMessage) (provider.OperationSpec, error)
}

type LocalSkillCatalog interface {
	Handle(context.Context, json.RawMessage) (json.RawMessage, error)
}

type LocalToolBinder interface {
	Bind(context.Context, provider.OperationSpec, mcpproxy.OperationIdentity, *mcpproxy.Set) error
}

// localToolPrewarmer is optional: a LocalToolBinder that can discover its tool
// catalog ahead of the first Operation implements it.
type localToolPrewarmer interface {
	Prewarm(context.Context)
}

type Daemon struct {
	controlPlane        transport.ControlPlane
	identityStore       transport.IdentityStore
	executor            provider.Executor
	protocolVersion     string
	computerID          string
	operationResolver   OperationResolver
	enabledRuntimes     []string
	ledger              OperationLedgerStore
	registrations       registration.Store
	assignments         assignment.Store
	contextViews        *lingercontext.ViewStore
	localSkills         LocalSkillCatalog
	localTools          LocalToolBinder
	browserConnections  BrowserConnections
	computerPermissions ComputerPermissions
	owners              []ComputerOwner
	cliCredentials      *clicredential.Store
	onModelUnavailable  func(runtimeType, modelID string)
	openMCPProxies      func(context.Context, json.RawMessage, mcpproxy.OperationIdentity) (*mcpproxy.Set, error)
	connectionEpoch     uint64
	// contentURL is the current connection's context_content_url, read by
	// dispatch workers that bring a Context to its View.
	contentURL  atomic.Pointer[string]
	welcomeSeen bool
	prewarmOnce sync.Once
	welcomedAt  time.Time
	daemonID    string
	activeMu    sync.Mutex
	admissionMu sync.Mutex
	// authorityRevision counts, under admissionMu, the commands that can change
	// what an accepted Operation may start with: Registration snapshots, Agent
	// Runner commands and Context commands. A start whose revision is unchanged
	// after its off-lock MCP preparation needs no second Resolve.
	authorityRevision   uint64
	activeOperations    map[string]*activeOperation
	preparationMu       sync.Mutex
	preparedOperations  map[string]*preparedOperation
	providerPrepareMu   sync.Mutex
	providerPrepares    map[string]*providerPrepare
	sessionCompactMu    sync.Mutex
	sessionCompacts     map[string]*sessionCompact
	takeParkedSession   func(runtimeType, contextKey string) parkedSession
	modelInvoker        ModelInvoker
	modelInvokeMu       sync.Mutex
	modelInvokes        map[string]*modelInvoke
	operationWG         sync.WaitGroup
	inputWG             sync.WaitGroup
	preparationWG       sync.WaitGroup
	cleanupWG           sync.WaitGroup
	draining            bool
	closing             bool
	selfUpdate          SelfUpdater
	retryDelay          func(int) time.Duration
	stableConnection    time.Duration
	now                 func() time.Time
	displayName         string
	capacity            *int
	runtimes            []string
	runtimeDiagnostics  json.RawMessage
	workspaceGrants     json.RawMessage
	stateDirectory      string
	runtimeHomeRoot     string
	runtimeObservations []transport.RegistrationObservation
	inventoryMu         sync.RWMutex
	diagnosticsRevision uint64
	connectionMu        sync.Mutex
	diagnosticsStream   transport.Stream
	operationStream     transport.Stream
	// dispatcher is the live connection's command dispatcher. It is atomic so
	// DrainIfIdle can read it under admissionMu without taking connectionMu.
	dispatcher           atomic.Pointer[commandDispatcher]
	contextDispatchLimit int
	fatalMu              sync.Mutex
	fatalErr             error
	gatewayStateMu       sync.RWMutex
	reconciled           bool
	gatewayState         string
	// welcomedEpochs are the connection epochs this process was welcomed
	// with, under gatewayStateMu. A start sent on any other epoch was sent to
	// an earlier Daemon process.
	welcomedEpochs map[uint64]bool
	locallyStopped map[string]bool
}

type activeOperation struct {
	identity          OperationIdentity
	ctx               context.Context
	cancel            context.CancelFunc
	execution         *provider.Execution
	reason            string
	mcpProxies        *mcpproxy.Set
	terminalCommitted bool
	inputMu           sync.Mutex
	finishing         bool
	pendingInputs     map[string]*pendingOperationInput
}

func New(options Options) (*Daemon, error) {
	if options.ControlPlane == nil {
		return nil, errors.New("daemon requires a control plane")
	}
	if options.IdentityStore == nil {
		return nil, errors.New("daemon requires an identity store")
	}
	if options.ComputerID == "" {
		return nil, errors.New("daemon requires a Computer identity")
	}
	if options.OperationResolver == nil {
		return nil, errors.New("daemon requires a local Operation resolver")
	}
	if err := provider.ValidateRuntimeSelection(options.EnabledRuntimes); err != nil {
		return nil, err
	}
	if err := validateRuntimeInventoryScope(options.EnabledRuntimes, options.Runtimes, options.RuntimeDiagnostics, options.RuntimeObservations); err != nil {
		return nil, err
	}
	if options.Ledger == nil || options.Registrations == nil || options.Assignments == nil {
		return nil, errors.New("daemon requires Operation, Registration and Assignment stores")
	}
	return &Daemon{
		controlPlane:         options.ControlPlane,
		identityStore:        options.IdentityStore,
		executor:             options.Executor,
		protocolVersion:      protocol.Version,
		computerID:           options.ComputerID,
		operationResolver:    options.OperationResolver,
		enabledRuntimes:      append([]string(nil), options.EnabledRuntimes...),
		activeOperations:     make(map[string]*activeOperation),
		preparedOperations:   make(map[string]*preparedOperation),
		providerPrepares:     make(map[string]*providerPrepare),
		sessionCompacts:      make(map[string]*sessionCompact),
		takeParkedSession:    takeNativeParkedSession,
		modelInvoker:         options.ModelInvoker,
		modelInvokes:         make(map[string]*modelInvoke),
		contextDispatchLimit: defaultContextDispatchLimit,
		retryDelay:           defaultRetryDelay(options.RetryDelay),
		stableConnection:     stableGatewayConnection,
		now:                  time.Now,
		displayName:          options.DisplayName,
		capacity:             options.Capacity,
		runtimes:             append([]string(nil), options.Runtimes...),
		runtimeDiagnostics:   append(json.RawMessage(nil), options.RuntimeDiagnostics...),
		workspaceGrants:      append(json.RawMessage(nil), options.WorkspaceGrants...),
		stateDirectory:       options.StateDirectory,
		runtimeHomeRoot:      options.RuntimeHomeRoot,
		runtimeObservations:  append([]transport.RegistrationObservation(nil), options.RuntimeObservations...),
		diagnosticsRevision:  1,
		gatewayState:         "connecting",
		locallyStopped:       make(map[string]bool),
		welcomedEpochs:       make(map[uint64]bool),
		ledger:               options.Ledger,
		registrations:        options.Registrations,
		assignments:          options.Assignments,
		contextViews:         options.ContextViews,
		localSkills:          options.LocalSkills,
		localTools:           options.LocalTools,
		browserConnections:   options.BrowserConnections,
		computerPermissions:  options.ComputerPermissions,
		owners:               options.Owners,
		cliCredentials:       options.CLICredentials,
		openMCPProxies:       mcpproxy.Open,
		onModelUnavailable:   options.OnModelUnavailable,
	}, nil
}

func (d *Daemon) Run(ctx context.Context) error {
	defer func() {
		_, _ = native.StopAllParkedResidents()
		if d.modelInvoker != nil {
			d.modelInvoker.Close()
		}
	}()
	deviceIdentity, err := d.identityStore.LoadOrCreate(ctx)
	if err != nil {
		return err
	}
	d.daemonID = deviceIdentity.DaemonID
	var quickRedialUntil time.Time
	for attempt := 0; ; attempt++ {
		d.setGatewayState("connecting")
		d.connectionEpoch = 0
		d.welcomeSeen = false
		if d.selfUpdate != nil {
			d.selfUpdate.ConnectionStarted()
		}
		err := d.runConnection(ctx, deviceIdentity)
		d.setGatewayState("connecting")
		if fatalErr := d.fatalError(); fatalErr != nil {
			return fatalErr
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			slog.Warn("Runner Gateway connection ended", "error", redact.Text(err.Error()))
		}
		if err != nil && !d.welcomeSeen && d.selfUpdate != nil {
			d.selfUpdate.ConnectionFailed(err, transport.ClassifyConnectionFailure(err))
		}
		var authenticationError *transport.AuthenticationError
		if errors.As(err, &authenticationError) {
			d.setGatewayState("authentication-failed")
			<-ctx.Done()
			return ctx.Err()
		}
		var upgradeRequired *transport.UpgradeRequiredError
		if errors.As(err, &upgradeRequired) {
			d.setGatewayState("upgrade-required")
			<-ctx.Done()
			return ctx.Err()
		}
		if transport.IsGatewayRestart(err) {
			if !d.now().Before(quickRedialUntil) {
				slog.Info("Runner Gateway is restarting; redialing at the shortest delay", "window", gatewayRestartRedialWindow)
			}
			quickRedialUntil = d.now().Add(gatewayRestartRedialWindow)
		}
		if d.welcomeSeen && time.Since(d.welcomedAt) >= d.stableConnection {
			attempt = 0
		}
		var delay time.Duration
		if d.now().Before(quickRedialUntil) {
			delay = d.retryDelay(0)
		} else {
			delay = d.retryDelay(attempt)
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (d *Daemon) reportFatal(err error) {
	if err == nil {
		return
	}
	d.fatalMu.Lock()
	if d.fatalErr != nil {
		d.fatalMu.Unlock()
		return
	}
	d.fatalErr = err
	d.fatalMu.Unlock()

	d.Drain()
	d.connectionMu.Lock()
	stream := d.operationStream
	d.connectionMu.Unlock()
	if stream != nil {
		_ = stream.Close()
	}
}

func (d *Daemon) fatalError() error {
	d.fatalMu.Lock()
	defer d.fatalMu.Unlock()
	return d.fatalErr
}

func (d *Daemon) ActiveOperationCount() int {
	d.activeMu.Lock()
	defer d.activeMu.Unlock()
	return len(d.activeOperations)
}

func (d *Daemon) DrainIfIdle() int {
	d.admissionMu.Lock()
	defer d.admissionMu.Unlock()
	d.activeMu.Lock()
	activeCount := len(d.activeOperations)
	d.activeMu.Unlock()
	d.preparationMu.Lock()
	preparationCount := len(d.preparedOperations)
	d.preparationMu.Unlock()
	// Queued and executing Context commands are work a self-update must not cut
	// off, and unacknowledged events live only in this process's memory.
	if active := activeCount + preparationCount + d.dispatcher.Load().activeCount() + d.ledger.Unacknowledged(); active > 0 {
		return active
	}
	d.draining = true
	return 0
}

// SetSelfUpdater attaches the upgrade manager. Call it before Run.
func (d *Daemon) SetSelfUpdater(updater SelfUpdater) {
	d.selfUpdate = updater
}

// ResumeAdmission reopens admissions closed by DrainIfIdle after an abandoned
// upgrade. It does nothing once shutdown has started.
func (d *Daemon) ResumeAdmission() {
	d.admissionMu.Lock()
	defer d.admissionMu.Unlock()
	if !d.closing {
		d.draining = false
	}
}

func (d *Daemon) Drain() {
	if dispatch := d.dispatcher.Load(); dispatch != nil {
		dispatch.cancel()
	}
	d.admissionMu.Lock()
	d.closing = true
	d.draining = true
	d.cancelPreparedOperations("")
	d.cancelProviderPrepares(providerPrepareAll, "drain")
	d.cancelSessionCompacts(sessionCompactAll, "drain")
	d.cancelModelInvokes("drain")
	d.activeMu.Lock()
	for _, active := range d.activeOperations {
		if active.reason == "" {
			active.reason = "Local Computer Daemon is shutting down"
		}
		active.cancel()
	}
	d.activeMu.Unlock()
	d.admissionMu.Unlock()
}

func (d *Daemon) WaitForOperations() {
	// Workers may start Operations and preparations, so they finish first.
	d.dispatcher.Load().waitWorkers()
	d.preparationWG.Wait()
	d.operationWG.Wait()
	d.inputWG.Wait()
	d.cleanupWG.Wait()
}

func mustJSON(value any) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return encoded
}
