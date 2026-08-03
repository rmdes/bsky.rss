# Cross-Repository Deployment Capability Design

**Date:** 2026-08-03  
**Status:** Approved design, pending implementation plan  
**Authoritative repository:** `rmdes/bsky.rss`  
**Companion deployment repository:** `rmdes/bsky-rss-fleet-template`

## 1. Purpose

This document defines the product, deployment, documentation, testing, release, and operational contract shared by `rmdes/bsky.rss` and `rmdes/bsky-rss-fleet-template`.

The goal is to make both supported execution modes—solo and fleet—deployable through Docker by default and through managed platforms where equivalent behavior is technically possible. Managed deployments must either match the Docker reference capabilities or explicitly document the required adaptation and remaining limitation.

This design converts the current repository audit into one implementation contract. It supersedes informal assumptions spread across READMEs, deployment files, commit messages, and machine-local notes.

### 1.1 Normative production baseline and adoption boundary

The following reports are normative preconditions for this program:

- [Production fleet baseline](../reports/2026-08-03-production-fleet-baseline.md)
- [Repository/production drift matrix](../reports/2026-08-03-repository-production-drift-matrix.md)

`/home/skyfleet-next` is the authoritative current production fleet. It is a **Production-proven baseline**: the operator attests to at least three days of successful operation, while direct process evidence showed four days of uninterrupted container uptime, zero restarts, and no OOM event. That evidence establishes stable process operation, not readiness or all-bot health. Health, graceful shutdown, backup, restore, update, and rollback remain unverified until their lifecycle cases are exercised.

Production adoption is incremental **in-place hardening**; historical legacy migration/export remains outside scope. Implementation and automated acceptance may create and validate artifacts, but they do not authorize access to the production host, container lifecycle actions, publishing changes, or deployment. Any production adoption is a separate, explicitly operator-approved and **Field-verified** operation.

All implementation must preserve the current configuration shapes, 59 independent per-bot SQLite stores, per-bot state separation, 30-second sequential authentication staggering, queue/freshness/rate-limit behavior, direct Node entrypoint, durable mounts, single-publisher invariant, 45-second stop grace, and optional custom-CA capability unless a separately approved compatibility change proves an equivalent replacement.

## 2. Product model

`bsky.rss` is one product with two execution modes.

### 2.1 Solo mode

Solo mode runs one RSS or Atom feed against one Bluesky account in one process.

Reference entry point:

```text
node --import tsx app/index.ts
```

Solo mode remains appropriate for a single bot, low-complexity deployments, and managed platforms where one process, one account, and one persistent state directory are sufficient.

### 2.2 Fleet mode

Fleet mode runs multiple independently configured bots in one Node.js process.

Reference entry point:

```text
node --import tsx fleet/runFleet.ts
```

Each bot has independent configuration, credentials, queue state, session state, cursor state, deduplication state, and scheduling behavior. The fleet shares bounded Open Graph and image-processing concurrency. Authentication is staggered to avoid login bursts.

Fleet mode must run as exactly one active publisher replica unless a future architecture introduces distributed locking and shared transactional state. Managed platforms must disable horizontal autoscaling for fleet deployments.

## 3. Repository responsibilities

### 3.1 `rmdes/bsky.rss`

The application repository owns:

- Solo and fleet source code.
- Shared domain behavior.
- Configuration types and schemas.
- Configuration validation.
- Health, readiness, and status semantics.
- Unit, integration, lifecycle, and dry-run tests.
- Docker image construction.
- Versioned GHCR releases.
- Provider-neutral deployment requirements.
- Solo deployment manifests.
- Fleet development and source-build examples.
- Current runtime compatibility and architecture documentation.
- The cross-repository deployment capability matrix.
- The release compatibility contract consumed by the fleet template.

Existing legacy importer/exporter code and historical documents remain untouched and outside this program. They are not current deployment deliverables or acceptance dependencies.

### 3.2 `rmdes/bsky-rss-fleet-template`

The companion repository owns the canonical fleet operator experience:

- Fleet Docker Compose deployment using a published image.
- Safe runtime directory initialization.
- Example fleet and per-bot configuration.
- Example secret-file shape without real credentials.
- Dry-run-first startup.
- Application version pinning.
- Backup, restore, update, and rollback procedures.
- Fleet-specific managed-platform manifests or overlays.
- Fleet operator troubleshooting.
- Provider field-verification checklists.
- Compatibility validation against a released `bsky.rss` image.

