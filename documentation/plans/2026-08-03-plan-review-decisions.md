# Cross-Repository Deployment Plan Review Decisions

This document records the mandatory decisions produced by the implementation-plan self-review. It overrides any conflicting illustrative snippet in the four detailed plans.

## 1. JSON Schema Runtime

Use Ajv's JSON Schema 2020-12 implementation explicitly:

```ts
import Ajv2020 from "ajv/dist/2020.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
```

Do not instantiate the default Ajv export for schemas declaring draft 2020-12.

## 2. Configuration Schema Versioning

Avoid an unnecessary breaking rewrite of every existing configuration file.

- `config/fleet.json` gains required `schemaVersion: 1`.
- Per-bot `bot.json`, per-bot `config.json`, and the secrets file retain their current top-level shapes.
- Their schema versions are represented by versioned schema `$id` values and the fleet-level `schemaVersion` compatibility boundary.
- The secrets file remains a flat `Record<string, string>` keyed by `secretKey`.
- Solo environment variables are converted to an internal object and validated against the solo schema; operators do not set a schema-version environment variable.
- Release compatibility metadata publishes the supported fleet schema version.

The schema-registry test therefore checks draft, strict object boundaries, and versioned `$id` values for every schema, but checks `properties.schemaVersion.const === 1` only for the fleet-wide schema.

## 3. Schema Loading

Do not make the plan depend on uncertain JSON import-attribute behavior.

Load checked-in schema JSON through a focused helper:

```ts
import { readFileSync } from "node:fs";

function readSchema(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}
```

No `tsconfig.json` change is required solely for schema loading.

## 4. Managed-Platform Fleet Secrets

The application owns secret parsing. Add:

```ts
export function loadFleetSecrets(options: {
  filePath?: string;
  json?: string;
}): Record<string, string>;
```

Rules:

- exactly one source must be provided;
- local Docker/template deployments use `FLEET_SECRETS_PATH`;
- managed providers may use `FLEET_SECRETS_JSON` from their secret store;
- validation and runtime use the same parser;
- parser errors never include the supplied JSON or secret values;
- provider manifests must not materialize secrets through a shell wrapper when `FLEET_SECRETS_JSON` is available.

## 5. Healthcheck Port

Container health commands must honor the configured port:

```yaml
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
```

No healthcheck may hard-code port 8080 while also advertising a configurable `HEALTH_CHECK_PORT`.

## 6. SQLite Backup Method

Choose the simplest consistency guarantee: graceful stop followed by filesystem backup.

The fleet backup script must:

1. record whether the fleet was running and its dry-run state;
2. issue `docker compose stop`;
3. wait until the container is no longer running;
4. verify graceful-shutdown completion in the container logs when logs are available;
5. archive the complete closed `data/` tree, including any SQLite WAL/SHM files;
6. archive config, secrets, and metadata with restrictive permissions;
7. restart only when the fleet was previously running, preserving the previous dry-run state.

Do not add an unspecified alternative using `VACUUM INTO` or a future application backup command in this implementation cycle.

## 7. Docker Validation Acceptance

Do not run the image validator against placeholder example secrets and expect success.

The runtime-plan image acceptance test must create a temporary valid secrets file and mount it:

```bash
docker run --rm \
  -e FLEET_CONFIG_ROOT=/build/config.example \
  -e FLEET_SECRETS_PATH=/run/secrets/bsky-fleet.json \
  -v "$VALID_SECRETS_FILE:/run/secrets/bsky-fleet.json:ro" \
  bsky-rss:runtime-contracts \
  node --import tsx fleet/validateFleet.ts
```

Expected exit status: 0.

A separate test must prove the checked-in placeholder secrets fail validation without disclosing their values.

## 8. Managed Provider Decisions

- Render fleet uses one paid, always-on web service with persistent disk so HTTP readiness is available. Do not leave worker-versus-web selection open.
- Fly, Railway, and Render fleet manifests consume `FLEET_SECRETS_JSON` from provider secret stores.
- DigitalOcean App Platform fleet remains unsupported; DigitalOcean fleet support is a one-Droplet Docker Compose adaptation.
- For DigitalOcean App Platform solo mode, consult current official provider documentation during execution. If durable mounted state is unavailable to the selected component, mark the target `State requirement: Unsupported` and recommend a Droplet. If durable state is available, configure it and mark `Persistent`. This decision rule is mandatory and must be evidenced in the PR.

