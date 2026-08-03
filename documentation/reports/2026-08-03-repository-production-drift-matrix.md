# Repository/Production Drift Matrix

**Date:** 2026-08-03

**Production reference:** `/home/skyfleet-next`

**Runtime repository:** `rmdes/bsky.rss`

**Deployment repository:** `rmdes/bsky-rss-fleet-template`

This matrix compares observed production with the two checked-in repositories. It records current reality, not the capabilities proposed by the merged design and implementation plans. Evidence labels are **Observed**, **Attested**, **Inferred**, and **Unverified**.

## Capability matrix

| Capability | Production (`/home/skyfleet-next`) | `bsky.rss` | Fleet template | Drift and reconciliation |
|---|---|---|---|---|
| Entrypoint | **Observed:** direct `node --import tsx fleet/runFleet.ts`; Docker entrypoint is the image's standard Node entrypoint. | Fleet example and `fleet/runFleet.ts` match production. Solo Docker default remains `app/index.ts`. | Direct fleet Node command matches production. | Aligned. Preserve direct Node as PID 1; do not regress to Yarn/shell wrappers. |
| Image/version | **Observed:** locally tagged `bsky.rss:fleet`, app `2.2.0`, no numeric production pin, no OCI revision/version labels. Selected image hashes match production source commit `2953011…` and local runtime files. | Dockerfile builds Node 24 Alpine and release workflow publishes numeric plus `latest`; current image has no compatibility metadata contract. | Pulls `ghcr.io/rmdes/bsky.rss:latest`. | Production, source examples, and template use three different provenance models. Transition in place to a verified numeric image with revision metadata; do not assume the GHCR artifact is equivalent until tested against production state. |
| Configuration | **Observed:** 59 enabled bot configs; fleet settings match both repositories' examples. Production also declares an extra-CA environment key. Environment values, including current dry-run/publishing mode, were deliberately not extracted. | Owns config loader and examples; no schema-backed validator yet. Runtime fleet example includes extra-CA support. | Example fleet values match production/runtime; no validator and no extra-CA operator contract. | Core shapes align. Preserve existing shapes while adding schema version/validation. Model extra CA as a documented optional operator overlay, not a hard-coded production identity. |
| Secrets | **Observed:** 59 secret keys; file `0600`, read-only container mount; values excluded. Parent directory is `0755`. | File parser reads a flat key/value JSON file; errors can contain `secretKey` names. No standalone validation command. | Example secrets live below `config.example/`; `secrets/` only has `.gitkeep`; quickstart writes a file manually; no `.gitignore`. | Template baseline is unsafe/incomplete. Separate secret examples, create `0700` runtime directory, keep `0600` file, ignore it, validate without echoing keys or values. Consider redacting secret-key names from errors/support output. |
| State | **Observed:** durable bind mount, 59 SQLite files plus lock; state directories `0755`, files `0644`. | Fleet state path is per-bot under `data/fleet`; session, cursor, dedupe, and queue are durable. | Bind-mounts `./data`; no initialization, permission, backup, or restore tooling. | Layout aligns. Harden state permissions because databases contain sessions and post/queue data; verify any permission change in place. |
| SQLite | **Observed:** 59 databases, 17,014,784 bytes; no WAL/SHM sidecars at the sample time. No rows inspected. | Native `node:sqlite`, one database per bot; no migration/version/backup CLI. | Knows only that `./data` is persistent. | Add compatibility metadata and graceful-stop filesystem backup/restore tests. Absence of sidecars at one instant is not proof that live copying is safe. |
| Authentication staggering | **Observed:** 30 seconds, 59 enabled bots; source sequentially activates and skips failed bots. | Implements `AuthCoordinator` and interruptible stagger. | Example value matches; README explains stagger. | Behavior aligns. Health/readiness plan must allow roughly 29 minutes plus login time for a clean start and expose progress without identifiers. |
| Queue behavior | **Observed/source-matched:** per-bot persistent queue ceiling 500; 60-second drain; 5-item/120-minute freshness; 57 bots use 60–300-second adaptive spacing. Sanitized available logs show queue activity plus skips/errors. | Implements persistent statuses, dedupe, freshness, capacity, adaptive spacing, rate limits, and conservative uncertain-result skip. | Only supplies matching example settings; no queue diagnostics or validation. | Runtime behavior is authoritative. Preserve it during health/schema work; add aggregate status without identifiers/content and exact edge-case tests. |
| Health | **Observed:** no fleet endpoint, port, Compose healthcheck, or Docker health state. Process-running is the only current signal. | Solo has a legacy `/health`; fleet has no server. Process-safety handlers log and continue after unhandled/uncaught failures. Merged plans propose shared `/live`, `/ready`, `/health`, `/status`. | No ports or healthcheck. | Major planned capability, not current fact. Do not label the existing production fleet healthy/readiness-verified. Define/test whether process-fatal events exit or degrade health; implement fixture tests before any field claim. |
| Shutdown | **Observed static contract:** 45-second Compose grace, direct Node; source has 30-second overall bounded shutdown and lock release. **Unverified live.** | Fleet handlers exist; solo parity and lifecycle tests are pending. | Declares direct Node and 45-second grace. | Static alignment. Production shutdown evidence is absent; acceptance must test signal handling, queue persistence, SQLite close, and lock release. |
| Orchestration | **Observed:** one Compose container with `unless-stopped` plus PID lock. No ports/health. Current-fleet systemd unit/timer not found. A historical boot unit still references `/home/skyfleet`. | Source-build fleet Compose example uses local build/tag and mounts. | Deploy-only Compose pulls `latest`; no scripts/CI. | Canonical future orchestration belongs in the template, but production adoption is an in-place replacement in `/home/skyfleet-next`, not a legacy migration. Add an explicit single-replica declaration/check. |
| Backup | **Observed:** no script, backup directory, or matching unit/timer under the deployment; one Compose `.bak` only. Host-wide cron unverified. | Documentation suggests ad-hoc live `rsync`, which is not SQLite-consistency evidence. Merged plan-review decision requires graceful stop then filesystem archive. | No backup tooling. | Implement and test graceful-stop backup. Remove conflicting detailed-plan text that still proposes application backup/VACUUM. Do not call the Compose `.bak` or live `rsync` a recoverable fleet backup. |
| Restore | **Observed:** no restore tooling or evidence. | No current guarded restore. | No restore tooling. | Planned only. Must refuse active fleet, validate archive paths/version/state, restore permissions, validate config, and start dry-run by default. |
| Update | **Observed:** no update script; local image tag; live Compose build context resolves to a deployment root with no Dockerfile. | Release workflow publishes GHCR numeric and `latest`, but does not embed/verify compatibility metadata. | README says pull/recreate `latest`; no backup, validation, health gate, or dry-run transition. | Current production update path is not reproducible from Compose alone, and template update is floating. Add a staged numeric-image transaction only after the published artifact is proven compatible with current state. |
| Rollback | **Observed:** no same-fleet image/state rollback. `/home/skyfleet` is explicitly historical, not a rollback target. | Has a generic legacy exporter and docs that currently present rollback to legacy as active. | Points operators to runtime legacy rollback docs; no same-fleet rollback. | Correct the spec/plans: production rollback means previous fleet image plus pre-update backup. Keep generic legacy export as separately scoped optional tooling, never the production destination. |
| Logging | **Observed:** host-default `journald`; no Compose logging block; available log window was shorter than requested. App source can log IDs, handles, item/post excerpts, URLs within errors, and error strings. | Category tags exist but structured/redacted logging and bounded retention are absent. | No logging configuration. Merged plan hard-codes `json-file` rotation. | Preserve the retention goal, not one driver. Make backend configurable and document a tested journald policy for this host; sanitize support/status output and reduce sensitive message payloads. |
| Resource limits | **Observed:** no memory/CPU/PID/swap limits; one sample was 0.53% CPU, 345.1 MiB, 11 PIDs. | Shared network/image concurrency is bounded; container resources are not. | No resource limits. | Do not derive limits from one sample. Add optional profiles plus startup/catch-up soak evidence before production defaults; document single-replica enforcement independently. |

