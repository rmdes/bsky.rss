# Release and Documentation Synchronization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent the application, published image, fleet template, deployment manifests, and documentation from drifting after the initial implementation.

**Architecture:** Every application release publishes machine-readable compatibility metadata alongside the multi-architecture image. The main repository workflow tests and releases the image, then opens a pinned-version/config synchronization PR in the companion repository. Both repositories validate deployment documentation and compatibility in CI.

**Tech Stack:** GitHub Actions, GHCR, Node.js 24, TypeScript, JSON metadata, GitHub App or fine-grained repository token, Docker Buildx.

## Global Constraints

- The application repository remains authoritative.
- The template pins a numeric released image version.
- Release automation never commits real configuration, secrets, state, or backups.
- Template update PRs are opened, not auto-merged.
- Release tests run before image publication.
- A compatibility change that requires operator action must produce explicit upgrade notes.
- Documentation tests fail on stale paths, unsupported evidence claims, `latest` production examples, or `v`-prefixed image tags.
- Release metadata must support comparison between the locally built image from the **Production-proven baseline** and a published image; a shared `2.2.0` version string is insufficient.
- Compatibility covers existing configuration shapes, per-bot state separation, direct Node entrypoint, single-replica behavior, logging backend/retention, and optional custom CA support.
- Automation never connects to the production host, changes publishing mode, performs container lifecycle actions, or deploys a release. Production transitions require explicit approval and a Field-verified record.

---

### Task 1: Define Release Compatibility Metadata

**Files (`rmdes/bsky.rss`):**
- Create: `release/compatibility.ts`
- Create: `release/compatibility.test.ts`
- Create: `release/generateCompatibility.ts`
- Create: `release/compatibility.schema.json`
- Create: `release/runtime-contract.v1.json`
- Modify: `package.json`

**Interfaces:**
- Produces `dist/compatibility.json`:

```json
{
  "applicationVersion": "2.2.0",
  "image": "ghcr.io/rmdes/bsky.rss:2.2.0",
  "nodeMajor": 24,
  "schemaVersion": 1,
  "supportedModes": ["solo", "fleet"],
  "entrypoints": {
    "solo": ["node", "--import", "tsx", "app/index.ts"],
    "fleet": ["node", "--import", "tsx", "fleet/runFleet.ts"],
    "fleetValidate": ["node", "--import", "tsx", "fleet/validateFleet.ts"]
  },
  "health": {
    "portEnvironmentVariable": "HEALTH_CHECK_PORT",
    "paths": ["/live", "/ready", "/health", "/status"]
  },
  "statePaths": {
    "solo": "/build/data",
    "fleet": "/build/data/fleet"
  },
  "minimumTemplateFormatVersion": 1,
  "imageProvenance": {
    "sourceRevision": "<full-git-commit>"
  },
  "runtimeContract": {
    "contractVersion": 1,
    "input": "release/runtime-contract.v1.json",
    "digestAlgorithm": "sha256",
    "runtimeContractDigest": "sha256:<lowercase-hex-digest>",
    "invariants": {
      "configuration": {
        "fleetSchemaVersion": 1,
        "soloShape": "environment-to-versioned-schema",
        "botShape": "unchanged-v1",
        "postShape": "unchanged-v1",
        "secretsShape": "flat-string-map",
        "schemaDigests": {
          "solo": "sha256:<solo-schema-digest>",
          "fleet": "sha256:<fleet-schema-digest>",
          "bot": "sha256:<bot-schema-digest>",
          "post": "sha256:<post-schema-digest>",
          "secrets": "sha256:<secrets-schema-digest>"
        }
      },
      "state": {
        "productionConfiguredWorkers": 59,
        "productionSqliteStores": 59,
        "separation": "one-sqlite-store-per-bot",
        "durableMountsRequired": true
      },
      "authentication": {
        "strategy": "sequential",
        "staggerSeconds": 30
      },
      "queue": {
        "perBotMaximum": 500,
        "drainIntervalSeconds": 60,
        "freshnessCatchUpItems": 5,
        "freshnessMaximumAgeMinutes": 120,
        "rateLimitSemantics": "defer-recognized-skip-uncertain"
      },
      "process": {
        "fleetEntrypoint": ["node", "--import", "tsx", "fleet/runFleet.ts"],
        "activePublisherReplicas": 1,
        "stopGraceSeconds": 45
      },
      "logging": {
        "supportedBackends": ["journald", "json-file"],
        "boundedRetentionRequired": true
      },
      "customCa": {
        "optional": true,
        "environment": "NODE_EXTRA_CA_CERTS"
      }
    }
  },
  "failureCategories": ["feed-retrieval", "open-graph-fallback", "item-handler"]
}
```