## 9. Documentation Header Values

Provider documents must select one exact value. Text such as `Persistent or Unsupported` is not a valid final header.

## 10. Execution Order

The runtime-contract implementation must land and produce a released image before the companion template is validated against it. Provider manifests depending on `FLEET_SECRETS_JSON`, `/ready`, or compatibility metadata cannot merge first.

## 11. Production Baseline and In-Place Adoption

The [production fleet baseline](../reports/2026-08-03-production-fleet-baseline.md) and [repository/production drift matrix](../reports/2026-08-03-repository-production-drift-matrix.md) are normative Phase 0 inputs. `/home/skyfleet-next` is the authoritative in-place compatibility target and a **Production-proven baseline** based on operator-attested successful operation for at least three days plus four days of uninterrupted container uptime with zero restarts and no OOM event. That evidence is not all-bot health and does not make readiness, shutdown, backup, restore, update, or recovery **Verified**.

## 12. Incremental Hardening Scope

Production is hardened in place and does not depend on the historical deployment; migration and legacy export are outside production adoption. Preserve current config shapes, 59 independent per-bot SQLite stores, state separation, 30-second sequential authentication, queue/freshness/rate-limit behavior, direct Node PID 1, durable mounts, one active publisher, 45-second stop grace, and optional custom-CA behavior.

## 13. Published-Image Transition Gate

Do not replace the locally built production image with a GHCR image merely because both report `2.2.0`. Require:

1. compatible source revision/provenance and runtime-contract evidence;
2. validation of existing configuration and all per-bot state stores;
3. a controlled fixture dry-run;
4. a consistent pre-update backup;
5. an operator-approved change window;
6. readiness evidence; and
7. a tested recovery path using the previous compatible fleet image.

## 14. Backend-Neutral Bounded Logging

Require bounded retention and privacy regardless of backend. Supported Docker profiles are host-managed `journald` with a documented and tested retention policy, and portable bounded `json-file`. Do not force a production driver switch. Logs, status, and support artifacts exclude identifiers, URLs, titles, bodies, credentials, sessions, database contents, and raw errors.

## 15. Optional Generic Custom CA

Preserve a generic optional CA-bundle contract compatible with `NODE_EXTRA_CA_CERTS`. The default trust store works without an overlay. Validate absent, readable-valid, missing, and invalid selections; mount bundles read-only where applicable; sanitize failures; and never place a private feed, endpoint, or production-specific path in canonical examples.

## 16. Production-Scale Startup Acceptance

Exercise exactly 59 configured worker-equivalents with a 30-second sequential authentication stagger through an injected or virtual clock, without waiting roughly 29 real minutes. While activation progresses, `starting` stays live and ready enough once configuration, lock, status server, and scheduler progress are valid. Status exposes aggregate configured/active/failed counts only.

## 17. Failure Isolation and Classification

Use a controlled fixture where one synthetic feed returns persistent HTTP 500 while the other 58 workers continue queueing and draining. Feed retrieval, caught Open Graph fallback, and item-handler failures are distinct categories. Evidence remains aggregate and identifier-free, and a useful 58-worker fleet is not unhealthy merely because one feed is persistently failing.

## 18. Production Authorization Boundary

Implementation, template scripts, automated tests, CI, and release workflows do not authorize connection to the production host, container lifecycle actions, publishing-mode changes, or deployment. Production adoption is a separate explicitly approved operation and becomes **Field-verified** only when its sanitized record includes the image-transition gate, readiness, and previous-compatible-image recovery evidence.

The graceful-stop filesystem procedure in decision 6 is the only backup method planned for this cycle. Detailed task text and tests must implement that exact running-mode capture, graceful stop/wait, shutdown-log verification when logs are available, complete closed-tree archive including sidecars, owner-only permissions, and conditional restart sequence.
