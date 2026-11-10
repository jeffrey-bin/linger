package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcredential"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/retention"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/riverqueue/river"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentconnectedapps"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentcreationapproval"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdirectmessage"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentdocument"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentsendmessage"
	artifactstore "github.com/simplexai-labs/linger/apps/teamhub/internal/artifact"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/composio"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/document"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/documenttext"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/externalsource"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/mcpcontext"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/memoryclient"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/permissionreview"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalinsight"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/personalprofile"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/platform/agenttemplates"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/proactive"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/reminder"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomdocument"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskdelegation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicecaptureqa"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/workitem"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const principalKey = "teamhub.principal"

const presentationSequenceBatchSize = 100

const (
	skillPackageAuditPending int32 = iota
	skillPackageAuditReady
	skillPackageAuditFailed
)

// A failed Skill Package storage probe retries with a doubling delay up to this
// cap, so objects repaired after startup restore readiness.
const skillPackageProbeRetryMax = 10 * time.Minute

// App aggregates the Human API, PostgreSQL, Artifact Storage, the SSE Broker, and the optional Room Agent worker.
// Callers must call Close before the process exits, so long-lived connections and background workers stop before the connection pool closes.
type App struct {
	draining                 atomic.Bool
	closeOnce                sync.Once
	closeDone                chan struct{}
	cfg                      config.Config
	pool                     *pgxpool.Pool
	queries                  *store.Queries
	engine                   *gin.Engine
	logger                   *slog.Logger
	broker                   *realtime.Broker
	roomPresence             roomPresenceThrottle
	realtimeListener         *realtime.Listener
	streamsDone              context.Context
	stopStreams              context.CancelFunc
	workerContext            context.Context
	stopWorkers              context.CancelFunc
	workerWG                 sync.WaitGroup
	riverClient              *river.Client[pgx.Tx]
	artifacts                artifactstore.ObjectStore
	documentPreviews         *document.PreviewService
	documentRuntime          *roomdocument.HTTPRuntime
	documentTextNormalizer   documenttext.Normalizer
	wikiDispatch             *document.WikiRefreshDispatcher
	personalInsightsGenerate bool
	signingKey               []byte
	agentManagement          roomagent.AgentManagement
	localComputers           roomagent.LocalComputerManagement
	voiceMedia               voicemedia.Plane
	// voiceTranscription is Soniox ASR: Recording, dictation and Pocket Notes.
	voiceTranscription             bool
	voiceRecordings                *voicemedia.LocalStagingStore
	accounts                       *account.Lifecycle
	passwordHashes                 *account.HashLimiter
	verifyPassword                 func(password, encoded string) (bool, error)
	loginFailures                  *loginFailures
	workItems                      *workitem.Service
	reminders                      *reminder.Service
	taskExecutions                 taskExecutionService
	readTaskProgress               func(context.Context, string) (taskexecution.CoordinatorProgress, error)
	permissionReviews              *permissionreview.Service
	proactive                      *proactive.Service
	voiceCaptureAnswerer           voicecaptureqa.Answerer
	agentRuntimeState              *agentruntimestate.Service
	presentationSequences          *agentsendmessage.PresentationSequenceService
	typedCards                     *typedcard.Service
	mcpContexts                    mcpContextService
	agentAuth                      agentauth.Authorizer
	agentDirectMessages            agentDirectMessageService
	agentDocumentCreations         agentDocumentCreateService
	agentDocumentComments          agentDocumentCommentService
	agentDocumentSemanticMutations agentDocumentSemanticService
	agentSendMessages              agentSendMessageService
	agentCreationApprovals         agentCreationApprovalService
	taskDelegation                 *taskdelegation.Service
	agentConnectedApps             *agentconnectedapps.Service
	memory                         *memoryclient.Client
	documents                      *document.Service
	collaboration                  *collaboration.Service
	sessions                       *account.Sessions
	agents                         *agentregistry.Service
	agentMessages                  *agentmessages.Service
	canvas                         *agentconnectedapps.Canvas
	voice                          *voice.Service
	agentCredentials               *agentcredential.Service
	tracking                       *reminder.TrackingService
	documentComments               *document.CommentService
	externalSources                *externalsource.Service
	composioClient                 *composio.Client
	personalInsights               *personalinsight.Service
	personalProfile                *personalprofile.Service
	accountProfiles                *account.ProfileService
	skillPackageAuditState         atomic.Int32
	retention                      *retention.Sweeper
}

type principal struct {
	// Session carries the Account's single Human Actor, resolved once when the
	// session is loaded; its tenant_id is the deployment's Space.
	Session store.GetActiveSessionRow
	// Token holds the digest of the session token so established SSE connections can revalidate the session; the server never persists the raw token.
	Token []byte
}

// inSpace reports whether tenantID names the signed-in Human's Space. A valid
// session is the whole membership rule: the Human belongs to every part of it.
func (p principal) inSpace(tenantID string) bool {
	return tenantID != "" && tenantID == p.Session.HumanTenantID
}

// spaceHuman returns the signed-in Human's Actor ID when tenantID names its
// Space, and answers 404 otherwise.
func (a *App) spaceHuman(c *gin.Context, tenantID string) (string, bool) {
	if !a.requireSpace(c, tenantID) {
		return "", false
	}
	return currentPrincipal(c).Session.HumanActorID, true
}

// requireSpace answers 404 unless tenantID names the signed-in Human's Space,
// so a request cannot tell another Space ID from a missing one.
func (a *App) requireSpace(c *gin.Context, tenantID string) bool {
	if currentPrincipal(c).inSpace(tenantID) {
		return true
	}
	a.writeError(c, http.StatusNotFound, "NOT_FOUND", "resource was not found")
	return false
}