`release/runtime-contract.v1.json` is the canonical, versioned digest input and contains exactly `contractVersion` plus the `invariants` object above. Generate `runtimeContractDigest` by parsing the JSON, recursively sorting object keys lexicographically while preserving array order, serializing with `JSON.stringify` and no whitespace, encoding the result as UTF-8, and calculating SHA-256 as lowercase hexadecimal prefixed by `sha256:`. The generator embeds the parsed contract version and invariants plus the input path, algorithm, and digest in `compatibility.json`; it must never hash Markdown prose, timestamps, absolute paths, Git worktree state, or production data.

- [ ] **Step 1: Write failing metadata tests**

Assert version comes from `package.json`, image tag is numeric without leading `v`, source revision is non-placeholder provenance, entrypoints match checked-in files, and health paths match shared health constants. Assert the canonical runtime-contract input and emitted invariants explicitly preserve current config shapes, 59 configured workers and 59 independent per-bot SQLite stores, state separation, durable mounts, 30-second sequential authentication, queue/freshness/rate-limit semantics, direct Node fleet entrypoint, one active publisher, 45-second stop grace, bounded `journald`/`json-file` retention, and optional `NODE_EXTRA_CA_CERTS`. Assert all three failure categories remain distinct.

Digest tests must independently calculate every schema digest and the canonical runtime-contract SHA-256, compare them with generated metadata, and prove that changing each invariant group changes `runtimeContractDigest`. Contract tests compare the direct Node/one-publisher/45-second settings with reference Compose, execute the controlled 59-worker/30-second fixture, and assert the recorded queue/freshness/rate-limit behavior. A missing input, unknown contract version, non-canonical digest, missing invariant, changed value, or version-only match must fail compatibility verification. These are metadata and test contracts; they do not rewrite production configuration or state.

- [ ] **Step 2: Run and confirm failure**

```bash
yarn tsx --test release/compatibility.test.ts
```

- [ ] **Step 3: Implement typed metadata generation**

Export:

```ts
export interface ReleaseCompatibility { /* exact fields above */ }
export function buildCompatibility(): ReleaseCompatibility;
```

Write JSON with stable key order and trailing newline.

- [ ] **Step 4: Add scripts**

```json
{
  "release:compatibility": "tsx release/generateCompatibility.ts",
  "release:verify": "yarn check && yarn deployment:validate && yarn release:compatibility"
}
```

- [ ] **Step 5: Run and commit**

```bash
yarn release:verify
git add release package.json
git commit -m "feat: publish release compatibility metadata"
```

---

### Task 2: Publish Compatibility Metadata with the Image

**Files (`rmdes/bsky.rss`):**
- Modify: `Dockerfile`
- Modify: `.github/workflows/release-image.yml`
- Create: `release/verifyImage.ts`
- Create: `release/verifyImage.test.ts`

**Interfaces:**
- The image contains `/build/release/compatibility.json` and `/build/release/runtime-contract.v1.json`.
- The release workflow uploads `compatibility.json` and `runtime-contract.v1.json` as GitHub release assets or workflow artifacts and exposes both to the template update job.

