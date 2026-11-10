.PHONY: install generate sqlc-verify fmt fmt-check static lint-go lint-go-daemon test test-race test-scripts check-builtin-skill-immutability test-integration test-integration-process test-integration-migrations test-db-up test-db-down test-reliability build-windows dev-migrate dev watch e2e-identity vulncheck check-code check-generated check verify

LOCAL_ENV_FILE ?= .env
export LOCAL_ENV_FILE
NODE_ENV_RUNNER := node ../../scripts/with-local-env.mjs --
# The launcher resolves LOCAL_ENV_FILE from the repository root before Compose
# reads it; preserve checkout-specific project names and caller overrides.
TEAMHUB_TEST_POSTGRES_PORT ?= 0
RELIABILITY_COUNT ?= 3

# Keep tool targets relative to this Makefile's working directory. GNU Make
# cannot parse an absolute target path when the repository path contains spaces.
TOOLS_BIN := .tools/bin
GO_TOOLCHAIN_VERSION := $(shell go env GOVERSION)
GOLANGCI_LINT_VERSION := v2.8.0
GOVULNCHECK_VERSION := v1.1.4
SQLC_VERSION := v1.29.0
GOLANGCI_LINT ?= $(TOOLS_BIN)/golangci-lint-$(GOLANGCI_LINT_VERSION)-$(GO_TOOLCHAIN_VERSION)
GOVULNCHECK ?= $(TOOLS_BIN)/govulncheck-$(GOVULNCHECK_VERSION)-$(GO_TOOLCHAIN_VERSION)

RELIABILITY_TESTS := Test(RoomEventCatchupAndSSE|SSEClosesWhenSessionExpires|SSEClosesWhenSessionIsRevoked|SSEClosesDuringApplicationShutdown)

install:
	pnpm -C ../.. install

generate:
	$(MAKE) -C ../.. contracts-generate
	SQLC_VERSION=$(SQLC_VERSION) SQLC_BIN='$(SQLC_BIN)' ./scripts/verify-generated.sh --write

sqlc-verify:
	SQLC_VERSION=$(SQLC_VERSION) SQLC_BIN='$(SQLC_BIN)' ./scripts/verify-generated.sh

fmt:
	gofmt -w cmd internal tests ../../skills

fmt-check:
	@unformatted="$$(gofmt -l cmd internal tests ../../skills)"; \
	if [ -n "$$unformatted" ]; then \
		echo "The following Go files are not gofmt-formatted:"; \
		printf '%s\n' "$$unformatted"; \
		exit 1; \
	fi

static:
	go vet ./...
	cd ../../skills && go vet ./...

# A private GOBIN per install: parallel root make check targets may install at once.
$(GOLANGCI_LINT):
	mkdir -p $(TOOLS_BIN)
	gobin=$$(mktemp -d '$(abspath $(TOOLS_BIN))/install.XXXXXX') && \
		GOTOOLCHAIN=$(GO_TOOLCHAIN_VERSION) GOBIN="$$gobin" go install github.com/golangci/golangci-lint/v2/cmd/golangci-lint@$(GOLANGCI_LINT_VERSION) && \
		mv "$$gobin/golangci-lint" $@ && rmdir "$$gobin"

# Root make check lints TeamHub and the Daemon in parallel; golangci-lint
# otherwise refuses a second concurrent run.
GOLANGCI_RUN = '$(abspath $(GOLANGCI_LINT))' run --allow-parallel-runners

# With BASE set, doc comments are also required on declarations changed since BASE.
DOC_COMMENTS_LINT = $(if $(strip $(BASE)),$(GOLANGCI_RUN) --config '$(abspath .golangci.doc-comments.yml)' --new-from-rev='$(BASE)' ./...)

lint-go: $(GOLANGCI_LINT)
	$(GOLANGCI_RUN) ./...
	$(DOC_COMMENTS_LINT)

# The Local Computer Daemon is a separate Go module that shares the repository
# .golangci.yml and this pinned binary.
lint-go-daemon: $(GOLANGCI_LINT)
	cd ../computer/local-daemon && $(GOLANGCI_RUN) ./...
	$(if $(strip $(BASE)),cd ../computer/local-daemon && $(DOC_COMMENTS_LINT))

