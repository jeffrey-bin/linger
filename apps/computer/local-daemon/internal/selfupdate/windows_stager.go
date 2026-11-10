package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	// windowsInstallerTimeout bounds how long the daemon waits for the
	// installer to stop it. Past it the installer keeps running; the daemon
	// only reopens admissions.
	windowsInstallerTimeout = 30 * time.Minute
	maxDepsArchiveLen       = 512 << 20
	windowsUpgradePrefix    = ".upgrade-"
	windowsInstallerName    = "linger-computer.ps1"
	windowsMetadataStart    = "FromBase64String('"
)

// WindowsStager downloads both archives and the PowerShell installer the Web
// origin renders, and checks that the installer names the welcome's digests.
// Once the daemon is idle it runs that installer against the downloaded
// files: the installer stops this daemon, switches bundles, starts the new
// daemon, and when that daemon does not become ready it rolls back and
// records upgrade-failed.
type WindowsStager struct {
	HTTPClient *http.Client
	// Command builds the installer process; nil runs Windows PowerShell.
	Command func(script string) *exec.Cmd
}

type windowsArchive struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type windowsInstallerRelease struct {
	Targets map[string]struct {
		App  windowsArchive `json:"app"`
		Deps windowsArchive `json:"deps"`
	} `json:"targets"`
}

// Prepare downloads the installer and both archives into a new directory in
// the install root while the daemon keeps serving.
func (s WindowsStager) Prepare(ctx context.Context, request StageRequest) (*Prepared, error) {
	ctx, cancel := context.WithTimeout(ctx, stageTimeout)
	defer cancel()
	removeWindowsUpgrades(request.Root)
	directory, err := os.MkdirTemp(request.Root, windowsUpgradePrefix)
	if err != nil {
		return nil, &StageError{Stage: "install", Err: err}
	}
	prepared, err := s.prepare(ctx, request, directory)
	if err != nil {
		_ = os.RemoveAll(directory)
		return nil, err
	}
	return prepared, nil
}

func (s WindowsStager) prepare(ctx context.Context, request StageRequest, directory string) (*Prepared, error) {
	script := filepath.Join(directory, windowsInstallerName)
	if err := download(ctx, s.HTTPClient, request.WebOrigin+"/install/"+windowsInstallerName, script, maxInstallerLen, ""); err != nil {
		return nil, err
	}
	content, err := os.ReadFile(script)
	if err != nil {
		return nil, &StageError{Stage: "verify", Err: err}
	}
	archives, err := windowsInstallerArchives(string(content), request)
	if err != nil {
		return nil, &StageError{Stage: "verify", Err: err}
	}
	for _, archive := range archives {
		limit := min(archive.file.Size, archive.limit)
		destination := filepath.Join(directory, "files", archive.file.File)
		if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
			return nil, &StageError{Stage: "install", Err: err}
		}
		if err := download(ctx, s.HTTPClient, request.WebOrigin+"/install/files/"+archive.file.File, destination, limit, archive.file.SHA256); err != nil {
			return nil, err
		}
	}
	return &Prepared{request: request, directory: directory}, nil
}

type windowsDownload struct {
	file  windowsArchive
	limit int64
}

// windowsInstallerArchives reads the release the installer was rendered with
// and returns this target's archives, which must be the ones the welcome
// names.
func windowsInstallerArchives(script string, request StageRequest) ([]windowsDownload, error) {
	start := strings.Index(script, windowsMetadataStart)
	if start < 0 {
		return nil, errors.New("installer has no release metadata")
	}
	encoded := script[start+len(windowsMetadataStart):]
	end := strings.IndexByte(encoded, '\'')
	if end < 0 {
		return nil, errors.New("installer release metadata is unterminated")
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded[:end])
	if err != nil {
		return nil, fmt.Errorf("installer release metadata is not base64: %w", err)
	}
	var release windowsInstallerRelease
	if err := json.Unmarshal(decoded, &release); err != nil {
		return nil, fmt.Errorf("installer release metadata is malformed: %w", err)
	}
	files, ok := release.Targets[request.Target]
	if !ok || files.App.SHA256 != request.App.SHA256 || files.App.Size != request.App.Size ||
		files.Deps.SHA256 != request.Deps.SHA256 || files.Deps.Size != request.Deps.Size {
		return nil, errors.New("installer release does not match target_release")
	}
	for kind, archive := range map[string]windowsArchive{"app": files.App, "deps": files.Deps} {
		if archive.File != kind+"-"+request.Target+"-"+archive.SHA256+".tar.gz" {
			return nil, errors.New("installer release names an unexpected " + kind + " archive")
		}
	}
	return []windowsDownload{{files.Deps, maxDepsArchiveLen}, {files.App, maxAppArchiveLen}}, nil
}

