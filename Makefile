.PHONY: bench loadbench up down reset test tokens tokens-check test-server test-web lock e2e e2e-down migration-test restore-test leakcheck prod-config multiarch decrypt-test decrypt-tool upload-test upload-tool upload-e2e play-aab
up:        ## build and start; app at https://cipherfilm.orb.local
	docker compose -f compose.dev.yaml up -d --build --wait
	@echo "https://cipherfilm.orb.local"
down:
	docker compose -f compose.dev.yaml down
reset:     ## wipe containers, volumes and image
	docker compose -f compose.dev.yaml down -v --rmi local
test: tokens-check test-server test-web decrypt-test upload-test restore-test   ## single test command
tokens:    ## write the design tokens (design/tokens/tokens.json) into web/, mobile/ and mac/
	node design/tokens/build.mjs
tokens-check: ## fail if a generated token file is out of date or a contrast pair falls short
	docker run --rm -v "$(CURDIR):/repo:ro" -w /repo node:26-alpine node design/tokens/build.mjs --check
test-server:
	docker run --rm -v gocache:/go/pkg/mod -v "$(CURDIR)/server:/src" -w /src golang:1.27-alpine sh -c 'mkdir -p static && go vet ./... && go test ./...'
test-web:
	docker run --rm -v "$(CURDIR)/web:/web" -v /web/node_modules -v "$(CURDIR)/server/models.json:/server/models.json:ro" -v "$(CURDIR)/server/explicit-filter.json:/server/explicit-filter.json:ro" -v "$(CURDIR)/tools/decrypt/testdata:/tools/decrypt/testdata:ro" -w /web node:26-alpine sh -c 'npm ci --silent && npm run build --silent && npm test --silent'
lock:      ## regenerate web/package-lock.json
	docker run --rm -v "$(CURDIR)/web:/web" -w /web node:26-alpine npm install --package-lock-only
# Playwright's browser image in compose.e2e.yaml follows the npm package, so Dependabot bumps one version, not two
export PLAYWRIGHT_VERSION := $(shell sed -n 's/.*"@playwright\/test": "\([0-9][0-9.]*\)".*/\1/p' e2e/package.json)
E2E = docker compose -f compose.e2e.yaml
leakcheck: ## assert the e2e stack's data volume holds none of the plaintext markers the e2e uploaded
	@test -s e2e/test-results/markers.txt || (echo "run make e2e first" && exit 1)
	@docker run --rm -v cipherfilm-e2e_appdata:/data:ro -v "$(CURDIR)/e2e/test-results/markers.txt:/markers.txt:ro" alpine sh -c \
	  'n=$$(find /data/blobs -type f | wc -l); [ "$$n" -ge 10 ] || { echo "only $$n blob files: nothing to check"; exit 1; }; \
	   if grep -rlaF -f /markers.txt /data; then echo "LEAK: plaintext found on the server volume"; exit 1; else echo "leak check clean: $$n blob files and the database contain none of the markers"; fi'
e2e:       ## fresh, self-contained stack (app + Caddy HTTPS) and Playwright; same as in CI
	$(E2E) --profile test down -v --remove-orphans
	$(E2E) up -d --build --wait app proxy
	SETUP_TOKEN="$$($(E2E) logs app | grep -o 'token: .*' | tail -1 | cut -c8-)" $(E2E) run --rm playwright && $(MAKE) leakcheck
e2e-down:  ## remove the e2e stack and its data
	$(E2E) --profile test down -v --remove-orphans

MIGRATED = docker compose -p cipherfilm-migrated -f compose.e2e.yaml
restore-test: ## offline checks of scripts/restore.sh and deploy/demo/reset.sh (no Docker): a failed after-restore keeps .previous/
	scripts/test-restore.sh

migration-test: ## move the e2e stack to a second, empty stack with scripts/backup.sh + scripts/restore.sh, sign in there and decrypt offline (run make e2e first)
	mkdir -p dist && docker run --rm -v "$(CURDIR)/dist:/d" alpine:3.24 rm -rf /d/migration && mkdir -p dist/migration/extracted
	COMPOSE_FILE=compose.e2e.yaml COMPOSE_PROJECT_NAME=cipherfilm-e2e DATA_VOLUME=cipherfilm-e2e_appdata scripts/backup.sh dist/migration
	$(MIGRATED) --profile test down -v --remove-orphans
	COMPOSE_FILE=compose.e2e.yaml COMPOSE_PROJECT_NAME=cipherfilm-migrated DATA_VOLUME=cipherfilm-migrated_appdata scripts/restore.sh dist/migration/cipherfilm-*.tar --yes
	$(MIGRATED) up -d --wait app proxy
	$(MIGRATED) run --rm playwright sh -c 'npx playwright test -c restore.config.ts'
	docker run --rm -v "$(CURDIR)/dist/migration:/m" alpine:3.24 sh -c 'tar -xf /m/cipherfilm-*.tar -C /m/extracted'   # the backup is root-owned, mode 600
	docker run --rm -v "$(CURDIR)/e2e:/e2e:ro" -v "$(CURDIR)/dist/migration:/m" node:26-alpine \
	  node -e 'require("fs").writeFileSync("/m/pw", require("/e2e/.e2e-passwords.json").frank, { mode: 0o600 })'   # written by the test container as root
	docker run --rm -v gocache:/go/pkg/mod -v "$(CURDIR)/tools/decrypt:/src" -v "$(CURDIR)/dist/migration:/m" -w /src golang:1.27-alpine \
	  go run . --verify --email frank@example.org --password-file /m/pw /m/extracted
	$(MIGRATED) --profile test down -v --remove-orphans
	docker run --rm -v "$(CURDIR)/dist:/d" alpine:3.24 rm -rf /d/migration
	@echo "migration test passed: backup, restore on a new stack, sign-in and offline decrypt all work"

