ARG NODE_IMAGE=node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb

FROM ${NODE_IMAGE} AS dependency-manifests

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# better-sqlite3 compiles against the image's own Node headers.
ENV npm_config_nodedir=/usr/local
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.7.0 --registry="$NPM_REGISTRY" \
    && npm config set registry "$NPM_REGISTRY" --location=user \
    && npm config set @openai:registry https://registry.npmjs.org --location=user

WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# The root prepare script installs Git hooks: the build context has no Git
# checkout, and the production install omits husky.
RUN npm pkg delete scripts.prepare
COPY patches ./patches
COPY contracts/generated/typescript/package.json ./contracts/generated/typescript/package.json
COPY packages/document-files/package.json ./packages/document-files/package.json
COPY packages/document-model/package.json ./packages/document-model/package.json
COPY packages/knowledge-format/package.json ./packages/knowledge-format/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json
COPY apps/node-services/package.json ./apps/node-services/package.json
COPY apps/voice-runtime/package.json ./apps/voice-runtime/package.json
# The Agent tests' development dependency; only its manifest and bin entry.
COPY apps/teamhub-cli/package.json ./apps/teamhub-cli/package.json
COPY apps/teamhub-cli/bin ./apps/teamhub-cli/bin

FROM dependency-manifests AS dependencies
RUN --mount=type=cache,id=pnpm-store-node-services-node26.5.0-pnpm11.7.0-linux-amd64,sharing=locked,target=/pnpm/store \
    pnpm install --filter @linger/node-services... --frozen-lockfile --trust-lockfile \
    --store-dir /pnpm/store --fetch-retries 5 --fetch-timeout 1800000

FROM dependency-manifests AS production-dependencies
RUN --mount=type=cache,id=pnpm-store-node-services-node26.5.0-pnpm11.7.0-linux-amd64,sharing=locked,target=/pnpm/store \
    pnpm install --filter @linger/node-services... --prod --frozen-lockfile --trust-lockfile \
    --store-dir /pnpm/store --fetch-retries 5 --fetch-timeout 1800000

FROM dependencies AS release-dependencies
# Include the production install in the immutable dependency cache before main publishes.
COPY --from=production-dependencies /app/node_modules/.modules.yaml /release-dependencies/production-node-modules.yaml

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY contracts/generated/typescript/tsconfig.json contracts/generated/typescript/tsconfig.build.json ./contracts/generated/typescript/
COPY contracts/generated/typescript/src ./contracts/generated/typescript/src
COPY packages/document-files/tsconfig.json packages/document-files/tsconfig.build.json ./packages/document-files/
COPY packages/document-files/src ./packages/document-files/src
COPY packages/document-model/tsconfig.json packages/document-model/tsconfig.build.json ./packages/document-model/
COPY packages/document-model/src ./packages/document-model/src
COPY packages/knowledge-format/tsconfig.json packages/knowledge-format/tsconfig.build.json ./packages/knowledge-format/
COPY packages/knowledge-format/src ./packages/knowledge-format/src
COPY packages/service-kit/tsconfig.json packages/service-kit/tsconfig.build.json ./packages/service-kit/
COPY packages/service-kit/src ./packages/service-kit/src
COPY apps/node-services/tsconfig.json apps/node-services/tsconfig.build.json ./apps/node-services/
COPY apps/node-services/src ./apps/node-services/src
COPY apps/voice-runtime/tsconfig.json apps/voice-runtime/tsconfig.build.json ./apps/voice-runtime/
COPY apps/voice-runtime/src ./apps/voice-runtime/src
COPY apps/node-services/scripts/generate-feature-catalog.ts ./apps/node-services/scripts/generate-feature-catalog.ts
RUN pnpm --filter @linger/wire-contracts build \
    && pnpm --filter @linger/document-files build \
    && pnpm --filter @linger/document-model build \
    && pnpm --filter @linger/knowledge-format build \
    && pnpm --filter @linger/service-kit build \
    && pnpm --filter @linger/voice-runtime build \
    && pnpm --filter @linger/node-services build

# The Computer release this image serves on /install/: macOS and
# Linux targets built from this same commit. Its install uses the pruned
# apps/node-services/release-lockfiles/computer.yaml rather than the root
# lockfile so a root lock change outside the Computer closure keeps these
# stages, including the multi-target Go builds and Node runtime archives,
# cached.
FROM ${NODE_IMAGE} AS computer-dependencies

