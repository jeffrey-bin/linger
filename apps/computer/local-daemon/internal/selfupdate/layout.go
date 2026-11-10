// Package selfupdate moves an installed Local Computer Daemon to the build its
// Agent targets. The installer first prepares each build as staged-upgrade
// while the daemon keeps serving, then activates it into a lib-* bundle and
// switches the active-bundle pointer once the daemon is idle.
// This package decides when to ask for each step and how the process hands over
// to the new bundle.
package selfupdate

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	daemonEntry        = "linger-computer-daemon"
	activeBundleFile   = "active-bundle"
	appSHA256File      = "app-sha256"
	webOriginFile      = "web-origin"
	upgradePendingFile = "upgrade-pending"
	upgradeFailedFile  = "upgrade-failed"
	// windowsReleaseIDFile is where the Windows installer records the release
	// identity of the active bundle.
	windowsReleaseIDFile = "installed-checksum"
	serviceCommandEnv    = "LINGER_COMPUTER_SERVICE_COMMAND"
)

var (
	bundlePattern = regexp.MustCompile(`^lib-[0-9A-Za-z._-]+$`)
	digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// layout is the install root that holds lib-* bundles and the root-level
// pointer files. The running daemon must live at <root>/<bundle>/daemon/.
type layout struct {
	root   string
	bundle string
}

func layoutFor(executable string) (layout, error) {
	name := filepath.Base(executable)
	if (name != daemonEntry && name != daemonEntry+".exe") || filepath.Base(filepath.Dir(executable)) != "daemon" {
		return layout{}, errors.New("daemon is not running from an installed bundle")
	}
	bundleDirectory := filepath.Dir(filepath.Dir(executable))
	bundle := filepath.Base(bundleDirectory)
	if !bundlePattern.MatchString(bundle) {
		return layout{}, errors.New("daemon bundle directory is not a lib-* bundle")
	}
	return layout{root: filepath.Dir(bundleDirectory), bundle: bundle}, nil
}

func (l layout) daemonPath(bundle string) string {
	return filepath.Join(l.root, bundle, "daemon", daemonEntry)
}

func (l layout) pendingPath() string {
	return filepath.Join(l.root, upgradePendingFile)
}

// readActiveBundle returns the bundle name the installer last activated.
func (l layout) readActiveBundle() (string, error) {
	content, err := os.ReadFile(filepath.Join(l.root, activeBundleFile))
	if err != nil {
		return "", err
	}
	bundle := strings.TrimSpace(string(content))
	if !bundlePattern.MatchString(bundle) {
		return "", errors.New("active-bundle is not a lib-* bundle name")
	}
	return bundle, nil
}

// readAppSHA256 returns the app archive sha256 the installer recorded in a
// bundle; it is the bundle's release identity.
func (l layout) readAppSHA256(bundle string) (string, error) {
	content, err := os.ReadFile(filepath.Join(l.root, bundle, appSHA256File))
	if err != nil {
		return "", err
	}
	digest := strings.TrimSpace(string(content))
	if !digestPattern.MatchString(digest) {
		return "", errors.New("bundle app-sha256 is not a sha256 digest")
	}
	return digest, nil
}

// readWindowsReleaseID returns the identity the Windows installer recorded in
// installed-checksum for the active bundle, which must be the running one.
func (l layout) readWindowsReleaseID() (string, error) {
	active, err := l.readActiveBundle()
	if err != nil {
		return "", err
	}
	if active != l.bundle {
		return "", errors.New("active-bundle does not name the running daemon's bundle")
	}
	content, err := os.ReadFile(filepath.Join(l.root, windowsReleaseIDFile))
	if err != nil {
		return "", err
	}
	digest := strings.TrimSpace(string(content))
	if !digestPattern.MatchString(digest) {
		return "", errors.New("installed-checksum is not a sha256 digest")
	}
	return digest, nil
}

// windowsReleaseID combines both archive digests the way the Windows
// installer records installed-checksum, so a new dependency archive also
// counts as another build.
func windowsReleaseID(appSHA256, depsSHA256 string) string {
	digest := sha256.Sum256([]byte(depsSHA256 + "\n" + appSHA256))
	return hex.EncodeToString(digest[:])
}

// readWebOrigin returns the Linger Web origin the installer was configured
// with. Upgrades are fetched from it over HTTPS or HTTP.
func (l layout) readWebOrigin() (string, error) {
	content, err := os.ReadFile(filepath.Join(l.root, webOriginFile))
	if err != nil {
		return "", err
	}
	origin := strings.TrimSpace(string(content))
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
		return "", errors.New("web-origin is not an origin")
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", errors.New("web-origin is not an HTTP(S) origin")
	}
	return origin, nil
}

// writeActiveBundle replaces active-bundle atomically, as the installer does.
func (l layout) writeActiveBundle(bundle string) error {
	return writePrivateFile(filepath.Join(l.root, activeBundleFile), []byte(bundle+"\n"))
}

func writePrivateFile(destination string, content []byte) error {
	pending, err := os.CreateTemp(filepath.Dir(destination), "."+filepath.Base(destination)+".*")
	if err != nil {
		return err
	}
	pendingPath := pending.Name()
	defer func() { _ = os.Remove(pendingPath) }()
	if _, err := pending.Write(content); err != nil {
		_ = pending.Close()
		return err
	}
	// Flush before the rename so a power loss cannot leave an empty pointer.
	if err := pending.Sync(); err != nil {
		_ = pending.Close()
		return err
	}
	if err := pending.Close(); err != nil {
		return err
	}
	if err := os.Chmod(pendingPath, 0o600); err != nil {
		return err
	}
	if err := os.Rename(pendingPath, destination); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(destination))
	if err != nil {
		return err
	}
	defer func() { _ = directory.Close() }()
	return directory.Sync()
}

func isExecutableFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Mode().Perm()&0o111 != 0
}

// upgradePending is the marker the installer writes before switching bundles.
// It names the bundle to return to if the new daemon never accepts a welcome;
// the new daemon recognizes itself by its bundle's app-sha256.
type upgradePending struct {
	PreviousBundle  string `json:"previous_bundle"`
	TargetAppSHA256 string `json:"target_app_sha256"`
	CreatedAt       string `json:"created_at"`
	// StartAttempts counts daemon starts of the target release; the daemon
	// maintains it from its first start, before anything else can fail.
	StartAttempts int `json:"start_attempts,omitempty"`
	// ConfirmBy replaces created_at+window once the daemon postponed the
	// deadline because the Gateway was unavailable; it never counts beyond
	// created_at+maxConfirmationWait.
	ConfirmBy string `json:"confirm_by,omitempty"`
}

// deadline is when an unconfirmed upgrade must roll back. It counts from the
// switch, not from the current process start.
func (p *upgradePending) deadline(window time.Duration) time.Time {
	if confirmBy, err := time.Parse(time.RFC3339, p.ConfirmBy); err == nil {
		if limit := p.postponeLimit(); limit.Before(confirmBy) {
			return limit
		}
		return confirmBy
	}
	createdAt, _ := time.Parse(time.RFC3339, p.CreatedAt)
	return createdAt.Add(window)
}

// postponeLimit is the latest deadline an unavailable Gateway can postpone to.
func (p *upgradePending) postponeLimit() time.Time {
	createdAt, _ := time.Parse(time.RFC3339, p.CreatedAt)
	return createdAt.Add(maxConfirmationWait)
}

func (l layout) writePending(marker *upgradePending) error {
	content, err := json.Marshal(marker)
	if err != nil {
		return err
	}
	return writePrivateFile(l.pendingPath(), append(content, '\n'))
}

func (l layout) readPending() (*upgradePending, error) {
	content, err := os.ReadFile(l.pendingPath())
	if err != nil {
		return nil, err
	}
	var marker upgradePending
	if err := json.Unmarshal(content, &marker); err != nil {
		return nil, fmt.Errorf("upgrade-pending is malformed: %w", err)
	}
	if !bundlePattern.MatchString(marker.PreviousBundle) {
		return nil, errors.New("upgrade-pending previous_bundle is invalid")
	}
	if !digestPattern.MatchString(marker.TargetAppSHA256) {
		return nil, errors.New("upgrade-pending target_app_sha256 is invalid")
	}
	if _, err := time.Parse(time.RFC3339, marker.CreatedAt); err != nil {
		return nil, errors.New("upgrade-pending created_at is invalid")
	}
	if marker.StartAttempts < 0 {
		return nil, errors.New("upgrade-pending start_attempts is invalid")
	}
	if _, err := time.Parse(time.RFC3339, marker.ConfirmBy); marker.ConfirmBy != "" && err != nil {
		return nil, errors.New("upgrade-pending confirm_by is invalid")
	}
	return &marker, nil
}

// upgradeFailed records a target whose upgrade was rolled back, so a restarted
// daemon waits out the retry cooldown before staging the same build again.
type upgradeFailed struct {
	AppSHA256 string `json:"app_sha256"`
	FailedAt  string `json:"failed_at"`
}

func (l layout) failedPath() string {
	return filepath.Join(l.root, upgradeFailedFile)
}

func (l layout) readFailed() (*upgradeFailed, error) {
	content, err := os.ReadFile(l.failedPath())
	if err != nil {
		return nil, err
	}
	var record upgradeFailed
	if err := json.Unmarshal(content, &record); err != nil {
		return nil, fmt.Errorf("upgrade-failed is malformed: %w", err)
	}
	if !digestPattern.MatchString(record.AppSHA256) {
		return nil, errors.New("upgrade-failed app_sha256 is invalid")
	}
	if _, err := time.Parse(time.RFC3339, record.FailedAt); err != nil {
		return nil, errors.New("upgrade-failed failed_at is invalid")
	}
	return &record, nil
}

func (l layout) writeFailed(appSHA256 string, failedAt time.Time) error {
	content, err := json.Marshal(upgradeFailed{
		AppSHA256: appSHA256, FailedAt: failedAt.UTC().Format(time.RFC3339),
	})
	if err != nil {
		return err
	}
	return writePrivateFile(l.failedPath(), append(content, '\n'))
}

// serviceCommandFor matches the argv the bundle's CLI binds when it starts
// the Daemon, so CLI-launched Runtime sessions keep it after the switch.
func (l layout) serviceCommandFor(bundle, configPath string) (string, error) {
	encoded, err := json.Marshal([]string{
		filepath.Join(l.root, bundle, "cli", "linger-computer"),
		"--config",
		configPath,
	})
	return string(encoded), err
}

func withEnv(environment []string, key, value string) []string {
	prefix := key + "="
	result := make([]string, 0, len(environment)+1)
	for _, entry := range environment {
		if !strings.HasPrefix(entry, prefix) {
			result = append(result, entry)
		}
	}
	return append(result, prefix+value)
}

// releaseTarget names the release platform the way release.json and the
// installer do.
func releaseTarget(goos, goarch string) (string, error) {
	architecture := map[string]string{"amd64": "x64", "arm64": "arm64"}[goarch]
	platform := map[string]string{"darwin": "darwin", "linux": "linux", "windows": "win32"}[goos]
	if platform == "" || architecture == "" {
		return "", fmt.Errorf("no Computer release for %s/%s", goos, goarch)
	}
	return platform + "-" + architecture, nil
}
