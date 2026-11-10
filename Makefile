.PHONY: contracts-generate contracts-verify computer-release-local source-archive source-dependencies
.PHONY: check-teamhub-cli check-installer check-desktop
.PHONY: check check-heavy-lane check-web
.PHONY: check-computer check-computer-release check-node-services check-voice-runtime
.PHONY: check-teamhub check-teamhub-tooling check-teamhub-integration
.PHONY: check-teamhub-integration-process check-teamhub-integration-migrations
.PHONY: check-contracts check-packages check-scripts check-scripts-fast check-scripts-heavy check-docs check-repository check-repository-gate
.PHONY: check-web-build check-node-services-build check-build check-voice-runtime-build
.PHONY: check-release-cache-core check-release-cache
.PHONY: check-container-web check-container-node-services check-container-other check-containers
.PHONY: check-e2e-room-document check-e2e check-all

OAPI_CODEGEN_VERSION := v2.7.1
OAPI_CODEGEN_COMMAND ?= go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION)
BASE ?=
SCRIPT_TEST_FILTER ?= %
SCRIPT_PROCESS_TEST_FILTER ?= $(SCRIPT_TEST_FILTER)
SCRIPT_INSTALLER_TEST := scripts/local-computer-installer.test.ts
SCRIPT_COMPUTER_RELEASE_TEST := scripts/prepare-local-computer-release.test.ts
COMPUTER_TEST_RUNNER := bash "$(CURDIR)/apps/computer/run-test.sh"
# Reviewed readers/private mkdtemp fixtures, no shared ports or process state.
SCRIPT_ISOLATED_PROCESS_TESTS := scripts/local-runner-smoke-entrypoints.test.ts
# New scripts/ci tests join the process group and must use private temp dirs
# and listen(0) ports.
SCRIPT_FAST_PROCESS_TESTS := $(filter-out $(SCRIPT_ISOLATED_PROCESS_TESTS),$(wildcard scripts/ci/*.test.ts)) \
	scripts/managed-tools-install.test.ts \
	scripts/managed-tools-runtime.test.ts \
	scripts/local-env.test.ts \
	scripts/computer-test-isolation.test.ts \
	scripts/check-web.test.ts \
	scripts/development-workflow.test.ts
SCRIPT_HEAVY_OTHER_TESTS := \
	scripts/local-computer-windows-installer.test.ts \
	scripts/local-computer-windows-native.test.ts \
	$(SCRIPT_COMPUTER_RELEASE_TEST)
SCRIPT_HEAVY_TESTS := $(SCRIPT_INSTALLER_TEST) $(SCRIPT_HEAVY_OTHER_TESTS)
SCRIPT_FAST_PARALLEL_TESTS := $(filter-out $(SCRIPT_HEAVY_TESTS) $(SCRIPT_FAST_PROCESS_TESTS) $(SCRIPT_ISOLATED_PROCESS_TESTS),$(wildcard scripts/*.test.ts))
# Fast files that spawn child processes get the process timeout budget; the rest keep the 5s default.
# Guarded because a bare grep reads stdin when a foreign-root make finds no test files.
SCRIPT_FAST_SPAWN_TESTS = $(if $(SCRIPT_FAST_PARALLEL_TESTS),$(shell grep -l child_process $(SCRIPT_FAST_PARALLEL_TESTS) 2>/dev/null))
SCRIPT_FAST_PURE_TESTS = $(filter-out $(SCRIPT_FAST_SPAWN_TESTS),$(SCRIPT_FAST_PARALLEL_TESTS))

# Every fast check. Integration, build, container, E2E and the heavy script
# tests stay separate targets. The light checks run CHECK_JOBS at a time beside
# one lane that runs the heavy test suites one after another: their timed tests
# fail when they share the CPU. BASE reaches the built-in Skill immutability
# check inside check-teamhub.
FAST_CHECKS := check-repository check-docs check-contracts check-packages \
	check-voice-runtime check-teamhub-cli check-installer check-desktop \
	check-teamhub check-teamhub-tooling check-scripts-fast
HEAVY_CHECKS := check-web check-node-services check-computer
CHECK_JOBS ?= 4
# GNU Make 3.81 (macOS) has no --output-sync.
OUTPUT_SYNC := $(if $(filter 3.%,$(MAKE_VERSION)),,--output-sync=target)

check:
	@test -n "$(strip $(BASE))" || { echo "Usage: make check BASE=<target-ref>" >&2; exit 2; }
	$(MAKE) -j$(CHECK_JOBS) $(OUTPUT_SYNC) $(FAST_CHECKS) check-heavy-lane

check-heavy-lane:
	$(MAKE) -j1 $(HEAVY_CHECKS)

check-repository:
	pnpm format:check
	pnpm lint
	pnpm env:inventory:check

# React Doctor compares against BASE. Without one it scans the whole repository,
# which exceeds its lint budget on CI runners and fails. A push that creates a
# branch reports the all-zero commit, which is not a ref.
DOCTOR_BASE = $(if $(filter-out 0000000000000000000000000000000000000000,$(BASE)),--base '$(BASE)')

check-web:
	pnpm exec concurrently --success all --names types,lint,tests,doctor \
		"pnpm --filter @linger/web typecheck" \
		"pnpm --filter @linger/web lint" \
		"pnpm --filter @linger/web test" \
		"pnpm react:doctor $(DOCTOR_BASE)"

check-node-services:
	pnpm --filter @linger/node-services check

check-computer:
	pnpm --filter @linger/computer typecheck
	pnpm --filter @linger/computer lint
	$(COMPUTER_TEST_RUNNER) pnpm --filter @linger/computer test
	$(MAKE) -C apps/teamhub lint-go-daemon
	cd apps/computer/local-daemon && go test ./... -run '^$$'
	cd apps/computer/local-daemon && $(COMPUTER_TEST_RUNNER) go test ./internal/platform/...
	cd apps/computer/local-daemon && $(COMPUTER_TEST_RUNNER) go test ./cmd/linger-computer-daemon ./cmd/linger-computer-launcher ./internal/computercli ./internal/computerconfig ./internal/daemon ./internal/linger/context ./internal/linger/assignment ./internal/linger/control ./internal/linger/registration ./internal/linger/localskills ./internal/linger/mcpproxy ./internal/linger/transport ./internal/linger/runtimehistory ./internal/linger/localtools ./internal/process ./internal/workspace ./internal/provider ./internal/provider/redact ./internal/permission
	cd apps/computer/local-daemon && $(COMPUTER_TEST_RUNNER) go test ./internal/provider/native
	LINGER_GO_LOCAL_DAEMON_TEST=1 $(COMPUTER_TEST_RUNNER) pnpm --filter @linger/node-services exec vitest run --project agent tests/agent/runner-gateway/go-local-daemon-process.test.ts --maxWorkers=2

check-teamhub-cli:
	pnpm --filter @linger/teamhub-cli typecheck
	pnpm --filter @linger/teamhub-cli lint
	pnpm --filter @linger/teamhub-cli test
	pnpm --filter @linger/teamhub-cli build

check-installer:
	pnpm --filter @linger/local-installation --filter @linger/linger-installer typecheck
	pnpm --filter @linger/local-installation --filter @linger/linger-installer lint
	pnpm --workspace-concurrency=1 --filter @linger/local-installation --filter @linger/linger-installer test

check-desktop:
	pnpm --filter @linger/desktop typecheck
	pnpm --filter @linger/desktop lint
	pnpm --filter @linger/desktop test
	# The Go daemon that packaging bundles, for every platform the app ships on.
	cd apps/desktop && node scripts/build-daemon.mjs --all

check-computer-release:
	pnpm vitest run --no-file-parallelism $(SCRIPT_COMPUTER_RELEASE_TEST)

check-voice-runtime:
	pnpm --filter @linger/voice-runtime check

check-teamhub:
	$(MAKE) -C apps/teamhub check-code sqlc-verify

check-teamhub-tooling:
	$(MAKE) -C apps/teamhub test-scripts

check-teamhub-integration:
	$(MAKE) -C apps/teamhub test-integration

check-teamhub-integration-process:
	$(MAKE) -C apps/teamhub test-integration-process

check-teamhub-integration-migrations:
	$(MAKE) -C apps/teamhub test-integration-migrations

check-contracts:
	$(MAKE) contracts-verify
	pnpm --filter @linger/wire-contracts typecheck
	pnpm exec vitest run --config contracts/vitest.config.ts --no-file-parallelism
	cd contracts/generated/go && go test ./...

check-packages:
	pnpm --filter './packages/*' exec node -e 'const p = require("./package.json"); for (const gate of ["typecheck", "lint", "test"]) { if (!p.scripts?.[gate]) { console.error(`Package $${p.name ?? process.cwd()} must define scripts.$${gate}`); process.exitCode = 1; } }'
	pnpm --filter './packages/*' typecheck
	pnpm --filter './packages/*' lint
	pnpm --workspace-concurrency=1 --filter './packages/*' test

check-scripts:
	$(MAKE) check-scripts-fast
	$(MAKE) check-scripts-heavy

check-scripts-fast:
ifneq ($(strip $(filter $(SCRIPT_TEST_FILTER),$(SCRIPT_FAST_PURE_TESTS))),)
	pnpm vitest run --maxWorkers="$${SCRIPT_TEST_FAST_WORKERS:-4}" $(filter $(SCRIPT_TEST_FILTER),$(SCRIPT_FAST_PURE_TESTS))
endif
ifneq ($(strip $(filter $(SCRIPT_TEST_FILTER),$(SCRIPT_FAST_SPAWN_TESTS))),)
	pnpm vitest run --maxWorkers="$${SCRIPT_TEST_FAST_WORKERS:-4}" --testTimeout="$${SCRIPT_TEST_PROCESS_TIMEOUT_MS:-30000}" $(filter $(SCRIPT_TEST_FILTER),$(SCRIPT_FAST_SPAWN_TESTS))
endif
ifneq ($(strip $(filter $(SCRIPT_PROCESS_TEST_FILTER),$(SCRIPT_ISOLATED_PROCESS_TESTS))),)
	pnpm vitest run --maxWorkers="$${SCRIPT_TEST_ISOLATED_WORKERS:-2}" --testTimeout="$${SCRIPT_TEST_PROCESS_TIMEOUT_MS:-30000}" $(filter $(SCRIPT_PROCESS_TEST_FILTER),$(SCRIPT_ISOLATED_PROCESS_TESTS))
endif
ifneq ($(strip $(filter $(SCRIPT_PROCESS_TEST_FILTER),$(SCRIPT_FAST_PROCESS_TESTS))),)
	pnpm vitest run --maxWorkers="$${SCRIPT_TEST_PROCESS_WORKERS:-1}" --testTimeout="$${SCRIPT_TEST_PROCESS_TIMEOUT_MS:-30000}" $(filter $(SCRIPT_PROCESS_TEST_FILTER),$(SCRIPT_FAST_PROCESS_TESTS))
endif

check-scripts-heavy:
	pnpm vitest run --no-file-parallelism --maxConcurrency="$${SCRIPT_TEST_INSTALLER_CONCURRENCY:-2}" $(SCRIPT_INSTALLER_TEST)
	pnpm vitest run --maxWorkers="$${SCRIPT_TEST_HEAVY_WORKERS:-2}" $(SCRIPT_HEAVY_OTHER_TESTS)

check-docs:
	node scripts/check-doc-links.mjs

check-repository-gate:
	@test -n "$(strip $(BASE))" || { echo "Usage: make check-repository-gate BASE=<target-ref>" >&2; exit 2; }
	BASE="$(BASE)" scripts/ci/check-repository-gate.sh

check-web-build:
	pnpm --filter @linger/web test:build
	pnpm --filter @linger/web run build:assets

check-node-services-build:
	pnpm --filter @linger/node-services build

check-voice-runtime-build:
	pnpm --filter @linger/voice-runtime build

check-build:
	pnpm build

check-release-cache-core:
	pnpm release-lockfiles:check
	pnpm exec vitest run --testTimeout="$${SCRIPT_TEST_PROCESS_TIMEOUT_MS:-15000}" scripts/release-lockfiles.test.ts scripts/local-computer-node-distributions.test.ts scripts/prepare-local-computer-release.test.ts scripts/development-workflow.test.ts

check-release-cache: check-release-cache-core check-container-web check-container-node-services

check-container-web:
	docker buildx build --check -f apps/web/Dockerfile .

check-container-node-services:
	docker buildx build --check -f apps/node-services/Dockerfile .


check-container-other:
	docker buildx build --check -f apps/teamhub/Dockerfile .
	LOCAL_ENV_FILE=.env.example docker compose config --quiet
	docker compose -f apps/teamhub/deployments/compose/docker-compose.yml config --quiet
	TEAMHUB_TEST_CONTAINER_NAME=teamhub-test-config-postgres \
	TEAMHUB_TEST_NETWORK_NAME=teamhub-test-config-network \
	TEAMHUB_TEST_RUN_TOKEN=teamhub-test-config \
		docker compose -f apps/teamhub/deployments/compose/docker-compose.test.yml config --quiet

check-containers: check-container-web check-container-node-services check-container-other

check-e2e-room-document:
	@if [ -z "$${ROOM_DOCUMENT_E2E_SHARD:-}" ] || [ "$${ROOM_DOCUMENT_E2E_SHARD%%/*}" = "1" ]; then \
		pnpm test:e2e:config; \
	fi
	pnpm test:e2e:room-document

check-e2e:
	pnpm test:e2e:config
	pnpm test:e2e:room-document

check-all:
	pnpm format:check
	pnpm typecheck
	pnpm lint
	pnpm react:doctor
	pnpm build
	pnpm test
	$(MAKE) -C apps/teamhub check
	$(MAKE) check-docs
	$(MAKE) check-teamhub-integration
	$(MAKE) check-containers
	pnpm test:e2e

# The host's Computer release for `pnpm dev`, served by the Agent Service on
# /install/. COMPUTER_RELEASE_TARGETS selects other targets.
computer-release-local:
	COMPUTER_RELEASE_TARGETS="$${COMPUTER_RELEASE_TARGETS:-$$(node -p 'process.platform + "-" + process.arch')}" \
		node scripts/prepare-local-computer-release.mjs --output .linger-runtime/computer-release

# The linger source package that desktop builds download for "Run on This
# Computer". SOURCE_ARCHIVE_REF picks the tag; SOURCE_ARCHIVE_URL_BASE is where
# the release hosts it, recorded in source-archive.json for the desktop build.
source-archive:
	node scripts/prepare-source-archive.mjs --ref "$${SOURCE_ARCHIVE_REF:-HEAD}" \
		$${SOURCE_ARCHIVE_URL_BASE:+--url-base "$$SOURCE_ARCHIVE_URL_BASE"}

# The dependency store published beside that package for one platform, so
# the desktop installs its packages without a registry. Build it on the
# platform it serves (SOURCE_DEPENDENCIES_TARGET, the host by default) to
# include compiled native modules; source-dependencies-<target>.json records
# it for that platform's desktop build.
source-dependencies:
	node scripts/prepare-source-dependencies.mjs --ref "$${SOURCE_ARCHIVE_REF:-HEAD}" \
		$${SOURCE_DEPENDENCIES_TARGET:+--target "$$SOURCE_DEPENDENCIES_TARGET"} \
		$${SOURCE_ARCHIVE_URL_BASE:+--url-base "$$SOURCE_ARCHIVE_URL_BASE"}

contracts-generate:
	OAPI_CODEGEN_COMMAND='$(OAPI_CODEGEN_COMMAND)' pnpm exec tsx contracts/codegen/contracts.ts generate

contracts-verify:
	OAPI_CODEGEN_COMMAND='$(OAPI_CODEGEN_COMMAND)' pnpm exec tsx contracts/codegen/contracts.ts verify