- [ ] **Step 1: Write failing image verification test**

The verifier runs a built image and asserts:

```bash
docker run --rm <image> node -e "const x=require('fs').readFileSync('/build/release/compatibility.json','utf8'); console.log(x)"
```

It compares image metadata and the canonical runtime-contract input against the source-generated files, recomputes the digest independently, and checks every preserved invariant.

The verifier also checks OCI source/revision/version labels and proves the embedded revision/provenance fields agree with the image. These fields are required for later comparison with a locally built production image; matching application-version strings alone must fail the transition comparison.

- [ ] **Step 2: Run and confirm failure**

Build the current image and run the verifier; expected failure because generated metadata is absent.

- [ ] **Step 3: Generate metadata before Docker build**

Workflow order:

```yaml
- run: yarn install --immutable
- run: yarn release:verify
- uses: docker/setup-qemu-action@v3
- uses: docker/setup-buildx-action@v3
- uses: docker/build-push-action@v6
```

Ensure `dist/compatibility.json` and `release/runtime-contract.v1.json` are copied into the image at `/build/release/compatibility.json` and `/build/release/runtime-contract.v1.json` without copying unrelated build output.

- [ ] **Step 4: Verify the built image before push**

Use a local single-platform Buildx load step for verification, then perform the multi-platform push only after verification succeeds.

- [ ] **Step 5: Upload metadata artifact**

```yaml
- uses: actions/upload-artifact@v4
  with:
    name: release-compatibility-${{ github.ref_name }}
    path: |
      dist/compatibility.json
      release/runtime-contract.v1.json
```

- [ ] **Step 6: Run tests and commit**

```bash
yarn release:verify
docker build -t bsky-rss:release-test .
yarn tsx release/verifyImage.ts bsky-rss:release-test
git add Dockerfile .github/workflows/release-image.yml release
git commit -m "ci: verify image compatibility metadata"
```

---

### Task 3: Add Template Compatibility Contract

**Files (`rmdes/bsky-rss-fleet-template`):**
- Create: `template-format.json`
- Create: `scripts/check-compatibility.sh`
- Create: `tests/compatibility.sh`
- Modify: `scripts/validate.sh`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- `template-format.json`:

```json
{
  "templateFormatVersion": 1,
  "applicationVersion": "2.2.0",
  "schemaVersion": 1,
  "runtimeContractVersion": 1,
  "runtimeContractDigest": "sha256:<lowercase-hex-digest>"
}
```

- Produces:

```bash
scripts/check-compatibility.sh [image]
```

- [ ] **Step 1: Write failing compatibility tests**

Use a fake image metadata JSON and assert the script rejects:

- application version mismatch;
- schema version mismatch;
- template format below `minimumTemplateFormatVersion`;
- missing fleet entrypoint;
- missing validation entrypoint;
- unexpected state path;
- missing or mismatched source revision, runtime-contract version, canonical input, or digest;
- changed/missing config-shape, 59-store/state-separation, 30-second-stagger, queue/freshness/rate-limit, direct-Node, durable-mount, one-publisher, 45-second-grace, logging, or custom-CA invariant;
- missing logging-profile retention metadata;
- missing optional custom-CA capability metadata; and
- collapsed or missing feed-retrieval, Open Graph fallback, or item-handler categories.

- [ ] **Step 2: Run and confirm failure**

```bash
bash tests/compatibility.sh
```

- [ ] **Step 3: Implement image metadata extraction**

```bash
docker run --rm --entrypoint node "$image" \
  -e "const fs=require('fs'); process.stdout.write(JSON.stringify({compatibility:JSON.parse(fs.readFileSync('/build/release/compatibility.json','utf8')),runtimeContract:JSON.parse(fs.readFileSync('/build/release/runtime-contract.v1.json','utf8'))}))"
```

