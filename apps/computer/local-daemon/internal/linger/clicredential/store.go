// Package clicredential stores Agent-level TeamHub CLI credentials privately
// on this Computer. The Agent Service pushes one long-term credential per
// (tenant, Agent) and Runtime Assignment; run.start points a Context
// workspace's CLI configuration at the stored file.
package clicredential

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"syscall"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const (
	credentialFile = "credential"
	stateFile      = "state.json"
	profileFile    = "profile.json"
	maxStateBytes  = 4 * 1024
	maxProfileSize = 16 * 1024
	// The TeamHub CLI reads token_file as raw text and rejects larger files.
	maxCredentialBytes = 8 * 1024
)

// ErrNotInstalled means no credential was pushed for this Agent.
var ErrNotInstalled = errors.New("TeamHub CLI credential is not installed for this Agent; the Agent Service must push it first")

// Retryable reports whether a storage error may clear without anyone acting
// on it: an I/O error, a temporarily unavailable resource, or a full disk.
// Permission, symbolic-link and invalid-path refusals stay definitive.
func Retryable(err error) bool {
	return errors.Is(err, syscall.EIO) || errors.Is(err, syscall.EAGAIN) || errors.Is(err, syscall.ENOSPC)
}

var (
	idPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	tokenPattern = regexp.MustCompile(`^th_agent_[A-Za-z0-9_-]{43}$`)
)

// Profile is the TeamHub endpoint and identity the credential belongs to.
type Profile struct {
	URL      string `json:"url"`
	TenantID string `json:"tenant_id"`
	AgentID  string `json:"agent_id"`
}

// PutResult reports the stored credential.
type PutResult struct {
	SHA256 string
}

// Installation locates a stored credential for a Run. The token is read by
// the TeamHub CLI from CredentialPath, never passed through the Daemon.
type Installation struct {
	CredentialPath string
	Profile        Profile
}

// Stored describes the credential held for an Agent, without its token, and
// the Runtime Assignment TeamHub issued it for.
type Stored struct {
	SHA256             string
	AssignmentRevision uint64
	Profile            Profile
}

type state struct {
	AssignmentRevision uint64 `json:"assignment_revision"`
	SHA256             string `json:"sha256"`
}

// Store keeps one owner-only directory per Agent under its root.
type Store struct {
	root string
	mu   sync.Mutex
}

// Open creates the private root directory and returns the store.
func Open(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("TeamHub CLI credential root is required")
	}
	if err := privatefs.EnsureDir(root); err != nil {
		return nil, fmt.Errorf("prepare TeamHub CLI credential root: %w", err)
	}
	return &Store{root: root}, nil
}