The template is deploy-only. It must not duplicate application source.

### 3.3 Source of truth

The application repository is authoritative for:

- Configuration schema.
- Runtime environment variables.
- Entrypoints.
- Health semantics.
- State layout.
- Image tags.
- Supported application capabilities.

The template repository may present operator-friendly examples, but those examples must be validated against the application release they pin.

## 4. Capability-first deployment contract

Deployment support is defined by capabilities rather than by provider marketing names.

Every supported deployment must address the following capabilities:

1. Correct solo or fleet entry point.
2. Safe dry-run behavior.
3. Persistent state.
4. Credential isolation.
5. Configuration validation.
6. Health and readiness.
7. Graceful shutdown.
8. Bounded restart behavior.
9. Version pinning.
10. Upgrade and rollback.
11. Backup and restore.
12. Log management.
13. Observability.
14. Single-replica enforcement for fleet mode.
15. Cross-repository compatibility.
16. Documented verification status.

Docker Compose is the behavioral reference implementation. Other providers must match these capabilities where possible. Where they cannot, the deployment documentation must state the adaptation, operational consequence, and support status.

## 5. Support and verification states

Every deployment document and its corresponding manifest set must declare one of three evidence levels.

### 5.1 Verified

A deployment is **Verified** when its complete local behavior has been executed and evidenced, including:

- Image build or image pull.
- Configuration validation.
- Dry-run startup.
- Feed polling against controlled fixtures.
- Queue processing up to the final Bluesky publication boundary.
- Health and readiness behavior.
- State persistence across restart.
- Graceful shutdown.
- Upgrade or replacement lifecycle.
- Backup and restore where applicable.

Docker solo and Docker fleet are expected to reach this level in this implementation cycle.

### 5.2 Validated

A deployment is **Validated** when:

- Its manifest parses.
- Required provider fields are present.
- Entrypoints, ports, mounts, secrets, and state paths match the application contract.
- The same image and mode are exercised locally.
- Static checks and provider-specific semantic checks pass.
- No live deployment to the external provider has been performed in this cycle.

Managed platform deployments may reach this level without live provider credentials.

### 5.3 Field-verified

A deployment is **Field-verified** only after a real deployment records:

- Provider and region.
- Application version.
- Solo or fleet mode.
- Deployment date.
- Health and readiness evidence.
- Persistent-state restart evidence.
- Upgrade evidence.
- Rollback evidence where supported.
- Known limitations.

No document may imply field verification without this record.

## 6. Deployment matrix

The target support matrix is:

| Provider | Solo mode | Fleet mode | Reference status target | Notes |
|---|---:|---:|---|---|
| Docker Compose | Yes | Yes | Verified | Default and behavioral reference |
| Fly.io | Yes | Yes | Validated | Fleet requires one machine and persistent volume |
| Railway | Yes | Yes | Validated | Fleet requires one replica and persistent volume |
| Render | Yes | Yes | Validated | Fleet uses one paid, always-on web service with persistent disk |
| DigitalOcean App Platform | Yes | No | Validated | Fleet is unsupported; DigitalOcean fleet uses a one-Droplet Docker Compose adaptation |

DigitalOcean App Platform fleet mode is unsupported. DigitalOcean fleet support is exactly one Droplet running the Docker Compose reference. The DigitalOcean solo guide must use current official provider evidence to select one exact state requirement: `Persistent` when durable mounted state is configured, otherwise `Unsupported`.

## 7. Documentation contract

### 7.1 Mandatory document header

Every deployment document must begin with:

```text
Mode: Solo | Fleet | Both
Reference deployment: Docker
Provider: Docker | Fly.io | Railway | Render | DigitalOcean
Support status: Verified | Validated | Field-verified
State requirement: Persistent | Ephemeral-safe | Unsupported
Application version policy: Pinned | Floating
```

### 7.2 Information architecture in `bsky.rss`

The main README must present an explicit decision path:

```text
Run one bot
  Docker
  Fly.io
  Railway
  Render
  DigitalOcean

Run a fleet
  New deployment -> bsky-rss-fleet-template
  Existing current fleet -> in-place hardening and update operations
  Build from source -> fleet development guide
```