// Deps are the outside systems TeamHub calls, and the seams a test observes
// them through. A nil field uses the production client built from Config, or
// nothing where Config leaves that system unconfigured.
type Deps struct {
	AgentManagement roomagent.AgentManagement
	LocalComputers  roomagent.LocalComputerManagement
	// Composio serves every connected app; nil uses the Composio API.
	Composio               externalsource.Provider
	WikiCandidates         document.WikiCandidateGenerator
	DocumentTextNormalizer documenttext.Normalizer
	VoiceMedia             voicemedia.Plane
	PersonalProfile        personalprofile.Generator
	PersonalInsight        personalinsight.Generator
	ProactiveEventJudge    proactive.EventJudge
	PermissionJudge        permissionreview.Judge
	// RealtimeBroker lets a test watch committed-event wakes.
	RealtimeBroker *realtime.Broker
	// QueryTracer observes TeamHub database queries.
	QueryTracer pgx.QueryTracer
	// VerifyPassword replaces login's password check, so a test can hold a
	// login while it hashes.
	VerifyPassword func(password, encoded string) (bool, error)
}

// Worker names one part of the background work StartWorkers starts.
type Worker int

const (
	// JobQueue is the River client; every job and sweep below runs on it.
	JobQueue Worker = iota + 1
	// RoomDocumentJobs are the Room Document event jobs and sweeps.
	RoomDocumentJobs
	// DocumentCommentSweep is the safety-net sweep for Document comment input.
	DocumentCommentSweep
	// AgentCredentialSweep deletes expired Agent CLI credentials.
	AgentCredentialSweep
	// PersonalWikiJobs dispatch Wiki refreshes to the LLM Wiki.
	PersonalWikiJobs
	// DocumentTextJobs sync the searchable text of Documents.
	DocumentTextJobs
	// ReminderJobs run Reminder schedules and the app listeners.
	ReminderJobs
	// VoiceJobs complete captures and recover recordings.
	VoiceJobs
	// PersonalProfileJobs generate Profiles from imported sources.
	PersonalProfileJobs
	// PersonalInsightJobs generate Personal Insights.
	PersonalInsightJobs
	// PresentationLoop paces presentation sequence delivery.
	PresentationLoop
	// SkillInstall reconciles the built-in Skills and Agent templates.
	SkillInstall
	// SkillPackageProbe checks Skill Package storage before /readyz passes;
	// skipping it reports ready at once.
	SkillPackageProbe
)

const defaultDatabaseMaxConnections int32 = 16

// PostgreSQL releases a backend's catalog cache and plans only when the backend
// exits, so pooled connections are recycled instead of growing for hours.
const (
	defaultDatabaseMaxConnLifetime       = 10 * time.Minute
	defaultDatabaseMaxConnLifetimeJitter = 2 * time.Minute
	defaultDatabaseMaxConnIdleTime       = time.Minute
)

// New builds a servable App from a complete Config (config.Load or
// config.ForTest): the database pool, the domain services, the routes and the
// realtime Listener. It starts no background work; call StartWorkers.
func New(ctx context.Context, cfg config.Config, deps Deps) (*App, error) {
	if err := validateConfig(cfg); err != nil {
		return nil, err
	}
	if err := linkAgentService(cfg, &deps); err != nil {
		return nil, err
	}
	signingKey, err := newSigningKey(cfg)
	if err != nil {
		return nil, err
	}
	pool, err := openDatabasePool(ctx, cfg, deps.QueryTracer)
	if err != nil {
		return nil, err
	}
	core, err := newCoreServices(cfg, deps, pool)
	if err != nil {
		pool.Close()
		return nil, err
	}
	a := newApp(cfg, deps, pool, signingKey, core)
	if err := a.registerFeatures(ctx, cfg, deps, core); err != nil {
		a.closeBuilt()
		return nil, err
	}
	a.retention = retention.NewSweeper(pool, a.retentionRules())
	a.engine = a.routes()
	if err := a.startRealtimeListener(ctx); err != nil {
		a.closeBuilt()
		return nil, err
	}
	return a, nil
}

// coreServices are the services New builds before the App exists; a failure
// among them closes only the pool.
type coreServices struct {
	runtimeState           *agentruntimestate.Service
	artifacts              artifactstore.ObjectStore
	documentRuntime        *roomdocument.HTTPRuntime
	commentRuntime         document.Runtime
	documents              *document.Service
	documentTextNormalizer documenttext.Normalizer
	memory                 *memoryclient.Client
	wikiDispatch           *document.WikiRefreshDispatcher
	models                 *roomagent.ModelCallClient
}

func validateConfig(cfg config.Config) error {
	if cfg.DatabaseURL == "" {
		return errors.New("database URL is required")
	}
	if cfg.SessionTTL > config.SessionMaxLifetime {
		return errors.New("Session TTL must not exceed the Session maximum lifetime")
	}
	if cfg.RoomDocument.RuntimeURL != "" && cfg.NodeServicesInternalToken == "" {
		return errors.New("Document Runtime URL requires the Node Services credential")
	}
	return nil
}

// linkAgentService fills the Agent management seams a test left nil with the
// Agent Service gateway.
func linkAgentService(cfg config.Config, deps *Deps) error {
	// Node Services role links are on when the Node Services credential is set.
	if cfg.NodeServicesURL == "" || cfg.NodeServicesInternalToken == "" {
		return nil
	}
	gateway, err := roomagent.NewHTTPGateway(cfg.NodeServicesURL, cfg.NodeServicesInternalToken, nil)
	if err != nil {
		return fmt.Errorf("create Agent Service HTTP gateway: %w", err)
	}
	if deps.AgentManagement == nil {
		deps.AgentManagement = gateway
	}
	if deps.LocalComputers == nil {
		deps.LocalComputers = gateway
	}
	return nil
}

func newSigningKey(cfg config.Config) ([]byte, error) {
	// Without LINGER_SECRET_SEED a process signs with its own key, so preview
	// URLs and upload credentials do not survive a restart or reach another
	// replica.
	signingKey := []byte(cfg.SigningKey)
	if len(signingKey) == 0 {
		signingKey = make([]byte, 32)
		if _, err := rand.Read(signingKey); err != nil {
			return nil, fmt.Errorf("generate TeamHub signing key: %w", err)
		}
	}
	return signingKey, nil
}

func openDatabasePool(ctx context.Context, cfg config.Config, tracer pgx.QueryTracer) (*pgxpool.Pool, error) {
	poolConfig, err := newDatabasePoolConfig(cfg, tracer)
	if err != nil {
		return nil, err
	}
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}