Write output to a temporary file with mode `0600`; remove it on exit.

- [ ] **Step 4: Compare with template contract**

Use a short Node command inside the application image or a checked-in Node script; do not parse JSON with fragile shell text processing. Recompute the canonical digest from the extracted runtime-contract input, require it to match both image metadata and `template-format.json`, and compare every invariant rather than accepting a contract-version match alone.

- [ ] **Step 5: Integrate validation and CI**

`scripts/validate.sh` runs compatibility checks before validating mounted config. CI checks the pinned image from `.env.example`.

- [ ] **Step 6: Run and commit**

```bash
bash tests/compatibility.sh
bash tests/run-all.sh
git add template-format.json scripts tests .github/workflows/ci.yml README.md
git commit -m "feat: enforce application template compatibility"
```

---

### Task 4: Automate Companion Version-Update Pull Requests

**Files (`rmdes/bsky.rss`):**
- Create: `.github/workflows/update-fleet-template.yml`
- Create: `release/renderTemplateUpdate.ts`
- Create: `release/renderTemplateUpdate.test.ts`
- Modify: `.github/workflows/release-image.yml`

**Files (`rmdes/bsky-rss-fleet-template`):**
- Create: `.github/pull_request_template.md`

**Interfaces:**
- A successful tagged release dispatches or calls a workflow that opens a branch in the template repository containing only:
  - updated `BSKY_RSS_VERSION` in `.env.example`;
  - updated `applicationVersion`, `schemaVersion`, `runtimeContractVersion`, and `runtimeContractDigest` in `template-format.json`;
  - synchronized example config files when schema-compatible changes require them;
  - generated upgrade notes.
  - compatibility/provenance comparison instructions and required Field-verified production-transition evidence.

- [ ] **Step 1: Write failing update-render tests**

Given old template files and new compatibility metadata, assert exact deterministic replacements and a Markdown summary listing:

```text
old version
new version
schema change
runtime contract version and digest change
configuration files changed
required operator action
verification commands
```

- [ ] **Step 2: Run and confirm failure**

```bash
yarn tsx --test release/renderTemplateUpdate.test.ts
```

- [ ] **Step 3: Implement update rendering without GitHub side effects**

```ts
export interface TemplateUpdate {
  files: Map<string, string>;
  title: string;
  body: string;
}

export function renderTemplateUpdate(input: {
  compatibility: ReleaseCompatibility;
  currentTemplateFiles: Map<string, string>;
  canonicalExamples: Map<string, string>;
}): TemplateUpdate;
```

Keep GitHub API interaction in the workflow, not the pure renderer.

- [ ] **Step 4: Add workflow permissions and secret contract**

Prefer a GitHub App installation token with access limited to the two repositories. If unavailable, use a fine-grained token named `FLEET_TEMPLATE_UPDATE_TOKEN` with only contents and pull-request write permissions on the template repository.

Workflow steps:

1. download compatibility artifact;
2. check out template repository;
3. run current template CI against the new image;
4. render updates;
5. create branch `release/bsky-rss-<version>`;
6. commit changes;
7. open draft PR;
8. never auto-merge.

- [ ] **Step 5: Add release workflow handoff**

Invoke the update workflow only after image push and image verification succeed.

- [ ] **Step 6: Test with dry-run mode**

Support `workflow_dispatch` with `dry_run: true` that uploads the proposed patch and PR body as artifacts without writing to the companion repository.

- [ ] **Step 7: Commit**

```bash
yarn check
yarn release:verify
git add .github/workflows release
git commit -m "ci: propose fleet template updates on release"
```

---

### Task 5: Reorganize Authoritative Documentation

**Files (`rmdes/bsky.rss`):**
- Create: `documentation/architecture/fleet.md`
- Create: `documentation/architecture/state-and-queues.md`
- Create: `documentation/architecture/scheduling.md`
- Create: `documentation/architecture/authentication.md`
- Create: `documentation/operations/backup-and-restore.md`
- Create: `documentation/operations/provider-verification.md`
- Modify: `README.md`