The application documentation should be organized by responsibility:

```text
documentation/
  architecture/
    fleet.md
    state-and-queues.md
    scheduling.md
    authentication.md

  deployment/
    overview.md
    solo-docker.md
    solo-flyio.md
    solo-railway.md
    solo-render.md
    solo-digitalocean.md
    fleet-from-source.md

  operations/
    backup-and-restore.md
    provider-verification.md

  specs/
    2026-08-03-cross-repository-deployment-capabilities-design.md
```

Historical v1-to-v2 material is not part of the current production architecture. It may remain untouched as archived history, but this program does not create migration documentation, require legacy import/export tests, modify `documentation/fleet.md`, or link historical material as an active prerequisite.

### 7.3 Information architecture in `bsky-rss-fleet-template`

The fleet template should contain:

```text
README.md
.env.example
.gitignore
compose.yaml

config.example/
  fleet.json
  bots/
    example-bot/
      bot.json
      config.json

secrets.example/
  bsky-fleet.json

scripts/
  init.sh
  validate.sh
  start-dry-run.sh
  enable-publishing.sh
  update.sh
  backup.sh
  restore.sh

providers/
  fly/
  railway/
  render/
  digitalocean/

docs/
  configuration.md
  operations.md
  backup-and-restore.md
  upgrading.md
  troubleshooting.md
  managed-platforms.md
  provider-verification.md
```

The root README remains a concise quickstart. Detailed operations belong under `docs/`.

## 8. Safety requirements

### 8.1 Dry-run first

Fleet deployment examples must default to dry-run.

Reference Compose behavior:

```yaml
environment:
  DRY_RUN: ${DRY_RUN:-true}
```

Publishing becomes active only through an explicit operator action.

Solo mode must support the same dry-run contract so deployment behavior is consistent across modes.

### 8.2 Credentials

- Real credentials must never be committed.
- `secrets/`, runtime data, environment override files, and backup output must be ignored.
- Secret example files must contain unmistakable placeholders.
- Validation must reject known placeholder values.
- Secrets must not appear in logs, thrown errors, health payloads, or generated support bundles.
- Managed deployments must use provider secret stores.
- File-based secrets must be supported where the provider can mount secrets as files.

### 8.3 Runtime state

Solo state and fleet SQLite state must be stored on durable storage for production deployments.

Fleet state includes:

- AT Protocol sessions.
- Deduplication history.
- Cursor state.
- Queue state.

A fleet deployment without durable state must be marked unsupported for production.

### 8.4 Version pinning

The fleet template must pin the currently supported released application version. At the date of this specification, the baseline is:

```text
BSKY_RSS_VERSION=2.2.0
```

The Compose image must resolve through that value. `latest` may be documented as an opt-in development convenience but not used as the production default. Release synchronization must update the baseline when a newer supported release is adopted.

Published image tag documentation must match the release workflow. If a Git tag `v2.2.0` publishes image tag `2.2.0`, documentation must use `2.2.0`.

For the production baseline, a matching application version string is not compatibility or provenance evidence. Replacing the locally built running image with a published GHCR image requires all of the following before the change is authorized:

1. image revision/provenance and selected runtime-file compatibility evidence, using an explicitly reconstructed local-image attestation when embedded metadata is unavailable;
2. validation of the existing configuration shapes and all per-bot state stores;
3. a controlled fixture dry-run using the candidate image;
4. a consistent pre-update fleet backup;
5. an operator-approved change window;
6. readiness evidence after replacement; and
7. evidence that the previous compatible fleet image plus the pre-update backup can restore the same fleet.

The current local image lacks embedded revision/runtime-contract metadata. Its comparison input must be a canonical `runtime-contract.v1` reconstructed from the verified source revision and audited selected-file SHA-256 evidence. The attestation is labeled `reconstructed`, not `embedded`, and records only the image digest, source revision, allowlisted relative file paths and hashes, canonical contract version/digest, and invariant projection. Generation must verify every selected-file hash against both the identified source revision and image evidence, reject missing/extra/mismatched evidence, and exclude absolute paths, environment values, configuration, state, and production data. Candidate comparison requires every invariant to match the candidate image's embedded attestation; version equality alone never passes.

### 8.5 Optional custom certificate authority

