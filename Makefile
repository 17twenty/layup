.DEFAULT_GOAL := help
SHELL := /bin/bash

CONTROL_DIR := services/control
# Every Go module in go.work. `go <cmd> ./...` is per-module, so we iterate.
GO_MODULES := $(patsubst ./%/go.mod,%,$(shell find . -name go.mod -not -path './node_modules/*' -not -path './*/node_modules/*'))

.PHONY: help
help: ## Show available developer commands
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: bootstrap
bootstrap: ## Install pinned JS dependencies
	npm ci || npm install

.PHONY: dev
dev: ## Run the desktop app against a local control service
	npm run dev

.PHONY: dev-control
dev-control: ## Run the Go control service
	cd $(CONTROL_DIR) && go run ./cmd/control

.PHONY: build
build: build-js build-go ## Build every component

.PHONY: build-js
build-js: ## Build the protocol binding and desktop bundles
	npm run build

.PHONY: build-go
build-go: ## Build every Go module in the workspace
	@for m in $(GO_MODULES); do echo "==> build $$m"; (cd $$m && go build ./...) || exit 1; done

.PHONY: typecheck
typecheck: ## Typecheck TypeScript workspaces
	npm run typecheck

.PHONY: lint
lint: lint-js lint-go ## Lint every component

.PHONY: lint-js
lint-js: ## Lint TypeScript workspaces
	npm run lint

.PHONY: lint-go
lint-go: ## Vet every Go module in the workspace
	@for m in $(GO_MODULES); do echo "==> vet $$m"; (cd $$m && go vet ./...) || exit 1; done

.PHONY: test
test: test-js test-go ## Run every component test suite

.PHONY: test-js
test-js: ## Run TypeScript unit tests
	npm test

.PHONY: test-go
test-go: ## Run Go tests
	@for m in $(GO_MODULES); do echo "==> test $$m"; (cd $$m && go test ./...) || exit 1; done

.PHONY: test-boundary
test-boundary: build-js ## Prove the Electron renderer boundary in a real window
	npm run test:boundary --workspace apps/desktop

.PHONY: test-smoke
test-smoke: ## Desktop control client against a real Go control service
	npm run test:smoke --workspace apps/desktop

.PHONY: bench
bench: ## Run every benchmark scenario and write result JSON
	node test/latency/run.mjs

.PHONY: test-bench
test-bench: ## Unit-test the benchmark harness itself
	node --test test/latency/harness.test.mjs

.PHONY: test-e2e
test-e2e: ## End-to-end tests against a real control service (wire contract only)
	node --test test/e2e/*.test.mjs

.PHONY: fmt-check
fmt-check: ## Fail if any Go file needs gofmt
	@unformatted="$$(gofmt -l $(GO_MODULES))"; \
	if [ -n "$$unformatted" ]; then echo "gofmt needed for:"; echo "$$unformatted"; exit 1; fi

.PHONY: ci
ci: validate-tasks fmt-check typecheck lint test test-bench build ## Everything CI runs, locally

.PHONY: check
check: typecheck lint test build ## Full local gate: typecheck, lint, test, build

.PHONY: tasks
tasks: ## Show the next eligible Ralph task
	python3 scripts/next_task.py

.PHONY: validate-tasks
validate-tasks: ## Validate the task graph
	python3 scripts/validate_tasks.py