## Documentation reconciliation

The merged design and plan suite is directionally consistent with the largest gaps, but it predates this production observation. The following are proposed documentation-only corrections; no spec or plan was edited in Task 0.

### Production-preserving corrections

1. **Add the baseline as a normative precondition.** The program must identify `/home/skyfleet-next` as the authoritative existing fleet and require in-place compatibility checks before production adoption. `/home/skyfleet` must be labeled historical-only everywhere production procedure is discussed.
2. **Replace production “rollback to legacy.”** In the design rollback section, program constraints, release/documentation plan, and current `documentation/fleet.md`, define production rollback as previous pinned fleet image plus pre-update backup. Retain the generic importer/exporter only as optional tooling for other legacy operators, not as this fleet's migration/rollback path.
3. **Reconcile the backup plan text with its normative review.** `2026-08-03-plan-review-decisions.md` selects graceful stop plus complete filesystem archive, but the detailed template plan still instructs application-owned backup or `VACUUM INTO`. Replace the stale detailed step and its tests with the reviewed method.
4. **Add an explicit production image transition gate.** The currently running locally built image must not be silently replaced by `ghcr.io/...:2.2.0` merely because their version strings match. Require selected-file/compatibility comparison, state/config validation, fixture dry-run, backup, operator-approved change window, readiness, and rollback evidence.
5. **Correct production build-context assumptions.** Record that the image source checkout is `/home/skyfleet/bsky.rss` while the live deployment root is `/home/skyfleet-next`; the current Compose build context is not self-contained. The future template should consume a verified published image and omit a misleading local build declaration.
6. **Preserve production-specific CA capability without productizing a private instance.** Add an optional custom-CA contract to configuration/deployment documentation and compatibility tests. Do not embed a production feed identity in canonical examples.
7. **Make logging policy driver-neutral.** The design should require bounded retention and secret/private-data hygiene. The template plan should not mandate `json-file` where production currently inherits `journald`; provide/test supported backend profiles.
8. **Treat long staggered activation as a concrete acceptance case.** Health tests should cover a 59-worker-equivalent, 30-second-stagger state model without waiting in real time, proving `starting` remains live/ready enough and status stays aggregate-only.
9. **Separate stable process evidence from health verification.** Record the operator attestation and zero-restart evidence, while retaining health, shutdown, backup, restore, update, and rollback as unverified until exercised.
10. **Make production adoption a separate, explicitly authorized operation.** The implementation plans may create and validate artifacts, but must not imply deployment to `ob`, publishing changes, or container lifecycle actions are part of automated acceptance.

