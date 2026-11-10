package workspace

import (
	"context"
	"maps"
	"os"
	"path/filepath"
)

// CodexProbeEnvironment keeps diagnostic state outside the selected source home.
// The caller releases the private home after its owned subprocesses have stopped.
// A probe that lists models passes the peers its models cache is seeded from;
// nil seeds nothing.
func CodexProbeEnvironment(ctx context.Context, environment map[string]string, version string, modelsCache *CodexModelsCachePeers) (map[string]string, func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	source, err := CodexSourceHome(environment)
	if err != nil {
		return nil, nil, err
	}
	root, err := os.MkdirTemp("", "linger-codex-probe-")
	if err != nil {
		return nil, nil, err
	}
	release := func() { _ = os.RemoveAll(root) }
	home := filepath.Join(root, ".codex")
	// Introspection starts no turn, so execution-only sandbox overrides are unused.
	if _, err := PrepareCodexHome(home, CodexHomeOptions{
		SharedHome: source, UserHome: environment["HOME"], CodexVersion: version, ModelsCache: modelsCache,
	}, nil); err != nil {
		release()
		return nil, nil, err
	}
	if err := ctx.Err(); err != nil {
		release()
		return nil, nil, err
	}
	prepared := maps.Clone(environment)
	prepared["CODEX_HOME"] = home
	return prepared, release, nil
}
