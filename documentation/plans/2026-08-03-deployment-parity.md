# Deployment Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Docker, Fly.io, Railway, Render, and DigitalOcean documentation and manifests for solo and fleet modes, matching the Docker capability contract where possible and explicitly documenting adaptations where not.

**Architecture:** Keep solo provider manifests in `rmdes/bsky.rss` because that repository owns the application and solo operator path. Keep fleet provider overlays in `rmdes/bsky-rss-fleet-template` because it owns the fleet operator experience. Managed providers adapt the Verified Docker runtime contract instead of redefining it. Add one shared manifest validator in the application repository and run it against checked-out copies of both repositories.

**Tech Stack:** Docker Compose, Fly TOML, Railway TOML, Render Blueprint YAML, DigitalOcean App Spec YAML, TypeScript, Node.js 24, `yaml`, `smol-toml`, GitHub Actions.

## Global Constraints

- Docker solo and Docker fleet target `Verified` status.
- Managed platforms target `Validated` status until a real deployment record exists.
- All fleet targets enforce one replica and durable state.
- Managed provider documentation must not promise feature parity where provider storage or lifecycle semantics prevent it.
- Render free/sleeping services are not recommended for production publishers.
- DigitalOcean App Platform fleet mode is unsupported; one DigitalOcean Droplet running Docker Compose is the supported fleet adaptation.
- Provider manifests use direct Node entry points, pinned application versions, dry-run-first behavior, health checks, and persistent storage where the platform supports them.
- The fleet template consumes a verified published image and must not carry a local build context that misleadingly suggests the deploy-only root can reproduce that image.
- Provider guides must document bounded, privacy-preserving retention for their selected log backend; Docker profiles support host-managed `journald` with tested retention and portable bounded `json-file`.
- Map the generic optional custom CA contract where the provider supports a mounted bundle or platform trust-store integration, and validate the unsupported/adapted case explicitly.
- `/home/skyfleet-next` is a **Production-proven baseline** from operator attestation and stable process evidence. Its lack of a current fleet health endpoint does not erase that evidence, but newly **Verified** readiness, shutdown, backup, update, and recovery capabilities require separate lifecycle tests.
- Static validation and local smoke tests never authorize production-host access, container lifecycle actions, publishing changes, or deployment; production adoption requires explicit approval and a **Field-verified** record.

---

### Task 1: Create Canonical Deployment Metadata and Manifest Validator

**Files (`rmdes/bsky.rss`):**
- Create: `deployment/capabilities.json`
- Create: `deployment/document-header.schema.json`
- Create: `scripts/validateDeployments.ts`
- Create: `scripts/validateDeployments.test.ts`
- Modify: `package.json`
- Modify: `yarn.lock`

**Interfaces:**
- Produces:

```ts
export interface DeploymentTarget {
  provider: "docker" | "fly" | "railway" | "render" | "digitalocean";
  mode: "solo" | "fleet";
  manifest?: string;
  documentation: string;
  expectedStatus: "Verified" | "Validated" | "Field-verified";
  stateRequirement: "Persistent" | "Ephemeral-safe" | "Unsupported";
  versionPolicy: "Pinned" | "Floating";
  replicaCount: number;
  loggingProfile: "journald" | "json-file" | "provider-managed";
  customCa: "mounted" | "platform-trust" | "unsupported";
}
```

and CLI:

```bash
yarn deployment:validate [--template-root ../bsky-rss-fleet-template]
```

- [ ] **Step 1: Write failing metadata tests**

Assert the matrix contains exactly ten provider/mode combinations, with DigitalOcean fleet represented as a Droplet adaptation and App Platform marked unsupported for fleet.

- [ ] **Step 2: Add parser dependencies**

```bash
yarn add -D yaml@^2 smol-toml@^1
```

- [ ] **Step 3: Implement parsers and semantic assertions**

Validate:

- YAML/TOML syntax;
- direct Node commands for fleet;
- pinned numeric image version where image references are present;
- `DRY_RUN=true` default;
- health path `/live` or `/ready` as appropriate;
- one replica for fleet;
- persistent mount/disk/volume for fleet;
- no `latest` or `v<version>` image tags;
- documentation header matches capability metadata;
- referenced files exist.
- published fleet images include revision/provenance and compatibility metadata;
- no fleet template manifest declares a local build context;
- the selected logging backend has a bounded retention contract; and
- custom-CA mapping is either validated generically or explicitly marked unsupported.

- [ ] **Step 4: Add package script**

```json
{
  "deployment:validate": "tsx scripts/validateDeployments.ts"
}
```

- [ ] **Step 5: Run and confirm current manifests fail**

