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
