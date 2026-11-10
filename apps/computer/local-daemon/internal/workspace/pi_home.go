package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// PiSourceEnvironment preserves one real auth.json path across Contexts, so
// Pi's native API-key/OAuth resolution and refresh locks remain authoritative.
func PiSourceEnvironment(environment map[string]string) (map[string]string, error) {
	result := make(map[string]string, len(environment)+1)
	for key, value := range environment {
		if strings.HasPrefix(strings.ToUpper(key), "TEAMHUB_") && key != "TEAMHUB_CONFIG" && key != "TEAMHUB_PROFILE" {
			continue
		}
		result[key] = value
	}
	root := strings.TrimSpace(result["PI_CODING_AGENT_DIR"])
	if root == "" {
		if result["HOME"] == "" {
			return nil, errors.New("Pi source directory requires Computer user HOME")
		}
		root = filepath.Join(result["HOME"], ".pi", "agent")
	}
	if !filepath.IsAbs(root) {
		return nil, errors.New("Pi source directory must be absolute")
	}
	// Resolve existing aliases once; never create per-Context auth symlinks.
	if canonical, err := filepath.EvalSymlinks(root); err == nil {
		root = canonical
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	result["PI_CODING_AGENT_DIR"] = filepath.Clean(root)
	return result, nil
}

// PiConfigDigest identifies the user's Pi settings.json and models.json in
// the agent directory PiSourceEnvironment chose. The Daemon reads them once
// while it prepares an Operation, so a parked Pi serves later Operations until
// the user's own edit changes them; auth.json is never read or moved.
func PiConfigDigest(environment map[string]string) (string, error) {
	dir := environment["PI_CODING_AGENT_DIR"]
	if dir == "" {
		return "", errors.New("Pi source directory is unavailable")
	}
	sum := sha256.New()
	for _, name := range []string{"settings.json", "models.json"} {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return "", fmt.Errorf("Pi settings could not be read: %w", err)
		}
		// Length-prefixed records keep adjacent files from blurring.
		for _, value := range []string{name, string(data)} {
			var size [8]byte
			binary.BigEndian.PutUint64(size[:], uint64(len(value)))
			sum.Write(size[:])
			sum.Write([]byte(value))
		}
	}
	return hex.EncodeToString(sum.Sum(nil)), nil
}

func PreparePiRuntimeHome(ctx context.Context, root string, identity RuntimeHomeIdentity) (*RuntimeHome, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if identity.ProviderType != "pi" {
		return nil, errors.New("Pi Runtime home identity is invalid")
	}
	home, err := claimRuntimeHome(root, identity)
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(home.Path, "sessions"), 0o700); err != nil {
		_ = home.Close()
		return nil, err
	}
	return home, nil
}
