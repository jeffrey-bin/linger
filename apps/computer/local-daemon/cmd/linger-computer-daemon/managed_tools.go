package main

import (
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// The bundled Node adapter owns bootstrap launchers and calls the existing
// installation transaction. Updates never signal or replace this daemon.
func prepareManagedToolsEnvironment(ctx context.Context, environment map[string]string, executable string) (string, error) {
	if strings.TrimSpace(environment["LINGER_CLI_RELEASE_ID"]) == "" {
		return "", nil
	}
	if runtime.GOOS == "windows" {
		return "", errors.New("managed business CLIs currently require Linux or macOS preview")
	}
	bundle := filepath.Clean(filepath.Join(filepath.Dir(executable), ".."))
	probeCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	command := exec.CommandContext(probeCtx, filepath.Join(bundle, "runtime", "bin", "node"), filepath.Join(bundle, "cli", "managed-tools-runtime.mjs"), "prepare")
	for key, value := range environment {
		command.Env = append(command.Env, key+"="+value)
	}
	output, err := command.Output()
	if err != nil {
		return "", errors.New("managed CLI bootstrap failed; check fixed release-id, source and bundled Node")
	}
	var prepared struct {
		BinDirectory string `json:"binDirectory"`
		Path         string `json:"path"`
	}
	if json.Unmarshal(output, &prepared) != nil || !filepath.IsAbs(prepared.BinDirectory) || !strings.HasPrefix(prepared.Path, prepared.BinDirectory+string(filepath.ListSeparator)) {
		return "", errors.New("invalid managed CLI bootstrap response")
	}
	environment["PATH"] = prepared.Path
	return prepared.BinDirectory, nil
}