Deployments may support a generic operator-supplied CA bundle through a validated optional mount and `NODE_EXTRA_CA_CERTS`-style selection contract. The default remains the standard trust store. Validation must reject an unreadable or invalid selected bundle without printing its path contents, and tests must prove both absent and enabled cases. Canonical examples must not contain a private feed, private endpoint, or production-specific path.

## 9. Configuration schemas and validation

The application repository must provide machine-readable schemas for:

- Solo configuration.
- Fleet-wide configuration.
- Per-bot identity/feed configuration.
- Per-bot post/render configuration.
- Secrets-file shape.

A dedicated validation command must validate configuration without starting publishers.

Target interface:

```text
yarn fleet:validate
```

Container-compatible interface:

```text
node --import tsx fleet/validateFleet.ts
```

Validation must detect:

- Invalid JSON.
- Missing required fields.
- Unknown fields in schema-controlled files by default, with backwards-compatibility exceptions explicitly encoded in the schema version.
- Invalid URLs.
- Invalid intervals and limiter values.
- Bot directory/id mismatch.
- Duplicate bot IDs.
- Duplicate identifiers where accidental duplication would cause conflict.
- Missing secret keys.
- Placeholder secrets.
- Unsupported embed types.
- Invalid language-code shape.
- Invalid spacing bounds.
- Unwritable or invalid data paths when filesystem checks are enabled.
- Incompatible configuration-schema version.

Validation output must be deterministic, actionable, and free of secrets.

Canonical newly written fleet configuration requires `schemaVersion: 1`. For baseline compatibility, the shared loader must normalize a parsed fleet object before validation:

```ts
export interface FleetConfigNormalizationResult {
  config: unknown;
  noticeCodes: readonly "fleet-schema-version-assumed-v1"[];
}

export function normalizeFleetConfigForValidation(raw: unknown): FleetConfigNormalizationResult;
```

If the fleet-level `schemaVersion` is absent, return a deep in-memory copy with only `schemaVersion: 1` added and emit that fixed sanitized notice code. Never write the normalized copy back to disk. Explicit `schemaVersion: 1` is accepted without a notice; an explicit unknown version is rejected. Tests compare the original and normalized object deeply and prove that no other key, value, array, or nested shape changes. This bridge is mandatory so the first hardened runtime can load the current production configuration unchanged.

State adoption uses a separate non-mutating, aggregate-only validator against a stopped backup copy mounted read-only:

```bash
node --import tsx fleet/validateStateCompatibility.ts \
  --state-root /candidate-state \
  --expected-stores 59
```

It must enumerate exactly 59 independent SQLite stores and, for every store, run `PRAGMA integrity_check`, verify `PRAGMA application_id`, `PRAGMA user_version`, required tables, columns, indexes, and allowlisted queue statuses, and prove candidate read compatibility. All 59 stores must pass. Output contains only aggregate counts and fixed reason codes; no rows, content, identifiers, database names/paths, URLs, or raw errors. Tests assert pre/post hashes and modes are identical and cover missing/extra/corrupt stores and every structural/version/status failure.

## 10. Health, readiness, and status

Solo and fleet modes must expose compatible health semantics.

### 10.1 Endpoint roles

- **Liveness:** the process is running and its event loop is responsive.
- **Readiness:** the process has loaded valid configuration and can perform its mode-specific work.
- **Status:** operational details suitable for diagnostics without exposing secrets.

Target paths:

```text
/live
/ready
/health
/status
```

A single endpoint may combine roles for providers with limited configuration, but the internal distinction must remain explicit.

### 10.2 Fleet startup semantics

Authentication staggering means a large fleet may take many minutes to activate. Health must not fail merely because startup is still progressing.

Fleet status states:

```text
starting
operational
degraded
unhealthy
shutting_down
```

Required interpretation:

- `starting`: valid configuration loaded; activation in progress.
- `operational`: expected workers active, useful through fresh successful polls, and scheduler running with no classified failures.
- `degraded`: one or more workers/feeds failed or became stale, but at least one useful worker remains and readiness stays true.
- `unhealthy`: no useful workers, unrecoverable configuration failure, or stalled scheduler.
- `shutting_down`: graceful shutdown initiated.

Status output must include:

- Application version.
- Mode.
- Dry-run state.
- Configured bot count.
- Active bot count.
- Useful worker count.
- Workers with a fresh successful poll.
- Persistently failing feed count.
- Failed activation count.
- Total queue depth.
- Last successful poll time.
- Uptime.

