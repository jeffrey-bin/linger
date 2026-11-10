package workspace

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"time"
)

// claudeAuthCheckHomes bounds one authentication check. Every Operation
// reconciles its own home before Claude starts, so an idle home left out here
// still runs with current credentials; checking only the most recently used
// homes keeps the check's cost independent of how many Contexts exist.
const claudeAuthCheckHomes = 4

// Visit the most recently used idle managed homes under the same lease as an
// Operation, once per distinct credential an Operation there would see. Never
// alter credentials under a running Claude process or follow a foreign
// directory link: retireResident stops a home's parked process first, and a
// home whose process cannot be confirmed gone is skipped like a claimed one.
func VisitClaudeAuthEnvironments(ctx context.Context, root string, environment map[string]string, retireResident func(home string) error, visit func(map[string]string) error) error {
	if root == "" {
		return nil
	}
	providerRoot := filepath.Join(root, "claude")
	entries, err := os.ReadDir(providerRoot)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	type candidate struct {
		home   string
		usedAt time.Time
	}
	var candidates []candidate
	for _, entry := range entries {
		if !entry.IsDir() || len(entry.Name()) != 64 {
			continue
		}
		if _, err := hex.DecodeString(entry.Name()); err != nil {
			continue
		}
		homeInfo, err := entry.Info()
		if err != nil {
			return err
		}
		homePath := filepath.Join(providerRoot, entry.Name())
		info, err := os.Lstat(filepath.Join(homePath, ".claude"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("Claude configuration must be a managed directory")
		}
		candidates = append(candidates, candidate{home: homePath, usedAt: homeInfo.ModTime()})
	}
	slices.SortFunc(candidates, func(left, right candidate) int { return right.usedAt.Compare(left.usedAt) })
	seen := make(map[[sha256.Size]byte]struct{})
	checked := 0
	for _, next := range candidates {
		if checked == claudeAuthCheckHomes {
			return nil
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		homePath := next.home
		configRoot := filepath.Join(homePath, ".claude")
		err := func() error {
			claudeAuthCheckMu.Lock()
			defer claudeAuthCheckMu.Unlock()
			home, err := claimRuntimeHomePath(homePath)
			if errors.Is(err, ErrRuntimeHomeInUse) {
				return nil
			}
			if err != nil {
				return err
			}
			defer home.Close()
			prepared := make(map[string]string, len(environment)+1)
			for name, value := range environment {
				prepared[name] = value
			}
			err = configureClaudeCredentials(configRoot, prepared, func() error {
				if retireResident(homePath) != nil {
					return ErrRuntimeHomeInUse
				}
				return nil
			})
			if errors.Is(err, ErrRuntimeHomeInUse) {
				return nil
			}
			if err != nil {
				return err
			}
			checked++
			// After reconciliation the file holds the credential Claude reads
			// there, and the rest of the environment is shared by every home.
			credential, err := os.ReadFile(filepath.Join(configRoot, ".credentials.json"))
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
			fingerprint := sha256.Sum256(credential)
			if _, duplicate := seen[fingerprint]; duplicate {
				return nil
			}
			seen[fingerprint] = struct{}{}
			return visit(prepared)
		}()
		if err != nil {
			return err
		}
	}
	return nil
}
