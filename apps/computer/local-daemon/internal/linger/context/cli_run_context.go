// Package lingercontext projects Room context, Skills and files into a Computer workspace and serves them to local runtimes.
package lingercontext

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
)

const maxCLIRunContextBytes = 16 * 1024

const (
	cliDirectory  = ".teamhub/cli"
	cliConfigFile = ".teamhub/cli/config.json"
	cliRunFile    = ".teamhub/cli/run.json"
)

var cliScopeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

// CLICredentialLookup finds the Agent-level TeamHub CLI credential that the
// Daemon stored for the Agent.
type CLICredentialLookup interface {
	Lookup(tenantID, agentID string) (clicredential.Installation, error)
}

// CLIScope is the resource that a Run's TeamHub CLI calls act on.
type CLIScope struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}

// ParseCLIRunContext extracts the optional per-run `cli_run_context` object of
// a run.start payload. It returns the run.json content without the scope, and
// the scope when present. An absent field yields `{}` so a previous Run's
// values never leak forward.
func ParseCLIRunContext(payload json.RawMessage) (json.RawMessage, *CLIScope, error) {
	var request struct {
		CLIRunContext json.RawMessage `json:"cli_run_context"`
	}
	if err := json.Unmarshal(payload, &request); err != nil {
		return nil, nil, fmt.Errorf("decode semantic Operation request: %w", err)
	}
	if request.CLIRunContext == nil {
		return json.RawMessage(`{}`), nil, nil
	}
	if len(request.CLIRunContext) > maxCLIRunContextBytes {
		return nil, nil, errors.New("cli_run_context exceeds 16 KiB")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(request.CLIRunContext, &object); err != nil || object == nil {
		return nil, nil, errors.New("cli_run_context must be a JSON object")
	}
	var scope *CLIScope
	if raw, ok := object["scope"]; ok {
		var parsed CLIScope
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, nil, errors.New("cli_run_context scope is invalid")
		}
		switch parsed.Kind {
		case "room", "task", "document":
		default:
			return nil, nil, errors.New("cli_run_context scope kind is invalid")
		}
		if !cliScopeIDPattern.MatchString(parsed.ID) {
			return nil, nil, errors.New("cli_run_context scope id is invalid")
		}
		scope = &parsed
		delete(object, "scope")
	}
	content, err := json.Marshal(object)
	if err != nil {
		return nil, nil, err
	}
	return content, scope, nil
}

type cliConfigDocument struct {
	Version        int                   `json:"version"`
	DefaultProfile string                `json:"default_profile"`
	Profiles       map[string]cliProfile `json:"profiles"`
}

type cliProfile struct {
	URL       string   `json:"url"`
	TenantID  string   `json:"tenant_id"`
	AgentID   string   `json:"agent_id"`
	TokenFile string   `json:"token_file"`
	Scope     CLIScope `json:"scope"`
}

// PrepareRunCLI prepares a Context workspace's TeamHub CLI files for one
// run.start. It runs before any Provider starts or reuses a process.
//
// A Run with a scope gets config.json pointing at the Agent's stored
// credential, then run.json without the scope. A Run without a scope gets
// neither file. Symbolic links in the workspace path are refused and never
// followed.
func PrepareRunCLI(workspace, tenantID, agentID string, credentials CLICredentialLookup, payload json.RawMessage) error {
	runContent, scope, err := ParseCLIRunContext(payload)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		return err
	}
	defer root.Close()
	if scope == nil {
		return removeCLIRunFiles(root)
	}
	if credentials == nil {
		return clicredential.ErrNotInstalled
	}
	installation, err := credentials.Lookup(tenantID, agentID)
	if err != nil {
		return err
	}
	config, err := json.Marshal(cliConfigDocument{
		Version:        1,
		DefaultProfile: "runtime",
		Profiles: map[string]cliProfile{"runtime": {
			URL:       installation.Profile.URL,
			TenantID:  installation.Profile.TenantID,
			AgentID:   installation.Profile.AgentID,
			TokenFile: installation.CredentialPath,
			Scope:     *scope,
		}},
	})
	if err != nil {
		return err
	}
	if err := writeCLIFile(root, cliConfigFile, append(config, '\n')); err != nil {
		return fmt.Errorf("write TeamHub CLI configuration: %w", err)
	}
	if err := writeCLIFile(root, cliRunFile, append(runContent, '\n')); err != nil {
		return fmt.Errorf("write TeamHub CLI run context: %w", err)
	}
	return nil
}

// cliDirectoryExists reports whether .teamhub/cli exists. A symbolic link or a
// non-directory on the path is an error, so writes never leave the workspace.
func cliDirectoryExists(root *os.Root) (bool, error) {
	for _, directory := range []string{".teamhub", cliDirectory} {
		info, err := root.Lstat(directory)
		if errors.Is(err, fs.ErrNotExist) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return false, errors.New("TeamHub CLI configuration directory is invalid")
		}
	}
	return true, nil
}

func removeCLIRunFiles(root *os.Root) error {
	exists, err := cliDirectoryExists(root)
	if err != nil || !exists {
		return err
	}
	for _, name := range []string{cliConfigFile, cliRunFile} {
		if err := root.Remove(name); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return err
		}
	}
	return nil
}

// writeCLIFile atomically publishes an owner-only file under .teamhub/cli.
func writeCLIFile(root *os.Root, relative string, content []byte) error {
	exists, err := cliDirectoryExists(root)
	if err != nil {
		return err
	}
	if !exists {
		for _, directory := range []string{".teamhub", cliDirectory} {
			if err := root.Mkdir(directory, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return err
			}
		}
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	temporary := cliDirectory + "/.publish-" + hex.EncodeToString(suffix[:])
	file, err := root.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = file.Write(bytes.TrimSpace(content))
	if err == nil {
		_, err = file.Write([]byte("\n"))
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = replaceProjectionFile(root, temporary, relative)
	}
	if err != nil {
		_ = root.Remove(temporary)
		return err
	}
	return syncDirectory(root, cliDirectory)
}