It must not include identifiers, passwords, sessions, feed contents, post bodies, or tokens by default.

Acceptance must exercise 59 worker-equivalents with the production 30-second sequential authentication stagger through an injected or virtual clock, without a real 29-minute wait. Throughout valid activation, `starting` remains live and ready enough for startup checks, activation progress remains aggregate-only, and stable PID/container evidence remains distinct from readiness and lifecycle verification.

Fleet status must derive aggregate usefulness from successful-poll freshness with an injected clock. A useful worker is active and has a successful poll within the configured freshness window. Before the first poll, while activation or the post-activation grace window is still valid, the phase remains `starting`, not false `unhealthy`. After activation plus grace, zero useful workers or all feeds persistently failing is `unhealthy` and not ready even if worker processes are active. At least one useful worker plus any activation, persistent-feed, or stale-worker failure is `degraded` and ready. The isolated HTTP-500 case therefore remains useful, degraded, and ready while the other 58 workers continue successful polls.

One controlled fixture must return a persistent feed-retrieval HTTP 500 for exactly one synthetic worker while the other 58 continue queueing and draining. Feed retrieval failures, caught Open Graph fallback failures, and item-handler failures are separate status/log categories. Aggregate status may expose category counts only; it must never expose identifiers, URLs, titles, bodies, or raw errors.

## 11. Process lifecycle

### 11.1 PID 1

Containers must execute Node directly. Docker deployment files must not place Yarn, npm, or a shell wrapper between PID 1 and the application process unless the wrapper explicitly forwards signals and is tested.

Reference fleet command:

```yaml
command: ["node", "--import", "tsx", "fleet/runFleet.ts"]
```

### 11.2 Graceful shutdown

Solo and fleet modes must:

- Handle `SIGTERM` and `SIGINT`.
- Stop accepting new queue work.
- Abort activation delays.
- Finish or safely persist in-flight work within a bounded period.
- Close SQLite stores.
- Release PID locks.
- Exit with a clear status.

Docker and provider shutdown timeouts must be longer than the application shutdown budget.

### 11.3 Fleet replica invariant

All fleet manifests must declare one replica. Documentation must warn that autoscaling is unsupported. Health and startup logs must identify a lock conflict clearly.

## 12. Backup, restore, update, and rollback

### 12.1 Backup

Fleet backup must capture:

- Non-secret configuration.
- Secrets with restrictive permissions.
- SQLite state, including associated WAL or shared-memory files when applicable.
- Version metadata.

The reference backup procedure records whether the fleet is running and its dry-run state, stops it gracefully when running, waits for it to be stopped, verifies graceful-shutdown logs when available, and archives the complete closed `data/` tree including SQLite sidecars together with config, secrets, and version metadata. The archive is owner-only. The fleet is restarted only when previously running and in its previous dry-run/publishing mode. Copying live database files without consistency guarantees is not sufficient.

The backup/restore integration test must exercise each binding step: capture stopped/running and dry-run/publishing mode, graceful stop and wait, shutdown-log verification when available, closed-tree capture including WAL/SHM plus config/secrets/metadata, archive mode `0600`, no restart when initially stopped, conditional restart in the exact prior mode when initially running, exact restored file modes and fixture row, and refusal to restore while active.

Backup archives containing secrets must be created with owner-only permissions and the documentation must recommend encryption before off-host storage.

### 12.2 Restore

Restore must:

- Refuse to overwrite an active fleet.
- Verify the target application version or compatibility range.
- Restore file permissions.
- Validate configuration and state before startup.
- Start in dry-run unless the operator explicitly preserves live publishing mode.

### 12.3 Updates

Updates must be versioned and deliberate:

1. Review release notes.
2. Back up state.
3. Change the pinned image version.
4. Pull the image.
5. Validate configuration compatibility.
6. Start in dry-run when the release changes configuration or posting behavior.
7. Confirm health.
8. Enable publishing.

For production, these steps are subject to the published-image compatibility/provenance gate in section 8.4 and a separate operator-approved field operation. A template script or passing automated acceptance is not deployment authority.

### 12.4 Rollback

Rollback must support:

- Returning to the previous compatible fleet image version when schema compatibility permits.
- Restoring the pre-update backup when state migration is not backward-compatible.
- Preserving dry-run/publishing mode explicitly and never enabling publishing automatically.

## 13. Managed platform adaptations

### 13.1 Fly.io

Solo and fleet deployments may use the same image with different commands and storage layouts.

Fleet requirements:

- Exactly one machine.
- Persistent volume mounted for state.
- `FLEET_SECRETS_JSON` delivered directly from Fly secrets to the application-owned exactly-one-source parser.
- Health checks configured with startup-aware readiness.
- Automatic stop disabled for active publishers.
- Version-pinned image or reproducible source deployment.

### 13.2 Railway

Fleet requirements:

- Exactly one replica.
- Persistent volume for SQLite state.
- `FLEET_SECRETS_JSON` delivered directly from the Railway secret store to the application-owned exactly-one-source parser.
- Correct direct Node start command.
- Health check path matching application readiness semantics.
- Deployment replacement tested through local lifecycle simulation and later field verification.

### 13.3 Render

Fleet requirements:

- One paid, always-on web service so HTTP readiness is available.
- Persistent disk.
- One instance.
- `FLEET_SECRETS_JSON` delivered directly from the Render secret store to the application-owned exactly-one-source parser.
- HTTP readiness configured for the web service.
- No recommendation of a free service that sleeps or discards required state.

### 13.4 DigitalOcean

Solo mode may use App Platform where its state needs are satisfied.

Fleet mode is unsupported on App Platform. The supported DigitalOcean fleet adaptation is one Droplet running the Docker Compose reference with durable state and one active publisher. The App Platform solo guide must record the current official-provider evidence used to choose its exact `Persistent` or `Unsupported` state requirement.

## 14. Testing strategy

### 14.1 Application tests

The application repository must expose canonical commands:

```text
yarn typecheck
yarn test
yarn check
```

`yarn check` runs all required non-destructive verification.

Tests must cover:

- Solo and fleet configuration validation.
- Feed parsing with RSS and Atom fixtures.
- Queue behavior.
- Deduplication.
- Freshness limits.
- Adaptive spacing.
- Session persistence.
- Authentication success, failure, and rate limiting through mocks.
- Open Graph and image-processing limits.
- Dry-run behavior.
- Health state transitions.
- Graceful shutdown.
- PID-lock behavior.
- Backup/restore consistency helpers.
- Secret redaction.
- Absent fleet schema version accepted as v1 in memory without rewrite, explicit v1 accepted, unknown versions rejected, and no other shape changes.
- Aggregate-only state compatibility across exactly 59 read-only SQLite fixtures, including integrity, application/user version, required tables/columns/indexes/statuses, candidate reads, and non-mutation.
- A 59-worker, 30-second authentication stagger through virtual time, including identifier-free startup progress.
- Isolation of one persistent feed HTTP 500 while the other 58 synthetic workers continue queueing and draining.
- Separate feed-retrieval, Open Graph fallback, and item-handler failure categories.
- Structured sanitized log events across every runtime category, including process-safety, with fixed reason codes and aggregate counts only.
- Optional custom CA validation with and without a selected bundle.

### 14.2 Docker verification

Automated local smoke tests must exercise:

- Solo Compose startup.
- Fleet Compose startup.
- Dry-run as default.
- Fixture feed ingestion.
- Persistence across restart.
- Health and readiness.
- Graceful Compose stop.
- Version output.
- Invalid configuration rejection.

No real Bluesky post is required. The final publication boundary is mocked or disabled.

### 14.3 Provider validation

Provider files must receive:

- YAML/TOML parsing.
- Schema or CLI validation where available offline.
- Required-field checks.
- Entrypoint checks.
- Port and health-path checks.
- Persistent-storage checks.
- Secret-handling checks.
- Exact `FLEET_SECRETS_JSON` secret-store delivery for Fly, Railway, and Render fleet manifests, with no `FLEET_SECRETS_PATH`, shell materialization, literal value, or second parser.
- Fleet replica-count checks.
- Image-version checks.

Provider manifests remain `Validated` until deployed on the real provider.

### 14.4 Documentation tests

Executable shell snippets used for local setup must be tested in temporary directories. Internal links must be checked. Duplicate or contradictory deployment instructions must fail documentation review.

## 15. Cross-repository release synchronization