**Files (`rmdes/bsky-rss-fleet-template`):**
- Create: `docs/troubleshooting.md`
- Create: `docs/provider-verification.md`
- Modify: `README.md`

**Interfaces:**
- Produces stable public documentation boundaries without relying on gitignored `CLAUDE.md`.

- [ ] **Step 1: Move current runtime architecture content out of machine-local notes**

Document public contracts for configuration layout, SQLite tables/state, authentication staggering, shared limiters, queue behavior, startup, shutdown, backup, update compatibility, and previous-compatible-image recovery. Include distinct feed-retrieval, Open Graph fallback, and item-handler diagnostics; selected log backend/retention; optional custom CA behavior; and identifier-free status. Do not copy private scratchpad commentary or unverified claims. Leave the existing legacy documentation structure and current fleet guide unchanged.

- [ ] **Step 2: Add current architecture navigation without changing the fleet guide**

Link the new focused architecture, operations, and template documents from the main README and other newly created current-deployment documents.

- [ ] **Step 3: Add field-verification record format**

Provider verification records use:

```yaml
provider: fly
mode: fleet
region: ams
applicationVersion: 2.2.0
deploymentDate: 2026-08-03
healthVerified: true
persistenceRestartVerified: true
upgradeVerified: true
previousImageRecoveryVerified: false
verifiedBy: rmdes
limitations:
  - previous image recovery not yet exercised
```

Store real records under `documentation/verification/<provider>/<mode>/<date>.yaml`. Do not create fabricated records during automated implementation.

Any production image transition record must additionally include the approved change window; source local-image digest, revision/provenance, and runtime-contract digest; target published-image digest, revision/provenance, and runtime-contract digest; invariant-by-invariant compatibility evidence; configuration/state validation evidence; controlled fixture dry-run result; consistent backup reference; readiness evidence; and previous-compatible-image recovery evidence. Use sanitized artifact references only; never record private identifiers, URLs, environment values, database contents, or raw logs.

- [ ] **Step 4: Add troubleshooting decision trees**

Cover validation failure, placeholder secret, lock conflict, partial activation, all bots failed, stale scheduler, volume missing, database recovery, health mismatch, update failure, and previous-image recovery.

- [ ] **Step 5: Commit repository-specific documentation**

Application:

```bash
git add README.md documentation
git commit -m "docs: publish fleet architecture and operations"
```

Template:

```bash
git add README.md docs
git commit -m "docs: add fleet troubleshooting and verification"
```

---

### Task 6: Add Documentation and Drift Tests

**Files (`rmdes/bsky.rss`):**
- Create: `test/documentation/deploymentDocs.test.ts`
- Create: `test/documentation/links.test.ts`
- Create: `test/documentation/imageTags.test.ts`
- Create: `test/documentation/evidenceClaims.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`

**Files (`rmdes/bsky-rss-fleet-template`):**
- Create: `tests/documentation.sh`
- Modify: `tests/run-all.sh`

**Interfaces:**
- Prevents future drift and unsupported claims.

- [ ] **Step 1: Write failing document-header tests**

Every Markdown file under `documentation/deployment/` and `providers/*/README.md` must contain exactly one header block with mode, reference deployment, provider, support status, state requirement, and version policy.

- [ ] **Step 2: Add link tests**

Resolve repository-relative Markdown links and fail on missing files or case mismatches. Ignore external URLs.

- [ ] **Step 3: Add image-tag tests**

Reject production snippets matching:

```text
ghcr.io/rmdes/bsky.rss:latest
ghcr.io/rmdes/bsky.rss:v[0-9]
```

Allow `latest` only in an explicitly labeled development-warning section.

- [ ] **Step 4: Add evidence-claim tests**

