package process

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

var serviceNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type ManagedServiceStart struct {
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Cwd     string   `json:"cwd"`
}

type ManagedServiceStatus struct {
	Name    string `json:"name"`
	Command string `json:"command"`
	Cwd     string `json:"cwd"`
	LogPath string `json:"log_path"`
	PID     int    `json:"pid"`
	State   string `json:"state"`
}

type managedProcessIdentity struct {
	PID            int    `json:"pid"`
	ProcessGroupID int    `json:"process_group_id"`
	StartToken     string `json:"start_token"`
}

type managedServiceRecord struct {
	Version  int                    `json:"version"`
	Args     []string               `json:"args"`
	Identity managedProcessIdentity `json:"identity"`
	ManagedServiceStatus
}

type ManagedServiceRegistry struct {
	recordsDirectory string
	logsDirectory    string
	environment      map[string]string
	mu               sync.Mutex
}

func NewManagedServiceRegistry(stateDirectory string, environment map[string]string) (*ManagedServiceRegistry, error) {
	if !filepath.IsAbs(stateDirectory) {
		return nil, errors.New("managed service state directory must be absolute")
	}
	return &ManagedServiceRegistry{
		recordsDirectory: filepath.Join(stateDirectory, "managed-services"),
		logsDirectory:    filepath.Join(stateDirectory, "service-logs"), environment: cloneManagedEnvironment(environment),
	}, nil
}

func (r *ManagedServiceRegistry) List(ctx context.Context) ([]ManagedServiceStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, context.Cause(ctx)
	}
	if err := r.prepareDirectories(); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(r.recordsDirectory)
	if err != nil {
		return nil, err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	result := make([]ManagedServiceStatus, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		path := filepath.Join(r.recordsDirectory, entry.Name())
		record, err := r.readRecord(path)
		if err != nil {
			return nil, err
		}
		live, err := sameManagedProcess(record.Identity)
		if err != nil {
			return nil, err
		}
		if !live {
			if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			continue
		}
		result = append(result, record.ManagedServiceStatus)
	}
	return result, nil
}

func (r *ManagedServiceRegistry) Start(ctx context.Context, input ManagedServiceStart) (*ManagedServiceStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if err := validateManagedServiceStart(input); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, context.Cause(ctx)
	}
	if err := r.prepareDirectories(); err != nil {
		return nil, err
	}
	info, err := os.Stat(input.Cwd)
	if err != nil || !info.IsDir() {
		return nil, errors.New("managed service working directory is not a directory")
	}
	recordPath := r.recordPath(input.Name)
	if record, err := r.optionalRecord(recordPath); err != nil {
		return nil, err
	} else if record != nil {
		live, err := sameManagedProcess(record.Identity)
		if err != nil {
			return nil, err
		}
		if live {
			return nil, nil
		}
		if err := os.Remove(recordPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	logPath := filepath.Join(r.logsDirectory, input.Name+".log")
	// No process of this service is live, so keep its previous run's log.
	// Best effort: a log another process still holds open, such as a Windows
	// antivirus scan, is appended to instead.
	_ = os.Rename(logPath, logPath+".1")
	identity, err := startManagedProcess(ctx, input, r.environment, logPath)
	if err != nil {
		return nil, err
	}
	record := managedServiceRecord{
		Version: 1, Args: append([]string(nil), input.Args...), Identity: identity,
		ManagedServiceStatus: ManagedServiceStatus{
			Name: input.Name, Command: input.Command, Cwd: input.Cwd,
			LogPath: logPath, PID: identity.PID, State: "running",
		},
	}
	if err := atomicWriteServiceRecord(recordPath, record); err != nil {
		_ = terminateManagedProcess(context.Background(), identity)
		return nil, err
	}
	status := record.ManagedServiceStatus
	return &status, nil
}

func (r *ManagedServiceRegistry) Stop(ctx context.Context, name string) (*ManagedServiceStatus, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !serviceNamePattern.MatchString(name) {
		return nil, errors.New("managed service name is invalid")
	}
	if err := r.prepareDirectories(); err != nil {
		return nil, err
	}
	path := r.recordPath(name)
	record, err := r.optionalRecord(path)
	if err != nil || record == nil {
		return nil, err
	}
	live, err := sameManagedProcess(record.Identity)
	if err != nil {
		return nil, err
	}
	if live {
		if err := terminateManagedProcess(ctx, record.Identity); err != nil {
			return nil, err
		}
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	status := record.ManagedServiceStatus
	return &status, nil
}

func (r *ManagedServiceRegistry) prepareDirectories() error {
	for _, path := range []string{r.recordsDirectory, r.logsDirectory} {
		if err := privatefs.EnsureDir(path); err != nil {
			return err
		}
	}
	return nil
}

func (r *ManagedServiceRegistry) recordPath(name string) string {
	return filepath.Join(r.recordsDirectory, name+".json")
}

func (r *ManagedServiceRegistry) optionalRecord(path string) (*managedServiceRecord, error) {
	record, err := r.readRecord(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	return record, err
}

func (r *ManagedServiceRegistry) readRecord(path string) (*managedServiceRecord, error) {
	data, err := privatefs.ReadFile(path, 1024*1024)
	if err != nil {
		return nil, err
	}
	var record managedServiceRecord
	if json.Unmarshal(data, &record) != nil || record.Version != 1 || record.State != "running" ||
		!serviceNamePattern.MatchString(record.Name) || record.PID != record.Identity.PID ||
		record.Identity.PID < 1 || record.Identity.ProcessGroupID < 1 || record.Identity.StartToken == "" ||
		!filepath.IsAbs(record.Cwd) || !filepath.IsAbs(record.LogPath) {
		return nil, errors.New("managed service record is invalid")
	}
	return &record, nil
}

func validateManagedServiceStart(input ManagedServiceStart) error {
	if !serviceNamePattern.MatchString(input.Name) || !filepath.IsAbs(input.Cwd) || input.Command == "" || len(input.Command) > 4096 || len(input.Args) > 128 {
		return errors.New("managed service request is invalid")
	}
	for _, argument := range input.Args {
		if len(argument) > 4096 {
			return errors.New("managed service request is invalid")
		}
	}
	return nil
}

func atomicWriteServiceRecord(path string, record managedServiceRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return privatefs.WriteFile(path, append(data, '\n'), false)
}

func cloneManagedEnvironment(input map[string]string) map[string]string {
	result := make(map[string]string, len(input))
	for key, value := range input {
		result[key] = value
	}
	return result
}

func managedEnvironmentList(input map[string]string) []string {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, fmt.Sprintf("%s=%s", key, input[key]))
	}
	return result
}
