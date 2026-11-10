package lingercontext

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/sqlitedb"
)

var (
	// ErrContextConflict reports a Context that is not at the named View or
	// belongs to another owner.
	ErrContextConflict = errors.New("Context View conflicts with retained state")
	// ErrContextClosed reports a call after the store closed.
	ErrContextClosed = errors.New("Context View store is closed")
	// ErrContextStorage wraps the SQLite cause of a failed View read.
	ErrContextStorage = errors.New("Context View store read failed")
)

// viewReadError keeps a storage failure distinct from a missing View. Reporting
// a SQLite error as a conflict made a Run look like a permanent business
// refusal and lost its cause.
func viewReadError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrContextConflict
	}
	if errors.Is(err, ErrProjectionRecoveryRequired) || errors.Is(err, ErrContextConflict) {
		return err
	}
	return fmt.Errorf("%w: %w", ErrContextStorage, err)
}

// ErrInputDownloadUnavailable marks a View that could not be fetched now: the
// Agent Service, TeamHub or the network failed, or a source changed after the
// manifest named it. A later attempt with the same or a newer View may pass.
var ErrInputDownloadUnavailable = errors.New("Context file download temporarily unavailable")

// View is one Context's content as its manifest names it. ViewDigest is the
// SHA-256 of the manifest bytes the Agent Service served; it is the View's
// only identity.
type View struct {
	TenantID            string           `json:"tenant_id"`
	RunnerID            string           `json:"runner_id"`
	AgentID             string           `json:"agent_id"`
	WorkspaceGrantID    string           `json:"workspace_grant_id"`
	ExecutionContextKey string           `json:"execution_context_key"`
	RuntimeInstanceID   string           `json:"runtime_instance_id"`
	ViewDigest          string           `json:"view_digest"`
	SharedTaskScope     *SharedTaskScope `json:"shared_task_scope,omitempty"`
	Mappings            []Mapping        `json:"mappings,omitempty"`
}

type Mapping struct {
	Kind       string      `json:"kind"`
	TargetPath string      `json:"target_path"`
	Access     string      `json:"access"`
	Files      []FileInput `json:"files"`
}

type FileInput struct {
	RelativePath string `json:"relative_path"`
	MediaType    string `json:"media_type"`
	SizeBytes    int64  `json:"size_bytes"`
	SHA256       string `json:"sha256"`
	Executable   bool   `json:"executable,omitempty"`
	// source is a verified local copy, such as an extracted Skill package
	// file; without one the file is fetched from the View's content URL.
	source string
}

type ViewRecord struct {
	View          View
	WorkspacePath string
	Unready       bool
	Pending       *pendingProjection
}

// ViewRef is the wire reference an Operation names its View by.
type ViewRef struct {
	ViewDigest string `json:"view_digest"`
}

// ViewRequest names the View one Operation of a Context needs.
type ViewRequest struct {
	TenantID            string
	RunnerID            string
	AgentID             string
	WorkspaceGrantID    string
	ExecutionContextKey string
	RuntimeInstanceID   string
	ViewDigest          string
}

// ContentSource is where a View's content comes from: the manifest and its
// files from the Agent Service, and Skill packages from TeamHub.
type ContentSource struct {
	// ContentURL is the current connection's context_content_url.
	ContentURL string
	// FetchSkillPackage downloads one Skill package archive with the Agent's
	// TeamHub credential.
	FetchSkillPackage func(ctx context.Context, manifestID string) (io.ReadCloser, error)
}

const maxManifestBytes = 16 << 20

var (
	viewDigestPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	packageNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	manifestIDPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
)

type ViewStore struct {
	db         *sql.DB
	path       string
	root       string
	httpClient *http.Client
	logger     *slog.Logger
	now        func() time.Time
	mu         sync.Mutex
	closed     bool
	// ensureMu serializes Ensure per Context, so one fetch serves concurrent
	// Operations of that Context.
	ensureMu    sync.Mutex
	ensureLocks map[string]*sync.Mutex
	// verifiedMu guards the verified-file cache and its read counter. Downloads
	// run without mu, so digest checks can run concurrently for different keys.
	verifiedMu              sync.Mutex
	verifiedProjectionFiles map[string]verifiedProjectionFile
	projectionDigestReads   uint64
	projectionFault         func(projectionMutationKind) error
	warm                    downloadWarmer
	shared                  sharedTaskState
	skills                  skillPackageCache
	connectedMu             sync.Mutex
	connected               time.Time
}

