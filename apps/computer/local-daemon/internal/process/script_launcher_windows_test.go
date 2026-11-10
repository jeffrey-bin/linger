//go:build windows

package process

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// runArgvFixture echoes argv and stdin when TestMain runs the test binary as
// a script-launcher child.
func runArgvFixture() {
	input, _ := io.ReadAll(os.Stdin)
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"args": os.Args[1:], "stdin": string(input)})
	os.Exit(0)
}

func TestNativeNpmEntryPreservesArgvAndStdin(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Café npm path")
	script := filepath.Join(root, "node_modules", "@openai", "codex", "bin", "codex.js")
	if err := os.MkdirAll(filepath.Dir(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, []byte("// intercepted by fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "node.exe"), contents, 0o700); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(root, "codex.cmd")
	if err := os.WriteFile(shim, []byte("@exit /b 99"), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"with space", `quotes "inside"`, "Café déjà vu\nsecond line", `C:\trailing\`, "%PATH% & ^ ! (test)", ""}
	cmd := exec.Command(shim, args...)
	cmd.Env = append(os.Environ(), "LINGER_ARGV_FIXTURE=1")
	cmd.Stdin = strings.NewReader("Größe JSON\n")
	prepareScriptLauncher(cmd)
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Args  []string `json:"args"`
		Stdin string   `json:"stdin"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("output=%s: %v", output, err)
	}
	expected := append([]string{script}, args...)
	if !reflect.DeepEqual(result.Args, expected) || result.Stdin != "Größe JSON\n" {
		t.Fatalf("result=%+v", result)
	}
}
func TestPowerShellScriptPreservesArguments(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Café ps script")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "fixture.ps1")
	source := `[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($args)))`
	if err := os.WriteFile(script, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"with space", `quotes "inside"`, "Café déjà vu\nsecond line", `C:\trailing\`, "%PATH% & ^ ! (test)", ""}
	cmd := exec.Command(script, args...)
	prepareScriptLauncher(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	var got []string
	if err := json.Unmarshal(output, &got); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	if !reflect.DeepEqual(got, args) {
		t.Fatalf("argv=%q want=%q", got, args)
	}
}

func TestNativePnpmClaudeEntryPreservesArgvAndStdin(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Café pnpm")
	native := filepath.Join(root, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
	shim := filepath.Join(root, "node_modules", ".bin", "claude.cmd")
	for _, directory := range []string{filepath.Dir(native), filepath.Dir(shim)} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	contents, err := os.ReadFile(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(native, contents, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(shim, []byte("@exit /b 99"), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"with space", `quotes "inside"`, "Café déjà vu\nsecond line", ""}
	cmd := exec.Command(shim, args...)
	cmd.Env = append(os.Environ(), "LINGER_ARGV_FIXTURE=1")
	cmd.Stdin = strings.NewReader("Résumé JSON\n")
	prepareScriptLauncher(cmd)
	output, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Args  []string `json:"args"`
		Stdin string   `json:"stdin"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Args, args) || result.Stdin != "Résumé JSON\n" {
		t.Fatalf("result=%+v", result)
	}
}
func TestBatchLauncherDoesNotExpandMetacharacterArguments(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Café batch path")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "fixture.cmd")
	source := `@"` + os.Args[0] + `" %*` + "\r\n"
	if err := os.WriteFile(script, []byte(source), 0o600); err != nil {
		t.Fatal(err)
	}
	args := []string{"with space", `quotes "inside"`, `C:\trailing\`, "%PATH% & ^ ! (test)", ""}
	cmd := exec.Command(script, args...)
	cmd.Env = append(os.Environ(), "LINGER_ARGV_FIXTURE=1")
	prepareScriptLauncher(cmd)
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	var result struct {
		Args []string `json:"args"`
	}
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("%v: %s", err, output)
	}
	if !reflect.DeepEqual(result.Args, args) {
		t.Fatalf("argv=%q want=%q", result.Args, args)
	}
}