ARG NPM_REGISTRY=https://registry.npmjs.org
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN npm install --global pnpm@11.7.0 --registry="$NPM_REGISTRY" \
    && npm config set registry "$NPM_REGISTRY" --location=user

WORKDIR /app
COPY apps/node-services/release-lockfiles/package.json ./package.json
COPY pnpm-workspace.yaml ./
COPY apps/node-services/release-lockfiles/computer.yaml ./pnpm-lock.yaml
COPY patches ./patches
COPY contracts/generated/typescript/package.json ./contracts/generated/typescript/package.json
COPY packages/document-files/package.json ./packages/document-files/package.json
COPY packages/service-kit/package.json ./packages/service-kit/package.json
COPY apps/computer/package.json ./apps/computer/package.json
COPY apps/teamhub-cli/package.json ./apps/teamhub-cli/package.json
RUN --mount=type=cache,id=pnpm-store-computer-node26.5.0-pnpm11.7.0-linux-amd64,sharing=locked,target=/pnpm/store \
    pnpm install --filter @linger/computer... --filter @linger/teamhub-cli... --frozen-lockfile --trust-lockfile \
    --store-dir /pnpm/store --fetch-retries 5 --fetch-timeout 1800000

# Only the dependency inputs: pinned Node distributions, tool versions and
# their lockfile, and the Cua driver pins. The archives are reproducible, and
# their fixed mtimes keep the COPY --link layer digest stable across uncached
# builds.
FROM computer-dependencies AS computer-deps
ARG COMPUTER_RELEASE_TARGETS=darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64
COPY scripts/local-computer-node-distributions.mjs scripts/managed-tools-runtime-files.mjs scripts/prepare-local-computer-release.mjs scripts/publish-windows-installers.mjs ./scripts/
COPY apps/computer/scripts/bundle-computer-tools.mjs ./apps/computer/scripts/
COPY apps/computer/tools ./apps/computer/tools
RUN --mount=type=cache,id=computer-release-downloads,target=/root/.cache \
    LINGER_COMPUTER_NODE_DISTRIBUTION_CACHE=/root/.cache/node-distributions \
    COMPUTER_RELEASE_TARGETS="$COMPUTER_RELEASE_TARGETS" \
    node scripts/prepare-local-computer-release.mjs --part deps --output /out \
    && find /out -exec touch -h -d 2000-01-01T00:00:00Z {} +

FROM computer-dependencies AS computer-app
ARG COMPUTER_RELEASE_TARGETS=darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64
COPY --from=golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd /usr/local/go /usr/local/go
# The slim Node image has no CA bundle; Go module downloads need one.
COPY --from=golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV PATH="/usr/local/go/bin:$PATH"
COPY apps/computer/local-daemon/go.mod apps/computer/local-daemon/go.sum ./apps/computer/local-daemon/
COPY contracts/generated/go/runnergateway ./contracts/generated/go/runnergateway
RUN --mount=type=cache,id=computer-go-modules,target=/root/go/pkg/mod \
    cd apps/computer/local-daemon && for attempt in 1 2 3 4 5; do \
        go mod download && exit 0; \
        sleep $((attempt * 5)); \
    done; \
    exit 1
COPY tsconfig.base.json ./
COPY contracts/generated/typescript ./contracts/generated/typescript
COPY packages/document-files ./packages/document-files
COPY packages/service-kit ./packages/service-kit
COPY apps/teamhub-cli ./apps/teamhub-cli
COPY apps/computer ./apps/computer
COPY scripts/local-computer-node-distributions.mjs scripts/managed-tools-*.mjs scripts/prepare-local-computer-release.mjs scripts/install-linger-computer.sh scripts/uninstall-linger-computer.sh scripts/publish-windows-installers.mjs scripts/local-computer-windows-installer.mjs scripts/local-computer-windows-bootstrap.ps1 scripts/install-linger-computer.ps1 scripts/uninstall-linger-computer.ps1 ./scripts/
COPY --from=computer-deps /out/files /deps/files
RUN --mount=type=cache,id=computer-go-modules,target=/root/go/pkg/mod \
    --mount=type=cache,id=computer-go-build,target=/root/.cache/go-build \
    COMPUTER_RELEASE_TARGETS="$COMPUTER_RELEASE_TARGETS" \
    node scripts/prepare-local-computer-release.mjs --part app --deps /deps --output /out