func newCoreServices(cfg config.Config, deps Deps, pool *pgxpool.Pool) (coreServices, error) {
	core := coreServices{runtimeState: agentruntimestate.New(pool)}
	storageMaxBytes := max(cfg.ArtifactMaxBytes, config.SkillPackageMaxFileBytes, cfg.CaptureMaxBytes)
	artifactStorage, err := artifactstore.NewLocalStore(cfg.ArtifactStorageRoot, storageMaxBytes)
	if err != nil {
		return coreServices{}, fmt.Errorf("configure artifact object storage: %w", err)
	}
	core.artifacts = artifactStorage
	if err := core.addDocuments(cfg, pool); err != nil {
		return coreServices{}, err
	}
	wikiCandidateGenerator, err := newWikiCandidateGenerator(cfg, deps.WikiCandidates)
	if err != nil {
		return coreServices{}, err
	}
	if core.documentTextNormalizer, err = newDocumentTextNormalizer(cfg, deps.DocumentTextNormalizer); err != nil {
		return coreServices{}, err
	}
	if cfg.NodeServicesURL != "" && cfg.NodeServicesInternalToken != "" {
		core.memory, err = memoryclient.New(cfg.NodeServicesURL, cfg.NodeServicesInternalToken)
		if err != nil {
			return coreServices{}, fmt.Errorf("configure Memory client: %w", err)
		}
	}
	if wikiCandidateGenerator != nil {
		core.wikiDispatch, err = document.NewWikiRefreshDispatcher(
			pool,
			artifactStorage,
			wikiCandidateGenerator,
			core.documents,
			document.WikiRefreshDispatchOptions{
				MaxAttempts: 5, GenerationTimeout: config.PersonalWikiGenerationTimeout,
			},
		)
		if err != nil {
			return coreServices{}, fmt.Errorf("configure unified Wiki dispatcher: %w", err)
		}
	}
	// Every TeamHub model call goes through the Agent Service, which runs it
	// on the owner's Agent Runtime; without that link the model features stay off.
	models, err := roomagent.NewModelCallClient(cfg.NodeServicesURL, cfg.NodeServicesInternalToken)
	if errors.Is(err, roomagent.ErrModelCallUnconfigured) {
		models, err = nil, nil
	}
	if err != nil {
		return coreServices{}, fmt.Errorf("configure Agent Service model calls: %w", err)
	}
	core.models = models
	return core, nil
}

// addDocuments builds the unified Document service, on the Document Runtime
// when one is configured.
func (core *coreServices) addDocuments(cfg config.Config, pool *pgxpool.Pool) error {
	if cfg.RoomDocument.RuntimeURL != "" {
		documentRuntime, err := roomdocument.NewHTTPRuntime(
			cfg.RoomDocument.RuntimeURL,
			cfg.NodeServicesInternalToken,
			nil,
		)
		if err != nil {
			return fmt.Errorf("configure Document Runtime: %w", err)
		}
		core.documentRuntime = documentRuntime
	}
	if core.documentRuntime == nil {
		core.documents = document.NewWithObjectStore(pool, core.artifacts)
	} else {
		core.commentRuntime = core.documentRuntime
		core.documents = document.NewWithRuntime(pool, core.documentRuntime, core.artifacts)
	}
	core.documents.ConfigureAssets(document.AssetOptions(cfg.RoomDocument.AssetQuotas))
	core.documents.ConfigureConnectionTokens(cfg.DocumentConnectionTokenKey)
	return nil
}

func newWikiCandidateGenerator(cfg config.Config, injected document.WikiCandidateGenerator) (document.WikiCandidateGenerator, error) {
	if injected != nil || cfg.NodeServicesURL == "" || cfg.NodeServicesInternalToken == "" {
		return injected, nil
	}
	generator, err := document.NewHTTPWikiCandidateGenerator(
		cfg.NodeServicesURL,
		cfg.NodeServicesInternalToken,
		&http.Client{Timeout: config.PersonalWikiGenerationTimeout},
	)
	if err != nil {
		return nil, fmt.Errorf("configure unified Wiki candidate generator: %w", err)
	}
	return generator, nil
}

func newDocumentTextNormalizer(cfg config.Config, injected documenttext.Normalizer) (documenttext.Normalizer, error) {
	// File Versions are normalized by the same LLM Wiki role that serves the
	// document normalization contract; without Node Services file Version
	// text jobs wait for a TeamHub that has one.
	if injected != nil || cfg.NodeServicesURL == "" || cfg.NodeServicesInternalToken == "" {
		return injected, nil
	}
	normalizer, err := documenttext.NewNormalizerClient(
		cfg.NodeServicesURL, cfg.NodeServicesInternalToken, &http.Client{Timeout: 3 * time.Minute},
	)
	if err != nil {
		return nil, fmt.Errorf("configure Document text normalizer: %w", err)
	}
	return normalizer, nil
}

// newApp assembles the App around the core services; it builds no feature.
func newApp(cfg config.Config, deps Deps, pool *pgxpool.Pool, signingKey []byte, core coreServices) *App {
	streamsDone, stopStreams := context.WithCancel(context.Background())
	broker := deps.RealtimeBroker
	if broker == nil {
		broker = realtime.NewBroker(cfg.SSEQueueCapacity)
	}
	workerContext, stopWorkers := context.WithCancel(context.Background())
	return &App{
		cfg: cfg, pool: pool, queries: store.New(pool), logger: slog.Default(),
		broker: broker, streamsDone: streamsDone, stopStreams: stopStreams,
		workerContext: workerContext, stopWorkers: stopWorkers,
		artifacts: core.artifacts, documentPreviews: document.NewPreviewService(pool, core.artifacts, cfg.DocumentPreviewPublicOrigin, signingKey), signingKey: signingKey, agentManagement: deps.AgentManagement,
		localComputers:         deps.LocalComputers,
		memory:                 core.memory,
		documents:              core.documents,
		documentComments:       document.NewCommentService(pool, core.commentRuntime),
		documentRuntime:        core.documentRuntime,
		documentTextNormalizer: core.documentTextNormalizer,
		wikiDispatch:           core.wikiDispatch,
	}
}

