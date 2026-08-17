.DEFAULT_GOAL := help
SHELL := /bin/bash

CONTROL_DIR := services/control
# The task tooling needs PyYAML. A repo-local venv is used when present, so the
# host python is never modified (many are externally managed).
PYTHON := $(shell [ -x .venv/bin/python ] && echo .venv/bin/python || echo python3)
# Every Go module in go.work. `go <cmd> ./...` is per-module, so we iterate.
GO_MODULES := $(patsubst ./%/go.mod,%,$(shell find . -name go.mod -not -path './node_modules/*' -not -path './*/node_modules/*'))

.PHONY: help
help: ## Show available developer commands
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

.PHONY: bootstrap
bootstrap: tools ## Install pinned JS dependencies and the task tooling
	npm ci || npm install

.PHONY: tools
tools: ## Create .venv with the task tooling's only dependency
	@[ -x .venv/bin/python ] || python3 -m venv .venv
	@.venv/bin/pip install --quiet pyyaml
	@echo "task tooling ready: .venv/bin/python scripts/ralph.py" 

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

.PHONY: build-web
build-web: ## Build the web guest client
	npm run build --workspace apps/web

.PHONY: build-helper
build-helper: ## Build the input helper as a universal macOS binary
	bash native/input-helper/build.sh

.PHONY: package
package: build-helper ## Build the macOS app, unsigned
	npm run package --workspace apps/desktop

.PHONY: release
release: build-helper ## Build, sign and notarise the macOS app
	@test -n "$$APPLE_API_KEY" || (echo "set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER" && exit 1)
	npm run package --workspace apps/desktop
	@# electron-builder staples the .app, then builds the DMG around it, leaving
	@# the DMG itself unsigned and ticketless. The DMG is what gets downloaded.
	bash scripts/notarize-dmg.sh apps/desktop/release/Layup-*-universal.dmg
	@# Signing and stapling changed the DMG after electron-builder measured it,
	@# so the feed now describes a file that no longer exists.
	node scripts/restamp-feed.mjs apps/desktop/release/latest-mac.yml

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

.PHONY: test-restamp-feed
test-restamp-feed: ## Unit-test the release-feed restamping script
	node --test scripts/restamp-feed.test.mjs

