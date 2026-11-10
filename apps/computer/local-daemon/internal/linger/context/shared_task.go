package lingercontext

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// SharedTaskScope is the TeamHub-trusted identity of a shared Task directory
// (Runner Gateway SharedTaskScope). The daemon resolves it under its own
// configured storage; no host path crosses the protocol.
type SharedTaskScope struct {
	Version      int    `json:"version"`
	TenantID     string `json:"tenant_id"`
	AgentID      string `json:"agent_id"`
	OriginRoomID string `json:"origin_room_id"`
	Role         string `json:"role"`
	TaskID       string `json:"task_id,omitempty"`
}

const (
	sharedTaskRoleMeta     = "meta"
	sharedTaskRoleAlterEgo = "alter_ego"
	sharedTaskPlayground   = "playground"
	sharedTaskPollInterval = time.Second
	// A Meta rechecks its links under s.mu at least this often.
	sharedTaskFullCheckInterval = 30 * time.Second
)

var sharedTaskIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)

var (
	ErrSharedTaskScope              = errors.New("Shared Task scope does not match the Context identity")
	ErrSharedTaskScopeConflict      = errors.New("Shared Task scope differs from the scope registered for this Context")
	ErrSharedTaskStorageUnavailable = errors.New("Shared Task storage is unavailable on this endpoint")
	ErrSharedTaskPathConflict       = errors.New("Shared Task entry is occupied by content the daemon does not own")
)

// SharedTaskKey is the directory key of a tenant, Agent, or Room id: the first
// 48 hex characters of the SHA-256 of its UTF-8 bytes.
func SharedTaskKey(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:])[:48]
}

// SharedTaskStorage resolves shared Task scopes on one endpoint.
type SharedTaskStorage struct {
	root string
}

// LocalSharedTaskStorage lays Task directories out under a daemon-owned root:
// tenants/<key>/agents/<key>/rooms/<key>/tasks/<taskId>. The daemon creates
// the directories a scope owns.
func LocalSharedTaskStorage(root string) SharedTaskStorage {
	return SharedTaskStorage{root: root}
}

func (storage SharedTaskStorage) roomTasks(scope SharedTaskScope) string {
	return filepath.Join(storage.root, "tenants", SharedTaskKey(scope.TenantID), "agents", SharedTaskKey(scope.AgentID),
		"rooms", SharedTaskKey(scope.OriginRoomID), "tasks")
}

func (storage SharedTaskStorage) taskDirectory(scope SharedTaskScope, taskID string) string {
	return filepath.Join(storage.roomTasks(scope), taskID)
}

// prepare makes the scope's directories ready.
func (storage SharedTaskStorage) prepare(scope SharedTaskScope) error {
	components := []string{"tenants", SharedTaskKey(scope.TenantID), "agents", SharedTaskKey(scope.AgentID),
		"rooms", SharedTaskKey(scope.OriginRoomID), "tasks"}
	if scope.Role == sharedTaskRoleAlterEgo {
		components = append(components, scope.TaskID)
	}
	return ensureOwnedDirectories(storage.root, components)
}

// ensureOwnedDirectories creates root and each component as a private real
// directory. An existing link or file on the path is a conflict, so the layout
// never follows an unknown link. Concurrent creators of one path both succeed.
func ensureOwnedDirectories(root string, components []string) error {
	current := root
	for index := -1; index < len(components); index++ {
		if index >= 0 {
			current = filepath.Join(current, components[index])
		}
		if err := os.Mkdir(current, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
			return fmt.Errorf("%w: %w", ErrSharedTaskStorageUnavailable, err)
		}
		info, err := os.Lstat(current)
		if err != nil {
			return fmt.Errorf("%w: %w", ErrSharedTaskStorageUnavailable, err)
		}
		if !realDirectory(info) {
			return fmt.Errorf("%w: %s", ErrSharedTaskPathConflict, current)
		}
	}
	return nil
}

// directoryLink reports a symbolic link or, on Windows, a junction (which Go
// reports as an irregular directory rather than a symbolic link).
func directoryLink(info os.FileInfo) bool {
	return info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0
}

func emptyDirectory(path string) bool {
	directory, err := os.Open(path)
	if err != nil {
		return false
	}
	defer directory.Close()
	_, err = directory.Readdirnames(1)
	return errors.Is(err, io.EOF)
}