// Put replaces the credential for one Agent. Writes are ordered credential,
// state, then profile, so an interrupted Put never reports an assignment for
// a token it did not store.
func (s *Store) Put(tenantID, agentID string, profile Profile, token string, assignmentRevision uint64) (PutResult, error) {
	if err := validatePut(tenantID, agentID, profile, token, assignmentRevision); err != nil {
		return PutResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	agentDirectory := s.agentDirectory(tenantID, agentID)
	if err := s.ensureDirectory(agentDirectory); err != nil {
		return PutResult{}, err
	}
	content := []byte(token + "\n")
	// The digest is the token's own, the form TeamHub records, so the Agent
	// Service can ask TeamHub whether the held token is still live.
	sum := sha256.Sum256([]byte(token))
	digest := hex.EncodeToString(sum[:])
	stored, hasProfile, err := readProfile(agentDirectory)
	if err != nil {
		return PutResult{}, err
	}
	if err := writeAtomic(agentDirectory, credentialFile, content); err != nil {
		return PutResult{}, err
	}
	stateContent, err := json.Marshal(state{AssignmentRevision: assignmentRevision, SHA256: digest})
	if err != nil {
		return PutResult{}, err
	}
	if err := writeAtomic(agentDirectory, stateFile, stateContent); err != nil {
		return PutResult{}, err
	}
	if !hasProfile || stored != profile {
		profileContent, err := json.Marshal(profile)
		if err != nil {
			return PutResult{}, err
		}
		if err := writeAtomic(agentDirectory, profileFile, profileContent); err != nil {
			return PutResult{}, err
		}
	}
	return PutResult{SHA256: digest}, nil
}

// Lookup returns the stored credential path and profile for an Agent.
func (s *Store) Lookup(tenantID, agentID string) (Installation, error) {
	if !idPattern.MatchString(tenantID) || !idPattern.MatchString(agentID) {
		return Installation{}, errors.New("TeamHub CLI credential identity is invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	agentDirectory := s.agentDirectory(tenantID, agentID)
	if err := s.checkDirectory(agentDirectory); err != nil {
		return Installation{}, err
	}
	profile, hasProfile, err := readProfile(agentDirectory)
	if err != nil {
		return Installation{}, err
	}
	if !hasProfile {
		return Installation{}, ErrNotInstalled
	}
	credentialPath := filepath.Join(agentDirectory, credentialFile)
	info, err := os.Lstat(credentialPath)
	if errors.Is(err, fs.ErrNotExist) {
		return Installation{}, ErrNotInstalled
	}
	if err != nil {
		return Installation{}, err
	}
	if !info.Mode().IsRegular() {
		return Installation{}, errors.New("TeamHub CLI credential path is invalid")
	}
	return Installation{CredentialPath: credentialPath, Profile: profile}, nil
}

// Current reports the credential stored for an Agent. ok is false when none
// is stored, or when its state names no Runtime Assignment, which Put always
// records.
func (s *Store) Current(tenantID, agentID string) (Stored, bool, error) {
	if !idPattern.MatchString(tenantID) || !idPattern.MatchString(agentID) {
		return Stored{}, false, errors.New("TeamHub CLI credential identity is invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	agentDirectory := s.agentDirectory(tenantID, agentID)
	if err := s.checkDirectory(agentDirectory); errors.Is(err, ErrNotInstalled) {
		return Stored{}, false, nil
	} else if err != nil {
		return Stored{}, false, err
	}
	current, hasState, err := readState(agentDirectory)
	if err != nil || !hasState || current.AssignmentRevision == 0 {
		return Stored{}, false, err
	}
	profile, hasProfile, err := readProfile(agentDirectory)
	if err != nil || !hasProfile {
		return Stored{}, false, err
	}
	info, err := os.Lstat(filepath.Join(agentDirectory, credentialFile))
	if errors.Is(err, fs.ErrNotExist) {
		return Stored{}, false, nil
	}
	if err != nil {
		return Stored{}, false, err
	}
	if !info.Mode().IsRegular() {
		return Stored{}, false, errors.New("TeamHub CLI credential path is invalid")
	}
	return Stored{SHA256: current.SHA256, AssignmentRevision: current.AssignmentRevision, Profile: profile}, true, nil
}

// RemoveAgent deletes every credential stored for one Agent. It is idempotent.
func (s *Store) RemoveAgent(tenantID, agentID string) error {
	if !idPattern.MatchString(tenantID) || !idPattern.MatchString(agentID) {
		return errors.New("TeamHub CLI credential identity is invalid")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.RemoveAll(s.agentDirectory(tenantID, agentID)); err != nil {
		return fmt.Errorf("remove TeamHub CLI credentials: %w", err)
	}
	return nil
}

func (s *Store) agentDirectory(tenantID, agentID string) string {
	sum := sha256.Sum256([]byte(tenantID + "\x00" + agentID))
	return filepath.Join(s.root, hex.EncodeToString(sum[:])[:32])
}

// checkDirectory refuses symbolic links and non-directories between the root
// and dir. Missing components are allowed and reported by the caller.
func (s *Store) checkDirectory(dir string) error {
	relative, err := filepath.Rel(s.root, dir)
	if err != nil {
		return err
	}
	current := s.root
	for part := range strings.SplitSeq(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotInstalled
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("TeamHub CLI credential directory is invalid")
		}
	}
	return nil
}

// ensureDirectory creates the Agent directory as owner-only,
// refusing any existing symbolic link on the path.
func (s *Store) ensureDirectory(dir string) error {
	relative, err := filepath.Rel(s.root, dir)
	if err != nil {
		return err
	}
	current := s.root
	for part := range strings.SplitSeq(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, fs.ErrNotExist) {
			break
		}
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return errors.New("TeamHub CLI credential directory is invalid")
		}
	}
	if err := privatefs.EnsureDir(dir); err != nil {
		return fmt.Errorf("prepare TeamHub CLI credential directory: %w", err)
	}
	return nil
}

func readState(agentDirectory string) (state, bool, error) {
	data, err := privatefs.ReadFile(filepath.Join(agentDirectory, stateFile), maxStateBytes)
	if errors.Is(err, fs.ErrNotExist) {
		return state{}, false, nil
	}
	if err != nil {
		return state{}, false, fmt.Errorf("read TeamHub CLI credential state: %w", err)
	}
	var current state
	if err := json.Unmarshal(data, &current); err != nil {
		return state{}, false, fmt.Errorf("decode TeamHub CLI credential state: %w", err)
	}
	return current, true, nil
}

func readProfile(agentDirectory string) (Profile, bool, error) {
	data, err := privatefs.ReadFile(filepath.Join(agentDirectory, profileFile), maxProfileSize)
	if errors.Is(err, fs.ErrNotExist) {
		return Profile{}, false, nil
	}
	if err != nil {
		return Profile{}, false, fmt.Errorf("read TeamHub CLI profile: %w", err)
	}
	var profile Profile
	if err := json.Unmarshal(data, &profile); err != nil {
		return Profile{}, false, fmt.Errorf("decode TeamHub CLI profile: %w", err)
	}
	return profile, true, nil
}

// writeAtomic publishes a complete owner-only file. The rename replaces the
// previous content at the same path, and the directory sync makes it durable.
func writeAtomic(directory, name string, content []byte) error {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temporary := filepath.Join(directory, "."+name+"."+hex.EncodeToString(nonce[:])+".tmp")
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("write TeamHub CLI credential file: %w", err)
	}
	defer os.Remove(temporary)
	_, err = file.Write(content)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return fmt.Errorf("write TeamHub CLI credential file: %w", err)
	}
	if err := os.Rename(temporary, filepath.Join(directory, name)); err != nil {
		return fmt.Errorf("publish TeamHub CLI credential file: %w", err)
	}
	return syncDirectory(directory)
}

func syncDirectory(directory string) error {
	// Windows offers no ordinary-user directory fsync; the file contents were
	// flushed before publication.
	if runtime.GOOS == "windows" {
		return nil
	}
	file, err := os.Open(directory)
	if err != nil {
		return err
	}
	defer file.Close()
	return file.Sync()
}

func validatePut(tenantID, agentID string, profile Profile, token string, assignmentRevision uint64) error {
	if !idPattern.MatchString(tenantID) || !idPattern.MatchString(agentID) {
		return errors.New("TeamHub CLI credential identity is invalid")
	}
	if profile.TenantID != tenantID || profile.AgentID != agentID {
		return errors.New("TeamHub CLI credential profile does not match its Agent")
	}
	parsed, err := url.Parse(profile.URL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return errors.New("TeamHub CLI credential profile URL is invalid")
	}
	if !tokenPattern.MatchString(token) || len(token)+1 > maxCredentialBytes {
		return errors.New("TeamHub CLI credential token is invalid")
	}
	if assignmentRevision == 0 {
		return errors.New("TeamHub CLI credential assignment is required")
	}
	return nil
}
