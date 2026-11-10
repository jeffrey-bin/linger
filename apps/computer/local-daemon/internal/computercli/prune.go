package computercli

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

// pruneTarget is the managed local enrollment beside a config file.
type pruneTarget struct {
	configPath         string
	dataRoot           string
	setupRevisionsPath string
	stateDirectory     string
}

func inspectPruneTarget(configPath string) (pruneTarget, error) {
	dataRoot := filepath.Dir(configPath)
	if err := checkOwnedDirectory(dataRoot, "Local Computer data directory"); err != nil {
		return pruneTarget{}, err
	}
	stateDirectory, err := loadStateDirectory(configPath)
	if err != nil {
		return pruneTarget{}, err
	}
	if stateDirectory != filepath.Join(dataRoot, "state") {
		return pruneTarget{}, newError(categoryConfiguration, "Local Computer state directory is outside the managed enrollment location")
	}
	target := pruneTarget{configPath: configPath, dataRoot: dataRoot, setupRevisionsPath: filepath.Join(dataRoot, "setup-revisions"), stateDirectory: stateDirectory}
	return target, target.checkOptionalDirectories()
}

func (t pruneTarget) checkOptionalDirectories() error {
	if err := checkOptionalOwnedDirectory(t.stateDirectory, "Local Computer state directory"); err != nil {
		return err
	}
	return checkOptionalOwnedDirectory(t.setupRevisionsPath, "Local Computer credential directory")
}

// prune removes the local enrollment. The configuration goes first: a prune
// that fails halfway must not leave a Computer that still looks enrolled but
// has lost its credentials.
func (t pruneTarget) prune() error {
	if err := checkOwnedDirectory(t.dataRoot, "Local Computer data directory"); err != nil {
		return err
	}
	if err := t.checkOptionalDirectories(); err != nil {
		return err
	}
	if err := os.Remove(t.configPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := removeSealedTree(t.stateDirectory); err != nil {
		return explainInUse(err)
	}
	return explainInUse(removeSealedTree(t.setupRevisionsPath))
}

// explainInUse names the cause of a removal that another program blocks.
func explainInUse(err error) error {
	if err != nil && fileInUse(err) {
		return wrapError(categoryConfiguration, "Close the program that has this file open, then retry: "+err.Error(), err)
	}
	return err
}

// setupPreservedEntries survive an account replacement: the setup lock held
// by the running setup and the shared workspaces.
var setupPreservedEntries = map[string]bool{setupLockName: true, "workspaces": true}

// pruneDuringSetup removes the previous enrollment while a replacement setup
// holds the setup lock. A program the user left open on a file inside a state
// directory, such as an editor an Agent opened in a Context workspace, must
// not block the new enrollment: Windows refuses to delete or rename that tree
// while the handle is open, so it stays in place and its path is returned. The
// rest of the tree is gone and nothing in the new enrollment names it. Files
// directly in the state directory are the stores the Daemon opens at startup
// and must still be removed.
func (t pruneTarget) pruneDuringSetup() ([]string, error) {
	if err := checkOwnedDirectory(t.dataRoot, "Local Computer data directory"); err != nil {
		return nil, err
	}
	if err := t.checkOptionalDirectories(); err != nil {
		return nil, err
	}
	if err := os.Remove(t.configPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	if err := removeSealedTree(t.setupRevisionsPath); err != nil {
		return nil, explainInUse(err)
	}
	entries, err := os.ReadDir(t.stateDirectory)
	if err != nil {
		return nil, err
	}
	var leftovers []string
	for _, entry := range entries {
		if setupPreservedEntries[entry.Name()] {
			continue
		}
		path := filepath.Join(t.stateDirectory, entry.Name())
		if err := removeSealedTree(path); err != nil {
			if entry.IsDir() && fileInUse(err) {
				leftovers = append(leftovers, path)
				continue
			}
			return nil, explainInUse(err)
		}
	}
	return leftovers, nil
}

// removeSealedTree reopens read-only Context projection directories before
// removing them: unlinking needs write permission on the containing directory.
func removeSealedTree(target string) error {
	err := filepath.WalkDir(target, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if !entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().Perm()&0o300 != 0o300 {
			return os.Chmod(path, 0o700) //nolint:gosec // owner-only directory mode before removal
		}
		return nil
	})
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.RemoveAll(target)
}

func checkOptionalOwnedDirectory(directory, label string) error {
	if err := checkOwnedDirectory(directory, label); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func checkOwnedDirectory(directory, label string) error {
	if _, err := os.Lstat(directory); errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := privatefs.CheckPath(directory, "directory", true); err != nil {
		return wrapError(categoryConfiguration, label+" is unsafe", err)
	}
	return nil
}
