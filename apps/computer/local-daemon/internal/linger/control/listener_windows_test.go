//go:build windows

package control

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Microsoft/go-winio"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

func localHTTPClient(path string) *http.Client {
	return &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return winio.DialPipeContext(ctx, path) }}}
}
func TestPipeNameNormalizesCaseAndSeparators(t *testing.T) {
	nonce := "00000000-0000-4000-8000-000000000001"
	first, err := pipePath(`C:\Users\Alice\AppData\Local\Computer`, nonce)
	if err != nil {
		t.Fatal(err)
	}
	second, err := pipePath(`c:/users/alice/appdata/local/computer`, nonce)
	if err != nil || first != second {
		t.Fatalf("pipe paths=%q,%q err=%v", first, second, err)
	}
	if !strings.HasPrefix(first, `\\.\pipe\linger-computer-`) {
		t.Fatalf("pipe=%q", first)
	}
	restarted, err := pipePath(`C:\Users\Alice\AppData\Local\Computer`, "00000000-0000-4000-8000-000000000002")
	if err != nil || restarted == first {
		t.Fatalf("instance nonce did not isolate pipe: %v", err)
	}
}
func TestSecondServerCannotClaimExistingPipe(t *testing.T) {
	dir := controlTestDirectory(t)
	first, _ := New(dir, &fakeController{})
	if err := first.Start(); err != nil {
		t.Fatal(err)
	}
	defer first.Close(context.Background())
	second, _ := New(dir, &fakeController{})
	if err := second.Start(); err == nil {
		second.Close(context.Background())
		t.Fatal("second listener claimed live pipe")
	}
}

func TestNativeClientAuthenticatesPipeBeforeSendingHTTP(t *testing.T) {
	dir := controlTestDirectory(t)
	controller := &fakeController{}
	server, err := New(dir, controller)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	defer server.Close(context.Background())
	result, err := Call(context.Background(), dir, "GET", "/status", nil)
	if err != nil || result.Status != 200 || !controller.called.Load() {
		t.Fatalf("authenticated request: result=%v err=%v", result, err)
	}
	filename := filepath.Join(dir, "daemon.lock", "owner.json")
	original, err := privatefs.ReadFile(filename, 1024*1024)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := privatefs.WriteFile(filename, original, false); err != nil {
			t.Error(err)
		}
	}()
	for _, mismatch := range []string{"process", "generation"} {
		t.Run(mismatch, func(t *testing.T) {
			var owner controlOwner
			if err := json.Unmarshal(original, &owner); err != nil {
				t.Fatal(err)
			}
			if mismatch == "process" {
				owner.PID = 4
				owner.ProcessGroupID = 4
			} else {
				owner.StartTime = "windows:1"
			}
			encoded, _ := json.Marshal(owner)
			if err := privatefs.WriteFile(filename, encoded, false); err != nil {
				t.Fatal(err)
			}
			controller.called.Store(false)
			if _, err := Call(context.Background(), dir, "GET", "/status", nil); err == nil {
				t.Fatal("unrelated pipe accepted")
			}
			if controller.called.Load() {
				t.Fatal("HTTP sent before server identity was verified")
			}
		})
	}
}

func TestNativeClientDoesNotCreateIdentityWhenStopped(t *testing.T) {
	if _, err := Call(context.Background(), t.TempDir(), "GET", "/status", nil); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("err=%v, want a missing Daemon", err)
	}
}
