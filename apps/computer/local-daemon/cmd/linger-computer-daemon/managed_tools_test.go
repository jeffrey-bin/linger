package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestManagedToolsDaemonEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("managed business CLI support starts on Linux")
	}
	root := t.TempDir()
	executable := filepath.Join(root, "daemon", "linger-computer-daemon")
	node := filepath.Join(root, "runtime", "bin", "node")
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf '{\"binDirectory\":\"/managed/current/bin\",\"path\":\"/managed/current/bin:/managed/bootstrap/bin:/user/bin\"}\\n'\n"
	if err := os.WriteFile(node, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"LINGER_CLI_RELEASE_ID": "fixed", "LINGER_CLI_RELEASES_BASE_URL": root, "PATH": "/user/bin"}
	bin, err := prepareManagedToolsEnvironment(context.Background(), env, executable)
	if err != nil {
		t.Fatal(err)
	}
	if bin != "/managed/current/bin" || !strings.HasPrefix(env["PATH"], bin+":") {
		t.Fatalf("managed PATH missing: %v %q", env, bin)
	}
	providerEnv := runtimeProviderEnvironment(env, "", "")
	if providerEnv["PATH"] != env["PATH"] || providerEnv["LINGER_CLI_RELEASE_ID"] != "" {
		t.Fatalf("invalid provider environment: %v", providerEnv)
	}
	legacy := map[string]string{"PATH": "/bin"}
	if bin, err := prepareManagedToolsEnvironment(context.Background(), legacy, executable); err != nil || bin != "" || legacy["PATH"] != "/bin" {
		t.Fatalf("legacy path changed: %v %v", legacy, err)
	}
}
