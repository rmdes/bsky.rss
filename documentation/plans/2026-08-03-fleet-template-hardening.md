# Fleet Template Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `rmdes/bsky-rss-fleet-template` into a safe, version-pinned, dry-run-first fleet operator repository with tested initialization, validation, backup, restore, update, and rollback workflows.

**Architecture:** The template remains deploy-only and pulls a released `ghcr.io/rmdes/bsky.rss` image. Shell scripts provide thin operator workflows around the application-owned validation CLI and Docker Compose. Runtime config, secrets, and state remain separate host directories with explicit permissions and backup semantics.

**Tech Stack:** Docker Compose v2, POSIX shell/Bash, Node.js runtime inside the published image, SQLite, GitHub Actions, ShellCheck.

## Global Constraints

- Repository under implementation: `rmdes/bsky-rss-fleet-template`.
- Requires the runtime contracts from the preceding plan to exist in a released image.
- Default startup is `DRY_RUN=true`.
- Default image version is a pinned numeric release tag supplied by `.env`.
- `secrets/`, `data/`, `backups/`, and local `config/` are never committed by default.
- Docker executes `node --import tsx fleet/runFleet.ts` directly.
- Backup must be SQLite-consistent.
- Restore refuses to operate while the fleet container is active.
- Scripts must fail closed with `set -Eeuo pipefail` and sanitized errors.
- Preserve current config shapes, independent per-bot SQLite state, direct Node PID 1, durable mounts, one active publisher, 45-second stop grace, queue/freshness/rate-limit behavior, and 30-second sequential authentication.
- Log retention and privacy are mandatory but backend-neutral: support host-managed `journald` with a documented/tested retention policy and a portable bounded `json-file` profile.
- Support a generic optional custom-CA overlay compatible with `NODE_EXTRA_CA_CERTS`; never include a private feed, endpoint, or production path in examples.
- Template scripts and automated acceptance are capabilities only; they do not authorize execution against production.

---

### Task 1: Establish Template Safety Baseline

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Modify: `docker-compose.yml`
- Create: `compose.logging-json-file.yaml`
- Create: `compose.custom-ca.yaml`
- Move: `config.example/secrets/bsky-fleet.json` to `secrets.example/bsky-fleet.json`
- Modify: `README.md`
- Create: `tests/compose-config.sh`

**Interfaces:**
- Consumes: published image and runtime environment variables from `bsky.rss`.
- Produces: safe local directory contract and pinned Compose deployment.

- [ ] **Step 1: Write a failing Compose safety test**

Create `tests/compose-config.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

cp .env.example .env
rendered="$(docker compose config)"

grep -q 'DRY_RUN: "true"' <<<"$rendered"
grep -q 'ghcr.io/rmdes/bsky.rss:2.2.0' <<<"$rendered"
grep -q 'node' <<<"$rendered"
grep -q 'fleet/runFleet.ts' <<<"$rendered"
! grep -q 'yarn fleet' <<<"$rendered"
```

