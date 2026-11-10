#!/usr/bin/env bash
set -euo pipefail
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
output_file="${1:?Standalone runtime output is required}"
# Web owns the bundler dependency used by its standalone static host.
cd "$repository_root"
pnpm --filter @linger/web exec esbuild "$repository_root/apps/web/static-host.mjs" \
  --bundle --platform=node --format=esm --target=node26 \
  --outfile="$output_file"