// Activate runs the installer against the downloaded files and waits for it
// to stop this daemon, which cancels ctx. The installer keeps running then.
// An installer that exits while the daemon still runs did not switch.
func (s WindowsStager) Activate(ctx context.Context, prepared *Prepared) error {
	directory := prepared.directory
	log, err := os.OpenFile(filepath.Join(directory, "installer.log"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return &StageError{Stage: "activate", Err: err}
	}
	defer func() { _ = log.Close() }()
	command, err := startInstaller(func() *exec.Cmd {
		command := s.command(filepath.Join(directory, windowsInstallerName))
		command.Env = append(os.Environ(),
			"LINGER_COMPUTER_DATA_DIR="+prepared.request.Root,
			"LINGER_COMPUTER_DOWNLOAD_BASE_URL="+directory,
			"LINGER_WEB_URL="+prepared.request.WebOrigin,
		)
		command.Stdout = log
		command.Stderr = log
		return command
	})
	if err != nil {
		_ = log.Close()
		_ = os.RemoveAll(directory)
		return &StageError{Stage: "activate", Err: err}
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	timer := time.NewTimer(windowsInstallerTimeout)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return &StageError{Stage: "timeout", Err: errors.New("installer did not stop the daemon")}
	case err := <-done:
		_ = log.Close()
		tail := tailOf(filepath.Join(directory, "installer.log"))
		_ = os.RemoveAll(directory)
		if err == nil {
			return &StageError{Stage: "activate", OutputTail: tail, Err: errors.New("installer finished without replacing this daemon")}
		}
		exitCode := -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
		return &StageError{Stage: "install", ExitCode: exitCode, OutputTail: tail, Err: err}
	}
}

func (s WindowsStager) command(script string) *exec.Cmd {
	if s.Command != nil {
		return s.Command(script)
	}
	powershell := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	return exec.Command(powershell, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script)
}

// removeWindowsUpgrades deletes directories earlier attempts left behind; the
// installer has finished with them once a daemon prepares again.
func removeWindowsUpgrades(root string) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() && strings.HasPrefix(entry.Name(), windowsUpgradePrefix) {
			_ = os.RemoveAll(filepath.Join(root, entry.Name()))
		}
	}
}

func tailOf(path string) string {
	content, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(content[max(len(content)-outputTailBytes, 0):])
}

// download writes source to destination. More than limit bytes, or another
// sha256 when one is given, fail verification.
func download(ctx context.Context, client *http.Client, source, destination string, limit int64, digest string) error {
	if client == nil {
		client = &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return &StageError{Stage: "download", Err: err}
	}
	response, err := client.Do(request)
	if err != nil {
		return &StageError{Stage: stageFor(ctx, "download"), Err: err}
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return &StageError{Stage: "download", Err: fmt.Errorf("%s returned HTTP %d", source, response.StatusCode)}
	}
	file, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return &StageError{Stage: "download", Err: err}
	}
	defer func() { _ = file.Close() }()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(response.Body, limit+1))
	if err != nil {
		return &StageError{Stage: stageFor(ctx, "download"), Err: err}
	}
	if written > limit {
		return &StageError{Stage: "verify", Err: fmt.Errorf("%s exceeds %d bytes", filepath.Base(destination), limit)}
	}
	if digest != "" && hex.EncodeToString(hash.Sum(nil)) != digest {
		return &StageError{Stage: "verify", Err: fmt.Errorf("%s sha256 does not match target_release", filepath.Base(destination))}
	}
	if err := file.Close(); err != nil {
		return &StageError{Stage: "download", Err: err}
	}
	return nil
}