Use the current released image version when execution begins; `2.2.0` is the audit baseline, not a permanent plan constant.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/compose-config.sh
```

Expected: `.env.example` is missing and Compose still uses `latest`/live publishing.

- [ ] **Step 3: Add `.gitignore`**

```gitignore
.env
config/
secrets/
data/
backups/
*.sqlite
*.sqlite-shm
*.sqlite-wal
*.tar.gz
```

Do not ignore `config.example/`, `secrets.example/`, provider manifests, scripts, or tests.

- [ ] **Step 4: Add `.env.example`**

```dotenv
BSKY_RSS_VERSION=2.2.0
DRY_RUN=true
HEALTH_CHECK_PORT=8080
```

The version must be updated to the release produced by the runtime-contract PR before this template PR merges.

- [ ] **Step 5: Harden Compose**

Update `docker-compose.yml`:

```yaml
services:
  bsky-rss-fleet:
    image: ghcr.io/rmdes/bsky.rss:${BSKY_RSS_VERSION:?set BSKY_RSS_VERSION in .env}
    container_name: bsky-rss-fleet
    restart: unless-stopped
    command: ["node", "--import", "tsx", "fleet/runFleet.ts"]
    stop_grace_period: 45s
    environment:
      DRY_RUN: ${DRY_RUN:-true}
      HEALTH_CHECK_PORT: ${HEALTH_CHECK_PORT:-8080}
      FLEET_CONFIG_ROOT: /build/config
      FLEET_SECRETS_PATH: /build/secrets/bsky-fleet.json
      FLEET_DATA_ROOT: /build/data/fleet
      FLEET_LOCK_PATH: /build/data/fleet/fleet.pid
    volumes:
      - ./config:/build/config:ro
      - ./secrets:/build/secrets:ro
      - ./data:/build/data
    ports:
      - 127.0.0.1:${HEALTH_CHECK_PORT:-8080}:${HEALTH_CHECK_PORT:-8080}
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - >-
          const port = process.env.HEALTH_CHECK_PORT ?? '8080';
          fetch(`http://127.0.0.1:${port}/live`)
            .then(r => process.exit(r.ok ? 0 : 1))
            .catch(() => process.exit(1));
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 2m
```

Keep the base Compose file logging-driver neutral. Add `compose.logging-json-file.yaml` as a portable opt-in profile with `max-size: 20m` and `max-file: "5"`. Document a separate `journald` profile that inherits the host driver only when the operator has verified bounded retention and log availability. Tests must render both choices and reject an unbounded or undocumented backend.

Add `compose.custom-ca.yaml` as an optional overlay that mounts a generic operator-owned CA bundle read-only and selects it through `NODE_EXTRA_CA_CERTS`. The base deployment must work without the overlay. Compose and validation tests cover absent, readable-valid, missing, and invalid bundle cases without logging bundle contents or private paths.

- [ ] **Step 6: Separate secret examples**

Move the secret example to `secrets.example/bsky-fleet.json`. Update every README path and never copy example placeholders into the runtime secrets directory without explicit operator editing.

- [ ] **Step 7: Run test and commit**

```bash
bash tests/compose-config.sh
git add .gitignore .env.example docker-compose.yml compose.logging-json-file.yaml compose.custom-ca.yaml config.example secrets.example README.md tests/compose-config.sh
git commit -m "fix: make fleet template safe by default"
```

---

### Task 2: Add Idempotent Initialization

**Files:**
- Create: `scripts/lib/common.sh`
- Create: `scripts/init.sh`
- Create: `tests/init.sh`
- Modify: `README.md`

**Interfaces:**
- Produces:

```bash
scripts/init.sh [--force]
```

The script creates `.env`, `config/`, `secrets/`, `data/`, and `backups/` without overwriting operator files unless `--force` is supplied.

- [ ] **Step 1: Write failing initialization tests**

`tests/init.sh` creates a temporary copy of the repository and asserts:

- first run creates all directories;
- `.env` is copied from `.env.example`;
- `config/fleet.json` and one example bot are created;
- `secrets/bsky-fleet.json` has mode `0600`;
- `secrets/` has mode `0700`;
- second run does not overwrite an edited file;
- `--force` replaces only generated examples, never `data/`.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/init.sh
```

- [ ] **Step 3: Implement shared shell helpers**

`scripts/lib/common.sh` must provide:

```bash
repo_root()
require_command()
container_running()
read_env_value()
require_not_placeholder()
```

All diagnostics go to stderr and must not echo secret values.

- [ ] **Step 4: Implement initialization**

Core behavior:

```bash
install -d -m 0755 config data backups
install -d -m 0700 secrets
install -m 0600 secrets.example/bsky-fleet.json secrets/bsky-fleet.json
cp -R config.example/. config/
cp .env.example .env
```

Protect existing files unless `--force` is explicitly set.

- [ ] **Step 5: Replace the manual README sequence**

Quickstart becomes:

```bash
git clone https://github.com/rmdes/bsky-rss-fleet-template.git
cd bsky-rss-fleet-template
./scripts/init.sh
$EDITOR config/bots/example-bot/bot.json
$EDITOR secrets/bsky-fleet.json
./scripts/validate.sh
./scripts/start-dry-run.sh
```

- [ ] **Step 6: Run tests and commit**

```bash
bash tests/init.sh
git add scripts README.md tests/init.sh
git commit -m "feat: add safe fleet initialization"
```

---

### Task 3: Wrap Application-Owned Validation

**Files:**
- Create: `scripts/validate.sh`
- Create: `tests/validate.sh`
- Modify: `README.md`
- Create: `docs/configuration.md`

**Interfaces:**
- Consumes: `node --import tsx fleet/validateFleet.ts` inside the pinned application image.
- Produces:

```bash
scripts/validate.sh [--filesystem]
```

- [ ] **Step 1: Write failing validation wrapper tests**

Use a fake `docker` executable earlier on `PATH` to capture arguments. Assert the wrapper invokes:

```text
docker compose run --rm --no-deps bsky-rss-fleet node --import tsx fleet/validateFleet.ts
```