// registerFeatures builds every domain feature in dependency order; a
// feature reads only the ones registered before it.
func (a *App) registerFeatures(ctx context.Context, cfg config.Config, deps Deps, core coreServices) error {
	if err := a.registerVoice(cfg.Voice, deps.VoiceMedia, core.artifacts, cfg.ArtifactStorageRoot); err != nil {
		return err
	}
	a.reminders = reminder.New(a.pool)
	agentAuthorization := a.registerAgentAuthorization()
	if err := a.registerExternalApps(ctx, cfg.ExternalApps, deps.Composio, agentAuthorization); err != nil {
		return err
	}
	a.registerTasks()
	a.registerPersonalData(cfg, deps, core.models)
	if err := a.registerProactive(cfg, deps); err != nil {
		return err
	}
	a.registerVoiceCaptureAnswerer(core.models)
	a.registerCollaboration(core.runtimeState)
	a.registerAgentTools(cfg, deps, agentAuthorization, core.models)
	a.registerAccounts(deps)
	a.registerVoiceService()
	return nil
}

func (a *App) registerAgentAuthorization() *agentauth.Service {
	agentAuthorization := agentauth.New(a.pool)
	agentAuthorization.SetConnectedApps(a.connectedAppsConfigured)
	a.agentAuth = agentAuthorization
	return agentAuthorization
}

func (a *App) registerTasks() {
	a.workItems = workitem.New(a.pool)
	taskExecutionService := taskexecution.New(a.pool)
	a.taskExecutions = taskExecutionService
	a.readTaskProgress = func(ctx context.Context, contextKey string) (taskexecution.CoordinatorProgress, error) {
		return taskexecution.ReadCoordinatorProgress(ctx, a.queries, contextKey)
	}
}

// registerPersonalData builds Personal Insights and the Personal Profile and
// routes imported mail into the Wiki.
func (a *App) registerPersonalData(cfg config.Config, deps Deps, models *roomagent.ModelCallClient) {
	personalInsightGenerator := deps.PersonalInsight
	if personalInsightGenerator == nil && models != nil {
		personalInsightGenerator = personalinsight.NewHTTPGenerator(models, config.ProfileGenerationTimeout)
	}
	a.personalInsightsGenerate = personalInsightGenerator != nil
	a.personalInsights = personalinsight.New(a.pool, personalInsightGenerator, personalinsight.Options{})
	personalProfileGenerator := deps.PersonalProfile
	if personalProfileGenerator == nil && models != nil {
		personalProfileGenerator = personalprofile.NewHTTPGenerator(models, config.ProfileGenerationTimeout)
	}
	a.accountProfiles = account.NewProfileService(a.pool)
	documents := a.documents
	profileOptions := personalprofile.Options{
		External: a.externalSources, AppImportProviderCallBudget: cfg.ExternalApps.AppImportProviderCallBudget,
		Wiki:                   a.documents,
		EnqueuePersonalInsight: a.personalInsights.Enqueue,
	}
	a.personalProfile = personalprofile.New(a.pool, a.artifacts, personalProfileGenerator, profileOptions)
	a.externalSources.SetMailImport(func(ctx context.Context, source externalsource.MailWikiSource) error {
		_, err := documents.UpsertMailWikiSource(ctx, document.UpsertWikiSourceInput{
			TenantID: source.TenantID, OwnerActorID: source.OwnerActorID, SourceKey: source.SourceKey,
			Filename: source.Filename, Content: source.Content,
		})
		return err
	}, func(ctx context.Context, tx pgx.Tx, imported externalsource.MailImported) error {
		return document.QueueMailWikiInit(ctx, tx, document.MailWikiInitArgs{
			TenantID: imported.TenantID, OwnerActorID: imported.OwnerActorID,
			ConnectionID: imported.ConnectionID, Revision: imported.Revision,
		})
	})
}

func (a *App) registerProactive(cfg config.Config, deps Deps) error {
	eventJudge := deps.ProactiveEventJudge
	if eventJudge == nil && cfg.NodeServicesURL != "" {
		gateway, err := roomagent.NewHTTPGateway(cfg.NodeServicesURL, cfg.NodeServicesInternalToken, nil)
		if err != nil {
			return fmt.Errorf("create proactive event judge: %w", err)
		}
		eventJudge = proactive.AgentEventJudge(gateway.JudgeProactiveEvent)
	}
	a.proactive = proactive.New(a.pool, eventJudge, nil)
	return nil
}

func (a *App) registerVoiceCaptureAnswerer(models *roomagent.ModelCallClient) {
	if models != nil {
		a.voiceCaptureAnswerer = voicecaptureqa.NewAnswerer(models, voice.VoiceCaptureQuestionTimeout)
	}
}

// registerCollaboration builds Rooms, Agents and the typed cards they
// exchange.
func (a *App) registerCollaboration(runtimeState *agentruntimestate.Service) {
	a.presentationSequences = agentsendmessage.NewPresentationSequenceService(a.pool)
	a.agentRuntimeState = runtimeState
	a.typedCards = typedcard.New(a.pool)
	a.collaboration = collaboration.New(a.pool, a.artifacts, a.documents, a.typedCards, a.signingKey, a.logger)
	a.agents = agentregistry.New(a.pool, a.artifacts, a.collaboration, a.agentManagement, a.logger)
	runtimeState.OnLocalComputerOnline(a.agents.EnsureAnotherMe)
	a.typedCards.SetConnectionAuthorizer(a.externalSources)
	a.typedCards.SetOnboarding(a.collaboration.WriteOnboardingHandoff, a.onboardingConnections)
	a.registerDecisionExecutors()
}

