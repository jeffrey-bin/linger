package native

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const (
	piSessionRootKey     = "LINGER_PI_SESSION_ROOT"
	piLockFileName       = ".linger-lock"
	piInstructionsName   = "linger-instructions.md"
	piMCPConfigName      = "linger-mcp.json"
	piSessionHeaderLimit = 64 << 10
)

var (
	errPiSessionRoot     = errors.New("Pi requires a Context session directory")
	errPiSessionInUse    = errors.New("Pi session is already in use")
	errPiSessionMismatch = errors.New("the retained Pi session is missing or belongs to another Context")
)

// piSessionRoot reads the absolute session root from the profile
// environment. An exact key wins over a case-insensitive match.
func piSessionRoot(env map[string]string) (string, error) {
	root, ok := env[piSessionRootKey]
	if !ok {
		for key, value := range env {
			if strings.EqualFold(key, piSessionRootKey) {
				root = value
			}
		}
	}
	if root == "" || !filepath.IsAbs(root) {
		return "", errPiSessionRoot
	}
	return filepath.Clean(root), nil
}

// piSessionIdentity picks the logical session: resume, then assignment,
// then a fresh 26-character base32 identity.
func piSessionIdentity(spec RunSpec) (string, error) {
	id := spec.ResumeID
	if id == "" {
		id = spec.AssignSessionID
	}
	if id == "" {
		var raw [16]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return "", err
		}
		id = base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw[:])
	}
	if !piValidSessionID(id) {
		return "", fmt.Errorf("Pi session identity %q is invalid", id)
	}
	return id, nil
}

func piValidSessionID(id string) bool {
	if len(id) < 2 || len(id) > 128 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		alnum := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9'
		if (i == 0 || i == len(id)-1) && !alnum {
			return false
		}
		if !alnum && c != '.' && c != '_' && c != '-' {
			return false
		}
	}
	return true
}

// piSessionFolder creates the session directory and refuses anything that is
// not a real directory at that path.
func piSessionFolder(root, id string) (string, error) {
	dir := filepath.Join(root, id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("Pi session directory could not be created: %w", err)
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", fmt.Errorf("Pi session directory could not be inspected: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return "", errors.New("Pi session directory is unsafe")
	}
	return dir, nil
}

// piLockSession takes the non-blocking exclusive session lock. A second run
// on the same session fails at once instead of waiting.
func piLockSession(dir string) (*os.File, error) {
	file, ok, err := privatefs.AcquireLock(filepath.Join(dir, piLockFileName))
	if err != nil {
		return nil, fmt.Errorf("Pi session lock failed: %w", err)
	}
	if !ok {
		return nil, errPiSessionInUse
	}
	return file, nil
}

// piValidateSession requires a transcript of this identity whose header
// names the same working directory as contextDir.
func piValidateSession(sessionDir, id, contextDir string) error {
	want, err := filepath.EvalSymlinks(contextDir)
	if err != nil || contextDir == "" {
		return errPiSessionMismatch
	}
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		return errPiSessionMismatch
	}
	suffix := "_" + id + ".jsonl"
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || !strings.HasSuffix(entry.Name(), suffix) {
			continue
		}
		if piSessionHeaderMatches(filepath.Join(sessionDir, entry.Name()), id, want) {
			return nil
		}
	}
	return errPiSessionMismatch
}

func piSessionHeaderMatches(path, id, resolvedDir string) bool {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	var header struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Cwd  string `json:"cwd"`
	}
	if json.NewDecoder(io.LimitReader(file, piSessionHeaderLimit)).Decode(&header) != nil {
		return false
	}
	if header.Type != "session" || header.ID != id || header.Cwd == "" {
		return false
	}
	cwd, err := filepath.EvalSymlinks(header.Cwd)
	return err == nil && cwd == resolvedDir
}

// piWritePrivate replaces path atomically with an owner-only file.
func piWritePrivate(path string, data []byte) error {
	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	temp := fmt.Sprintf("%s.%x.tmp", path, nonce)
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(temp)
	err = file.Chmod(0o600)
	if err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp, path)
}