FROM ${NODE_IMAGE} AS node-services

RUN apt-get update && apt-get install --yes --no-install-recommends ca-certificates ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Dependency archives first: this layer changes only with dependency pins.
COPY --link --from=computer-deps /out/files/ /app/computer-release/files/
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=production-dependencies /app/apps/node-services/node_modules ./apps/node-services/node_modules
COPY --from=production-dependencies /app/apps/voice-runtime/node_modules ./apps/voice-runtime/node_modules
COPY --from=build /app/apps/voice-runtime/package.json ./apps/voice-runtime/package.json
COPY --from=build /app/apps/voice-runtime/dist ./apps/voice-runtime/dist
COPY --from=production-dependencies /app/contracts/generated/typescript/node_modules ./contracts/generated/typescript/node_modules
COPY --from=production-dependencies /app/packages/document-files/node_modules ./packages/document-files/node_modules
COPY --from=production-dependencies /app/packages/document-model/node_modules ./packages/document-model/node_modules
COPY --from=production-dependencies /app/packages/knowledge-format/node_modules ./packages/knowledge-format/node_modules
COPY --from=build /app/contracts/generated/typescript/package.json ./contracts/generated/typescript/package.json
COPY --from=build /app/contracts/generated/typescript/dist ./contracts/generated/typescript/dist
COPY --from=build /app/packages/document-files/package.json ./packages/document-files/package.json
COPY --from=build /app/packages/document-files/dist ./packages/document-files/dist
COPY --from=build /app/packages/document-model/package.json ./packages/document-model/package.json
COPY --from=build /app/packages/document-model/dist ./packages/document-model/dist
COPY --from=build /app/packages/knowledge-format/package.json ./packages/knowledge-format/package.json
COPY --from=build /app/packages/knowledge-format/dist ./packages/knowledge-format/dist
COPY --from=build /app/packages/service-kit/package.json ./packages/service-kit/package.json
COPY --from=build /app/packages/service-kit/dist ./packages/service-kit/dist
COPY --from=build /app/apps/node-services/package.json ./apps/node-services/package.json
COPY --from=build /app/apps/node-services/dist ./apps/node-services/dist
COPY apps/node-services/prompts ./apps/node-services/prompts
COPY --from=computer-app /out/ /app/computer-release/
RUN mkdir -p /data/agent \
    && chown -R node:node /data/agent \
    && chmod -R a+rX /app/apps/node-services/prompts

ENV NODE_ENV=production
# glibc otherwise gives each Node and native-addon thread its own malloc arena,
# and arenas keep freed memory resident.
ENV MALLOC_ARENA_MAX=2
# Agent state, the Memory projections and LLM Wiki checkpoints under it share
# one volume.
ENV AGENT_HOME=/data/agent/mirror
ENV NODE_SERVICES_HTTP_ADDRESS=0.0.0.0:4319
ENV DOCUMENT_RUNTIME_HTTP_ADDRESS=0.0.0.0:4321

USER node
# Read every packaged prompt as the runtime user before accepting the image.
RUN node --input-type=module -e \
    "import { readdir, readFile } from 'node:fs/promises'; async function check(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = directory + '/' + entry.name; if (entry.isDirectory()) await check(path); else await readFile(path); } } await check('./apps/node-services/prompts')"
# Check the production workspace links of every role without dev dependencies.
RUN node --conditions=linger-production --input-type=module -e \
    "await import('./apps/node-services/dist/agent/main.js'); await import('./apps/node-services/dist/memory/main.js'); await import('./apps/node-services/dist/llm-wiki/service.js'); await import('./apps/node-services/dist/document/realtime.js'); await import('./apps/node-services/dist/document/app.js')"

ARG SOURCE_COMMIT=dev
ENV APP_VERSION=$SOURCE_COMMIT
# One listener serves the Agent Service, Memory and LLM Wiki; the Document
# Runtime keeps its own port on its worker thread.
EXPOSE 4319 4321
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "Promise.all([4319, 4321].map((port) => fetch('http://127.0.0.1:' + port + '/healthz'))).then((responses) => { if (responses.some((response) => !response.ok)) process.exit(1); }).catch(() => process.exit(1))"
CMD ["node", "--conditions=linger-production", "apps/node-services/dist/main.js"]