```bash
yarn deployment:validate --template-root ../bsky-rss-fleet-template
```

Expected failures include floating `latest`, solo-only provider manifests, missing fleet provider files, and missing document headers.

- [ ] **Step 6: Commit**

```bash
git add deployment scripts package.json yarn.lock
git commit -m "test: define deployment capability validation"
```

---

### Task 2: Establish Canonical Solo Docker Deployment

**Files (`rmdes/bsky.rss`):**
- Create: `deployment/solo/docker/compose.yaml`
- Create: `deployment/solo/docker/.env.example`
- Create: `documentation/deployment/solo-docker.md`
- Modify: `README.md`
- Test: `scripts/validateDeployments.test.ts`

**Interfaces:**
- Produces a pinned, dry-run-first single-bot Compose deployment.

- [ ] **Step 1: Add failing semantic test**

Assert the solo Compose file contains:

```text
node --import tsx app/index.ts
DRY_RUN=true
one persistent data mount
/live healthcheck
numeric pinned image tag
```

- [ ] **Step 2: Create solo Compose**

Use:

```yaml
services:
  bsky-rss:
    image: ghcr.io/rmdes/bsky.rss:${BSKY_RSS_VERSION:?set BSKY_RSS_VERSION}
    restart: unless-stopped
    command: ["node", "--import", "tsx", "app/index.ts"]
    stop_grace_period: 45s
    environment:
      DRY_RUN: ${DRY_RUN:-true}
      IDENTIFIER: ${IDENTIFIER:?set IDENTIFIER}
      APP_PASSWORD: ${APP_PASSWORD:?set APP_PASSWORD}
      FETCH_URL: ${FETCH_URL:?set FETCH_URL}
      INSTANCE_URL: ${INSTANCE_URL:-https://bsky.social}
      FETCH_INTERVAL: ${FETCH_INTERVAL:-5}
      HEALTH_CHECK_PORT: ${HEALTH_CHECK_PORT:-8080}
    volumes:
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
      start_period: 60s
```

- [ ] **Step 3: Add document header and exact workflow**

Header:

```text
Mode: Solo
Reference deployment: Docker
Provider: Docker
Support status: Verified
State requirement: Persistent
Application version policy: Pinned
```

Document initialization, validation, dry-run, readiness, explicit publishing, backup, update, and rollback.

- [ ] **Step 4: Add local smoke test**

Exercise the Compose file against the controlled feed and AT Protocol fixtures from the runtime plan.

- [ ] **Step 5: Run checks and commit**

```bash
yarn deployment:validate
yarn check
docker compose -f deployment/solo/docker/compose.yaml config
git add deployment/solo/docker documentation/deployment/solo-docker.md README.md scripts
git commit -m "feat: add verified solo Docker deployment"
```

---

### Task 3: Align Solo Managed-Platform Manifests

**Files (`rmdes/bsky.rss`):**
- Modify: `fly.toml`
- Modify: `railway.toml`
- Modify: `render.yaml`
- Modify: `.do/app.yaml`
- Create: `documentation/deployment/solo-flyio.md`
- Create: `documentation/deployment/solo-railway.md`
- Create: `documentation/deployment/solo-render.md`
- Create: `documentation/deployment/solo-digitalocean.md`
- Test: `scripts/validateDeployments.test.ts`

**Interfaces:**
- Produces four solo targets marked `Validated`.

- [ ] **Step 1: Add provider-specific failing assertions**

Fly:

- one machine minimum;
- auto-stop disabled;
- volume mounted at `/build/data`;
- readiness-aware health check;
- direct solo Node command.

Railway:

- `startCommand = "node --import tsx app/index.ts"`;
- one replica documented;
- persistent volume documented because Railway config-as-code does not fully declare user-provisioned volume lifecycle;
- `/ready` health check.

Render:

- paid always-on web service if HTTP health is required, or background worker with explicit external health limitation;
- persistent disk;
- one instance;
- no free-tier recommendation.

DigitalOcean:

- App Platform solo service only;
- `instance_count: 1`;
- direct Node command;
- state limitation stated if durable volume support is unavailable for the selected component type;
- production recommendation becomes Droplet Docker when durable solo state cannot be guaranteed.

- [ ] **Step 2: Refactor manifests**

All manifests set `DRY_RUN=true` by default and expose/inject only non-secret defaults. Credentials remain provider secrets.

Use application version pinning through provider-supported image references where practical. If a provider builds from GitHub rather than pulling GHCR, pin the Git ref/release in the documented deployment process and mark the manifest as source-build pinned.

- [ ] **Step 3: Add mandatory document headers**

Fly.io, Railway, and Render documents use this exact state line:

```text
Mode: Solo
Reference deployment: Docker
Provider: <provider>
Support status: Validated
State requirement: Persistent
Application version policy: Pinned
```

The DigitalOcean solo guide must consult current official provider documentation during implementation and then choose exactly one line: `State requirement: Persistent` when durable mounted state is configured, or `State requirement: Unsupported` when it is unavailable. A combined or provisional header value is forbidden.

- [ ] **Step 4: Document local evidence and field-verification boundary**

Each guide explains what was validated locally and includes a provider checklist for real deployment, restart, persistence, update, and rollback.

- [ ] **Step 5: Run static validation and commit**

```bash
yarn deployment:validate
yarn check
git add fly.toml railway.toml render.yaml .do/app.yaml documentation/deployment scripts
git commit -m "feat: align solo managed deployments"
```

---

### Task 4: Add Fleet Managed-Platform Overlays

**Files (`rmdes/bsky-rss-fleet-template`):**
- Create: `providers/fly/fly.toml`
- Create: `providers/fly/README.md`
- Create: `providers/railway/railway.toml`
- Create: `providers/railway/README.md`
- Create: `providers/render/render.yaml`
- Create: `providers/render/README.md`
- Create: `providers/digitalocean/README.md`
- Create: `providers/digitalocean/cloud-init.yaml`
- Create: `docs/managed-platforms.md`
- Test: application `scripts/validateDeployments.ts`

**Interfaces:**
- Consumes the pinned template image/version contract.
- Produces fleet deployments for Fly.io, Railway, Render, and DigitalOcean Droplet.

- [ ] **Step 1: Add missing-target tests in the application repository**

Run validator against the template checkout and assert each fleet target exists with one replica, persistent state, dry-run-first behavior, direct Node command, and required documentation header.

- [ ] **Step 2: Implement Fly fleet overlay**

Requirements:

```text
process command: node --import tsx fleet/runFleet.ts
one machine
persistent volume at /build/data
config provisioned through the documented Fly file workflow
FLEET_SECRETS_JSON supplied directly by the Fly secret store to the Node process
HTTP health service on 8080
auto-stop off
startup-aware readiness
optional custom CA mapped through a generic read-only mount or documented Fly trust-store adaptation
provider log retention documented and bounded
```

The runtime plan lands first and provides the application-owned `loadFleetSecrets({ json })` path. Pass `FLEET_SECRETS_JSON` directly from the Fly secret store to the direct Node process. Validation and runtime must use that parser and enforce exactly one of `FLEET_SECRETS_JSON` or `FLEET_SECRETS_PATH`. A shell wrapper must not write the JSON to disk or duplicate parsing outside the application.

- [ ] **Step 3: Implement Railway fleet overlay**

Requirements:

- direct Node command;
- one replica;
- mounted volume at `/build/data` documented and verified manually later;
- configuration deployment method that does not bake real secrets into the repository;
- `/ready` health path;
- no horizontal autoscaling.
- generic optional custom CA mapping where supported, with a documented unsupported alternative otherwise;
- bounded provider log retention without emitting private request/error payloads.

- [ ] **Step 4: Implement Render fleet overlay**

Use exactly one paid, always-on web service with persistent disk and HTTP readiness. Use the direct Node command and document that free/sleeping services are unsupported.

Map the optional custom CA contract using a provider-supported read-only secret file or trust-store mechanism and document/test the mapping. Document Render log retention and privacy boundaries separately from application status retention.

- [ ] **Step 5: Implement DigitalOcean fleet adaptation**

Do not create an App Platform fleet manifest. Create a Droplet cloud-init example that:

- installs Docker and Compose;
- creates `/opt/bsky-rss-fleet`;
- writes only non-secret scaffolding;
- requires the operator to install secrets after provisioning;
- enables a systemd unit running `docker compose up`;
- preserves `/opt/bsky-rss-fleet/data` on the Droplet disk.

The guide explicitly states App Platform fleet mode is unsupported because durable local SQLite state cannot be guaranteed.

- [ ] **Step 6: Validate both repositories and commit**

From the application checkout:

```bash
yarn deployment:validate --template-root ../bsky-rss-fleet-template
```

From the template checkout:

```bash
docker compose config
shellcheck scripts/*.sh scripts/lib/*.sh
```

Commit in the template repository:

```bash
git add providers docs/managed-platforms.md
git commit -m "feat: add validated fleet provider deployments"
```

---

### Task 5: Add Cross-Mode Local Deployment Smoke Matrix

