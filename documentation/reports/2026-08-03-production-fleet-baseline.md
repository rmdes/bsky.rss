# Production Fleet Baseline

**Audit date:** 2026-08-03

**Authoritative running fleet:** `/home/skyfleet-next` on the production host

**Historical deployment:** `/home/skyfleet` (evidence only; not a migration or rollback target)

**Production image source repository:** `/home/skyfleet/bsky.rss`

**Audit mode:** read-only, allowlisted, secret-safe

## Executive baseline

The current production fleet is one directly executed Node.js fleet process in one Docker container. At the observation time, the container had been up for four days, had zero restarts, had not been OOM-killed, and exposed no Docker health status because neither the fleet runtime nor Compose currently defines a fleet healthcheck.

The operator attests that `/home/skyfleet-next` has run flawlessly for at least three days. That attestation is recorded as an attestation, not upgraded to direct verification. Direct process evidence supports uninterrupted container operation. Sanitized log aggregation also shows one persistent, isolated upstream feed failure, caught Open Graph failures, and one uncertain publish result in the original audit window, so this report does not reinterpret “flawlessly” as “no per-feed or per-item errors.” No raw log messages were inspected because they may contain identifiers, feed URLs, or post contents.

The production image contains application version `2.2.0`. Its selected runtime-file hashes exactly match both `/home/skyfleet/bsky.rss` at commit `29530113c7cf46531b48fd28c4cd019b538223ed` and the current local runtime worktree. The image is locally tagged `bsky.rss:fleet`; it has no OCI revision or version label and is not pinned by a numeric image tag in the production Compose file.

## Evidence labels

- **Directly observed:** returned by a read-only command during this audit, through an allowlisted projection that excluded sensitive values.
- **Operator-attested:** supplied by the operator in the task brief; not independently reproduced.
- **Inferred:** a conclusion from directly observed metadata or checked-in source, with the inference stated.
- **Unverified:** not exercised or not safely observable within this audit boundary.

## Safety and extraction boundary

The audit did not print or retain environment values, credentials, secret values, sessions, JWTs, database rows, feed URLs, bot identifiers, or raw log messages. It did not start, stop, restart, pull, build, or recreate containers; edit production files; run migrations; or publish to Bluesky.

Evidence was limited to:

- filesystem names and sanitized metadata at the deployment root;
- Git commit, branch, cleanliness count, and selected source hashes;
- Docker Compose projections containing service shape, command, image, environment key names, mounts, healthcheck presence, logging, and resource declarations;
- container/image state, timestamps, IDs/tags, restart/OOM status, mount metadata, and selected file hashes;
- counts, sizes, permissions, and aggregate non-identifying configuration values;
- sanitized log-category counts with no message bodies;
- systemd unit state and command metadata;
- local repository source, documentation, and template metadata.

## Directly observed production topology

| Item | Observation |
|---|---|
| Deployment root | `/home/skyfleet-next`, owned by `root:root`, mode `0755` |
| Compose service | One `bsky-rss-fleet` service and one running container |
| Entrypoint | Docker entrypoint followed by `node --import tsx fleet/runFleet.ts` |
| Restart policy | `unless-stopped` |
| Stop grace | 45 seconds |
| Container start | `2026-07-30T11:58:20.339523517Z` |
| Observation time | `2026-08-03T11:45:26Z` |
| Restart/OOM state | Zero restarts; not OOM-killed |
| Image | `bsky.rss:fleet`, image ID `sha256:9a0e728fc48407d5b6fe6a539a15335dd80977312010392d87e36632e3eead18` |
| Image build time | `2026-07-30T11:55:48.38764231Z` |
| Image platform/size | Linux AMD64; 257,221,791 bytes |
| Image provenance labels | Source URL present; revision and version labels absent |
| Published ports | None |
| Healthcheck | None |
| Compose logging override | None; host default logging driver is `journald` |
| Compose/host resource limits | None |
| Replica protection | One current container plus a fleet PID lock file; no declared Compose replica limit |

The container's config and secrets mounts are read-only and its data mount is read-write. Compose declares six runtime environment keys; only their names were extracted. Five are the fleet mode/config/secrets/data/lock contract and one enables an operator-specific extra-CA arrangement. No environment values were extracted.

## Image and source provenance

The production source repository was directly observed at:

- branch `main`;
- commit `29530113c7cf46531b48fd28c4cd019b538223ed` (`fix: exec fleet directly in the compose command instead of via yarn`);
- zero tracked changes when excluding untracked files.

The selected hashes for `package.json`, `Dockerfile`, the fleet entrypoint, authentication coordinator, store, worker, process-safety module, and fleet Compose example all match between the running image, the production source repository, and the local runtime worktree. The production commit is an ancestor of the local worktree head. This verifies selected-file equivalence, not a complete reproducible-build identity. The image lacks an embedded revision label, and the audit did not rebuild it.