prod-config: ## validate the production compose files
	@echo "== compose.yaml"; PUBLIC_HOSTS=photos.example.com docker compose -f compose.yaml config -q || exit 1; \
	t=deploy/tailnet; for o in "$$t/compose.tailscale.yaml" "$$t/compose.tailscale.yaml:$$t/compose.kopia.yaml" \
	  "$$t/compose.tailscale.yaml:$$t/compose.kopia.yaml:$$t/compose.domain.yaml" \
	  "$$t/compose.tailscale.yaml:$$t/compose.kopia.yaml:$$t/compose.domain.yaml:$$t/compose.portainer.yaml"; do \
	  echo "== compose.yaml:$$o"; COMPOSE_FILE="compose.yaml:$$o" PUBLIC_HOSTS=photos.example.com TS_AUTHKEY=x \
	  KOPIA_SERVER_PASSWORD=x DOMAIN=photos.example.com TS_DOMAIN=photos.example.ts.net CF_API_TOKEN=x \
	  docker compose config -q || exit 1; done; \
	echo "== deploy/mac-local/compose.yaml"; docker compose -f deploy/mac-local/compose.yaml config -q || exit 1; \
	scripts/check-compose-env.sh || exit 1; \
	echo "all valid"
multiarch: ## prove the image builds for amd64 and arm64 (not loaded, just built)
	docker buildx build --platform linux/amd64,linux/arm64 -o type=oci,dest=/tmp/cipherfilm-multiarch.tar . && echo "multi-arch build OK: /tmp/cipherfilm-multiarch.tar"

decrypt-test:   ## tests of the offline decrypt tool (tools/decrypt)
	docker run --rm -v gocache:/go/pkg/mod -v "$(CURDIR)/tools/decrypt:/src" -w /src golang:1.27-alpine sh -c 'go vet ./... && go test ./...'

decrypt-tool:   ## build the offline decrypt tool for macOS (Apple silicon and Intel) and Linux into dist/decrypt
	mkdir -p dist/decrypt
	docker run --rm -v gocache:/go/pkg/mod -v "$(CURDIR)/tools/decrypt:/src" -v "$(CURDIR)/dist/decrypt:/out" -w /src golang:1.27-alpine sh -c \
	  'for t in darwin/arm64 darwin/amd64 linux/amd64; do os=$${t%/*}; arch=$${t#*/}; CGO_ENABLED=0 GOOS=$$os GOARCH=$$arch go build -trimpath -ldflags="-s -w" -o /out/cipherfilm-decrypt-$$os-$$arch . || exit 1; done'
	@ls -la dist/decrypt

upload-test:    ## tests of the Mac uploader (tools/upload)
	docker run --rm -v gocache:/go/pkg/mod -v "$(CURDIR)/tools:/tools" -w /tools/upload golang:1.27-alpine sh -c 'go vet ./... && go test ./...'

upload-tool:    ## build the Mac uploader (Apple silicon and Intel) into dist/upload
	mkdir -p dist/upload
	docker run --rm -v gocache:/go/pkg/mod -v "$(CURDIR)/tools/upload:/src" -v "$(CURDIR)/dist/upload:/out" -w /src golang:1.27-alpine sh -c \
	  'for arch in arm64 amd64; do CGO_ENABLED=0 GOOS=darwin GOARCH=$$arch go build -trimpath -ldflags="-s -w" -o /out/cipherfilm-upload-darwin-$$arch . || exit 1; done'
	@ls -la dist/upload

upload-e2e:     ## uploader end to end on this Mac against a throwaway server (needs Docker and swift)
	tools/upload/e2e/run.sh

bench:   ## upload benchmark on the e2e stack (run make e2e first; BENCH=<label> [BROWSER=firefox|webkit] make bench)
	mkdir -p e2e/test-results
	$(E2E) run --rm -e BENCH="$(or $(BENCH),run)" -e LATENCY="$(or $(LATENCY),0)" -e NOWORKER="$(NOWORKER)" -e BROWSER="$(BROWSER)" playwright sh -c 'npm ci --silent && npx playwright test zzzzzzzbench'
	@cat e2e/test-results/bench.txt
loadbench: ## first thumbnails after a reload and lightbox paging, throttled to 10 Mbit/s (run make e2e first; LOADBENCH=<label> make loadbench)
	mkdir -p e2e/test-results
	SETUP_TOKEN="$$($(E2E) logs app | grep -o 'token: .*' | tail -1 | cut -c8-)" $(E2E) run --rm -e LOADBENCH="$(or $(LOADBENCH),run)" playwright sh -c 'npm ci --silent && npx playwright test zzzzzzzzloadbench'
	@cat e2e/test-results/loadbench.txt

play-aab:       ## the Google Play App Bundle, signed with the local upload key, into dist/ (VERSION=X.Y.Z; mobile/scripts/build-play-aab.sh)
	@test -n "$(VERSION)" || (echo "usage: make play-aab VERSION=X.Y.Z" && exit 1)
	VERSION="$(VERSION)" mobile/scripts/build-play-aab.sh