and adds `--check-filesystem` when requested.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/validate.sh
```

- [ ] **Step 3: Implement wrapper**

Before invoking Docker, check:

- `.env` exists;
- `BSKY_RSS_VERSION` is non-empty and not `latest`;
- config and secret files exist;
- secret file permissions are not group/world-readable;
- no placeholder pattern exists in the secret file.

Do not print the file content.

- [ ] **Step 4: Document schema errors**

`docs/configuration.md` must explain deterministic issue fields: `scope`, `botId`, `path`, `code`, and `message`, with sanitized examples.

- [ ] **Step 5: Run tests and commit**

```bash
bash tests/validate.sh
git add scripts/validate.sh tests/validate.sh README.md docs/configuration.md
git commit -m "feat: validate fleet configuration before startup"
```

---

### Task 4: Add Explicit Dry-Run and Publishing Workflows

**Files:**
- Create: `scripts/start-dry-run.sh`
- Create: `scripts/enable-publishing.sh`
- Create: `scripts/disable-publishing.sh`
- Create: `tests/publishing-mode.sh`
- Modify: `README.md`
- Create: `docs/operations.md`

**Interfaces:**
- Produces safe mode transitions through `.env` and Compose.

- [ ] **Step 1: Write failing mode-transition tests**

Assert:

- `start-dry-run.sh` forces `DRY_RUN=true`, validates, then starts;
- `enable-publishing.sh` refuses unless validation succeeds and `--confirm-publish` is supplied;
- enabling publishing writes `DRY_RUN=false` atomically;
- `disable-publishing.sh` writes `DRY_RUN=true` and recreates the container;
- scripts never echo secret values.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/publishing-mode.sh
```

- [ ] **Step 3: Implement atomic `.env` editing**

Write a temporary file in the repository root, replace exactly one key, then `mv` it over `.env`. Preserve other settings.

- [ ] **Step 4: Implement confirmation gate**

The only non-interactive activation command is:

```bash
./scripts/enable-publishing.sh --confirm-publish
```

Without that exact flag, exit 2 and keep dry-run enabled.

- [ ] **Step 5: Verify against real Compose config**

```bash
./scripts/start-dry-run.sh
docker compose config | grep 'DRY_RUN: "true"'
./scripts/disable-publishing.sh
```

Do not run `enable-publishing.sh` against real accounts during automated verification.

- [ ] **Step 6: Commit**

```bash
git add scripts tests/publishing-mode.sh README.md docs/operations.md
git commit -m "feat: make fleet publishing an explicit action"
```

---

### Task 5: Add SQLite-Consistent Backup and Restore

**Files:**
- Create: `scripts/backup.sh`
- Create: `scripts/restore.sh`
- Create: `tests/backup-restore.sh`
- Create: `docs/backup-and-restore.md`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces:

```bash
scripts/backup.sh [--output backups/<name>.tar.gz]
scripts/restore.sh backups/<name>.tar.gz [--confirm-restore]
```

- [ ] **Step 1: Write failing backup/restore integration test**

The test must:

1. create a temporary runtime tree;
2. create a SQLite database with one row using the application image or local `node:sqlite`;
3. run backup;
4. modify/delete the state;
5. run restore;
6. assert the original row and file permissions return;
7. assert restore refuses while a fake fleet container is reported running.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/backup-restore.sh
```

- [ ] **Step 3: Implement consistent backup**

Normative sequence:

1. record whether the fleet is running and its current dry-run/publishing mode;
2. if it is running, issue a graceful `docker compose stop`;
3. wait until the container is no longer running;
4. verify graceful-shutdown completion in container logs when logs are available;
5. archive the complete closed `data/` tree, including every SQLite file and any WAL/SHM sidecars, together with `config/`, `secrets/`, and `backup-metadata.json`;
6. create the archive with owner-only mode `0600`; and
7. restart only if the fleet was previously running, preserving its previous dry-run/publishing mode.

Do not copy live SQLite state or introduce a second backup mechanism in this cycle.

Metadata shape:

```json
{
  "formatVersion": 1,
  "applicationVersion": "2.2.0",
  "createdAt": "2026-08-03T00:00:00.000Z",
  "dryRun": true
}
```

- [ ] **Step 4: Implement guarded restore**

Restore must:

- require `--confirm-restore`;
- refuse while container is running;
- verify archive paths do not escape the restore root;
- validate metadata format and application compatibility;
- restore permissions;
- invoke `scripts/validate.sh --filesystem`;
- force `DRY_RUN=true` unless `--preserve-publishing-mode` is explicitly supplied.

- [ ] **Step 5: Run integration test and commit**

```bash
bash tests/backup-restore.sh
git add scripts tests/backup-restore.sh docs/backup-and-restore.md docker-compose.yml
git commit -m "feat: add consistent fleet backup and restore"
```

---

### Task 6: Add Deliberate Update and Rollback

**Files:**
- Create: `scripts/update.sh`
- Create: `scripts/rollback.sh`
- Create: `tests/update-rollback.sh`
- Create: `docs/upgrading.md`
- Modify: `.env.example`

**Interfaces:**
- Produces:

```bash
scripts/update.sh <numeric-version>
scripts/rollback.sh <backup-archive> <previous-version>
```

- [ ] **Step 1: Write failing update tests**

Assert update rejects:

- `latest`;
- tags beginning with `v`;
- empty versions;
- versions not matching `^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$`.

Assert it backs up before changing `.env`, pulls the target image, validates, starts dry-run, and checks `/ready`.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/update-rollback.sh
```