The live Compose model resolves its build context to `/home/skyfleet-next`, but that directory has no Dockerfile at its root. The task brief identifies `/home/skyfleet/bsky.rss` as the repository used to build the image, and the selected hashes corroborate that source relationship. Therefore, the currently rendered Compose build context is not a self-contained update path even though the existing image is running correctly.

## Configuration, secrets, and state

Only aggregate metadata and non-identifying fleet-wide settings were extracted.

| Area | Direct observation |
|---|---|
| Bot/config cardinality | 59 bot directories, 59 `bot.json` files, 59 `config.json` files |
| Enabled set | 59 enabled, zero disabled |
| Secret cardinality | 59 keys; values not read or printed |
| Secrets file | Owner-only file mode `0600`; parent directory mode `0755` |
| Config permissions | Fleet and per-bot JSON files observed at mode `0644`; config directories at `0755` |
| State cardinality | 59 SQLite files and one lock file |
| SQLite size | 17,014,784 bytes total at the observation point |
| SQLite sidecars | No `-wal` or `-shm` files observed at the observation point |
| State permissions | SQLite files observed at mode `0644`; state directories at `0755` |
| Fleet staggering | 30 seconds |
| Worker interval | 60 seconds |
| Per-bot queue ceiling | 500 items |
| Freshness | Up to 5 catch-up items; maximum age 120 minutes |
| Shared limiter settings | 6 Open Graph fetches, 2 image jobs, 10,000,000-byte image cap, 10-second HTTP timeout |
| Bot polling | All 59 observed configurations use a 5-minute fetch interval |
| Adaptive spacing | Enabled for 57 of 59 configurations; those 57 use 60-second minimum and 300-second maximum spacing |

The permissive config/state directory and file modes are not evidence of unauthorized access. They are, however, a safe-hardening gap because config can contain private feed URLs and SQLite contains sessions and queue/post data.

## Authentication and queue behavior

The running image source directly shows sequential authentication with a fleet-wide delay. With 59 enabled bots and a 30-second stagger, a clean full activation can take roughly 29 minutes, excluding authentication time. A single activation failure is recorded and skipped while other workers continue.

Queue behavior is persistent per bot in SQLite. The source directly implements a 500-item per-bot ceiling, freshness/catch-up filtering, adaptive spacing, rate-limit deferral, deterministic deduplication, and conservative handling of uncertain publication outcomes. A recognized rate limit is deferred; an unrecognized uncertain result is marked skipped rather than retried automatically.

The available sanitized log interval was `2026-08-02T17:00:52Z` through `2026-08-03T11:43:55Z`; although a 72-hour query was requested, older records were not available through the host's current `journald`-backed Docker log stream. Within that available interval:

- 926 items were queued;
- 833 items were logged as posted;
- 83 stale/catch-up-limit skips were logged;
- one uncertain publish result was skipped without retry;
- 229 feed-fetch errors were logged;
- no known queue-capacity drops, rate-limit messages, item-handler errors, authentication activation failures, configuration errors, unhandled rejections, or uncaught exceptions matched the source-defined message categories.

These are event counts, not database verification. Raw messages and database rows were deliberately excluded.

### Follow-up error classification

The original 229 count specifically matched `[bsky.rss FEED] Error fetching feed`: failure to retrieve an RSS/Atom feed. It did not include `[bsky.rss FETCH] Error fetching Open Graph data`, which is a separate source-defined category. **Directly observed (coordinator-supplied recount):** a fresh allowlisted aggregation during review of the then-available rolling log stream produced:

| Category | Events | Anonymous bot count | Production-safe assessment |
|---|---:|---:|---|
| Feed retrieval | 187 | 3 | One anonymous bot/feed accounted for 185 HTTP 500 responses and had zero queue and zero posted events in the same rolling window. The two other anonymous bots each had one retrieval error and continued processing. |
| Open Graph retrieval | 196 | 22 | The source catches these failures and constructs its fallback embed/description path; these are not feed retrieval failures. |
| Item handler | 0 | 0 | No item-handler errors matched. |

For the two bots that continued after one feed retrieval error, the same window contained 18 queued/16 posted events and 1 queued/1 posted event respectively. The status-only projection classified 185 events as HTTP 500 and the two remaining events as having no HTTP status. The 185 HTTP 500 responses are direct evidence of a real, isolated upstream feed failure: not an Open Graph failure and not fleet-wide. The identity and URL were intentionally excluded.

The earlier 229 and later 187 feed-retrieval counts are observations of different rolling `journald` availability windows, not contradictory counts over one fixed interval. Whether the persistent HTTP 500 condition predates the new fleet is unverified because older logs are unavailable.

## Health, shutdown, and orchestration