// registerAgentTools builds the Agent CLI tools, each authorized by the
// current Agent identity.
func (a *App) registerAgentTools(cfg config.Config, deps Deps, agentAuthorization *agentauth.Service, models *roomagent.ModelCallClient) {
	a.mcpContexts = mcpcontext.New(a.pool, a.documents)
	a.agentDocumentComments = agentdocument.NewCommentTool(agentAuthorization, a.documentComments, a.documents)
	a.agentDocumentCreations = agentdocument.NewCreateTool(agentAuthorization, a.documents)
	a.agentDocumentSemanticMutations = agentdocument.NewSemanticTool(agentAuthorization, a.documents)
	a.agentDirectMessages = agentdirectmessage.New(a.pool, agentAuthorization)
	messageSender := agentsendmessage.New(a.pool, agentAuthorization, a.documents, a.artifacts)
	a.agentSendMessages = messageSender
	a.registerPermissionReview(cfg.PermissionReview, models, deps.PermissionJudge)
	a.agentCreationApprovals = agentcreationapproval.New(a.pool, agentAuthorization, a.typedCards)
	a.taskDelegation = taskdelegation.New(a.pool, agentAuthorization)
}

// registerAccounts builds Accounts, Sessions, login and the Agent-facing
// services that hang off them.
func (a *App) registerAccounts(deps Deps) {
	a.accounts = account.NewLifecycle(a.pool)
	a.sessions = account.NewSessions(a.pool)
	a.agentMessages = agentmessages.New(a.pool)
	a.agentCredentials = agentcredential.New(a.pool)
	a.tracking = reminder.NewTrackingService(a.pool)
	a.canvas = agentconnectedapps.NewCanvas(a.documents, a.artifacts)
	a.passwordHashes = account.NewHashLimiter(passwordHashPermits, passwordHashWait)
	a.verifyPassword = account.VerifyPassword
	if deps.VerifyPassword != nil {
		a.verifyPassword = deps.VerifyPassword
	}
	a.loginFailures = newLoginFailures()
}

func (a *App) registerVoiceService() {
	a.voice = voice.New(voice.Deps{
		Pool: a.pool, Artifacts: a.artifacts, Documents: a.documents, DocumentComments: a.documentComments, Collaboration: a.collaboration,
		Canvas: a.canvas, AgentConnectedApps: a.agentConnectedApps, Agents: a.agents, Reminders: a.reminders, WorkItems: a.workItems, TypedCards: a.typedCards,
		Memory: a.memory, LocalComputers: a.localComputers, Answerer: a.voiceCaptureAnswerer, VoiceMedia: a.voiceMedia, Logger: a.logger,
	})
}

func (a *App) startRealtimeListener(ctx context.Context) error {
	realtimeListener, err := realtime.NewListener(a.cfg.DatabaseURL, a.broker, a.logger)
	if err != nil {
		return fmt.Errorf("configure realtime Listener: %w", err)
	}
	if err := realtimeListener.Start(ctx); err != nil {
		return fmt.Errorf("start realtime Listener: %w", err)
	}
	a.realtimeListener = realtimeListener
	return nil
}

// retentionRules are the core rules plus voice's when voice media is on.
func (a *App) retentionRules() []retention.Rule {
	rules := slices.Clone(retention.Core)
	if a.voiceMedia != nil {
		rules = append(rules, retention.Voice...)
	}
	return rules
}

// closeBuilt releases what New built before it failed.
func (a *App) closeBuilt() {
	a.StopStreams()
	a.stopWorkers()
	a.pool.Close()
}

// StartWorkers starts TeamHub's background work: the built-in Skill install,
// the River jobs and sweeps, the presentation loop and the Skill Package probe.
// A process calls it once, after New and before it serves. A test skips the
// parts it drives itself.
func (a *App) StartWorkers(ctx context.Context, skip ...Worker) error {
	runs := func(worker Worker) bool { return !slices.Contains(skip, worker) }
	if runs(SkillInstall) {
		if err := skill.Ensure(ctx, a.pool, a.artifacts); err != nil {
			return fmt.Errorf("install built-in platform Skills: %w", err)
		}
		if err := agenttemplates.Ensure(ctx, a.pool); err != nil {
			return fmt.Errorf("install built-in Agent templates: %w", err)
		}
	}
	if runs(JobQueue) {
		if err := a.startJobs(ctx, runs); err != nil {
			return err
		}
	}
	if runs(SkillPackageProbe) {
		a.workerWG.Add(1)
		go func() {
			defer a.workerWG.Done()
			a.probeSkillPackageStorage(a.workerContext)
		}()
	} else {
		a.skillPackageAuditState.Store(skillPackageAuditReady)
	}
	if runs(PresentationLoop) {
		a.workerWG.Add(1)
		go func() {
			defer a.workerWG.Done()
			a.presentationSequences.Run(a.workerContext, presentationSequenceBatchSize, func(err error) {
				a.logger.Error("drive presentation sequences", "error", err)
			})
		}()
	}
	return nil
}

