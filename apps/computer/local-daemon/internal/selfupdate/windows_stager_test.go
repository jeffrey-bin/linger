package selfupdate

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

type windowsRelease struct {
	request StageRequest
	server  *httptest.Server
}

// serveWindowsRelease serves a rendered installer naming both archives, as
// Agent Service does, and returns the matching request.
func serveWindowsRelease(t *testing.T, edit func(metadata map[string]any)) windowsRelease {
	t.Helper()
	archives := map[string][]byte{"app": []byte("app archive"), "deps": []byte("deps archive")}
	files := map[string]map[string]any{}
	served := map[string][]byte{}
	request := StageRequest{Root: t.TempDir(), Target: "win32-x64"}
	for kind, content := range archives {
		digest := buildSHAOf(content)
		name := kind + "-win32-x64-" + digest + ".tar.gz"
		files[kind] = map[string]any{"file": name, "sha256": digest, "size": len(content)}
		served["/install/files/"+name] = content
		file := protocol.ReleaseFile{SHA256: digest, Size: int64(len(content))}
		if kind == "app" {
			request.App = file
		} else {
			request.Deps = file
		}
	}
	request.ID = windowsReleaseID(request.App.SHA256, request.Deps.SHA256)
	metadata := map[string]any{"targets": map[string]any{"win32-x64": files}}
	if edit != nil {
		edit(metadata)
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		t.Fatal(err)
	}
	served["/install/linger-computer.ps1"] = []byte("$LingerRelease = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
		base64.StdEncoding.EncodeToString(encoded) + "')) | ConvertFrom-Json\n")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		content, ok := served[r.URL.Path]
		if !ok {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write(content)
	}))
	t.Cleanup(server.Close)
	request.WebOrigin = server.URL
	return windowsRelease{request: request, server: server}
}

func buildSHAOf(content []byte) string {
	digest := sha256.Sum256(content)
	return hex.EncodeToString(digest[:])
}

// fakeInstaller runs a real child process that records the installer's inputs.
func fakeInstaller(mode string) func(string) *exec.Cmd {
	return func(installer string) *exec.Cmd {
		executable, err := os.Executable()
		if err != nil {
			panic(err)
		}
		return exec.Command(executable, "-test.run=^TestWindowsInstallerFixture$", "--", mode, installer)
	}
}

func TestWindowsInstallerFixture(t *testing.T) {
	for i, arg := range os.Args {
		if arg != "--" {
			continue
		}
		mode, installer := os.Args[i+1], os.Args[i+2]
		switch mode {
		case "record":
			root := os.Getenv("LINGER_COMPUTER_DATA_DIR")
			downloads := os.Getenv("LINGER_COMPUTER_DOWNLOAD_BASE_URL")
			files, err := os.ReadDir(filepath.Join(downloads, "files"))
			if err != nil {
				os.Exit(4)
			}
			values := []string{installer, root, downloads, os.Getenv("LINGER_WEB_URL")}
			for _, file := range files {
				values = append(values, file.Name())
			}
			if err := os.WriteFile(filepath.Join(root, "seen"), []byte(strings.Join(values, "\n")+"\n"), 0600); err != nil {
				os.Exit(4)
			}
			fmt.Println("rolled back")
			os.Exit(3)
		case "sleep":
			time.Sleep(time.Second)
			os.Exit(0)
		default:
			fmt.Println("already up to date")
			os.Exit(0)
		}
	}
}

