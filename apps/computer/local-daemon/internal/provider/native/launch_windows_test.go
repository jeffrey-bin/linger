//go:build windows

package native

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestOwnedCommandResolvesNpmShimToNode(t *testing.T) {
	root := filepath.Join(t.TempDir(), "Exécution dossier with spaces")
	npm := filepath.Join(root, "npm")
	script := filepath.Join(npm, "node_modules", "@openai", "codex", "bin", "codex.js")
	nodeDir := filepath.Join(root, "node")
	for _, dir := range []string{filepath.Dir(script), nodeDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	shim := filepath.Join(npm, "codex.cmd")
	node := filepath.Join(nodeDir, "node.exe")
	for path, body := range map[string]string{
		shim:   "@ECHO off\r\n\"%_prog%\"  \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n",
		script: "",
		node:   "",
	} {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	invocation := NewInvocation(shim, nil).WithEnvironment(map[string]string{"PATH": nodeDir})
	cmd := ownedCommand(context.Background(), invocation, "app-server")
	if !strings.EqualFold(cmd.Path, node) {
		t.Fatalf("program = %s, want %s", cmd.Path, node)
	}
	if len(cmd.Args) != 3 || !strings.EqualFold(cmd.Args[1], script) || cmd.Args[2] != "app-server" {
		t.Fatalf("argv = %q", cmd.Args)
	}
	if !reflect.DeepEqual(cmd.Env, invocation.Env) {
		t.Fatalf("env = %q, want %q", cmd.Env, invocation.Env)
	}
}
