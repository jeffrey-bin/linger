package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

const (
	stageTimeout = 10 * time.Minute
	// activateTimeout bounds the offline switch; it re-verifies and rewrites a
	// few small files and never touches the network.
	activateTimeout = 2 * time.Minute
	// interruptGrace lets the installer's interrupt trap restore the previous
	// installation before the process is killed.
	interruptGrace  = 30 * time.Second
	outputTailBytes = 4096
	// maxAppArchiveLen caps the app archive download whatever size the
	// welcome names.
	maxAppArchiveLen = 64 << 20
	maxInstallerLen  = 8 << 20
	// installerEntry is the installer template inside the app archive.
	installerEntry = "installer/linger-computer.sh"
)

// StageRequest names the install root, the Web origin, the release target,
// and the app and dependency archives the installer must stage.
type StageRequest struct {
	// ID is the release identity the running install is compared with: the
	// app sha256, or on Windows windowsReleaseID of both archives.
	ID        string
	Root      string
	WebOrigin string
	Target    string
	App       protocol.ReleaseFile
	Deps      protocol.ReleaseFile
}

// Stager prepares a build while the daemon keeps serving work, then activates
// the prepared build once the daemon is idle.
type Stager interface {
	Prepare(ctx context.Context, request StageRequest) (*Prepared, error)
	Activate(ctx context.Context, prepared *Prepared) error
}

// Prepared is a build whose app archive verified and whose installer staged
// it. Activate runs the same installer bytes, so nothing is fetched twice.
type Prepared struct {
	request   StageRequest
	installer []byte
	// directory holds the archives and installer WindowsStager downloaded.
	directory string
}

// StageError reports which step of staging failed, for structured logs.
// Stage is one of "download", "verify", "install", "activate", or "timeout".
type StageError struct {
	Stage      string
	ExitCode   int
	OutputTail string
	Err        error
}

func (e *StageError) Error() string {
	return fmt.Sprintf("stage Computer upgrade (%s): %v", e.Stage, e.Err)
}

func (e *StageError) Unwrap() error { return e.Err }

// ScriptStager downloads the target app archive from the Web origin, verifies
// its sha256 against the welcome, and runs the installer template it carries
// with bash in one of its two stage-only modes.
type ScriptStager struct {
	HTTPClient *http.Client
}

func (s ScriptStager) client() *http.Client {
	if s.HTTPClient != nil {
		return s.HTTPClient
	}
	return &http.Client{Transport: &http.Transport{Proxy: http.ProxyFromEnvironment}}
}

// Prepare downloads and verifies the app archive, then lets the installer
// persist its bundle without switching the active installation.
func (s ScriptStager) Prepare(ctx context.Context, request StageRequest) (*Prepared, error) {
	ctx, cancel := context.WithTimeout(ctx, stageTimeout)
	defer cancel()
	// Only this user can write the 0700 directory, so bash runs and the
	// installer reads the bytes that were verified.
	directory, err := os.MkdirTemp("", "linger-computer-upgrade-")
	if err != nil {
		return nil, &StageError{Stage: "install", Err: err}
	}
	defer func() { _ = os.RemoveAll(directory) }()
	archive := filepath.Join(directory, "app.tar.gz")
	if err := s.downloadApp(ctx, request, archive); err != nil {
		return nil, err
	}
	installer, err := extractInstaller(archive)
	if err != nil {
		return nil, &StageError{Stage: "verify", Err: err}
	}
	if err := runInstaller(ctx, directory, installer, request, "prepare", "install",
		"LINGER_COMPUTER_APP_ARCHIVE="+archive,
		"LINGER_COMPUTER_DEPS_SHA256="+request.Deps.SHA256,
		"LINGER_COMPUTER_DEPS_SIZE="+strconv.FormatInt(request.Deps.Size, 10),
	); err != nil {
		return nil, err
	}
	return &Prepared{request: request, installer: installer}, nil
}

// Activate runs the held installer in activate mode. It makes no network
// requests; callers run it only after the daemon has drained.
func (s ScriptStager) Activate(ctx context.Context, prepared *Prepared) error {
	ctx, cancel := context.WithTimeout(ctx, activateTimeout)
	defer cancel()
	directory, err := os.MkdirTemp("", "linger-computer-upgrade-")
	if err != nil {
		return &StageError{Stage: "activate", Err: err}
	}
	defer func() { _ = os.RemoveAll(directory) }()
	return runInstaller(ctx, directory, prepared.installer, prepared.request, "activate", "activate")
}

