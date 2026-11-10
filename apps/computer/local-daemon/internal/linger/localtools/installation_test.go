package localtools

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestInstalledToolsRejectCorruptOrRedirectedAssets(t *testing.T) {
	root := t.TempDir()
	toolRoot := filepath.Join(root, "cli", "computer-tools")
	entries := []string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs"}
	assets := []map[string]any{}
	for _, name := range entries {
		p := filepath.Join(toolRoot, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		body := []byte("fixture")
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(body)
		assets = append(assets, map[string]any{"path": name, "size_bytes": len(body), "sha256": hex.EncodeToString(sum[:])})
	}
	node := filepath.Join(root, "runtime", "bin", "node")
	_ = os.MkdirAll(filepath.Dir(node), 0o700)
	_ = os.WriteFile(node, []byte("fixture"), 0o700)
	manifest := map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.2.0", "cua": "0.35.4"}, "playwright_entry": entries[0], "pi_extension": entries[1], "assets": assets}
	write := func() {
		t.Helper()
		data, _ := json.Marshal(manifest)
		if err := os.WriteFile(filepath.Join(toolRoot, "manifest.json"), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write()
	executable := filepath.Join(root, "daemon", "linger-computer-daemon")
	if result, err := Installed(executable); err != nil || result == nil || result.NodePath != node {
		t.Fatalf("valid installation: %+v %v", result, err)
	}
	asset := filepath.Join(toolRoot, entries[0])
	_ = os.WriteFile(asset, []byte("truncated or replaced"), 0o600)
	if _, err := Installed(executable); err == nil {
		t.Fatal("corrupt tool accepted")
	}
	_ = os.Remove(asset)
	if err := os.Symlink(node, asset); err == nil {
		if _, err := Installed(executable); err == nil {
			t.Fatal("redirected tool accepted")
		}
		_ = os.Remove(asset)
	}
	_ = os.WriteFile(asset, []byte("fixture"), 0o600)
	extra := filepath.Join(toolRoot, "node_modules", "unexpected.js")
	_ = os.WriteFile(extra, []byte("unlisted"), 0o600)
	if _, err := Installed(executable); err == nil {
		t.Fatal("unlisted tool asset accepted")
	}
	_ = os.Remove(extra)
	assets[0]["path"] = "../escape"
	write()
	if _, err := Installed(executable); err == nil {
		t.Fatal("asset escaped its release directory")
	}
}

// The installer links the bundle's runtime and cli/computer-tools to its
// deps-<sha16> directory; those links are the installed layout, not redirects.
func TestInstalledToolsFollowTheBundleDepsLinks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the Windows installer extracts dependencies into the bundle")
	}
	root := t.TempDir()
	deps := filepath.Join(root, "deps-0123456789abcdef")
	bundle := filepath.Join(root, "lib-fedcba9876543210-1")
	entries := []string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs"}
	assets := []map[string]any{}
	for _, name := range entries {
		p := filepath.Join(deps, "computer-tools", name)
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256([]byte("fixture"))
		assets = append(assets, map[string]any{"path": name, "size_bytes": 7, "sha256": hex.EncodeToString(sum[:])})
	}
	data, _ := json.Marshal(map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.2.0", "cua": "0.35.4"}, "playwright_entry": entries[0], "pi_extension": entries[1], "assets": assets})
	if err := os.WriteFile(filepath.Join(deps, "computer-tools", "manifest.json"), data, 0o600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(deps, "runtime", "bin", "node")
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(bundle, "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../deps-0123456789abcdef/runtime", filepath.Join(bundle, "runtime")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("../../deps-0123456789abcdef/computer-tools", filepath.Join(bundle, "cli", "computer-tools")); err != nil {
		t.Fatal(err)
	}
	result, err := Installed(filepath.Join(bundle, "daemon", "linger-computer-daemon"))
	if err != nil || result == nil {
		t.Fatalf("linked installation: %+v %v", result, err)
	}
}

func TestWindowsInstalledToolsUseExtractedBundle(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows bundle layout")
	}
	root := t.TempDir()
	tools := filepath.Join(root, "cli", "computer-tools")
	entries := []string{"node_modules/@playwright/mcp/cli.js", "extensions/pi-mcp.mjs"}
	assets := make([]map[string]any, 0, len(entries))
	for _, name := range entries {
		file := filepath.Join(tools, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte("fixture"), 0o600); err != nil {
			t.Fatal(err)
		}
		assets = append(assets, map[string]any{"path": name, "size_bytes": 7})
	}
	manifest, err := json.Marshal(map[string]any{"schema_version": 1, "versions": map[string]string{"playwright": "0.0.83", "pi": "1.2.0", "cua": "0.35.4"}, "playwright_entry": entries[0], "pi_extension": entries[1], "assets": assets})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tools, "manifest.json"), manifest, 0o600); err != nil {
		t.Fatal(err)
	}
	node := filepath.Join(root, "runtime", "bin", "node.exe")
	if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(node, []byte("fixture"), 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "daemon", "linger-computer-daemon.exe")
	result, err := Installed(executable)
	if err != nil || result == nil || result.NodePath != node {
		t.Fatalf("extracted installation: %+v %v", result, err)
	}
	if err := os.WriteFile(filepath.Join(tools, "unexpected.js"), []byte("unlisted"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Installed(executable); err == nil {
		t.Fatal("unlisted tool asset accepted")
	}
}