func TestWindowsStagerRunsTheRenderedInstallerOnDownloadedFiles(t *testing.T) {
	release := serveWindowsRelease(t, nil)
	stager := WindowsStager{Command: fakeInstaller("record")}
	prepared, err := stager.Prepare(context.Background(), release.request)
	if err != nil {
		t.Fatal(err)
	}
	err = stager.Activate(context.Background(), prepared)
	var stageError *StageError
	if !errors.As(err, &stageError) || stageError.Stage != "install" || stageError.ExitCode != 3 || !strings.Contains(stageError.OutputTail, "rolled back") {
		t.Fatalf("Activate error = %#v", err)
	}
	seen := strings.Split(strings.TrimSpace(readFileString(t, filepath.Join(release.request.Root, "seen"))), "\n")
	if len(seen) != 6 || seen[0] != filepath.Join(prepared.directory, windowsInstallerName) || seen[1] != release.request.Root ||
		seen[2] != prepared.directory || seen[3] != release.request.WebOrigin ||
		!strings.HasPrefix(seen[4], "app-win32-x64-") || !strings.HasPrefix(seen[5], "deps-win32-x64-") {
		t.Fatalf("installer saw %q", seen)
	}
	if _, err := os.Stat(prepared.directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("download directory remains after the installer exited: %v", err)
	}
}

func TestWindowsStagerTreatsAnInstallerThatLeavesTheDaemonRunningAsFailure(t *testing.T) {
	release := serveWindowsRelease(t, nil)
	stager := WindowsStager{Command: fakeInstaller("success")}
	prepared, err := stager.Prepare(context.Background(), release.request)
	if err != nil {
		t.Fatal(err)
	}
	var stageError *StageError
	if err := stager.Activate(context.Background(), prepared); !errors.As(err, &stageError) || stageError.Stage != "activate" {
		t.Fatalf("Activate error = %v", err)
	}
}

func TestWindowsStagerRemovesDownloadsWhenInstallerCannotStart(t *testing.T) {
	release := serveWindowsRelease(t, nil)
	stager := WindowsStager{Command: func(string) *exec.Cmd { return exec.Command(filepath.Join(t.TempDir(), "missing-installer")) }}
	prepared, err := stager.Prepare(context.Background(), release.request)
	if err != nil {
		t.Fatal(err)
	}
	var stageError *StageError
	if err := stager.Activate(context.Background(), prepared); !errors.As(err, &stageError) || stageError.Stage != "activate" {
		t.Fatalf("Activate error = %v", err)
	}
	if _, err := os.Stat(prepared.directory); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("download directory remains after startup failure: %v", err)
	}
}

func TestWindowsStagerLeavesTheInstallerRunningWhenTheDaemonStops(t *testing.T) {
	release := serveWindowsRelease(t, nil)
	stager := WindowsStager{Command: fakeInstaller("sleep")}
	prepared, err := stager.Prepare(context.Background(), release.request)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := stager.Activate(ctx, prepared); !errors.Is(err, context.Canceled) {
		t.Fatalf("Activate error = %v, want context.Canceled", err)
	}
	if _, err := os.Stat(prepared.directory); err != nil {
		t.Fatalf("the running installer's files were removed: %v", err)
	}
}

func TestWindowsStagerRejectsAnInstallerForAnotherRelease(t *testing.T) {
	cases := map[string]func(metadata map[string]any){
		"other app": func(metadata map[string]any) {
			metadata["targets"].(map[string]any)["win32-x64"].(map[string]map[string]any)["app"]["sha256"] = buildSHA("other")
		},
		"no target": func(metadata map[string]any) { metadata["targets"] = map[string]any{} },
		"renamed archive": func(metadata map[string]any) {
			metadata["targets"].(map[string]any)["win32-x64"].(map[string]map[string]any)["deps"]["file"] = "../deps.tar.gz"
		},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			release := serveWindowsRelease(t, edit)
			_, err := WindowsStager{Command: fakeInstaller("success")}.Prepare(context.Background(), release.request)
			var stageError *StageError
			if !errors.As(err, &stageError) || stageError.Stage != "verify" {
				t.Fatalf("Prepare error = %v, want verify", err)
			}
			entries, _ := os.ReadDir(release.request.Root)
			if len(entries) != 0 {
				t.Fatalf("Prepare left %d entries in the install root", len(entries))
			}
		})
	}
}