// startJobs registers the River workers and sweeps of every part that runs,
// resumes the work a stopped process left, and starts River.
func (a *App) startJobs(ctx context.Context, runs func(Worker) bool) error {
	features := newFeatureSet()
	if runs(VoiceJobs) {
		a.addVoiceJobs(features)
	}
	a.addExternalAppJobs(features, runs(ReminderJobs))
	riverWorkers := features.workers
	document.AddJobWorkers(riverWorkers, a.documents, a.publishedWikiGraphUpdater())
	voice.AddPocketNoteTrackingWorker(riverWorkers, a.queries, a.pocketNoteTrackingRefresher())
	personalprofile.AddMemorySyncWorker(riverWorkers, a.personalProfile, a.profileMemorySyncer())
	if a.wikiDispatch != nil && runs(PersonalWikiJobs) {
		document.AddWikiRefreshDispatchWorker(riverWorkers, a.wikiDispatch)
	}
	if a.personalInsightsGenerate && runs(PersonalInsightJobs) {
		personalinsight.AddJobWorkers(riverWorkers, a.personalInsights)
	}
	if runs(PersonalProfileJobs) {
		personalprofile.AddJobWorkers(riverWorkers, a.personalProfile)
	}
	if runs(ReminderJobs) {
		reminder.AddJobWorkers(riverWorkers, a.reminders, nil, a.logger)
	}
	proactive.AddEventWorker(riverWorkers, a.proactive, a.logger)
	reminder.AddWorker(riverWorkers, a.pool, a.logger)
	features.schedule(a.maintenanceJobs(riverWorkers, runs(AgentCredentialSweep))...)
	if runs(RoomDocumentJobs) {
		var disconnecter document.RuntimeDisconnecter
		if a.documentRuntime != nil {
			disconnecter = a.documentRuntime
		}
		document.AddRoomDocumentJobWorkers(riverWorkers, a.documents)
		river.AddWorker(riverWorkers, document.NewRuntimeDisconnectWorker(disconnecter, a.logger))
		// One collector serves every run, so a pass cut short resumes where it stopped.
		features.schedule(a.roomDocumentSweepJobs(riverWorkers, document.NewRetentionCollector(a.pool), a.documentRuntime != nil, runs(DocumentCommentSweep))...)
	}
	if runs(DocumentTextJobs) {
		documenttext.AddJobWorkers(riverWorkers, documenttext.NewWorker(a.queries, a.documents, a.artifacts, a.documentTextNormalizer, a.logger))
	}
	river.AddWorker(riverWorkers, &stoppedTaskApprovalsWorker{app: a})
	river.AddWorker(riverWorkers, a.collaboration.MessageAttachmentExpiryWorker())
	river.AddWorker(riverWorkers, &decisionRunWorker{app: a})
	river.AddWorker(riverWorkers, &decisionExpireWorker{app: a})
	taskexecution.AddJobWorkers(riverWorkers, a.pool)
	riverOptions := jobs.Options{
		Workers: riverWorkers, Queues: features.queues, Periodic: features.periodic,
		PersonalWikiConcurrency: config.PersonalWikiDispatchConcurrency, PollInterval: a.cfg.Jobs.PollInterval, TestOnly: a.cfg.Jobs.RiverTestOnly, Logger: a.logger,
	}
	riverClient, err := jobs.NewClient(a.pool, riverOptions)
	if err != nil {
		return fmt.Errorf("configure TeamHub jobs: %w", err)
	}
	// A Wiki dispatch attempt still marked running belongs to a process that
	// stopped or is stopping; the dispatch lock keeps the two apart.
	if err := document.ResumeInterruptedWikiDispatch(ctx, a.pool); err != nil {
		return fmt.Errorf("resume interrupted Wiki dispatch: %w", err)
	}
	for _, resume := range features.resume {
		if err := resume(ctx); err != nil {
			return fmt.Errorf("resume feature jobs: %w", err)
		}
	}
	if err := riverClient.Start(context.Background()); err != nil {
		return fmt.Errorf("start TeamHub jobs: %w", err)
	}
	a.riverClient = riverClient
	// River's queues poll rarely, so jobs that fall due later need this
	// notifier; it is woken on commit and sleeps until the next due time.
	dueNotifier := jobs.NewDueNotifier(a.pool, riverOptions, nil)
	a.broker.SetWorkWake(realtime.WorkRiverDueTopic, dueNotifier.Wake)
	a.workerWG.Add(1)
	go func() {
		defer a.workerWG.Done()
		dueNotifier.Run(a.workerContext)
	}()
	return nil
}

// publishedWikiGraphUpdater is the Memory client when Node Services are linked.
func (a *App) publishedWikiGraphUpdater() document.PublishedWikiGraphUpdater {
	if a.memory == nil {
		return nil
	}
	return a.memory
}

func (a *App) pocketNoteTrackingRefresher() voice.PocketNoteTrackingRefresher {
	if a.memory == nil {
		return nil
	}
	return a.memory
}

func (a *App) profileMemorySyncer() personalprofile.ProfileMemorySyncer {
	if a.memory == nil {
		return nil
	}
	return a.memory
}

// probeSkillPackageStorage keeps /readyz failing until Skill Package storage
// verifies, retrying from the configured delay and doubling up to a cap, so
// objects repaired with teamhub-skill-package-audit -repair-builtin need no
// restart.
func (a *App) probeSkillPackageStorage(ctx context.Context) {
	delay := a.cfg.Jobs.SkillPackageProbeRetry
	for {
		stats, err := skill.ProbePackageStorage(ctx, a.pool, a.artifacts)
		logFields := []any{
			"duration_ms", stats.Duration.Milliseconds(),
			"object_count", stats.ObjectCount,
			"bytes_verified", stats.BytesVerified,
		}
		if err == nil {
			a.logger.Info("probe Skill Package storage completed", logFields...)
			a.skillPackageAuditState.Store(skillPackageAuditReady)
			return
		}
		if ctx.Err() != nil {
			return
		}
		a.skillPackageAuditState.Store(skillPackageAuditFailed)
		a.logger.Error("probe Skill Package storage", append(logFields, "error", err, "retry_in_ms", delay.Milliseconds())...)
		retry := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			retry.Stop()
			return
		case <-retry.C:
		}
		delay = min(2*delay, skillPackageProbeRetryMax)
	}
}

func newDatabasePoolConfig(cfg config.Config, tracer pgx.QueryTracer) (*pgxpool.Config, error) {
	connectionConfig, err := pgx.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	configured := func(name string) bool {
		_, ok := connectionConfig.RuntimeParams[name]
		return ok
	}

	poolConfig, err := pgxpool.ParseConfig(cfg.DatabaseURL)
	if err != nil {
		return nil, err
	}
	if !configured("pool_max_conns") {
		poolConfig.MaxConns = defaultDatabaseMaxConnections
	}
	if !configured("pool_max_conn_lifetime") {
		poolConfig.MaxConnLifetime = defaultDatabaseMaxConnLifetime
	}
	if !configured("pool_max_conn_lifetime_jitter") {
		poolConfig.MaxConnLifetimeJitter = defaultDatabaseMaxConnLifetimeJitter
	}
	if !configured("pool_max_conn_idle_time") {
		poolConfig.MaxConnIdleTime = defaultDatabaseMaxConnIdleTime
	}
	// Named server-side statements would keep up to 512 plans per backend;
	// describing on the client keeps parameter typing without that memory.
	// pgx consumes default_query_exec_mode while parsing, so an explicit choice
	// is only visible in the connection string itself.
	if !strings.Contains(cfg.DatabaseURL, "default_query_exec_mode") {
		poolConfig.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe
	}
	poolConfig.ConnConfig.Tracer = tracer
	return poolConfig, nil
}