func OpenViewStore(path, root string, client *http.Client) (*ViewStore, error) {
	return openViewStore(path, root, client, defaultDownloadWarm)
}

func openViewStore(path, root string, client *http.Client, warm downloadWarmSettings) (*ViewStore, error) {
	if !filepath.IsAbs(root) {
		return nil, errors.New("Context View store requires an absolute root")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, err
	}
	db, err := sqlitedb.Open(path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := initializeViewSchema(db, filepath.Clean(root)); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := initializeSharedTaskSchema(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Workspaces hold independent copies of their Skill files, so the package
	// cache only saves downloads within one Daemon process; clearing it here
	// drops crashed staging directories and package versions no View needs.
	skillPackages := filepath.Join(root, ".skill-packages")
	if err := removeGeneration(skillPackages); err != nil {
		_ = db.Close()
		return nil, err
	}
	if client == nil {
		client = defaultViewHTTPClient()
	}
	store := &ViewStore{
		db: db, path: path, root: root, httpClient: client, logger: slog.Default(), now: time.Now,
		ensureLocks:             make(map[string]*sync.Mutex),
		verifiedProjectionFiles: make(map[string]verifiedProjectionFile), connected: time.Now(),
		skills: skillPackageCache{root: skillPackages, locks: make(map[string]*sync.Mutex)},
	}
	store.startDownloadWarmer(warm)
	return store, nil
}

const (
	contextDownloadParallelism      = 16
	contextDownloadMaxInFlightBytes = int64(400 << 20)
)

type contextApplyTiming struct {
	startedAt          time.Time
	manifest           time.Duration
	skills             time.Duration
	materialize        time.Duration
	lockWait           time.Duration
	prepare            time.Duration
	admit              time.Duration
	downloadWall       time.Duration
	pendingCommit      time.Duration
	publish            time.Duration
	readyCommit        time.Duration
	cleanup            time.Duration
	fileCount          int
	totalBytes         int64
	reusedFileCount    int
	downloadFileCount  int
	localCopyFileCount int
	sharedTaskPrepare  time.Duration
	sharedTaskLink     time.Duration
}

type materializeTiming struct {
	downloadWall       time.Duration
	fileCount          int
	totalBytes         int64
	reusedFileCount    int
	downloadFileCount  int
	localCopyFileCount int
}

func defaultViewHTTPClient() *http.Client {
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		ForceAttemptHTTP2:   true,
		MaxIdleConns:        32,
		MaxIdleConnsPerHost: 16,
		IdleConnTimeout:     90 * time.Second,
	}
	if base, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = base.Clone()
		if transport.MaxIdleConns < 32 {
			transport.MaxIdleConns = 32
		}
		if transport.MaxIdleConnsPerHost < 16 {
			transport.MaxIdleConnsPerHost = 16
		}
		if transport.IdleConnTimeout < 90*time.Second {
			transport.IdleConnTimeout = 90 * time.Second
		}
	}
	return &http.Client{Timeout: 30 * time.Second, Transport: transport}
}