# Integration packages (tests/integration/...) run in test-integration.
test:
	TEST_DATABASE_URL= go test $$(go list ./... | grep -v '/tests/integration')
	cd ../../skills && go test ./...

test-race:
	TEST_DATABASE_URL= go test -race ./...

test-scripts:
	bash ./scripts/test-migration-history.sh
	bash ./scripts/test-builtin-skill-immutability.sh
	./scripts/test-with-test-database.sh
	./scripts/test-make-targets.sh

# pnpm dev migrates the PostgreSQL that TEAMHUB_DATABASE_URL names; the
# developer runs that database.
dev-migrate:
	$(NODE_ENV_RUNNER) go run ./cmd/migrate

dev: dev-migrate watch

watch:
	$(NODE_ENV_RUNNER) go run github.com/air-verse/air@v1.67.3 -c .air.toml

e2e-identity:
	$(NODE_ENV_RUNNER) go run ./cmd/demo-seed e2e-identity

# CI and local runs use this same plain go test command. PARALLEL overrides the
# default -parallel (GOMAXPROCS); GO_TEST_FLAGS adds flags such as -json.
test-integration:
	go test ./tests/integration/layout -count=1
	./scripts/with-test-database.sh go test ./tests/integration/... -count=1 -timeout 15m $(if $(PARALLEL),-parallel $(PARALLEL)) $(GO_TEST_FLAGS)

# Names of the top-level tests in files whose build line is exactly //go:build $(1).
# -run pins them, because the untagged default suite compiles with the same tag set.
tagged_test_pattern = $$(grep -lx '//go:build $(1)' tests/integration/*_test.go | xargs grep -ho '^func Test[A-Za-z0-9_]*' | sed 's/^func //' | paste -sd'|' -)

test-integration-process:
	./scripts/with-test-database.sh go test -tags=integration_process ./tests/integration -count=1 -timeout 15m -run "^($(call tagged_test_pattern,integration_process))$$"

test-integration-migrations:
	./scripts/with-test-database.sh go test -tags=integration_migration_history ./tests/integration -count=1 -timeout 15m -run "^($(call tagged_test_pattern,integration_migration_history))$$"

# Optional shared PostgreSQL for repeated local runs; per-run databases stay isolated.
test-db-up:
	./scripts/shared-test-database.sh up

test-db-down:
	./scripts/shared-test-database.sh down

test-reliability:
	go test ./internal/realtime -count=$(RELIABILITY_COUNT)
	TEAMHUB_TEST_POSTGRES_PORT='$(TEAMHUB_TEST_POSTGRES_PORT)' TEST_DATABASE_URL='$(TEST_DATABASE_URL)' ./scripts/with-test-database.sh go test ./tests/integration -count=$(RELIABILITY_COUNT) -run '$(RELIABILITY_TESTS)' -v

smoke-agent-compose:
	./scripts/smoke-agent-compose.sh


$(GOVULNCHECK):
	mkdir -p $(TOOLS_BIN)
	GOTOOLCHAIN=$(GO_TOOLCHAIN_VERSION) GOBIN='$(abspath $(TOOLS_BIN))' go install golang.org/x/vuln/cmd/govulncheck@$(GOVULNCHECK_VERSION)
	mv $(TOOLS_BIN)/govulncheck $@

vulncheck: $(GOVULNCHECK)
	$(GOVULNCHECK) ./...

# make check passes its diff base as BASE; the Skill check compares against it.
check-builtin-skill-immutability:
	BUILTIN_SKILL_BASE_REF="$${BUILTIN_SKILL_BASE_REF:-$(BASE)}" ./scripts/check-builtin-skill-immutability.sh

# Native installs on Windows compile these commands on the user's machine.
build-windows:
	GOOS=windows GOARCH=amd64 go build -o /dev/null ./cmd/teamhub ./cmd/migrate ./cmd/account

check-code: check-builtin-skill-immutability fmt-check lint-go test build-windows

check-generated: sqlc-verify
	$(MAKE) -C ../.. contracts-verify

check: check-code test-scripts check-generated

verify: check test-race test-integration test-reliability vulncheck