func realDirectory(info os.FileInfo) bool {
	return info.IsDir() && !directoryLink(info)
}

// listSharedTaskNames reads only the first-level names of a Room tasks
// directory. A read error is returned, never reported as an empty Room.
func listSharedTaskNames(directory string) ([]string, error) {
	file, err := os.Open(directory)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	entries, err := file.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&(os.ModeSymlink|os.ModeIrregular) != 0 || !entry.IsDir() || !sharedTaskIDPattern.MatchString(entry.Name()) {
			continue
		}
		names = append(names, entry.Name())
	}
	return names, nil
}

// validateSharedTaskScope binds a scope to the Context it arrives with. The
// tenant is the command's tenant, which the daemon has already bound to the
// Local Runtime Registration (Computer) or to the Worker binding (Worker).
func validateSharedTaskScope(command View) error {
	scope := command.SharedTaskScope
	if scope == nil {
		return nil
	}
	if scope.Version != 1 || !sharedTaskIDPattern.MatchString(scope.TenantID) || !sharedTaskIDPattern.MatchString(scope.AgentID) ||
		!sharedTaskIDPattern.MatchString(scope.OriginRoomID) || scope.TenantID != command.TenantID || scope.AgentID != command.AgentID {
		return ErrSharedTaskScope
	}
	var key []string
	if json.Unmarshal([]byte(command.ExecutionContextKey), &key) != nil {
		return ErrSharedTaskScope
	}
	switch scope.Role {
	case sharedTaskRoleMeta:
		if scope.TaskID != "" || len(key) != 4 || key[0] != "meta" || key[1] != scope.AgentID || key[2] != "room" || key[3] != scope.OriginRoomID {
			return ErrSharedTaskScope
		}
	case sharedTaskRoleAlterEgo:
		if !sharedTaskIDPattern.MatchString(scope.TaskID) || len(key) != 3 || key[0] != "alter_ego" || key[1] != scope.AgentID || key[2] != scope.TaskID {
			return ErrSharedTaskScope
		}
	default:
		return ErrSharedTaskScope
	}
	for _, mapping := range command.Mappings {
		if mapping.Access == "read_only" && (pathWithin(sharedTaskPlayground, filepath.Clean(mapping.TargetPath)) || pathWithin(filepath.Clean(mapping.TargetPath), sharedTaskPlayground)) {
			return fmt.Errorf("%w: playground is a read-only projection", ErrSharedTaskPathConflict)
		}
	}
	return nil
}

