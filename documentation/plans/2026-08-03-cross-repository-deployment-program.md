# Cross-Repository Deployment Capability Implementation Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver aligned, testable solo and fleet deployments for Docker, Fly.io, Railway, Render, and DigitalOcean across `rmdes/bsky.rss` and `rmdes/bsky-rss-fleet-template` without claiming live-provider or live-Bluesky verification that was not performed.

**Architecture:** `rmdes/bsky.rss` remains the source of truth for runtime contracts, schemas, health semantics, image releases, solo manifests, and compatibility metadata. `rmdes/bsky-rss-fleet-template` consumes a pinned release and owns the fleet operator experience, lifecycle scripts, and fleet provider overlays. Docker is the verified behavioral reference; managed platforms are validated statically and through local image/mode smoke tests until field evidence is recorded.

**Tech Stack:** Node.js 24, TypeScript 6, Yarn 4, Node test runner, Ajv JSON Schema validation, Docker/Compose, GitHub Actions, Fly TOML, Railway TOML, Render Blueprint YAML, DigitalOcean App Spec YAML, SQLite.

## Global Constraints

- Support both `solo` and `fleet` execution modes.
- Docker Compose is the default and behavioral reference deployment.
- Fleet mode runs as exactly one active publisher replica.
- Production deployments require durable state.
- Fleet examples default to `DRY_RUN=true`; solo mode gains the same contract.
- Production image references are pinned to a released numeric tag such as `2.2.0`, never `latest` by default.
- Image documentation must reflect that Git tag `v2.2.0` publishes image tag `2.2.0`.
- Real credentials, sessions, databases, and backups must never be committed or logged.
- Managed deployments are marked `Validated` until real provider evidence exists.
- No live Bluesky publishing is required for automated acceptance.
- Tests use controlled RSS/Atom fixtures and mocked AT Protocol responses.
- Every implementation PR must preserve the existing one-container-per-bot migration and rollback tooling.

---

## Normative Plan Review

Read [`2026-08-03-plan-review-decisions.md`](2026-08-03-plan-review-decisions.md) before executing any detailed plan. Those reviewed decisions override conflicting illustrative snippets in the task documents, including:

- Ajv 2020-12 initialization;
- non-breaking schema-version placement;
- application-owned `FLEET_SECRETS_JSON` parsing;
- configurable healthcheck ports;
- graceful-stop filesystem backups;
- valid mounted secrets for image acceptance;
- exact Render and DigitalOcean deployment choices.

## Plan Suite

Execute the plans in this order:

1. [`2026-08-03-runtime-contracts.md`](2026-08-03-runtime-contracts.md)
   - Canonical test/check commands.
   - JSON Schemas and deterministic validation.
   - Compatible solo/fleet health, readiness, and status.
   - Solo dry-run and lifecycle parity.
   - Mocked feed-to-publication-boundary smoke harness.

2. [`2026-08-03-fleet-template-hardening.md`](2026-08-03-fleet-template-hardening.md)
   - Safe clone-and-run operator surface.
   - Credential protection and dry-run-first defaults.
   - Version pinning.
   - Initialization, validation, backup, restore, update, and rollback scripts.
   - Template CI using the runtime contracts from Plan 1.

3. [`2026-08-03-deployment-parity.md`](2026-08-03-deployment-parity.md)
   - Canonical solo and fleet Docker deployments.
   - Fly.io, Railway, Render, and DigitalOcean adaptations.
   - Static manifest validation and local mode smoke matrix.
   - Explicit Verified/Validated/Field-verified evidence labels.

4. [`2026-08-03-release-and-documentation-sync.md`](2026-08-03-release-and-documentation-sync.md)
   - Release compatibility metadata.
   - Automated template update PRs.
   - Documentation information architecture and stale-claim removal.
   - Provider field-verification records and final consistency checks.

## Repository and Worktree Layout

At execution time, create sibling worktrees so cross-repository changes can be tested together without contaminating either default checkout:

```text
worktrees/
  bsky-rss-runtime/
  bsky-rss-fleet-template/
```

Use the branch naming convention:

```text
agent/runtime-contracts
agent/fleet-template-hardening
agent/deployment-parity
agent/release-documentation-sync
```

Each plan produces one focused PR in the repository or repositories it changes. Cross-repository phases may use two coordinated PRs, but each PR must explain its dependency and compatibility version.

## Program Acceptance

The implementation program is complete only when all of the following are evidenced:

- `yarn test`, `yarn typecheck`, and `yarn check` pass in `bsky.rss`.
- Solo and fleet Docker smoke tests pass with controlled fixtures and no real Bluesky post.
- Fleet configuration validation rejects malformed, duplicate, placeholder, and incompatible inputs.
- Solo and fleet health endpoints expose consistent liveness, readiness, health, and status semantics.
- Fleet startup reports `starting` during staggered activation rather than becoming falsely unhealthy.
- The fleet template starts in dry-run with a pinned image and cannot accidentally commit runtime secrets or state.
- Backup and restore tests prove SQLite-consistent state recovery.
- Fly.io, Railway, Render, and DigitalOcean manifests parse and satisfy the capability matrix or explicitly document unsupported features.
- Every deployment document declares mode, provider, evidence status, state requirement, and version policy.
- A release compatibility check verifies that the template examples and pinned image agree with application schemas and entry points.
- The release workflow can open a version-update PR in the companion repository.
- No document claims field verification without a dated provider verification record.

## PR and Review Gates

After each plan:

1. Run every command listed in that plan from a clean worktree.
2. Inspect the complete diff for secret material and unrelated changes.
3. Request code review using `superpowers:requesting-code-review`.
4. Address feedback using `superpowers:receiving-code-review`.
5. Re-run the full verification matrix.
6. Publish a draft PR.
7. Merge only after the plan-specific acceptance checklist is satisfied.

Do not combine all four workstreams into one implementation PR. Runtime contracts must land before the template and provider manifests depend on them.
