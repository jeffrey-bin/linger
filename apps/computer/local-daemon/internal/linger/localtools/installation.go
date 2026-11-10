package localtools

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type Installation struct{ NodePath, PlaywrightEntry, PiExtension, CuaPath string }

func cuaEntry(executable string) string {
	if strings.HasSuffix(executable, ".exe") {
		return "cua/cua-driver.exe"
	}
	return "cua/cua-driver"
}

// Installed resolves only sibling release assets and verifies their frozen
// manifest. An unbundled development daemon has no implicit PATH fallback.
func Installed(executable string) (*Installation, error) {
	root := filepath.Dir(filepath.Dir(executable))
	// An installed bundle links cli/computer-tools to its verified deps
	// directory; the checks below apply to the files it points at.
	tools, err := filepath.EvalSymlinks(filepath.Join(root, "cli", "computer-tools"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(tools, "manifest.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var manifest struct {
		Version    int                                  `json:"schema_version"`
		Versions   struct{ Playwright, Pi, Cua string } `json:"versions"`
		Playwright string                               `json:"playwright_entry"`
		Pi         string                               `json:"pi_extension"`
		Cua        string                               `json:"cua_entry"`
		Assets     []struct {
			Path string `json:"path"`
			Size int64  `json:"size_bytes"`
		} `json:"assets"`
	}
	if json.Unmarshal(data, &manifest) != nil || manifest.Version != 1 || manifest.Versions.Playwright != "0.0.83" || manifest.Versions.Pi != "1.2.0" || manifest.Versions.Cua != "0.35.4" || manifest.Playwright != "node_modules/@playwright/mcp/cli.js" || manifest.Pi != "extensions/pi-mcp.mjs" || (manifest.Cua != "" && manifest.Cua != cuaEntry(executable)) {
		return nil, errors.New("managed Computer tool manifest is invalid")
	}
	seen := map[string]bool{}
	for _, asset := range manifest.Assets {
		if asset.Path == "" || strings.Contains(asset.Path, "\\") || filepath.IsAbs(asset.Path) || filepath.ToSlash(filepath.Clean(asset.Path)) != asset.Path || strings.HasPrefix(asset.Path, "../") || seen[asset.Path] {
			return nil, errors.New("managed Computer tool asset path is invalid")
		}
		seen[asset.Path] = true
		path := filepath.Join(tools, filepath.FromSlash(asset.Path))
		// Release assets are files, not links to another installation.
		for current := path; current != tools; current = filepath.Dir(current) {
			info, e := os.Lstat(current)
			if e != nil || info.Mode()&os.ModeSymlink != 0 {
				return nil, errors.New("managed Computer tool asset is unavailable")
			}
		}
		// The installer verified every asset digest. Reading thousands of
		// files here made antivirus scan each one before the control socket
		// opened, so first setup on Windows outlasted the start timeout.
		info, e := os.Lstat(path)
		if e != nil || !info.Mode().IsRegular() || info.Size() != asset.Size {
			return nil, errors.New("managed Computer tool asset size mismatch")
		}
	}
	for _, entry := range []string{manifest.Playwright, manifest.Pi} {
		if !seen[entry] {
			return nil, errors.New("managed Computer tool entrypoint is missing")
		}
	}
	if err := filepath.WalkDir(tools, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(tools, path)
		if err != nil || entry.Type()&os.ModeSymlink != 0 || (!seen[filepath.ToSlash(relative)] && relative != "manifest.json") {
			return errors.New("managed Computer tools contain an unlisted asset")
		}
		return nil
	}); err != nil {
		return nil, err
	}
	node := filepath.Join(root, "runtime", "bin", "node")
	if strings.HasSuffix(executable, ".exe") {
		node += ".exe"
	}
	if info, e := os.Stat(node); e != nil || !info.Mode().IsRegular() {
		return nil, errors.New("managed Computer tools require the bundled Node runtime")
	}
	installed := &Installation{NodePath: node, PlaywrightEntry: filepath.Join(tools, manifest.Playwright), PiExtension: filepath.Join(tools, manifest.Pi)}
	if manifest.Cua != "" {
		// macOS drives the desktop through the signed application.
		if !seen[manifest.Cua] || (manifest.Cua == "cua/cua-driver" && !seen["cua/CuaDriver.app/Contents/MacOS/cua-driver"]) {
			return nil, errors.New("signed Cua application is missing")
		}
		installed.CuaPath = filepath.Join(tools, manifest.Cua)
	}
	return installed, nil
}