// initializeViewSchema keeps one row per Context. A store written before Views
// were named by digest is dropped with the workspaces its rows named; the next
// Ensure of each Context fetches its View into a fresh workspace.
func initializeViewSchema(db *sql.DB, root string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS context_views_v3 (
		execution_context_key TEXT PRIMARY KEY,
		view_json TEXT NOT NULL,
		workspace_path TEXT NOT NULL,
		ready INTEGER NOT NULL CHECK (ready IN (0,1)),
		pending_projection_json TEXT
	) STRICT`); err != nil {
		return err
	}
	var previous int
	if err := tx.QueryRow(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name='context_views_v2'`).Scan(&previous); err != nil {
		return err
	}
	if previous == 1 {
		if err := removePreviousWorkspaces(tx, root); err != nil {
			return err
		}
		if _, err := tx.Exec(`DROP TABLE context_views_v2`); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DROP TABLE IF EXISTS context_command_outcomes`); err != nil {
		return err
	}
	return tx.Commit()
}

func removePreviousWorkspaces(tx *sql.Tx, root string) error {
	rows, err := tx.Query(`SELECT workspace_path FROM context_views_v2`)
	if err != nil {
		return err
	}
	var paths []string
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			_ = rows.Close()
			return err
		}
		paths = append(paths, path)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, path := range paths {
		if !strings.HasPrefix(filepath.Clean(path), root+string(filepath.Separator)) {
			continue
		}
		if err := removeGeneration(path); err != nil {
			return err
		}
	}
	return nil
}

// Ensure brings the Context's workspace to the View the request names. A
// workspace already at that digest is returned without any request; otherwise
// the manifest and every file the workspace lacks are fetched and verified.
func (s *ViewStore) Ensure(ctx context.Context, request ViewRequest, source ContentSource) (ViewRecord, error) {
	if !viewDigestPattern.MatchString(request.ViewDigest) || request.ExecutionContextKey == "" {
		return ViewRecord{}, ErrContextConflict
	}
	lock := s.ensureLock(request.ExecutionContextKey)
	lock.Lock()
	defer lock.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ViewRecord{}, ErrContextClosed
	}
	current, readErr := s.read(ctx, request.ExecutionContextKey)
	s.mu.Unlock()
	if readErr == nil && !current.Unready && current.View.ViewDigest == request.ViewDigest &&
		current.View.RuntimeInstanceID == request.RuntimeInstanceID && sameRequestOwner(current.View, request) {
		if err := validateWorkspaceLinks(current.WorkspacePath, current.View.Mappings); err != nil {
			return ViewRecord{}, err
		}
		return current, nil
	}
	if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
		return ViewRecord{}, s.observeStorage(ctx, "ensure", readErr)
	}
	timing := contextApplyTiming{startedAt: time.Now()}
	view, skills, err := s.fetchManifest(ctx, request, source)
	timing.manifest = time.Since(timing.startedAt)
	if err != nil {
		return ViewRecord{}, err
	}
	if len(skills) > 0 {
		skillsStartedAt := time.Now()
		mapping, err := s.skillMapping(ctx, skills, source.FetchSkillPackage)
		timing.skills = time.Since(skillsStartedAt)
		if err != nil {
			return ViewRecord{}, err
		}
		view.Mappings = append(view.Mappings, mapping)
	}
	if err := validateView(view); err != nil {
		return ViewRecord{}, err
	}
	s.noteDownloadActivity(source.ContentURL)
	record, err := s.apply(ctx, view, source.ContentURL, timing)
	if err == nil {
		s.afterSharedTaskApply(record)
	}
	return record, s.observeStorage(ctx, "ensure", err)
}

// contextWorkspace is the stable working directory of one Execution Context.
func contextWorkspace(viewRoot, contextKey string) string {
	sum := sha256.Sum256([]byte(contextKey))
	return filepath.Join(viewRoot, hex.EncodeToString(sum[:16]), "workspace")
}

func (s *ViewStore) ensureLock(key string) *sync.Mutex {
	s.ensureMu.Lock()
	defer s.ensureMu.Unlock()
	lock, ok := s.ensureLocks[key]
	if !ok {
		lock = &sync.Mutex{}
		s.ensureLocks[key] = lock
	}
	return lock
}

type manifestDocument struct {
	Version             int              `json:"version"`
	ExecutionContextKey string           `json:"execution_context_key"`
	RuntimeInstanceID   string           `json:"runtime_instance_id"`
	SharedTaskScope     *SharedTaskScope `json:"shared_task_scope,omitempty"`
	Mappings            []Mapping        `json:"mappings"`
	Skills              []Skill          `json:"skills"`
}

// fetchManifest reads the manifest the digest names and accepts only bytes
// whose SHA-256 is that digest.
func (s *ViewStore) fetchManifest(ctx context.Context, request ViewRequest, source ContentSource) (View, []Skill, error) {
	body, err := s.get(ctx, source.ContentURL, "views/"+request.ViewDigest, maxManifestBytes)
	if err != nil {
		return View{}, nil, err
	}
	digest := sha256.Sum256(body)
	if hex.EncodeToString(digest[:]) != request.ViewDigest {
		return View{}, nil, errors.New("Context View manifest does not match its digest")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var manifest manifestDocument
	if err := decoder.Decode(&manifest); err != nil {
		return View{}, nil, fmt.Errorf("decode Context View manifest: %w", err)
	}
	if manifest.Version != 1 || manifest.ExecutionContextKey != request.ExecutionContextKey ||
		manifest.RuntimeInstanceID != request.RuntimeInstanceID {
		return View{}, nil, errors.New("Context View manifest names another Context")
	}
	for _, mapping := range manifest.Mappings {
		if !slices.Contains([]string{"inbox_view", "memory", "playground"}, mapping.Kind) {
			return View{}, nil, errors.New("Context View manifest mapping kind is invalid")
		}
	}
	for _, skill := range manifest.Skills {
		if !packageNamePattern.MatchString(skill.PackageName) || len(skill.PackageName) > 64 ||
			!manifestIDPattern.MatchString(skill.ManifestID) || !viewDigestPattern.MatchString(skill.PackageSHA256) {
			return View{}, nil, errors.New("Context View manifest Skill is invalid")
		}
	}
	view := View{
		TenantID: request.TenantID, RunnerID: request.RunnerID, AgentID: request.AgentID,
		WorkspaceGrantID: request.WorkspaceGrantID, ExecutionContextKey: request.ExecutionContextKey,
		RuntimeInstanceID: request.RuntimeInstanceID, ViewDigest: request.ViewDigest,
		SharedTaskScope: manifest.SharedTaskScope, Mappings: manifest.Mappings,
	}
	return view, manifest.Skills, nil
}

// get reads one content resource. Every failure that a later attempt may not
// repeat is reported as ErrInputDownloadUnavailable.
func (s *ViewStore) get(ctx context.Context, contentURL, resource string, limit int64) ([]byte, error) {
	if contentURL == "" {
		return nil, fmt.Errorf("%w: the Agent Service named no content URL", ErrInputDownloadUnavailable)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(contentURL, "/")+"/"+resource, nil)
	if err != nil {
		return nil, errors.New("Context content URL is invalid")
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrInputDownloadUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w (HTTP %d)", ErrInputDownloadUnavailable, response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, ErrInputDownloadUnavailable
	}
	if int64(len(body)) > limit {
		return nil, errors.New("Context content exceeds its size limit")
	}
	return body, nil
}

func (s *ViewStore) apply(ctx context.Context, view View, contentURL string, timing contextApplyTiming) (result ViewRecord, resultErr error) {
	stagedPath := ""
	cleanupPending := false
	timingActive := false
	var admitStartedAt time.Time
	defer func() {
		if !admitStartedAt.IsZero() {
			timing.admit += time.Since(admitStartedAt)
		}
		if cleanupPending {
			startedAt := time.Now()
			_ = removeGeneration(stagedPath)
			timing.cleanup = time.Since(startedAt)
		}
		if timingActive {
			s.logApplyTiming(view, timing, resultErr == nil)
		}
	}()
	lockStartedAt := time.Now()
	s.mu.Lock()
	timing.lockWait += time.Since(lockStartedAt)
	defer s.mu.Unlock()
	prepareStartedAt := time.Now()
	if s.closed {
		return ViewRecord{}, ErrContextClosed
	}
	current, readErr := s.read(ctx, view.ExecutionContextKey)
	if readErr != nil && !errors.Is(readErr, sql.ErrNoRows) {
		return ViewRecord{}, readErr
	}
	if readErr == nil && !sameContextOwner(current.View, view) {
		return ViewRecord{}, ErrContextConflict
	}
	if err := s.checkSharedTaskScope(ctx, view); err != nil {
		return ViewRecord{}, err
	}
	workspacePath := contextWorkspace(s.root, view.ExecutionContextKey)
	projectionPrevious := current
	if readErr != nil || current.WorkspacePath != workspacePath {
		// Another directory never inherits the old row's file claims.
		projectionPrevious = ViewRecord{}
	}
	timingActive = true
	timing.prepare = time.Since(prepareStartedAt)
	// Downloads run without the store lock so other Contexts keep applying.
	// The per-Context Ensure lock keeps this Context's row unchanged meanwhile.
	s.mu.Unlock()
	materializeStartedAt := time.Now()
	materializedPath, materialized, err := s.materialize(ctx, view, projectionPrevious, contentURL)
	timing.materialize = time.Since(materializeStartedAt)
	timing.downloadWall = materialized.downloadWall
	timing.fileCount = materialized.fileCount
	timing.totalBytes = materialized.totalBytes
	timing.reusedFileCount = materialized.reusedFileCount
	timing.downloadFileCount = materialized.downloadFileCount
	timing.localCopyFileCount = materialized.localCopyFileCount
	if err == nil {
		stagedPath = materializedPath
		cleanupPending = true
	}
	relockStartedAt := time.Now()
	s.mu.Lock()
	timing.lockWait += time.Since(relockStartedAt)
	if s.closed {
		return ViewRecord{}, ErrContextClosed
	}
	if err != nil {
		return ViewRecord{}, err
	}
	admitStartedAt = time.Now()
	var sharedTasks []string
	if view.SharedTaskScope != nil {
		sharedStartedAt := time.Now()
		sharedTasks, err = s.prepareSharedTask(*view.SharedTaskScope)
		timing.sharedTaskPrepare = time.Since(sharedStartedAt)
		if err != nil {
			return ViewRecord{}, err
		}
	}
	ownership, err := retainedProjectionOwnership(workspacePath, projectionPrevious)
	if err != nil {
		return ViewRecord{}, err
	}
	if err := validateProjectionUpdate(workspacePath, ownership, projectionPrevious.View.Mappings, view.Mappings); err != nil {
		return ViewRecord{}, err
	}
	if _, err := os.Lstat(workspacePath); err == nil {
		if err := validateWorkspaceLinks(workspacePath, projectionPrevious.View.Mappings); err != nil {
			return ViewRecord{}, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ViewRecord{}, err
	}
	if scope := view.SharedTaskScope; scope != nil && scope.Role == sharedTaskRoleAlterEgo {
		// A conflicting entry fails the activation before any state changes.
		// Its own pre-upgrade directory is adopted once the scope is linked.
		if _, _, _, err := s.sharedTaskLinkState(ctx, view.ExecutionContextKey, workspacePath, scope.TaskID); err != nil && !errors.Is(err, errLegacyTaskDirectory) {
			return ViewRecord{}, err
		}
	}
	// The row claims the union of the old and new files until the publish
	// completes, so an interrupted publish is reconciled by the next Ensure.
	pending := projectionPrevious
	if projectionPrevious.WorkspacePath == "" {
		pending.View = view
		pending.View.Mappings = nil
	}
	pending.Unready = true
	pending.WorkspacePath = workspacePath
	pending.Pending, err = preparePendingProjection(workspacePath, projectionPrevious, view)
	if err != nil {
		return ViewRecord{}, err
	}
	timing.admit += time.Since(admitStartedAt)
	admitStartedAt = time.Time{}
	pendingCommitStartedAt := time.Now()
	pendingCommitErr := s.write(ctx, pending)
	timing.pendingCommit = time.Since(pendingCommitStartedAt)
	if pendingCommitErr != nil {
		return ViewRecord{}, pendingCommitErr
	}
	publishStartedAt := time.Now()
	if err := s.publishProjection(workspacePath, stagedPath, ownership, projectionPrevious.View.Mappings, view.Mappings); err != nil {
		timing.publish = time.Since(publishStartedAt)
		return ViewRecord{}, err
	}
	if err := validateWorkspaceLinks(workspacePath, view.Mappings); err != nil {
		timing.publish = time.Since(publishStartedAt)
		return ViewRecord{}, err
	}
	timing.publish = time.Since(publishStartedAt)
	if view.SharedTaskScope != nil {
		linkStartedAt := time.Now()
		err := s.linkSharedTasks(ctx, view, workspacePath, sharedTasks)
		timing.sharedTaskLink = time.Since(linkStartedAt)
		if err != nil {
			return ViewRecord{}, err
		}
	}
	record := ViewRecord{View: view, WorkspacePath: workspacePath}
	readyCommitStartedAt := time.Now()
	readyCommitErr := s.write(ctx, record)
	timing.readyCommit = time.Since(readyCommitStartedAt)
	if readyCommitErr != nil {
		return ViewRecord{}, readyCommitErr
	}
	return record, nil
}

func (s *ViewStore) logApplyTiming(view View, timing contextApplyTiming, succeeded bool) {
	logger := s.logger
	if logger == nil {
		logger = slog.Default()
	}
	outcome := "failed"
	if succeeded {
		outcome = "success"
	}
	logger.Info("runner.context_view.timing",
		"runner_id", view.RunnerID, "agent_id", view.AgentID, "view_digest", view.ViewDigest, "outcome", outcome,
		"total_ms", time.Since(timing.startedAt).Milliseconds(),
		"manifest_ms", timing.manifest.Milliseconds(), "skills_ms", timing.skills.Milliseconds(),
		"lock_wait_ms", timing.lockWait.Milliseconds(),
		"prepare_ms", timing.prepare.Milliseconds(), "materialize_ms", timing.materialize.Milliseconds(),
		"admit_ms", timing.admit.Milliseconds(),
		"download_wall_ms", timing.downloadWall.Milliseconds(),
		"pending_commit_ms", timing.pendingCommit.Milliseconds(), "publish_ms", timing.publish.Milliseconds(),
		"ready_commit_ms", timing.readyCommit.Milliseconds(), "cleanup_ms", timing.cleanup.Milliseconds(),
		"file_count", timing.fileCount, "total_bytes", timing.totalBytes,
		"reused_file_count", timing.reusedFileCount, "download_file_count", timing.downloadFileCount,
		"local_copy_file_count", timing.localCopyFileCount,
		"shared_task_prepare_ms", timing.sharedTaskPrepare.Milliseconds(), "shared_task_link_ms", timing.sharedTaskLink.Milliseconds())
}

// ValidatedWorkspace returns the workspace of a Context whose ready View is
// the one the reference names.
func (s *ViewStore) ValidatedWorkspace(ctx context.Context, executionContextKey string, encoded json.RawMessage) (string, error) {
	record, err := s.ValidatedView(ctx, executionContextKey, encoded)
	if err != nil {
		return "", err
	}
	return record.WorkspacePath, nil
}

// ValidatedView is the Context's ready View that an Operation's reference
// names, read once for its workspace and its mappings.
func (s *ViewStore) ValidatedView(ctx context.Context, executionContextKey string, encoded json.RawMessage) (ViewRecord, error) {
	var ref ViewRef
	if err := json.Unmarshal(encoded, &ref); err != nil || executionContextKey == "" || !viewDigestPattern.MatchString(ref.ViewDigest) {
		return ViewRecord{}, ErrContextConflict
	}
	return s.CurrentView(ctx, executionContextKey, ref.ViewDigest)
}

// CurrentView returns the Context's ready View. A non-empty digest must match.
func (s *ViewStore) CurrentView(ctx context.Context, executionContextKey, viewDigest string) (ViewRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ViewRecord{}, ErrContextClosed
	}
	record, err := s.read(ctx, executionContextKey)
	if err != nil {
		return ViewRecord{}, viewReadError(err)
	}
	if record.Unready || (viewDigest != "" && record.View.ViewDigest != viewDigest) {
		return ViewRecord{}, ErrContextConflict
	}
	if err := validateWorkspaceLinks(record.WorkspacePath, record.View.Mappings); err != nil {
		return ViewRecord{}, err
	}
	return record, nil
}

// ForgetAgent stops the shared Task discovery of a removed Agent's Views. Its
// workspaces stay; a later View of the same Agent reconciles them.
func (s *ViewStore) ForgetAgent(tenantID, agentID string) {
	s.stopMetaDiscovery(func(_ string, scope SharedTaskScope) bool {
		return scope.TenantID == tenantID && scope.AgentID == agentID
	})
}

func (s *ViewStore) Close() error {
	s.stopDownloadWarmer()
	s.closeSharedTasks()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.db.Close()
}

func (s *ViewStore) materialize(ctx context.Context, view View, previous ViewRecord, contentURL string) (string, materializeTiming, error) {
	var timing materializeTiming
	contextDigest := sha256.Sum256([]byte(view.ExecutionContextKey))
	contextRoot := filepath.Join(s.root, hex.EncodeToString(contextDigest[:16]))
	if err := os.MkdirAll(contextRoot, 0o700); err != nil {
		return "", timing, err
	}
	temporary, err := os.MkdirTemp(contextRoot, ".generation-*")
	if err != nil {
		return "", timing, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(temporary)
		}
	}()
	seen := make(map[string]string)
	var downloads []downloadJob
	for _, mapping := range view.Mappings {
		mappingRoot, err := safeJoin(temporary, mapping.TargetPath)
		if err != nil {
			return "", timing, err
		}
		if err := os.MkdirAll(mappingRoot, 0o700); err != nil {
			return "", timing, err
		}
		for _, input := range mapping.Files {
			target, err := safeJoin(mappingRoot, input.RelativePath)
			if err != nil {
				return "", timing, err
			}
			if digest, duplicate := seen[target]; duplicate {
				if digest != input.SHA256 {
					return "", timing, errors.New("Context View maps multiple files to one path")
				}
				continue
			}
			seen[target] = input.SHA256
			timing.fileCount++
			timing.totalBytes += input.SizeBytes
			workspaceFile, joinErr := workspaceMappingFile(previous.WorkspacePath, mapping.TargetPath, input.RelativePath)
			previousInput, previouslyCommitted := previousFileInput(previous.View.Mappings, mapping, input.RelativePath)
			// Publication may retain a read-only file without a staged source
			// only when the completed projection already owns that version.
			canRetain := mapping.Access == "read_write" || (previouslyCommitted && sameProjectionContent(previousInput, input))
			if canRetain && joinErr == nil && s.fileHasDigest(workspaceFile, input.SHA256, input.SizeBytes) {
				timing.reusedFileCount++
				continue
			}
			downloads = append(downloads, downloadJob{input: input, target: target, contentURL: contentURL})
		}
	}
	if len(downloads) > 0 {
		sources := s.localCopySources(ctx, view, downloads)
		for index := range downloads {
			downloads[index].sources = sources[downloads[index].input.SHA256]
		}
	}
	downloadStartedAt := time.Now()
	downloadErr := s.downloadAll(ctx, downloads)
	timing.downloadWall = time.Since(downloadStartedAt)
	for _, job := range downloads {
		if job.localCopy {
			timing.localCopyFileCount++
		}
	}
	timing.downloadFileCount = len(downloads) - timing.localCopyFileCount
	if downloadErr != nil {
		return "", timing, downloadErr
	}
	committed = true
	return temporary, timing, nil
}

// downloadAll fills every job's target. A job satisfied by a verified local copy
// sets job.localCopy in jobs; the slice element is written before its completion
// is sent and read only after that receive.
func (s *ViewStore) downloadAll(ctx context.Context, jobs []downloadJob) error {
	if len(jobs) == 0 {
		return nil
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	type completedDownload struct {
		weight int64
		err    error
	}
	completed := make(chan completedDownload, contextDownloadParallelism)
	nextJob := 0
	activeCount := 0
	activeBytes := int64(0)
	var firstErr error
	for nextJob < len(jobs) || activeCount > 0 {
		for firstErr == nil && nextJob < len(jobs) && activeCount < contextDownloadParallelism {
			if err := ctx.Err(); err != nil {
				firstErr = err
				break
			}
			job := jobs[nextJob]
			weight := downloadInFlightWeight(job.input.SizeBytes)
			if activeCount > 0 && activeBytes+weight > contextDownloadMaxInFlightBytes {
				break
			}
			index := nextJob
			nextJob++
			activeCount++
			activeBytes += weight
			go func() {
				local, err := s.fetch(ctx, job)
				jobs[index].localCopy = local
				completed <- completedDownload{weight: weight, err: err}
			}()
		}
		if activeCount == 0 {
			break
		}
		result := <-completed
		activeCount--
		activeBytes -= result.weight
		if result.err != nil && firstErr == nil {
			firstErr = result.err
			cancel()
		}
	}
	if firstErr != nil {
		return firstErr
	}
	return ctx.Err()
}

func downloadInFlightWeight(sizeBytes int64) int64 {
	if sizeBytes <= 0 {
		return 0
	}
	if sizeBytes > contextDownloadMaxInFlightBytes {
		return contextDownloadMaxInFlightBytes
	}
	return sizeBytes
}

func (s *ViewStore) download(ctx context.Context, job downloadJob) error {
	input := job.input
	if input.SizeBytes < 0 || !viewDigestPattern.MatchString(input.SHA256) {
		return errors.New("Context file metadata is invalid")
	}
	if input.source != "" {
		source, err := os.Open(input.source)
		if err != nil {
			return err
		}
		defer source.Close()
		return writeVerifiedFile(job.target, source, input)
	}
	if job.contentURL == "" {
		return fmt.Errorf("%w: the Agent Service named no content URL", ErrInputDownloadUnavailable)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(job.contentURL, "/")+"/files/"+input.SHA256, nil)
	if err != nil {
		return errors.New("Context content URL is invalid")
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return ErrInputDownloadUnavailable
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		// The Agent Service refuses a file whose source changed since the
		// manifest named it; the next View names the new content.
		return fmt.Errorf("%w (HTTP %d)", ErrInputDownloadUnavailable, response.StatusCode)
	}
	if err := writeVerifiedFile(job.target, response.Body, input); err != nil {
		return fmt.Errorf("%w: %w", ErrInputDownloadUnavailable, err)
	}
	return nil
}

// writeVerifiedFile writes exactly input.SizeBytes from body to a new target and
// accepts it only when the SHA-256 matches. Any mismatch removes the target.
func writeVerifiedFile(target string, body io.Reader, input FileInput) error {
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return err
	}
	file, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(body, input.SizeBytes+1))
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil || syncErr != nil || closeErr != nil || written != input.SizeBytes || hex.EncodeToString(hash.Sum(nil)) != input.SHA256 {
		_ = os.Remove(target)
		return errors.New("Context file size or digest mismatch")
	}
	mode := os.FileMode(0o600)
	if input.Executable {
		mode = 0o700
	}
	return os.Chmod(target, mode)
}

func (s *ViewStore) read(ctx context.Context, key string) (ViewRecord, error) {
	record, err := s.readOnce(ctx, key)
	if _, ok := sqliteResultCode(err); !ok {
		return record, err
	}
	if s.storageFault(ctx, "read", err) {
		if record, err = s.readOnce(ctx, key); err == nil {
			return record, nil
		}
		s.storageFault(ctx, "read_retry", err)
	}
	return ViewRecord{}, observedStorageError{err}
}

func (s *ViewStore) readOnce(ctx context.Context, key string) (ViewRecord, error) {
	var encoded string
	var record ViewRecord
	var ready int
	var pending sql.NullString
	err := s.db.QueryRowContext(ctx, `SELECT view_json,workspace_path,ready,pending_projection_json FROM context_views_v3 WHERE execution_context_key=?`, key).
		Scan(&encoded, &record.WorkspacePath, &ready, &pending)
	if err != nil {
		return ViewRecord{}, err
	}
	if err := json.Unmarshal([]byte(encoded), &record.View); err != nil {
		return ViewRecord{}, err
	}
	record.Unready = ready == 0
	if pending.Valid {
		decoder := json.NewDecoder(strings.NewReader(pending.String))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&record.Pending); err != nil {
			return ViewRecord{}, ErrProjectionRecoveryRequired
		}
		if err := validatePendingProjection(record); err != nil {
			return ViewRecord{}, err
		}
	}
	if record.Unready && record.Pending == nil {
		return ViewRecord{}, ErrProjectionRecoveryRequired
	}
	return record, nil
}

func (s *ViewStore) write(ctx context.Context, record ViewRecord) error {
	encoded, err := json.Marshal(record.View)
	if err != nil {
		return err
	}
	pending, err := encodePendingProjection(record.Pending)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO context_views_v3(execution_context_key,view_json,workspace_path,ready,pending_projection_json)
		VALUES(?,?,?,?,?) ON CONFLICT(execution_context_key) DO UPDATE SET view_json=excluded.view_json,
		workspace_path=excluded.workspace_path,ready=excluded.ready,pending_projection_json=excluded.pending_projection_json`,
		record.View.ExecutionContextKey, string(encoded), record.WorkspacePath, boolInt(!record.Unready), pending)
	return err
}