### Safe hardening

- Add schema-backed validation while preserving current config shapes and values.
- Pin images numerically and embed revision/version/compatibility metadata.
- Create secrets directories at `0700` and files at `0600`; plan an evidence-backed tightening of config/state permissions because they contain private URLs, sessions, and content.
- Add aggregate, identifier-free status and structured/sanitized logging.
- Define and lifecycle-test the policy for unhandled rejections/uncaught exceptions so a process is not considered useful merely because PID 1 still exists.
- Add tested graceful shutdown, backup, guarded restore, update, and same-fleet rollback workflows.
- Add a declared/checkable one-replica contract in addition to the PID lock.
- Add log-retention verification for journald and portable Compose deployments.

### New optional capabilities

- Operator-selectable logging backend profiles (`journald` or bounded `json-file`).
- Custom CA bundle mounting/selection for feeds with nonstandard chain requirements.
- Resource-limit profiles derived from startup, stagger, polling, image-processing, and catch-up soak tests.
- Metrics beyond the planned aggregate health/status surface.

### Breaking changes to avoid or gate

- Any production procedure that stops `/home/skyfleet-next` in order to re-enable `/home/skyfleet`.
- Automatic schema rewrites that invalidate the current 59 configurations.
- Automatic live publishing after init, update, restore, or rollback.
- Replacing the current image based only on a matching `2.2.0` version string.
- Forcing a logging-driver change or tight resource limit without host-specific evidence.
- Copying live SQLite files as if that were a consistent backup.
- Restoring over an active fleet.

### Unverified claims to keep explicitly unverified

- Full readiness of all 59 bots at any sampled time.
- Production graceful shutdown and restart persistence.
- SQLite backup consistency and end-to-end restore.
- Compatibility between the running local image/state and the published numeric GHCR image.
- Same-fleet update and rollback.
- Any host-wide cron backup not represented in the inspected tree or systemd metadata.
- Managed-provider behavior and field verification.
- The causes and operational impact of the sanitized feed-fetch errors.

## Evidence caveats

- Production inspection was strictly read-only and value-excluding.
- The log query requested 72 hours, but the available `journald` stream began at `2026-08-02T17:00:52Z`; counts apply only to the returned interval.
- No database row, raw log line, environment value, secret, session, feed URL, or private identifier was inspected or included.
- Source hash equality covered selected deployment/runtime files; it was not a full image rebuild or software-bill-of-materials verification.
- One resource sample is descriptive only and cannot establish capacity or a safe limit.
