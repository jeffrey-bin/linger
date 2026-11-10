package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

type archiveEntry struct {
	name     string
	typeflag byte
	content  string
	linkname string
}

// appArchive builds an app archive holding entries, in order.
func appArchive(t *testing.T, entries ...archiveEntry) []byte {
	t.Helper()
	var buffer bytes.Buffer
	compressed := gzip.NewWriter(&buffer)
	writer := tar.NewWriter(compressed)
	for _, entry := range entries {
		header := &tar.Header{Name: entry.name, Typeflag: entry.typeflag, Mode: 0o644, Size: int64(len(entry.content)), Linkname: entry.linkname}
		if entry.typeflag != tar.TypeReg {
			header.Size = 0
		}
		if err := writer.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if entry.typeflag == tar.TypeReg {
			if _, err := writer.Write([]byte(entry.content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := compressed.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// installerArchive is an app archive whose installer template is installer.
func installerArchive(t *testing.T, installer string) []byte {
	return appArchive(t,
		archiveEntry{name: "./daemon/", typeflag: tar.TypeDir},
		archiveEntry{name: "./daemon/linger-computer-daemon", typeflag: tar.TypeReg, content: "#!/bin/sh\n"},
		archiveEntry{name: "./" + installerEntry, typeflag: tar.TypeReg, content: installer},
	)
}

// releaseServer serves archive at its content-addressed app archive path and
// returns the request that stages it into root, plus the request counter.
func releaseServer(t *testing.T, root string, archive []byte) (StageRequest, *atomic.Int32) {
	t.Helper()
	return releaseServerServing(t, root, archive, archive)
}

// releaseServerServing names archive in the request but serves served.
func releaseServerServing(t *testing.T, root string, archive, served []byte) (StageRequest, *atomic.Int32) {
	t.Helper()
	digest := sha256.Sum256(archive)
	request := StageRequest{
		Root: root, Target: "linux-x64",
		App:  protocol.ReleaseFile{SHA256: hex.EncodeToString(digest[:]), Size: int64(len(archive))},
		Deps: protocol.ReleaseFile{SHA256: strings.Repeat("d", 64), Size: 4096},
	}
	requests := &atomic.Int32{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path != "/install/files/app-linux-x64-"+request.App.SHA256+".tar.gz" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(served)
	}))
	t.Cleanup(server.Close)
	request.WebOrigin = server.URL
	return request, requests
}

func expectStageError(t *testing.T, err error, stage string) {
	t.Helper()
	var stageError *StageError
	if !errors.As(err, &stageError) || stageError.Stage != stage {
		t.Fatalf("error = %v, want %s stage failure", err, stage)
	}
}

func TestScriptStagerReportsDownloadStatus(t *testing.T) {
	request, _ := releaseServer(t, t.TempDir(), installerArchive(t, "exit 0\n"))
	request.App.SHA256 = strings.Repeat("e", 64)

	_, err := ScriptStager{}.Prepare(context.Background(), request)
	expectStageError(t, err, "download")
}

// An archive that is not the welcome's, or not a usable one, is never run.
func TestScriptStagerVerifiesArchiveBeforeRunningInstaller(t *testing.T) {
	cases := []struct {
		name string
		// archive returns the archive the welcome names and the bytes served.
		archive func(t *testing.T, ran string) (named, served []byte)
		adjust  func(*StageRequest)
	}{
		{name: "sha256 mismatch", archive: func(t *testing.T, ran string) ([]byte, []byte) {
			named := installerArchive(t, "exit 0\n")
			served := installerArchive(t, "touch '"+ran+"'\n")
			return named, served
		}},
		{name: "larger than the welcome size", archive: func(t *testing.T, ran string) ([]byte, []byte) {
			archive := installerArchive(t, "touch '"+ran+"'\n")
			return archive, archive
		}, adjust: func(request *StageRequest) { request.App.Size-- }},
		{name: "no installer template", archive: func(t *testing.T, _ string) ([]byte, []byte) {
			archive := appArchive(t, archiveEntry{name: "daemon/linger-computer-daemon", typeflag: tar.TypeReg, content: "x"})
			return archive, archive
		}},
		{name: "installer template is a symlink", archive: func(t *testing.T, _ string) ([]byte, []byte) {
			archive := appArchive(t, archiveEntry{name: installerEntry, typeflag: tar.TypeSymlink, linkname: "/bin/sh"})
			return archive, archive
		}},
		{name: "not a gzip archive", archive: func(*testing.T, string) ([]byte, []byte) {
			return []byte("plain text"), []byte("plain text")
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			directory := t.TempDir()
			ran := filepath.Join(directory, "ran")
			named, served := tc.archive(t, ran)
			request, _ := releaseServerServing(t, directory, named, served)
			if tc.adjust != nil {
				tc.adjust(&request)
			}

			_, err := ScriptStager{}.Prepare(context.Background(), request)
			expectStageError(t, err, "verify")
			if _, statErr := os.Stat(ran); !os.IsNotExist(statErr) {
				t.Fatal("installer ran from an unverified archive")
			}
		})
	}
}

func TestScriptStagerRunsArchiveInstallerWithReleaseEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX installer uses bash and process group signals")
	}
	directory := t.TempDir()
	record := filepath.Join(directory, "record")
	installer := `{
  printf 'mode=%s\n' "$LINGER_COMPUTER_INSTALL_STAGE_ONLY"
  printf 'root=%s\n' "$LINGER_COMPUTER_DATA_DIR"
  printf 'origin=%s\n' "$LINGER_WEB_URL"
  printf 'app=%s\n' "$LINGER_COMPUTER_APP_SHA256"
  printf 'deps=%s %s\n' "${LINGER_COMPUTER_DEPS_SHA256:-}" "${LINGER_COMPUTER_DEPS_SIZE:-}"
  if [ -n "${LINGER_COMPUTER_APP_ARCHIVE:-}" ]; then
    printf 'archive=%s\n' "$(shasum -a 256 "$LINGER_COMPUTER_APP_ARCHIVE" 2>/dev/null || sha256sum "$LINGER_COMPUTER_APP_ARCHIVE")"
  fi
} >> '` + record + "'\n"
	request, requests := releaseServer(t, directory, installerArchive(t, installer))

	prepared, err := ScriptStager{}.Prepare(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	afterPrepare := requests.Load()
	if err := (ScriptStager{}).Activate(context.Background(), prepared); err != nil {
		t.Fatal(err)
	}
	if n := requests.Load(); n != afterPrepare {
		t.Fatalf("activate made %d HTTP requests, want 0", n-afterPrepare)
	}
	got := readFileString(t, record)
	common := "root=" + directory + "\norigin=" + request.WebOrigin + "\napp=" + request.App.SHA256 + "\n"
	wantPrepare := "mode=prepare\n" + common + "deps=" + request.Deps.SHA256 + " 4096\narchive=" + request.App.SHA256
	if !strings.HasPrefix(got, wantPrepare) {
		t.Fatalf("prepare run = %q, want prefix %q", got, wantPrepare)
	}
	if wantActivate := "mode=activate\n" + common + "deps= \n"; !strings.HasSuffix(got, wantActivate) {
		t.Fatalf("activate run = %q, want suffix %q", got, wantActivate)
	}
}

func TestExtractInstallerIgnoresOtherEntries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.tar.gz")
	archive := appArchive(t,
		archiveEntry{name: "/etc/passwd", typeflag: tar.TypeReg, content: "hostile"},
		archiveEntry{name: "../escape", typeflag: tar.TypeSymlink, linkname: "/"},
		archiveEntry{name: installerEntry, typeflag: tar.TypeReg, content: "echo ok\n"},
	)
	if err := os.WriteFile(path, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	installer, err := extractInstaller(path)
	if err != nil || string(installer) != "echo ok\n" {
		t.Fatalf("installer = %q, %v", installer, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(path), "escape")); !os.IsNotExist(err) {
		t.Fatal("extractInstaller wrote another entry")
	}
}

func TestScriptStagerInterruptsInstallerOnCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX installer uses bash and process group signals")
	}
	directory := t.TempDir()
	restored := filepath.Join(directory, "restored")
	started := filepath.Join(directory, "started")
	script := "trap 'printf restored > \"" + restored + "\"; exit 130' INT\nprintf started > \"" + started + "\"\nwhile :; do sleep 0.05; done\n"
	expectInterruptRunsTrap(t, directory, script, started, restored, 10*time.Second)
}