- [ ] **Step 3: Implement update transaction**

Order is fixed:

```text
validate current deployment
backup
pull target image
run target image validation against mounted config
write BSKY_RSS_VERSION
force DRY_RUN=true
recreate
wait for /ready
leave publishing disabled
```

If any step fails, restore the previous `.env` and recreate the previous image.

- [ ] **Step 4: Implement rollback**

Rollback restores the supplied backup and prior version, validates, starts in dry-run, and reports the command required to re-enable publishing. It must not automatically publish.

- [ ] **Step 5: Run tests and commit**

```bash
bash tests/update-rollback.sh
git add scripts tests/update-rollback.sh docs/upgrading.md .env.example
git commit -m "feat: add fleet update and rollback workflows"
```

---

### Task 7: Add Template CI and End-to-End Dry-Run Smoke

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `tests/run-all.sh`
- Create: `tests/smoke-compose.sh`
- Create: `test-fixtures/config/`
- Modify: `README.md`

**Interfaces:**
- Consumes: pinned application image and its `/live`, `/ready`, validation, and dry-run contracts.
- Produces: reproducible template validation on every PR.

- [ ] **Step 1: Add aggregate test runner**

```bash
#!/usr/bin/env bash
set -Eeuo pipefail
for test_file in tests/*.sh; do
  [[ "$test_file" == "tests/run-all.sh" ]] && continue
  bash "$test_file"
done
```

- [ ] **Step 2: Add Compose smoke test**

Use controlled fixture config and a local mock service supplied by the application image/test harness. Assert:

- validation succeeds;
- container reaches `/ready`;
- `/status` reports fleet mode and dry-run;
- persistent SQLite state appears under `data/fleet/bots/`;
- `docker compose stop` logs graceful shutdown;
- no post-creation request is observed.

- [ ] **Step 3: Add CI workflow**

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: sudo apt-get update && sudo apt-get install -y shellcheck
      - run: shellcheck scripts/*.sh scripts/lib/*.sh tests/*.sh
      - run: bash tests/run-all.sh
```

- [ ] **Step 4: Run complete local verification**

```bash
shellcheck scripts/*.sh scripts/lib/*.sh tests/*.sh
bash tests/run-all.sh
```

- [ ] **Step 5: Commit**

```bash
git add .github tests test-fixtures README.md
git commit -m "test: verify fleet template lifecycle"
```

## Fleet Template Plan Acceptance

### Production adoption checklist

`/home/skyfleet-next` is an in-place compatibility target, not an automated acceptance environment. Before a published image is considered for production:

- compare candidate revision/provenance and selected runtime compatibility with the locally built running image; matching `2.2.0` strings are insufficient;
- validate the existing configuration shapes and all 59 independent SQLite stores without mutation;
- run the candidate against controlled fixtures in dry-run;
- create and verify a consistent graceful-stop backup;
- schedule an explicit operator-approved change window;
- preserve direct Node PID 1, durable mounts, one active publisher, 45-second stop grace, 30-second staggering, queue/freshness/rate-limit behavior, selected logging retention, and optional custom-CA behavior;
- collect readiness and lifecycle evidence after the change; and
- prove recovery using the previous compatible fleet image and pre-update backup.

Update, restore, and recovery scripts remain template capabilities. Running them against production, changing publishing mode, or performing container lifecycle actions is outside automated acceptance and requires separate authorization and Field-verified evidence.

Before opening the companion PR:

```bash
./scripts/init.sh
./scripts/validate.sh
./scripts/start-dry-run.sh
curl -fsS http://127.0.0.1:8080/ready
curl -fsS http://127.0.0.1:8080/status
docker compose stop
shellcheck scripts/*.sh scripts/lib/*.sh tests/*.sh
bash tests/run-all.sh
```

Inspect `git status --ignored` and prove that `.env`, `config/`, `secrets/`, `data/`, and `backups/` are ignored. The PR body must name the exact application image version used for validation.