.PHONY: test-e2e
test-e2e: ## End-to-end tests against a real control service (wire contract only)
	node --test test/e2e/*.test.mjs

.PHONY: test-webrtc
test-webrtc: ## Prove real WebRTC connectivity in an Electron window
	npm run test:webrtc --workspace apps/desktop

.PHONY: test-turn
test-turn: ## Prove forced relay through a real coturn (needs Docker)
	node test/network/turn-relay.mjs

.PHONY: test-turn-remote
test-turn-remote: ## Prove forced relay through the deployed coturn (needs make deploy first)
	node test/network/turn-remote.mjs

.PHONY: fmt-check
fmt-check: ## Fail if any Go file needs gofmt
	@unformatted="$$(gofmt -l $(GO_MODULES))"; \
	if [ -n "$$unformatted" ]; then echo "gofmt needed for:"; echo "$$unformatted"; exit 1; fi

.PHONY: verify
verify: check test-bench test-restamp-feed test-smoke test-e2e test-boundary test-webrtc ## check + every real-boundary proof (add test-turn for coturn)

.PHONY: ci
ci: validate-tasks fmt-check check test-bench test-restamp-feed ## Everything the fast CI jobs run, locally

.PHONY: check
check: typecheck lint test build ## Full local gate: typecheck, lint, test, build

.PHONY: tasks
tasks: ## Show the next eligible Ralph task, with the contract that governs it
	$(PYTHON) scripts/ralph.py

.PHONY: validate-tasks
validate-tasks: ## Validate every task graph (PLAN-1 and PLAN-1.5)
	$(PYTHON) scripts/ralph.py validate

.PHONY: plan-status
plan-status: ## Progress across both plans and their gates
	$(PYTHON) scripts/ralph.py status

LAYUP_DEPLOY_HOST ?= root@157.20.113.124
LAYUP_DEPLOY_DOMAIN ?= layup.blah.au
export LAYUP_DEPLOY_DOMAIN

.PHONY: publish
publish: ## Upload the DMG, the update zip and the feed manifest to the dev VM
	@ls apps/desktop/release/*.dmg >/dev/null 2>&1 || (echo "run 'make release' first" && exit 1)
	@# Squirrel.Mac cannot update from a DMG. No zip means a download page and
	@# no update path, which looks identical until nobody ever gets a fix.
	@ls apps/desktop/release/*-mac.zip >/dev/null 2>&1 || (echo "no update zip: check mac.target in electron-builder.yml" && exit 1)
	@# The manifest *is* the feed. Without it nothing ever updates, and it looks
	@# exactly like it is working.
	@test -f apps/desktop/release/latest-mac.yml || (echo "no latest-mac.yml: check the publish block in electron-builder.yml" && exit 1)
	ssh $(LAYUP_DEPLOY_HOST) 'install -d -m 0755 /srv/layup/public/download'
	@# Under their own versioned names, because latest-mac.yml names them.
	scp apps/desktop/release/*.dmg apps/desktop/release/*-mac.zip $(LAYUP_DEPLOY_HOST):/srv/layup/public/download/
	@# Blockmaps make an update a delta instead of a full download. Their
	@# absence only costs bandwidth, so a missing one is not a failed publish.
	-scp apps/desktop/release/*.blockmap $(LAYUP_DEPLOY_HOST):/srv/layup/public/download/
	@# And again under the stable name the download page links to.
	scp apps/desktop/release/*.dmg $(LAYUP_DEPLOY_HOST):/srv/layup/public/download/Layup.dmg
	@# Last: until the manifest lands the feed still describes the previous
	@# release, which is the only thing it is safe for it to describe.
	scp apps/desktop/release/latest-mac.yml $(LAYUP_DEPLOY_HOST):/srv/layup/public/download/latest-mac.yml
	@echo "https://$(LAYUP_DEPLOY_DOMAIN)/download/Layup.dmg"
	@echo "feed: https://$(LAYUP_DEPLOY_DOMAIN)/download/latest-mac.yml"
	@curl -fsS https://$(LAYUP_DEPLOY_DOMAIN)/download/latest-mac.yml | head -3

.PHONY: deploy-build
deploy-build: ## Cross-compile the control service for the dev VM
	cd $(CONTROL_DIR) && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
		go build -trimpath -o ../../dist/layup-control ./cmd/control

.PHONY: deploy
deploy: deploy-build ## Ship the control service to the dev VM and restart it
	scp dist/layup-control $(LAYUP_DEPLOY_HOST):/usr/local/bin/layup-control.new
	ssh $(LAYUP_DEPLOY_HOST) 'install -m 0755 /usr/local/bin/layup-control.new /usr/local/bin/layup-control \
		&& rm -f /usr/local/bin/layup-control.new \
		&& systemctl enable --now layup-control \
		&& systemctl restart layup-control'
	@echo "deployed; verifying"
	@node test/network/remote-health.mjs

.PHONY: deploy-config
deploy-config: ## Ship deploy/vm configuration and re-run bootstrap
	# scp -r into an already-existing remote directory nests instead of
	# overwriting, so a stale bootstrap.sh would silently keep running.
	ssh $(LAYUP_DEPLOY_HOST) 'rm -rf /tmp/layup-vm'
	scp -r deploy/vm $(LAYUP_DEPLOY_HOST):/tmp/layup-vm
	ssh $(LAYUP_DEPLOY_HOST) 'bash /tmp/layup-vm/bootstrap.sh'

.PHONY: deploy-status
deploy-status: ## Show service state on the dev VM
	ssh $(LAYUP_DEPLOY_HOST) 'systemctl --no-pager --lines=0 status layup-control caddy coturn nftables || true'

.PHONY: deploy-logs
deploy-logs: ## Tail the control service log on the dev VM
	ssh $(LAYUP_DEPLOY_HOST) 'journalctl -u layup-control -n 100 -f'

.PHONY: reset-identities
reset-identities: ## DESTRUCTIVE: wipe every identity on the dev VM - logs EVERYBODY out
	@echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
	@echo "!! DESTRUCTIVE"
	@echo "!! This deletes EVERY registered identity on $(LAYUP_DEPLOY_DOMAIN)"
	@echo "!! and restarts layup-control. It logs EVERYBODY out - every"
	@echo "!! desktop's token stops working, and re-registering (Add a"
	@echo "!! server, same join code) is the only way back in."
	@echo "!!"
	@echo "!! Only run this immediately before a fresh pairing session, with"
	@echo "!! nobody depending on the server staying up right now."
	@echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
	ssh $(LAYUP_DEPLOY_HOST) 'rm -f /var/lib/layup/identities.json && systemctl restart layup-control'
	@echo "identities wiped; layup-control restarted with an empty directory"
