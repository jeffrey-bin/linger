//go:build darwin

package workspace

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os/exec"
	"os/user"
	"path/filepath"
	"time"
)

func claudeKeychainService(configRoot string) string {
	service := "Claude Code-credentials"
	if configRoot != "" {
		absolute, _ := filepath.Abs(configRoot)
		digest := sha256.Sum256([]byte(absolute))
		service += "-" + hex.EncodeToString(digest[:4])
	}
	return service
}

func runClaudeKeychain(action, configRoot string) ([]byte, error) {
	account, err := user.Current()
	if err != nil {
		return nil, errors.New("Claude Keychain account could not be resolved")
	}
	args := []string{action, "-a", account.Username, "-s", claudeKeychainService(configRoot)}
	if action == "find-generic-password" {
		args = append(args, "-w")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "security", args...).Output()
	var exit *exec.ExitError
	if errors.As(err, &exit) && exit.ExitCode() == 44 {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("Claude Keychain credential could not be accessed")
	}
	return bytes.TrimSpace(output), nil
}

func readClaudeKeychain(configRoot string) ([]byte, error) {
	return runClaudeKeychain("find-generic-password", configRoot)
}

func removeClaudeKeychain(configRoot string) error {
	if configRoot == "" {
		return errors.New("refusing to remove the Host Claude login")
	}
	_, err := runClaudeKeychain("delete-generic-password", configRoot)
	return err
}