Reject `Field-verified` unless the document references an existing verification record. Reject unqualified phrases such as “fully tested on Fly.io” without a record path.

- [ ] **Step 5: Add stale architecture tests**

Reject links from current deployment documents to `documentation/v1-to-v2.md` and references to gitignored `CLAUDE.md` as authoritative documentation.

Add drift assertions that current deployment documents:

- distinguish feed-retrieval, Open Graph fallback, and item-handler failures;
- declare the selected logging backend and bounded retention policy;
- describe optional custom CA support generically when available; and
- never claim a production image transition is Field-verified without its transition record.

- [ ] **Step 6: Integrate checks**

```json
{
  "test:docs": "tsx --test test/documentation/*.test.ts",
  "check": "yarn typecheck && yarn test && yarn test:smoke && yarn deployment:validate && yarn test:docs"
}
```

- [ ] **Step 7: Run and commit**

```bash
yarn check
bash ../bsky-rss-fleet-template/tests/run-all.sh
git add test/documentation package.json .github/workflows/ci.yml
git commit -m "test: prevent deployment documentation drift"
```

---

### Task 7: Final Cross-Repository Release Rehearsal

**Files:**
- No production file changes expected; fixes discovered by rehearsal belong in the preceding task’s files.
- Create evidence artifacts locally or in CI; do not commit generated secrets/state.

**Interfaces:**
- Exercises the complete release-to-template flow without publishing to Bluesky or deploying to external providers.

- [ ] **Step 1: Build a release candidate image**

```bash
cd bsky.rss
yarn install --immutable
yarn release:verify
docker build -t ghcr.io/rmdes/bsky.rss:release-candidate .
yarn tsx release/verifyImage.ts ghcr.io/rmdes/bsky.rss:release-candidate
```

- [ ] **Step 2: Run application verification**

```bash
yarn check
yarn deployment:validate --template-root ../bsky-rss-fleet-template
yarn deployment:test --template-root ../bsky-rss-fleet-template
```

- [ ] **Step 3: Run template verification against candidate image**

Override the template image/version locally without committing the candidate tag:

```bash
cd ../bsky-rss-fleet-template
BSKY_RSS_IMAGE=ghcr.io/rmdes/bsky.rss:release-candidate bash tests/run-all.sh
```

- [ ] **Step 4: Rehearse update PR rendering**

Run the release update workflow in dry-run mode or invoke the pure renderer locally. Inspect the proposed patch and prove it changes only expected template files.

- [ ] **Step 5: Scan for sensitive material**

```bash
git grep -nE 'app-password|accessJwt|refreshJwt|REPLACE-WITH-REAL' -- ':!secrets.example/**' ':!test/**'
git status --ignored --short
```

Investigate every result; placeholders are allowed only in clearly named example/test files.

- [ ] **Step 6: Produce final evidence summary**

Record:

- exact commits tested in both repositories;
- image digest;
- source/target runtime-contract versions, digests, and invariant comparison result;
- unit/typecheck/smoke counts;
- Docker solo/fleet verification results;
- managed manifest validation results;
- untested live-provider boundary;
- untested live-Bluesky boundary.
- untested production-deployment boundary unless an explicitly approved field operation produced the required record.

- [ ] **Step 7: Request final review and merge in dependency order**

Merge order:

1. application runtime/release support;
2. companion template compatibility update;
3. deployment/documentation changes that depend on both.

## Release and Documentation Plan Acceptance

The program closes only when:

```bash
cd bsky.rss
yarn release:verify
yarn deployment:test --template-root ../bsky-rss-fleet-template
yarn test:docs

cd ../bsky-rss-fleet-template
bash tests/run-all.sh
```

all exit 0, the compatibility update dry run produces the expected patch, and the final report explicitly distinguishes local verification from field verification. No release or documentation workflow deploys to production; a production image transition is complete only when a separate approved Field-verified record satisfies the compatibility/provenance gate.