func sameSharedTaskScope(left, right *SharedTaskScope) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func initializeSharedTaskSchema(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS shared_task_scopes (
		execution_context_key TEXT PRIMARY KEY,
		scope_json TEXT NOT NULL
	) STRICT`); err != nil {
		return err
	}
	_, err := db.Exec(`CREATE TABLE IF NOT EXISTS shared_task_links (
		execution_context_key TEXT NOT NULL,
		task_id TEXT NOT NULL,
		link_path TEXT NOT NULL,
		target_path TEXT NOT NULL,
		PRIMARY KEY (execution_context_key, task_id)
	) STRICT`)
	return err
}

// checkSharedTaskScope keeps a Context on the scope it first registered, so a
// changed origin is refused instead of moving files. The caller holds s.mu.
func (s *ViewStore) checkSharedTaskScope(ctx context.Context, command View) error {
	var encoded string
	err := s.db.QueryRowContext(ctx, `SELECT scope_json FROM shared_task_scopes WHERE execution_context_key=?`, command.ExecutionContextKey).Scan(&encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var registered SharedTaskScope
	if err := json.Unmarshal([]byte(encoded), &registered); err != nil {
		return err
	}
	if !sameSharedTaskScope(&registered, command.SharedTaskScope) {
		return ErrSharedTaskScopeConflict
	}
	return nil
}

func (s *ViewStore) sharedTaskStorage() *SharedTaskStorage {
	s.shared.mu.Lock()
	defer s.shared.mu.Unlock()
	return s.shared.storage
}

// prepareSharedTask readies the scope's directories and, for a Meta, reads the
// Room's current Tasks. It runs without s.mu.
func (s *ViewStore) prepareSharedTask(scope SharedTaskScope) ([]string, error) {
	storage := s.sharedTaskStorage()
	if storage == nil {
		return nil, ErrSharedTaskStorageUnavailable
	}
	if err := storage.prepare(scope); err != nil {
		return nil, err
	}
	if scope.Role != sharedTaskRoleMeta {
		return nil, nil
	}
	names, err := listSharedTaskNames(storage.roomTasks(scope))
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrSharedTaskStorageUnavailable, err)
	}
	return names, nil
}

// linkSharedTasks registers the scope and links its Tasks into the published
// workspace. An alter_ego fails on any conflict; a Meta reports a conflicting
// Task and links the rest. The caller holds s.mu.
func (s *ViewStore) linkSharedTasks(ctx context.Context, command View, workspace string, tasks []string) error {
	scope := *command.SharedTaskScope
	storage := s.sharedTaskStorage()
	if storage == nil {
		return ErrSharedTaskStorageUnavailable
	}
	encoded, err := json.Marshal(scope)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO shared_task_scopes(execution_context_key,scope_json) VALUES(?,?)
		ON CONFLICT(execution_context_key) DO UPDATE SET scope_json=excluded.scope_json`, command.ExecutionContextKey, string(encoded)); err != nil {
		return err
	}
	if scope.Role == sharedTaskRoleAlterEgo {
		return s.ensureSharedTaskLink(ctx, command.ExecutionContextKey, workspace, scope.TaskID, storage.taskDirectory(scope, scope.TaskID), true)
	}
	for _, taskID := range tasks {
		err := s.ensureSharedTaskLink(ctx, command.ExecutionContextKey, workspace, taskID, storage.taskDirectory(scope, taskID), false)
		if errors.Is(err, ErrSharedTaskPathConflict) {
			s.sharedTaskLogger().Warn("runner.shared_task.link_conflict", "execution_context_key", command.ExecutionContextKey,
				"task_id", taskID, "role", scope.Role, "stage", "activation", "error", err)
			continue
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// sharedTaskLinkState inspects playground/<taskID> without changing it. It
// returns the registered target when the entry is this daemon's link, and
// ErrSharedTaskPathConflict when anything else occupies the path. Only a link
// this daemon registered for the Context is ever replaced; user content is
// never touched. The caller holds s.mu.
func (s *ViewStore) sharedTaskLinkState(ctx context.Context, key, workspace, taskID string) (link, registered string, exists bool, err error) {
	if !sharedTaskIDPattern.MatchString(taskID) {
		return "", "", false, ErrSharedTaskScope
	}
	playground := filepath.Join(workspace, sharedTaskPlayground)
	if info, err := os.Lstat(playground); err == nil && !realDirectory(info) {
		return "", "", false, fmt.Errorf("%w: %s", ErrSharedTaskPathConflict, playground)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", "", false, err
	}
	link = filepath.Join(playground, taskID)
	registered, found, err := s.registeredSharedTaskLink(ctx, key, taskID)
	if err != nil {
		return "", "", false, err
	}
	info, err := os.Lstat(link)
	if errors.Is(err, os.ErrNotExist) {
		return link, registered, false, nil
	}
	if err != nil {
		return "", "", false, err
	}
	if !found && realDirectory(info) {
		return link, "", false, fmt.Errorf("%w: %w: %s", ErrSharedTaskPathConflict, errLegacyTaskDirectory, link)
	}
	if found && realDirectory(info) && emptyDirectory(link) {
		// A junction starts as an empty directory; a crash between its two
		// steps leaves one behind, which counts as a missing link.
		return link, registered, false, nil
	}
	if !found || !directoryLink(info) {
		return "", "", false, fmt.Errorf("%w: %s", ErrSharedTaskPathConflict, link)
	}
	current, err := os.Readlink(link)
	if err != nil || filepath.Clean(current) != filepath.Clean(registered) {
		return "", "", false, fmt.Errorf("%w: %s", ErrSharedTaskPathConflict, link)
	}
	return link, registered, true, nil
}

// ensureSharedTaskLink makes playground/<taskID> a directory link to target.
// The registry row is written before a link is created and after an old one
// is removed, so a crash leaves at most a missing link, never an unregistered
// one. An alter_ego adopts the real directory it wrote there before shared
// Tasks. The caller holds s.mu.
func (s *ViewStore) ensureSharedTaskLink(ctx context.Context, key, workspaceDir, taskID, target string, adopt bool) error {
	link, registered, exists, err := s.sharedTaskLinkState(ctx, key, workspaceDir, taskID)
	if adopt && errors.Is(err, errLegacyTaskDirectory) {
		if err := adoptLegacyTaskDirectory(link, target); err != nil {
			return fmt.Errorf("%w: %w", ErrSharedTaskPathConflict, err)
		}
		s.sharedTaskLogger().Info("runner.shared_task.legacy_directory_adopted", "execution_context_key", key, "task_id", taskID)
		err = nil
	}
	if err != nil {
		return err
	}
	if exists && registered == target {
		return nil
	}
	if err := os.Mkdir(filepath.Dir(link), 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if info, err := os.Lstat(link); exists || (err == nil && realDirectory(info)) {
		if err := os.Remove(link); err != nil {
			return err
		}
	}
	if _, err := s.db.ExecContext(ctx, `INSERT INTO shared_task_links(execution_context_key,task_id,link_path,target_path) VALUES(?,?,?,?)
		ON CONFLICT(execution_context_key,task_id) DO UPDATE SET link_path=excluded.link_path,target_path=excluded.target_path`,
		key, taskID, link, target); err != nil {
		return err
	}
	return workspace.CreateDirectoryLink(target, link)
}

// registeredSharedTaskLink reads the target this daemon registered for a link.
// The caller holds s.mu.
func (s *ViewStore) registeredSharedTaskLink(ctx context.Context, key, taskID string) (string, bool, error) {
	var target string
	err := s.db.QueryRowContext(ctx, `SELECT target_path FROM shared_task_links WHERE execution_context_key=? AND task_id=?`, key, taskID).Scan(&target)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return target, true, nil
}

// SharedTaskAccess names the real shared Task directories a ready View's
// links reach, so a Runtime can be granted exactly those paths.
func (s *ViewStore) SharedTaskAccess(ctx context.Context, executionContextKey, viewDigest string) (provider.SharedTaskAccess, error) {
	record, err := s.CurrentView(ctx, executionContextKey, viewDigest)
	if err != nil {
		return provider.SharedTaskAccess{}, err
	}
	scope := record.View.SharedTaskScope
	if scope == nil {
		return provider.SharedTaskAccess{}, nil
	}
	storage := s.sharedTaskStorage()
	if storage == nil {
		return provider.SharedTaskAccess{}, ErrSharedTaskStorageUnavailable
	}
	if scope.Role == sharedTaskRoleAlterEgo {
		return provider.SharedTaskAccess{
			WritableTaskRoot: storage.taskDirectory(*scope, scope.TaskID),
			WritableTaskLink: filepath.Join(sharedTaskPlayground, scope.TaskID),
		}, nil
	}
	return provider.SharedTaskAccess{ReadableTasksRoot: storage.roomTasks(*scope)}, nil
}

func (s *ViewStore) sharedTaskLogger() *slog.Logger {
	if s.logger != nil {
		return s.logger
	}
	return slog.Default()
}

// sharedTaskState runs one discovery loop per active Meta View.
type sharedTaskState struct {
	mu      sync.Mutex
	storage *SharedTaskStorage
	poll    time.Duration
	loops   map[string]*metaDiscovery
	wg      sync.WaitGroup
	closed  bool
}

type metaDiscovery struct {
	scope  SharedTaskScope
	kick   chan struct{}
	cancel context.CancelFunc
}

var errMetaDiscoveryStopped = errors.New("Meta discovery stopped")

// UseSharedTaskStorage binds this endpoint's shared Task storage and resumes
// discovery for every active Meta View with a registered scope.
func (s *ViewStore) UseSharedTaskStorage(storage SharedTaskStorage) error {
	s.shared.mu.Lock()
	s.shared.storage = &storage
	s.shared.mu.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return ErrContextClosed
	}
	rows, err := s.db.Query(`SELECT view_json FROM context_views_v3 WHERE ready=1
		AND json_extract(view_json,'$.shared_task_scope.role')=?`, sharedTaskRoleMeta)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	var restored []View
	for rows.Next() {
		var encoded string
		var command View
		if err := rows.Scan(&encoded); err != nil {
			_ = rows.Close()
			s.mu.Unlock()
			return err
		}
		if json.Unmarshal([]byte(encoded), &command) == nil && command.SharedTaskScope != nil {
			restored = append(restored, command)
		}
	}
	err = rows.Err()
	_ = rows.Close()
	s.mu.Unlock()
	if err != nil {
		return err
	}
	for _, command := range restored {
		s.startMetaDiscovery(command.ExecutionContextKey, *command.SharedTaskScope)
	}
	return nil
}

// afterSharedTaskApply runs without s.mu once a View has been published.
func (s *ViewStore) afterSharedTaskApply(record ViewRecord) {
	scope := record.View.SharedTaskScope
	if scope == nil {
		return
	}
	if scope.Role == sharedTaskRoleMeta {
		s.startMetaDiscovery(record.View.ExecutionContextKey, *scope)
		return
	}
	// A Task created on this daemon appears in its Meta without waiting for
	// the next periodic check, which still runs regardless.
	s.shared.mu.Lock()
	defer s.shared.mu.Unlock()
	for _, loop := range s.shared.loops {
		if loop.scope.TenantID == scope.TenantID && loop.scope.AgentID == scope.AgentID && loop.scope.OriginRoomID == scope.OriginRoomID {
			select {
			case loop.kick <- struct{}{}:
			default:
			}
		}
	}
}

func (s *ViewStore) startMetaDiscovery(key string, scope SharedTaskScope) {
	s.shared.mu.Lock()
	defer s.shared.mu.Unlock()
	if s.shared.closed || s.shared.storage == nil {
		return
	}
	if loop, ok := s.shared.loops[key]; ok && loop.scope == scope {
		select {
		case loop.kick <- struct{}{}:
		default:
		}
		return
	} else if ok {
		loop.cancel()
	}
	if s.shared.loops == nil {
		s.shared.loops = make(map[string]*metaDiscovery)
	}
	ctx, cancel := context.WithCancel(context.Background())
	loop := &metaDiscovery{scope: scope, kick: make(chan struct{}, 1), cancel: cancel}
	s.shared.loops[key] = loop
	s.shared.wg.Add(1)
	go func() {
		defer s.shared.wg.Done()
		s.runMetaDiscovery(ctx, key, loop)
		cancel()
		s.shared.mu.Lock()
		if s.shared.loops[key] == loop {
			delete(s.shared.loops, key)
		}
		s.shared.mu.Unlock()
	}()
}

func (s *ViewStore) stopMetaDiscovery(match func(string, SharedTaskScope) bool) {
	s.shared.mu.Lock()
	defer s.shared.mu.Unlock()
	for key, loop := range s.shared.loops {
		if match(key, loop.scope) {
			loop.cancel()
			delete(s.shared.loops, key)
		}
	}
}

func (s *ViewStore) closeSharedTasks() {
	s.shared.mu.Lock()
	s.shared.closed = true
	for key, loop := range s.shared.loops {
		loop.cancel()
		delete(s.shared.loops, key)
	}
	s.shared.mu.Unlock()
	s.shared.wg.Wait()
}

// runMetaDiscovery checks the Meta's Room tasks directory every poll interval
// and whenever a Task on this daemon kicks it. A kick during a check is
// coalesced into the next one.
func (s *ViewStore) runMetaDiscovery(ctx context.Context, key string, loop *metaDiscovery) {
	poll := s.shared.poll
	if poll <= 0 {
		poll = sharedTaskPollInterval
	}
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	discovery := metaDiscoveryProgress{reported: map[string]bool{}}
	if !s.metaViewActive(ctx, key, loop.scope) {
		return
	}
	for {
		if !s.discoverMetaTasks(ctx, key, loop.scope, &discovery) {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-loop.kick:
		}
	}
}

type metaDiscoveryProgress struct {
	reported map[string]bool
	failing  bool
	// The last full pass that linked every listed Task.
	workspace string
	linked    []string
	verified  time.Time
}

// current reports, without s.mu, that the last full pass linked exactly these
// Tasks and that every link still points at its Task. A full pass runs at
// least every sharedTaskFullCheckInterval, which also catches a moved workspace.
func (p *metaDiscoveryProgress) current(names []string, scope SharedTaskScope, storage *SharedTaskStorage, now time.Time) bool {
	if p.workspace == "" || now.Sub(p.verified) >= sharedTaskFullCheckInterval || !slices.Equal(p.linked, names) {
		return false
	}
	for _, taskID := range names {
		link := filepath.Join(p.workspace, sharedTaskPlayground, taskID)
		info, err := os.Lstat(link)
		if err != nil || !directoryLink(info) {
			return false
		}
		target, err := os.Readlink(link)
		if err != nil || filepath.Clean(target) != filepath.Clean(storage.taskDirectory(scope, taskID)) {
			return false
		}
	}
	return true
}

// discoverMetaTasks lists the Room's Tasks without s.mu and makes each entry
// current under s.mu. A read failure keeps every existing link. It reports false when
// the Meta View is gone and the loop must stop.
func (s *ViewStore) discoverMetaTasks(ctx context.Context, key string, scope SharedTaskScope, progress *metaDiscoveryProgress) bool {
	storage := s.sharedTaskStorage()
	if storage == nil || ctx.Err() != nil {
		return false
	}
	logger := s.sharedTaskLogger()
	names, err := listSharedTaskNames(storage.roomTasks(scope))
	if err != nil {
		if !progress.failing {
			logger.Warn("runner.shared_task.discovery_failed", "execution_context_key", key, "role", scope.Role, "stage", "list", "error", err)
		}
		progress.failing = true
		return true
	}
	if progress.failing {
		logger.Info("runner.shared_task.discovery_recovered", "execution_context_key", key, "role", scope.Role)
		progress.failing = false
	}
	now := time.Now()
	if progress.current(names, scope, storage, now) {
		return true
	}
	workspace, results, err := s.linkMetaTasks(ctx, key, scope, names, storage)
	if errors.Is(err, errMetaDiscoveryStopped) {
		return false
	}
	if err != nil {
		logger.Warn("runner.shared_task.link_failed", "execution_context_key", key, "role", scope.Role, "stage", "discovery", "error", err)
		return true
	}
	for index, taskID := range names {
		err := results[index]
		switch {
		case errors.Is(err, ErrSharedTaskPathConflict):
			if !progress.reported[taskID] {
				logger.Warn("runner.shared_task.link_conflict", "execution_context_key", key, "task_id", taskID, "role", scope.Role, "stage", "discovery", "error", err)
				progress.reported[taskID] = true
			}
		case err != nil:
			logger.Warn("runner.shared_task.link_failed", "execution_context_key", key, "task_id", taskID, "role", scope.Role, "stage", "discovery", "error", err)
		default:
			delete(progress.reported, taskID)
		}
	}
	progress.workspace, progress.linked, progress.verified = workspace, nil, now
	if !slices.ContainsFunc(results, func(err error) bool { return err != nil }) {
		progress.linked = names
	}
	return true
}

// metaViewActive reports whether the Meta View still holds scope. A replayed
// command outcome can name a View that was released since.
func (s *ViewStore) metaViewActive(ctx context.Context, key string, scope SharedTaskScope) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || ctx.Err() != nil {
		return false
	}
	record, err := s.read(ctx, key)
	if err != nil {
		// Only a missing View stops discovery; a storage fault is retried.
		return !errors.Is(err, sql.ErrNoRows)
	}
	return sameSharedTaskScope(record.View.SharedTaskScope, &scope)
}

// linkMetaTasks makes every listed Task's entry current under one s.mu hold.
// Each check is idempotent, so an entry removed from the workspace returns on
// the next pass. It reports the workspace and one result per Task.
func (s *ViewStore) linkMetaTasks(ctx context.Context, key string, scope SharedTaskScope, taskIDs []string, storage *SharedTaskStorage) (string, []error, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || ctx.Err() != nil {
		return "", nil, errMetaDiscoveryStopped
	}
	record, err := s.read(ctx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil, errMetaDiscoveryStopped
	}
	if err != nil {
		return "", nil, err
	}
	if !sameSharedTaskScope(record.View.SharedTaskScope, &scope) {
		return "", nil, errMetaDiscoveryStopped
	}
	results := make([]error, len(taskIDs))
	for index, taskID := range taskIDs {
		results[index] = s.ensureSharedTaskLink(ctx, key, record.WorkspacePath, taskID, storage.taskDirectory(scope, taskID), false)
	}
	return record.WorkspacePath, results, nil
}