func sameContextOwner(current, next View) bool {
	return current.TenantID == next.TenantID && current.RunnerID == next.RunnerID && current.AgentID == next.AgentID && current.WorkspaceGrantID == next.WorkspaceGrantID && current.ExecutionContextKey == next.ExecutionContextKey
}

func sameRequestOwner(current View, request ViewRequest) bool {
	return current.TenantID == request.TenantID && current.RunnerID == request.RunnerID && current.AgentID == request.AgentID && current.WorkspaceGrantID == request.WorkspaceGrantID && current.ExecutionContextKey == request.ExecutionContextKey
}

func validateView(view View) error {
	if err := validatePlatformMappings(view.Mappings); err != nil {
		return err
	}
	if err := validateSharedTaskScope(view); err != nil {
		return err
	}
	if view.TenantID == "" || view.RunnerID == "" || view.AgentID == "" || view.WorkspaceGrantID == "" ||
		view.ExecutionContextKey == "" || view.RuntimeInstanceID == "" || !viewDigestPattern.MatchString(view.ViewDigest) {
		return ErrContextConflict
	}
	for _, mapping := range view.Mappings {
		if mapping.TargetPath == "" || (mapping.Access != "read_only" && mapping.Access != "read_write") {
			return ErrContextConflict
		}
		for _, file := range mapping.Files {
			if file.SizeBytes < 0 || !viewDigestPattern.MatchString(file.SHA256) {
				return ErrContextConflict
			}
		}
	}
	return nil
}

func safeJoin(root, relative string) (string, error) {
	if err := validatePlatformRelativePath(relative); err != nil {
		return "", err
	}
	if relative == "" || filepath.IsAbs(relative) || strings.Contains(relative, "\\") {
		return "", errors.New("Context path is invalid")
	}
	clean := filepath.Clean(relative)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("Context path escapes its workspace")
	}
	joined := filepath.Join(root, clean)
	if !strings.HasPrefix(joined, root+string(filepath.Separator)) {
		return "", errors.New("Context path escapes its workspace")
	}
	return joined, nil
}

func removeGeneration(root string) error {
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if directoryLink(info) {
			// Never follow a link or junction out of a generation.
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if info.IsDir() {
			return os.Chmod(path, 0o700) //nolint:gosec // owner-only directory mode; gosec expects a file mode for Chmod
		}
		return os.Chmod(path, 0o600)
	}); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.RemoveAll(root)
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