// Handler returns the HTTP handler with the public routes and authentication middleware.
func (a *App) Handler() http.Handler { return a.engine }

// StopStreams actively closes existing SSE and Voice Stream connections, but keeps the database and background workers running for the graceful shutdown phase.
func (a *App) StopStreams() { a.stopStreams() }

// Close stops long-lived connections and background workers, waits for the workers to exit, then closes the database connection pool.
func (a *App) Close() { _ = a.CloseContext(context.Background()) }

// BeginDrain makes readiness fail while HTTP remains available for route propagation.
func (a *App) BeginDrain() { a.draining.Store(true) }

// CloseContext retains dependencies until their users stop. A caller deadline
// bounds waiting; the process watchdog ends any non-cooperative cleanup.
func (a *App) CloseContext(ctx context.Context) error {
	a.BeginDrain()
	a.closeOnce.Do(func() {
		a.closeDone = make(chan struct{})
		a.StopStreams()
		a.stopWorkers()
		go func() {
			defer close(a.closeDone)
			a.stopRiverJobs()
			a.workerWG.Wait()
			if a.realtimeListener != nil {
				a.realtimeListener.Close()
			}
			if a.pool != nil {
				a.pool.Close()
			}
		}()
	})
	select {
	case <-a.closeDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (a *App) routes() *gin.Engine {
	engine := gin.New()
	engine.Use(a.requestContext(), a.cors(), gin.Recovery())
	// health, login, and idempotent logout are the only routes that bypass requireSession;
	// all other resource APIs must be mounted under the authenticated group, and queries narrow permissions for Tenant/Room scopes.
	engine.GET("/healthz", a.healthz)
	engine.GET("/readyz", a.readyz)
	engine.GET("/v0/document-previews/:token/*previewPath", a.serveDocumentPreview)
	engine.HEAD("/v0/document-previews/:token/*previewPath", a.headDocumentPreview)
	a.registerContractRoutes(engine)
	return engine
}

var traceparentPattern = regexp.MustCompile(`^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$`)

// clientAddressKey holds the request's client address in the gin context;
// request logs and the login failure count both use it.
const clientAddressKey = "client_address"

// clientAddress returns the connecting peer and the client the request came
// from. X-Forwarded-For counts only when the peer is a trusted proxy, and the
// client is the nearest untrusted address in the chain.
func clientAddress(r *http.Request, trusted []netip.Prefix) (peer, client string) {
	peer, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		peer = r.RemoteAddr
	}
	peerIP, _ := netip.ParseAddr(peer)
	client = peer
	isTrusted := func(ip netip.Addr) bool {
		for _, prefix := range trusted {
			if prefix.Contains(ip) {
				return true
			}
		}
		return false
	}
	forwarded := r.Header.Get("X-Forwarded-For")
	if peerIP.IsValid() && isTrusted(peerIP) && len(forwarded) <= 8192 && forwarded != "" {
		chain := strings.Split(forwarded, ",")
		valid := true
		for _, value := range chain {
			if _, err := netip.ParseAddr(strings.TrimSpace(value)); err != nil {
				valid = false
				break
			}
		}
		if valid {
			for i := len(chain) - 1; i >= 0; i-- {
				ip, _ := netip.ParseAddr(strings.TrimSpace(chain[i]))
				client = ip.String()
				if !isTrusted(ip) {
					break
				}
			}
		}
	}
	return peer, client
}

func requestOriginFields(r *http.Request, peer, client string) []any {
	ua := r.UserAgent()
	if len(ua) > 512 {
		ua = strings.ToValidUTF8(ua[:512], "")
	}
	ua = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, ua)
	trace := r.Header.Get("Traceparent")
	match := traceparentPattern.FindStringSubmatch(trace)
	if match == nil || match[1] == strings.Repeat("0", 32) || match[2] == strings.Repeat("0", 16) {
		trace = ""
	}
	return []any{"user_agent", ua, "peer_ip", peer, "client_ip", client, "traceparent", trace}
}

func (a *App) requestContext() gin.HandlerFunc {
	trusted := make([]netip.Prefix, 0, len(a.cfg.TrustedProxies))
	for _, value := range a.cfg.TrustedProxies {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(value))
		if err != nil {
			panic("invalid http.trusted_proxies CIDR")
		}
		trusted = append(trusted, prefix)
	}
	return func(c *gin.Context) {
		requestID := c.GetHeader("X-Request-ID")
		if requestID == "" {
			requestID = idgen.New("request")
		}
		c.Set("request_id", requestID)
		c.Header("X-Request-ID", requestID)
		peer, client := clientAddress(c.Request, trusted)
		c.Set(clientAddressKey, client)
		started := time.Now()
		c.Next()
		fields := []any{"request_id", requestID, "method", c.Request.Method, "path", c.Request.URL.Path,
			"duration_ms", time.Since(started).Milliseconds()}
		fields = append(fields, requestOriginFields(c.Request, peer, client)...)
		if timings, ok := c.Get("message_read"); ok {
			fields = append(fields, "message_read", timings)
		}
		if c.GetBool("request_canceled") && !c.Writer.Written() {
			a.logger.Info("http request", append(fields, "outcome", "request_canceled")...)
			return
		}
		if shouldLogHTTPRequest(c.Request.URL.Path, c.Writer.Status()) {
			a.logger.Info("http request", append(fields, "status", c.Writer.Status())...)
		}
	}
}

func shouldLogHTTPRequest(path string, status int) bool {
	if strings.HasPrefix(path, "/v0/document-previews/") {
		return false
	}
	switch path {
	case "/v0/task-execution-claims":
		return status != http.StatusNoContent
	default:
		return true
	}
}

