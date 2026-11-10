//go:build windows

package native

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// A pi.ps1 launcher must pass the stdin/stdout protocol through unchanged
// under every installed PowerShell host.
func TestPiPowerShellLauncherKeepsPromptExact(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	prompt := "Café \"quoted\" 'single'\nsecond line --data=literal & 100% done"
	ran := 0
	for _, host := range []string{"pwsh.exe", "powershell.exe"} {
		path, err := exec.LookPath(host)
		if err != nil {
			continue
		}
		ran++
		t.Run(host, func(t *testing.T) {
			base := t.TempDir()
			script := filepath.Join(base, "pi.ps1")
			if err := os.WriteFile(script, []byte("& $env:PI_FAKE_PROGRAM @args\r\nexit $LASTEXITCODE\r\n"), 0o600); err != nil {
				t.Fatal(err)
			}
			record := filepath.Join(base, "prompt")
			contextDir := filepath.Join(base, "context")
			if err := os.MkdirAll(contextDir, 0o700); err != nil {
				t.Fatal(err)
			}
			env := map[string]string{
				piFakeEnv: "finish", "PI_FAKE_PROGRAM": program, piFakeRecordEnv: record,
				piSessionRootKey: filepath.Join(base, "sessions"),
				// The Daemon passes its own Windows environment, which always has
				// PATHEXT. Windows PowerShell runs `& <file>.exe` as a console
				// application only when .EXE is in PATHEXT; otherwise it opens the
				// file through the shell, detached from the RPC pipes.
				"PATH": filepath.Dir(path), "SystemRoot": os.Getenv("SystemRoot"), "PATHEXT": os.Getenv("PATHEXT"),
			}
			runtime, _ := Open("pi", Profile{Program: script, Env: env})
			run, err := runtime.Start(t.Context(), prompt, RunSpec{Dir: contextDir})
			if err != nil {
				t.Fatal(err)
			}
			_, outcome := piCollect(t, run)
			if outcome.Status != statusCompleted {
				t.Fatalf("outcome = %+v", outcome)
			}
			got, err := os.ReadFile(record)
			if err != nil || string(got) != prompt {
				t.Fatalf("prompt = %q, %v", got, err)
			}
		})
	}
	if ran == 0 {
		t.Skip("no PowerShell host is installed")
	}
}