**Files (`rmdes/bsky.rss`):**
- Create: `test/deployment/manifestMatrix.test.ts`
- Create: `test/deployment/dockerSolo.test.ts`
- Create: `test/deployment/dockerFleet.test.ts`
- Create: `scripts/runDeploymentMatrix.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Files (`rmdes/bsky-rss-fleet-template`):**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Produces:

```bash
yarn deployment:test --template-root ../bsky-rss-fleet-template
```

- [ ] **Step 1: Write failing matrix test**

The test reads `deployment/capabilities.json` and requires one result record for each target:

```ts
interface DeploymentValidationRecord {
  provider: string;
  mode: "solo" | "fleet";
  manifestValid: boolean;
  localRuntimeSmoke: boolean;
  liveProviderTested: false;
  status: "Verified" | "Validated";
  loggingRetentionValidated: boolean;
  customCaMapping: "validated" | "unsupported";
  notes: string[];
}
```

- [ ] **Step 2: Implement Docker solo and fleet smoke**

Use the controlled fixtures, temporary directories, random health ports, and locally built image. Assert persistence, readiness, graceful stop, and no publication call.

- [ ] **Step 3: Implement managed-target local runtime mapping**

For each managed manifest, extract its image/command/env/state mapping and run the equivalent container locally. This verifies application-mode compatibility without claiming provider lifecycle behavior.

- [ ] **Step 4: Emit evidence artifact**

Write `artifacts/deployment-validation.json` in CI and upload it with `actions/upload-artifact@v4`.

- [ ] **Step 5: Add scripts**

```json
{
  "deployment:test": "tsx scripts/runDeploymentMatrix.ts",
  "check": "yarn typecheck && yarn test && yarn test:smoke && yarn deployment:validate"
}
```

Keep deployment Docker tests in their own CI job if runtime makes the normal unit job slow.

- [ ] **Step 6: Run and commit**

```bash
yarn deployment:validate --template-root ../bsky-rss-fleet-template
yarn deployment:test --template-root ../bsky-rss-fleet-template
git add test/deployment scripts package.json .github/workflows/ci.yml
git commit -m "test: verify solo and fleet deployment matrix"
```

---

### Task 6: Replace Monolithic and Contradictory Deployment Documentation

**Files (`rmdes/bsky.rss`):**
- Create: `documentation/deployment/overview.md`
- Modify: `documentation/DEPLOYMENT.md`
- Modify: `documentation/PLATFORM-COMPARISON.md`
- Modify: `README.md`

**Files (`rmdes/bsky-rss-fleet-template`):**
- Modify: `README.md`
- Modify: `docs/managed-platforms.md`

**Interfaces:**
- Produces one mode-first navigation path and capability matrix.

- [ ] **Step 1: Make `documentation/DEPLOYMENT.md` a compatibility redirect**

Keep the file to avoid broken external links, but reduce it to a short notice linking to `documentation/deployment/overview.md` and the mode/provider guides. Remove duplicated setup instructions.

- [ ] **Step 2: Rewrite platform comparison by capability**

Rows include:

```text
mode support
persistent state
one-replica enforcement
health/readiness
secret method
version pinning
backup/restore
local evidence status
field verification status
known adaptation
```

- [ ] **Step 3: Remove unsupported claims**

Remove or correct:

- “free tier available” recommendations for always-on Render publishing;
- generic “built-in scaling” language for fleet mode;
- optional-state language where state is production-critical;
- `latest` production examples;
- `v2.2.0` GHCR examples;
- statements that managed platforms are field-tested without evidence.

- [ ] **Step 4: Verify links and headers**

Add a documentation test that scans all deployment Markdown files for the six-line mandatory header and verifies relative links exist.

- [ ] **Step 5: Run all checks and commit**

```bash
yarn deployment:validate --template-root ../bsky-rss-fleet-template
yarn check
git add README.md documentation
git commit -m "docs: align deployment guidance by mode and capability"
```

## Deployment Parity Plan Acceptance

Run from sibling checkouts:

```bash
cd bsky.rss
yarn install --immutable
yarn check
yarn deployment:validate --template-root ../bsky-rss-fleet-template
yarn deployment:test --template-root ../bsky-rss-fleet-template

cd ../bsky-rss-fleet-template
shellcheck scripts/*.sh scripts/lib/*.sh tests/*.sh
bash tests/run-all.sh
```

The PRs must list each provider/mode target, log backend/retention choice, custom-CA mapping, and evidence state. Managed providers remain `Validated` unless real deployment records are added separately.

### Production adoption boundary

Deployment-parity acceptance validates reusable artifacts only. Considering a published image for `/home/skyfleet-next` additionally requires image compatibility/provenance comparison, validation of existing config and state, controlled fixture dry-run, consistent backup, an operator-approved change window, readiness evidence, and a recovery path through the previous compatible image. No command in this plan connects to or mutates production.