func (a *App) readyz(c *gin.Context) {
	if a.draining.Load() {
		a.writeError(c, http.StatusServiceUnavailable, "DRAINING", "service is draining")
		return
	}
	switch a.skillPackageAuditState.Load() {
	case skillPackageAuditPending:
		a.writeError(c, http.StatusServiceUnavailable, "SKILL_PACKAGE_AUDIT_PENDING", "Skill Package audit is still running")
		return
	case skillPackageAuditFailed:
		a.writeError(c, http.StatusServiceUnavailable, "SKILL_PACKAGE_AUDIT_FAILED", "Skill Package audit failed")
		return
	}
	a.healthz(c)
}

func (a *App) healthz(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), time.Second)
	defer cancel()
	if err := a.pool.Ping(ctx); err != nil {
		a.writeError(c, http.StatusServiceUnavailable, "DATABASE_UNAVAILABLE", "database is unavailable")
		return
	}
	realtimeStatus := realtime.ListenerStatus{}
	if a.realtimeListener != nil {
		realtimeStatus = a.realtimeListener.Status()
		// Commit notifications are the only realtime wake path;
		// while the Listener reconnects, open streams see changes only on
		// their heartbeat.
		if !realtimeStatus.Connected {
			a.writeError(c, http.StatusServiceUnavailable, "REALTIME_LISTENER_DISCONNECTED", "realtime Listener is disconnected")
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "realtime_listener": realtimeStatus})
}

func (a *App) requireSession() gin.HandlerFunc {
	return func(c *gin.Context) {
		resolved, ok, err := a.optionalPrincipal(c)
		if err != nil {
			a.internalError(c, "load session", err)
			c.Abort()
			return
		}
		if !ok {
			a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "authentication is invalid or expired")
			c.Abort()
			return
		}
		c.Set(principalKey, resolved)
		c.Next()
	}
}

func (a *App) streamSessionInvalidationCode(ctx context.Context, digest []byte) (string, error) {
	if _, err := a.sessions.Active(ctx, digest); err == nil {
		return "", nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	return "SESSION_EXPIRED", nil
}

func (a *App) optionalPrincipal(c *gin.Context) (principal, bool, error) {
	value, err := c.Cookie(a.cfg.CookieName)
	if err != nil {
		return principal{}, false, nil //nolint:nilerr // an unreadable or malformed session cookie means an anonymous request
	}
	token, err := hex.DecodeString(value)
	if err != nil || len(token) != 32 {
		return principal{}, false, nil //nolint:nilerr // an unreadable or malformed session cookie means an anonymous request
	}
	digest := tokenDigest(token)
	session, err := a.sessions.Active(c.Request.Context(), digest)
	if errors.Is(err, pgx.ErrNoRows) {
		return principal{}, false, nil
	}
	if err != nil {
		return principal{}, false, err
	}
	return principal{Session: session, Token: digest}, true, nil
}

func (a *App) requireAgentService() gin.HandlerFunc {
	return func(c *gin.Context) {
		if a.cfg.TeamHubInternalToken == "" {
			a.writeError(c, http.StatusServiceUnavailable, "AGENT_API_UNAVAILABLE", "Agent service authentication is not configured")
			c.Abort()
			return
		}
		token, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
		if !ok || token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.TeamHubInternalToken)) != 1 {
			a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Agent service authentication is invalid")
			c.Abort()
			return
		}
		c.Next()
	}
}

func (a *App) requireMemoryService() gin.HandlerFunc {
	return func(c *gin.Context) {
		if a.cfg.TeamHubInternalToken == "" {
			a.writeError(c, http.StatusServiceUnavailable, "MEMORY_API_UNAVAILABLE", "Memory service authentication is not configured")
			c.Abort()
			return
		}
		token, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
		if !ok || token == "" || subtle.ConstantTimeCompare([]byte(token), []byte(a.cfg.TeamHubInternalToken)) != 1 {
			a.writeError(c, http.StatusUnauthorized, "UNAUTHENTICATED", "Memory service authentication is invalid")
			c.Abort()
			return
		}
		c.Next()
	}
}

func currentPrincipal(c *gin.Context) principal {
	value, _ := c.Get(principalKey)
	return value.(principal)
}

// AddPersonalProfileWorkers registers the Personal Profile job workers, for a
// caller that runs them on a River client of its own instead of StartWorkers.
func (a *App) AddPersonalProfileWorkers(workers *river.Workers) {
	personalprofile.AddJobWorkers(workers, a.personalProfile)
}

// AddPersonalInsightWorkers registers the Personal Insight job worker, for a
// caller that runs it on a River client of its own instead of StartWorkers.
func (a *App) AddPersonalInsightWorkers(workers *river.Workers) {
	personalinsight.AddJobWorkers(workers, a.personalInsights)
}

func (a *App) writeError(c *gin.Context, status int, code, message string) {
	a.writeErrorWithDetails(c, status, code, message, nil)
}

func (a *App) writeErrorWithDetails(c *gin.Context, status int, code, message string, details []httpapi.ErrorDetail) {
	requestID, _ := c.Get("request_id")
	c.JSON(status, httpapi.ErrorResponse{Error: httpapi.Error{
		Code: code, Message: message, RequestId: requestID.(string),
		Details: func() *[]httpapi.ErrorDetail {
			if len(details) == 0 {
				return nil
			}
			return &details
		}(),
	}})
}

func (a *App) writeRetryableError(c *gin.Context, status int, code, message string) {
	requestID, _ := c.Get("request_id")
	retryable := true
	c.JSON(status, httpapi.ErrorResponse{Error: httpapi.Error{
		Code: code, Message: message, RequestId: requestID.(string), Retryable: &retryable,
	}})
}

func parsePage(c *gin.Context) (cursor string, limit int32, ok bool) {
	cursor = c.Query("cursor")
	if len(cursor) > 1024 {
		return "", 0, false
	}
	limit = 50
	if raw := c.Query("limit"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 32)
		if err != nil || value < 1 || value > 200 {
			return "", 0, false
		}
		limit = int32(value)
	}
	return cursor, limit, true
}

func tokenDigest(token []byte) []byte {
	digest := sha256.Sum256(token)
	return digest[:]
}
