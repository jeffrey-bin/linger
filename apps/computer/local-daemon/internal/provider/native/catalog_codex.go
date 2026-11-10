package native

import "context"

func codexCatalog(ctx context.Context, inv Invocation) (ModelList, error) {
	version, err := ProbeVersion(ctx, inv)
	if err != nil {
		return ModelList{}, err
	}
	// Ask the CLI for its current selectable catalog, including configured
	// providers, instead of the bundled model inventory.
	return discoverCodexProtocolCatalog(ctx, inv, version)
}