Fleet health is **not implemented or externally exposed** in the observed baseline. There is no fleet health endpoint in the current source, no port publication, and no Docker healthcheck. Docker therefore reports only that the process is running, not that all publishers are ready or useful.

The source implements direct Node PID 1 execution, `SIGTERM`/`SIGINT` handlers, interruption of authentication staggering, bounded parallel worker shutdown, SQLite close calls, and lock release. Compose grants 45 seconds while the application's overall shutdown budget defaults to 30 seconds. This is a coherent static contract, but graceful shutdown was not exercised during the read-only audit and remains unverified in production.

Two matching systemd units exist:

- `skyfleet-containers.service` is active/exited, disabled, and invokes `/home/skyfleet/boot.sh`; it belongs to the historical deployment and is not evidence of current-fleet orchestration.
- `bsky-queue-monitor.service` is inactive/dead and disabled; its description refers to restarting stuck containers. It is not active protection for the authoritative fleet.

The current fleet's effective orchestration is Docker Compose restart policy plus the running container and application lock. No current-fleet systemd unit or timer was observed.

## Backup, restore, update, and rollback

| Capability | Baseline |
|---|---|
| Backup | No backup script, backup directory, or matching timer/unit was observed under `/home/skyfleet-next`. A single Compose `.bak` file exists, but it is not a state/config/secrets backup. Host-wide cron was not inspected and remains unverified. |
| Restore | No restore script or tested restore record was observed. Unverified. |
| Update | No update script was observed. The image is locally built/tagged without numeric pinning or embedded revision metadata. The live Compose build context does not contain a Dockerfile. |
| Same-fleet rollback | No pinned previous image workflow or state restore workflow was observed. |
| Historical rollback | `/home/skyfleet` is explicitly historical and is not an authorized migration or rollback destination for this production deployment. |

The current application repository contains generic legacy importer/exporter code and documentation. Their existence is not authority to use `/home/skyfleet` against this production fleet.

## Logging and resources

The host default Docker logging driver is `journald`; Compose does not override it. The application emits category-tagged logs, but many source templates include bot IDs, handles, item titles, post excerpts, or error strings. This audit used counts only. Log retention was insufficient to return the full requested 72-hour interval, and no application-level bounded retention or sanitized support bundle exists.

No memory, CPU, PID, swap, OOM, or replica resource limits are declared. One point-in-time sample showed 0.53% CPU, 345.1 MiB memory, and 11 processes. That sample is not capacity evidence and must not be used to select production limits without longer observation, including startup and catch-up peaks.

## Attested, inferred, and unverified summary

### Operator-attested

- `/home/skyfleet-next` has run flawlessly for at least three days.
- `/home/skyfleet/bsky.rss` is the repository used to build the production image.
- `/home/skyfleet` is historical only and is not a migration or rollback destination.

### Inferred from direct evidence

- The uninterrupted container and zero restart/OOM counts support stable process operation over the observed four-day lifetime.
- The selected-file hash equality strongly supports that the running image was built from the identified production source revision, but does not prove full bit-for-bit reproducibility.
- The current Compose build declaration cannot reproduce the image from `/home/skyfleet-next` without an out-of-band build-context change because no Dockerfile exists there.
- At 30-second staggering, 59-bot activation needs roughly 29 minutes before authentication overhead; future readiness must model this as `starting`, not unhealthy.

### Unverified

- The current dry-run/publishing environment value, which was deliberately not extracted.
- Graceful shutdown behavior on the production host.
- Full fleet readiness or per-bot operational health.
- Backup consistency, restore, update, and same-fleet rollback.
- Any host-wide cron-based backup not represented by the inspected deployment tree or matching systemd timers.
- Compatibility of the current production state with a published numeric GHCR image.
- Provider deployments and any field-verification claims.
- Whether the isolated persistent HTTP 500 feed failure predates the new fleet; older logs are unavailable.

The current process-safety module logs and continues after an unhandled rejection or uncaught exception. No source-defined match for either category appeared in the available sanitized log interval, but without health/readiness there is presently no verified mechanism to detect whether a process that survived such an event remains useful. The runtime-contract plan should define and test this failure policy.

## Production-preserving adoption constraints

Future implementation must treat this baseline as an in-place hardening of `/home/skyfleet-next`, not a migration from or rollback to `/home/skyfleet`. It must preserve the direct Node entrypoint, durable config/secrets/data mounts, single publisher, 45-second stop grace, 30-second authentication staggering, current queue/freshness semantics, and operator-specific extra-CA capability unless a separately verified replacement exists.

Before production adoption, new health, validation, backup/restore, image pinning, logging, and resource controls must be exercised against non-secret fixtures and then field-verified on the host through an explicit operator-approved change window. This audit authorized documentation only and made no production changes.