// The installer usually times out while waiting on a foreground child (curl, a
// Node check); bash defers its trap until that child exits, so the interrupt
// must reach the whole process group.
func TestScriptStagerInterruptsInstallerForegroundChildOnCancel(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX installer uses bash and process group signals")
	}
	directory := t.TempDir()
	restored := filepath.Join(directory, "restored")
	started := filepath.Join(directory, "started")
	script := "trap 'printf restored > \"" + restored + "\"; exit 130' INT\nprintf started > \"" + started + "\"\nsleep 600\n"
	expectInterruptRunsTrap(t, directory, script, started, restored, 10*time.Second)
}

// The first SIGINT can land while bash is spawning a child and be lost. The
// installer ignores INT for a moment to stand in for that race; a later resent
// SIGINT must still run the trap inside interruptGrace.
func TestScriptStagerInterruptsInstallerAfterIgnoredFirstSIGINT(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX installer uses bash and process group signals")
	}
	directory := t.TempDir()
	restored := filepath.Join(directory, "restored")
	started := filepath.Join(directory, "started")
	script := "trap '' INT\nprintf started > \"" + started + "\"\nsleep 1.5\ntrap 'printf restored > \"" + restored + "\"; exit 130' INT\nwhile :; do sleep 0.05; done\n"
	expectInterruptRunsTrap(t, directory, script, started, restored, interruptGrace)
}

func expectInterruptRunsTrap(t *testing.T, directory, script, started, restored string, limit time.Duration) {
	t.Helper()
	request, _ := releaseServer(t, directory, installerArchive(t, script))
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := ScriptStager{}.Prepare(ctx, request)
		done <- err
	}()
	eventually(t, func() bool { _, err := os.Stat(started); return err == nil })
	began := time.Now()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled stage reported success")
		}
	case <-time.After(limit):
		t.Fatal("installer did not stop after interrupt")
	}
	if elapsed := time.Since(began); elapsed >= interruptGrace {
		t.Fatalf("installer exited after grace period: %s", elapsed)
	}
	if got := readFileString(t, restored); got != "restored" {
		t.Fatalf("installer trap did not run: %q", got)
	}
}

func TestTailWriterKeepsLastBytes(t *testing.T) {
	writer := &tailWriter{limit: 4}
	_, _ = writer.Write([]byte("abc"))
	_, _ = writer.Write([]byte("defgh"))
	if got := writer.String(); got != "efgh" {
		t.Fatalf("tail = %q", got)
	}
}