// downloadApp writes the app archive to destination. More bytes than the
// welcome size or maxAppArchiveLen, or another sha256, fail verification.
func (s ScriptStager) downloadApp(ctx context.Context, request StageRequest, destination string) error {
	source := request.WebOrigin + "/install/files/app-" + request.Target + "-" + request.App.SHA256 + ".tar.gz"
	return download(ctx, s.client(), source, destination, min(request.App.Size, maxAppArchiveLen), request.App.SHA256)
}

// extractInstaller returns the installer template from a verified app
// archive and ignores every other entry.
func extractInstaller(archive string) ([]byte, error) {
	file, err := os.Open(archive)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return nil, err
	}
	reader := tar.NewReader(compressed)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			return nil, errors.New("app archive has no " + installerEntry)
		}
		if err != nil {
			return nil, err
		}
		if strings.TrimPrefix(header.Name, "./") != installerEntry {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size > maxInstallerLen {
			return nil, errors.New(installerEntry + " is not a regular file within the size limit")
		}
		return io.ReadAll(reader)
	}
}

// runInstaller writes verified installer bytes into directory, a 0700
// temporary directory only this user can write, and runs them with bash in the
// given stage-only mode. failStage names the error stage for local and
// installer failures.
func runInstaller(ctx context.Context, directory string, installer []byte, request StageRequest, mode, failStage string, environment ...string) error {
	script := filepath.Join(directory, "linger-computer.sh")
	if err := os.WriteFile(script, installer, 0o600); err != nil {
		return &StageError{Stage: failStage, Err: err}
	}

	command := exec.CommandContext(ctx, "bash", script)
	// A kill would skip the installer's rollback trap and could leave
	// active-bundle switched with half-written receipts.
	interruptInstallerGroup(command)
	command.WaitDelay = interruptGrace
	stopResend := watchInstallerInterrupt(command)
	defer stopResend()
	command.Env = append(append(os.Environ(),
		"LINGER_COMPUTER_INSTALL_STAGE_ONLY="+mode,
		"LINGER_COMPUTER_DATA_DIR="+request.Root,
		"LINGER_WEB_URL="+request.WebOrigin,
		"LINGER_COMPUTER_APP_SHA256="+request.App.SHA256,
	), environment...)
	output := &tailWriter{limit: outputTailBytes}
	command.Stdout = output
	command.Stderr = output
	err := command.Run()
	if ctx.Err() != nil && command.Process != nil {
		killInstallerGroup(command)
	}
	if err != nil {
		exitCode := -1
		var exitError *exec.ExitError
		if errors.As(err, &exitError) {
			exitCode = exitError.ExitCode()
		}
		return &StageError{Stage: stageFor(ctx, failStage), ExitCode: exitCode, OutputTail: output.String(), Err: err}
	}
	return nil
}

// watchInstallerInterrupt resends the platform interrupt every second after
// Cancel until the installer returns or interruptGrace elapses. A SIGINT that
// lands while bash is spawning a foreground child can be lost; later retries
// reach the child once it exists.
func watchInstallerInterrupt(command *exec.Cmd) func() {
	stop := make(chan struct{})
	var startOnce, stopOnce sync.Once
	signalInterrupt := command.Cancel
	command.Cancel = func() error {
		err := signalInterrupt()
		startOnce.Do(func() {
			go resendInstallerInterrupt(stop, signalInterrupt)
		})
		return err
	}
	return func() {
		stopOnce.Do(func() { close(stop) })
	}
}

func resendInstallerInterrupt(stop <-chan struct{}, signalInterrupt func() error) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	grace := time.NewTimer(interruptGrace)
	defer grace.Stop()
	for {
		select {
		case <-stop:
			return
		case <-grace.C:
			return
		case <-ticker.C:
			if err := signalInterrupt(); err != nil {
				return
			}
		}
	}
}

func stageFor(ctx context.Context, stage string) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "timeout"
	}
	return stage
}

// tailWriter keeps the last limit bytes of installer output for diagnostics.
type tailWriter struct {
	buffer bytes.Buffer
	limit  int
}

func (w *tailWriter) Write(p []byte) (int, error) {
	w.buffer.Write(p)
	if extra := w.buffer.Len() - w.limit; extra > 0 {
		w.buffer.Next(extra)
	}
	return len(p), nil
}

func (w *tailWriter) String() string {
	return w.buffer.String()
}