A tagged `bsky.rss` release must:

1. Run type checking and tests.
2. Build the image.
3. Run solo and fleet image smoke tests.
4. Publish versioned AMD64 and ARM64 images.
5. Produce release metadata describing configuration-schema compatibility, image revision/provenance, state compatibility, optional custom-CA support, and supported logging profiles.
6. Validate the fleet template against the released image.
7. Automatically create a companion-repository update PR that:
   - changes the pinned application version,
   - synchronizes canonical example configuration,
   - updates upgrade notes,
   - records compatibility results.

The template must not silently advance to a new major or incompatible release. If cross-repository credentials are not yet configured, the workflow and its documented secret requirements must still be committed and testable without performing the write.

## 16. Logging and observability

Both modes must use structured, sanitized log events for:

- Startup.
- Configuration validation.
- Authentication.
- Feed polling.
- Open Graph fallback.
- Item handling.
- Queue operations.
- Posting or dry-run output.
- Rate limits.
- Health transitions.
- Shutdown.
- Process-safety events.

Each event has an allowlisted category, fixed reason code, severity, and optional aggregate counts. The application logger does not accept arbitrary context or raw `Error` serialization. Tests must cover startup, configuration, authentication, feed retrieval, Open Graph fallback, item handler, queue, post/dry-run, rate limit, health transition, shutdown, and process-safety call sites. Logs and support artifacts exclude IDs, handles, titles, excerpts, URLs, raw errors, secrets, sessions, and all content.

Backend retention is a separate deployment responsibility. Every deployment must document and verify bounded retention regardless of backend. Supported Docker profiles include host-managed `journald` with a documented/tested retention policy and a portable bounded `json-file` profile. Production adoption must not force a logging-driver switch merely to satisfy this design.

The in-process aggregate usefulness/freshness metrics required for health are mandatory. External metrics export is optional in the first implementation cycle; leave a clear interface for later Prometheus integration without coupling health responses to a monitoring stack.

## 17. Audit findings converted to requirements

| Audit finding | Design requirement |
|---|---|
| Fleet Compose example enables live publishing | All fleet examples default to dry-run |
| Companion quickstart writes into a missing `secrets/` directory | Initialization creates runtime directories with safe permissions |
| Companion lacks `.gitignore` | Runtime secrets, data, backups, and overrides are ignored |
| Companion follows `latest` | Production examples pin a released image version |
| Main deployment docs blur solo and fleet | Every deployment document declares mode and support status |
| Cloud manifests currently target solo entry point | Separate solo and fleet provider manifests or explicit mode parameters |
| Fleet lacks health endpoint | Shared health model implemented for both modes |
| Large staggered fleets need startup-aware health | Fleet readiness distinguishes starting from unhealthy |
| Tests lack canonical `yarn test` command | Standard `typecheck`, `test`, and `check` scripts |
| Config is validated only during startup | Dedicated schema-backed validation command |
| Template and application examples can drift | Release-time compatibility and synchronization workflow |
| Authoritative details live in gitignored machine-local notes | Public committed architecture documentation becomes authoritative |
| Docker shutdown bug was caused by Yarn as PID 1 | Direct Node entrypoints required and lifecycle-tested |
| DigitalOcean App Platform lacks the required fleet contract | App Platform fleet is unsupported; use the one-Droplet Docker Compose adaptation |
| Provider docs imply more verification than exists | Verified, Validated, and Field-verified evidence levels |

## 18. Scope boundaries

This implementation cycle does not require:

- Real Bluesky posting.
- Real provider credentials.
- Horizontal fleet scaling.
- A distributed queue or external database.
- A web administration interface.
- Runtime hot reload unless already supported safely.
- Prometheus or Grafana deployment.
- Automatic credential rotation.
- New migration documentation, legacy import/export testing, or changes to existing legacy assets including `documentation/fleet.md`.

Mocks and dry-run must nevertheless cover behavior up to the final external publication boundary.

## 19. Implementation sequencing and decomposition

This specification defines one coordinated program, not one giant pull request. The implementation plan must decompose it into sequential workstreams with independent verification and review gates.

### Workstream 1: Application contracts

- Canonical test commands.
- Configuration schemas and validation.
- Non-mutating baseline config and 59-store compatibility validators.
- Shared dry-run semantics.
- Shared health/readiness/status model.
- Structured sanitized runtime logging plus lifecycle and redaction tests.
- Virtual-time 59-worker readiness and isolated feed-failure acceptance.
- Optional custom-CA validation.

### Workstream 2: Docker references and fleet template

- Verified solo Docker deployment.
- Verified fleet Docker deployment.
- Template safety defaults.
- Initialization, backup, restore, update, and rollback tooling.
- Version pinning and bounded log-retention profiles.

### Workstream 3: Documentation and managed providers

- Documentation restructuring and mode metadata.
- Solo and fleet manifests for Fly.io, Railway, and Render.
- DigitalOcean App Platform fleet marked unsupported with a one-Droplet Docker Compose adaptation; solo state status selected from current official evidence.
- Static provider validation and field-verification checklists.

### Workstream 4: Release synchronization and final audit

- Image smoke tests.
- Configuration compatibility metadata.
- Automated companion update PR workflow.
- Cross-repository consistency, security, and documentation review.

### Phase 0: Documentation reconciliation gate

Before Workstream 1 begins, the production baseline report, drift matrix, this design, all detailed plans, and the normative review decisions must agree on the production-preserving compatibility contract. The documentation-only reconciliation PR must be approved before runtime implementation starts. Phase 0 authorizes no production access or deployment action.

The workstreams must preserve this dependency order. Changes may be split into multiple focused PRs, but each PR must leave its repository internally consistent and must include its verification evidence.

## 20. Acceptance criteria

The design is implemented when:

1. Docker solo and fleet deployments start in dry-run and pass automated local smoke tests.
2. Fleet credentials and state cannot be accidentally committed through the documented workflow.
3. Dedicated validation commands catch invalid/unsafe configuration and incompatible state before startup without mutating either.
4. Solo and fleet expose documented health/readiness semantics.
5. Fleet startup, degradation, and shutdown are represented correctly.
6. All deployment documents clearly identify solo, fleet, or both.
7. Docker is presented as the default reference without diminishing managed alternatives.
8. Fly.io, Railway, Render, and DigitalOcean each have explicit solo and fleet support statements.
9. Managed manifests match Docker capabilities where possible and document adaptations where not.
10. Fleet manifests enforce one replica.
11. Production examples pin a versioned image.
12. Backup, restore, update, and rollback procedures are documented and locally testable.
13. `yarn test` and `yarn check` exist and are used by CI.
14. Provider manifests pass static validation.
15. The template is validated against the pinned released image.
16. Release automation detects or prevents cross-repository configuration drift.
17. No documentation claims field verification without recorded evidence.
18. No real secret appears in tests, logs, fixtures, commits, or generated artifacts.
19. A virtual-time test covers 59 worker-equivalents with the 30-second stagger while `starting` remains live and ready enough.
20. One persistent feed HTTP 500 is isolated while the other 58 synthetic workers continue, with separate Open Graph and item-handler evidence and identifier-free aggregate status.
21. Logging retention is bounded and privacy-preserving under either supported `journald` or bounded `json-file` profiles.
22. Optional custom CA behavior is documented and tested generically.
23. A published-image production transition has compatibility/provenance, backup, change-window, readiness, previous-compatible-image recovery, and Field-verified evidence; automated acceptance alone does not authorize it.
24. The first hardened runtime accepts the current absent-version fleet config as v1 only in memory, emits a sanitized notice, and never rewrites or otherwise reshapes it.
25. A reconstructed local-image attestation and read-only aggregate validator prove candidate compatibility for all 59 state stores before adoption.
26. Runtime logs use allowlisted categories/reason codes and aggregate counts only, while Fly, Railway, and Render pass `FLEET_SECRETS_JSON` directly from provider secret stores.
27. Existing migration/import/export assets and `documentation/fleet.md` remain unchanged and are not current navigation, deliverables, tests, or acceptance dependencies.

## 21. Decision summary

The approved direction is capability-first and cross-repository:

- One authoritative design in `rmdes/bsky.rss`.
- Docker Compose as the default and behavioral reference.
- Solo and fleet treated as explicit product modes.
- Managed providers implemented to equivalent capability where possible.
- Adaptations and limitations documented rather than hidden.
- Broad implementation now, with honest separation between local verification and provider field verification.
- The companion repository retained as the canonical fleet deployment surface.
