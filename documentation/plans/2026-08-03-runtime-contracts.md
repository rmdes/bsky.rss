# Runtime Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give solo and fleet modes one tested contract for configuration validation, dry-run behavior, health/readiness/status, process lifecycle, and local no-publish smoke testing.

**Architecture:** Add provider-neutral runtime modules under `shared/` and keep mode-specific adapters in `app/` and `fleet/`. JSON Schema files are the machine-readable source of truth and Ajv validates both CLI and runtime inputs. A shared HTTP status server exposes consistent endpoints while mode adapters supply snapshots.

**Tech Stack:** Node.js 24, TypeScript 6, Yarn 4, Node `test`, Ajv 8, JSON Schema 2020-12, native `http`, Docker.

## Global Constraints

- Preserve current solo and fleet posting behavior outside explicit dry-run changes.
- Do not require a live Bluesky account in automated tests.
- Do not emit credentials, sessions, feed bodies, or post contents from health/status endpoints.
- Fleet `starting` remains ready enough for provider startup checks once configuration is valid and the scheduler is progressing.
- Fleet `unhealthy` means no useful workers or a stalled/unrecoverable runtime, not merely incomplete staggered activation.
- Containers execute Node directly as PID 1.
- Tests use `node:test` and `node:assert/strict` to match the repository.
- Preserve current configuration shapes and values, 59 per-bot SQLite stores and state separation, 30-second sequential authentication, queue/freshness/rate-limit behavior, durable mounts, one publisher, and the 45-second container stop grace.
- Canonical new fleet config requires `schemaVersion: 1`; an absent version in the current baseline is assumed to be v1 only in a deep in-memory normalized copy, with a fixed sanitized notice and no rewrite or other shape change.
- State compatibility checks run non-mutating against a stopped backup copy, emit aggregate counts/fixed codes only, and require all 59 expected stores to pass before adoption.
- Stable PID/container operation is not readiness or usefulness evidence; liveness, readiness, and lifecycle assertions remain separate.
- Preserve optional `NODE_EXTRA_CA_CERTS`-style behavior through a generic validated custom-CA contract without private paths, endpoints, or feed identities.
- Runtime work starts only after the Phase 0 documentation reconciliation PR is approved. Tests and implementation do not authorize production-host access or deployment.

---

### Task 1: Establish Canonical Test and Check Commands

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/release-image.yml`
- Create: `.github/workflows/ci.yml`
- Test: all existing `fleet/*.test.ts` files

**Interfaces:**
- Consumes: existing `tsx --test fleet/*.test.ts` release command.
- Produces: `yarn test`, `yarn test:unit`, `yarn typecheck`, and `yarn check` commands used by every later task and companion-repository validation.

- [ ] **Step 1: Add a failing CI assertion for the missing scripts**

Create `.github/workflows/ci.yml` with a temporary command that invokes the intended interface:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: corepack enable
      - run: yarn install --immutable
      - run: yarn check
```

- [ ] **Step 2: Run the intended command and confirm it fails**

Run:

```bash
yarn check
```

Expected: Yarn reports that the `check` script is not defined.

- [ ] **Step 3: Add canonical scripts**

Update `package.json` scripts to include:

```json
{
  "test:unit": "tsx --test app/**/*.test.ts fleet/*.test.ts shared/**/*.test.ts test/**/*.test.ts",
  "test": "yarn test:unit",
  "typecheck": "tsc --noEmit",
  "check": "yarn typecheck && yarn test"
}
```

Keep existing `start`, `dev`, `fleet`, `release`, and Docker scripts unchanged.

- [ ] **Step 4: Point release verification at the canonical command**

Replace the workflow-specific test invocation in `.github/workflows/release-image.yml`:

```yaml
- name: Run checks
  run: yarn check
```

- [ ] **Step 5: Run the complete baseline**

Run:

```bash
yarn install --immutable
yarn check
```

Expected: TypeScript exits 0 and all existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json .github/workflows/ci.yml .github/workflows/release-image.yml
git commit -m "test: add canonical project checks"
```

---

### Task 2: Add Machine-Readable Configuration Schemas

**Files:**
- Create: `schemas/solo-config.schema.json`
- Create: `schemas/fleet-config.schema.json`
- Create: `schemas/fleet-bot.schema.json`
- Create: `schemas/post-config.schema.json`
- Create: `schemas/fleet-secrets.schema.json`
- Create: `shared/config/schemaRegistry.ts`
- Create: `shared/config/schemaRegistry.test.ts`
- Create: `shared/config/fleetCompatibility.ts`
- Create: `shared/config/fleetCompatibility.test.ts`
- Modify: `package.json`
- Modify: `yarn.lock`

**Interfaces:**
- Consumes: current solo environment variables, `config.example/fleet.json`, `config.example/bots/*/bot.json`, per-bot `config.json`, and fleet secrets JSON.
- Produces: `SCHEMA_VERSION`, `SchemaName`, `getSchema(name)`, Ajv-ready strict JSON Schema documents, and the non-mutating fleet compatibility bridge.

```ts
export interface FleetConfigNormalizationResult {
  config: unknown;
  noticeCodes: readonly "fleet-schema-version-assumed-v1"[];
}

export function normalizeFleetConfigForValidation(raw: unknown): FleetConfigNormalizationResult;
```

- [ ] **Step 1: Write failing schema-registry tests**

Create `shared/config/schemaRegistry.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SCHEMA_VERSION, getSchema } from "./schemaRegistry.ts";

test("runtime schemas use the reviewed version boundary", () => {
  assert.equal(SCHEMA_VERSION, 1);
  for (const name of ["solo", "fleet", "bot", "post", "secrets"] as const) {
    const schema = getSchema(name);
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.match(String(schema.$id), /\/v1\//);
  }

  const fleet = getSchema("fleet");
  const fleetProperties = fleet.properties as Record<string, { const?: unknown }>;
  assert.equal(fleetProperties.schemaVersion.const, SCHEMA_VERSION);

  for (const name of ["solo", "bot", "post"] as const) {
    const schema = getSchema(name);
    const properties = schema.properties as Record<string, unknown>;
    assert.equal(properties.schemaVersion, undefined);
    assert.equal(schema.additionalProperties, false);
  }

  const secrets = getSchema("secrets");
  const secretProperties = (secrets.properties ?? {}) as Record<string, unknown>;
  assert.equal(secretProperties.schemaVersion, undefined);
  assert.deepEqual(secrets.additionalProperties, { type: "string" });
});
```

Create `shared/config/fleetCompatibility.test.ts` with four binding cases:

```ts
test("accepts absent fleet schemaVersion as v1 in memory and does not mutate input", () => {});
test("accepts explicit fleet schemaVersion 1 without a compatibility notice", () => {});
test("leaves an explicit unknown version for schema rejection", () => {});
test("adds no change except fleet-level schemaVersion in the normalized copy", () => {});
```

The absent-version case asserts the fixed notice code `fleet-schema-version-assumed-v1`, byte-identical source-file contents before/after, unchanged original object, and a deep diff containing exactly one added fleet-level property. Tests must include nested objects and arrays so accidental reshaping fails.

- [ ] **Step 2: Run the test and confirm it fails**

Run:

```bash
yarn tsx --test shared/config/schemaRegistry.test.ts
```

Expected: module `shared/config/schemaRegistry.ts` does not exist.

- [ ] **Step 3: Add Ajv**

Run:

```bash
yarn add ajv@^8
```

- [ ] **Step 4: Create strict schemas**

Each schema must:

- use JSON Schema draft 2020-12;
- use a versioned `$id` containing `/v1/`;
- require `schemaVersion: 1` only in the fleet-wide schema;
- omit a top-level `schemaVersion` property from solo, per-bot identity, post, and secrets schemas;
- set `additionalProperties: false` at every owned fixed-shape object boundary;
- preserve the secrets file as a flat `Record<string, string>` whose arbitrary keys are validated through a string-valued `additionalProperties` schema;
- preserve all currently supported post configuration fields;
- encode positive bounds for intervals, queue lengths, concurrency, image size, timeout, and spacing;
- encode URL format for `instanceUrl` and `feedUrl`;
- encode non-empty strings for IDs, identifiers, and secret keys;
- encode language entries as two-to-eight character BCP-47-like tokens using `^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$`.

Example fleet schema shape:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://github.com/rmdes/bsky.rss/schemas/v1/fleet-config.schema.json",
  "type": "object",
  "additionalProperties": false,
  "required": ["schemaVersion", "staggerSeconds", "runIntervalSeconds", "freshness", "sharedLimiters", "perBotQueueMaxLength"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "staggerSeconds": { "type": "number", "minimum": 0 },
    "runIntervalSeconds": { "type": "number", "exclusiveMinimum": 0 },
    "perBotQueueMaxLength": { "type": "integer", "minimum": 1 }
  }
}
```

- [ ] **Step 5: Implement the registry**

Create `shared/config/schemaRegistry.ts`:

```ts
import { readFileSync } from "node:fs";

function readSchema(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(relativePath, import.meta.url), "utf8")
  ) as Record<string, unknown>;
}

export const SCHEMA_VERSION = 1 as const;
export type SchemaName = "solo" | "fleet" | "bot" | "post" | "secrets";

const schemas = {
  solo: readSchema("../../schemas/solo-config.schema.json"),
  fleet: readSchema("../../schemas/fleet-config.schema.json"),
  bot: readSchema("../../schemas/fleet-bot.schema.json"),
  post: readSchema("../../schemas/post-config.schema.json"),
  secrets: readSchema("../../schemas/fleet-secrets.schema.json"),
} as const;

export function getSchema(name: SchemaName): Record<string, unknown> {
  return schemas[name];
}
```

No TypeScript compiler-setting change is needed for schema loading.

Implement `normalizeFleetConfigForValidation` with a deep copy. It may add `schemaVersion: 1` only when the parsed top-level fleet object has no such property. It must never write, rename, coerce, default, reorder, or drop any other data. Notices contain a fixed code only: no path, identifier, config value, or serialized input.

- [ ] **Step 6: Update checked-in examples**

Add `"schemaVersion": 1` only to `config.example/fleet.json`. Preserve every existing per-bot `bot.json` and `config.json` top-level shape. Preserve `config.example/secrets/bsky-fleet.json` as the existing flat string map keyed by `secretKey`.

Do not rewrite the current production config or make adoption depend on that manual edit. The compatibility bridge is what lets the first hardened runtime load its current absent-version shape.

- [ ] **Step 7: Run schema tests and project checks**

Run:

```bash
yarn tsx --test shared/config/schemaRegistry.test.ts
yarn tsx --test shared/config/fleetCompatibility.test.ts
yarn check
```

Expected: all schema registry and existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add package.json yarn.lock schemas shared/config config.example
git commit -m "feat: define runtime configuration schemas"
```

---

### Task 3: Implement Deterministic Fleet Validation CLI

**Files:**
- Create: `shared/config/validation.ts`
- Create: `shared/config/validation.test.ts`
- Create: `fleet/validateFleet.ts`
- Create: `fleet/validateFleet.test.ts`
- Modify: `fleet/configLoader.ts`
- Modify: `fleet/configLoader.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `getSchema()`, filesystem paths, and current fleet config tree.
- Produces:

```ts
export interface ValidationIssue {
  scope: "fleet" | "bot" | "post" | "secrets" | "filesystem" | "cross-field";
  botId?: string;
  path: string;
  code: string;
  message: string;
}

export interface FleetValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  enabledBotCount: number;
}

export function validateFleetTree(options: {
  configRoot: string;
  secretsFilePath: string;
  dataRoot?: string;
  checkFilesystem?: boolean;
}): FleetValidationResult;
```

- [ ] **Step 1: Write failing validation tests**

Cover at least:

```ts
test("rejects duplicate Bluesky identifiers", () => { /* two enabled bots, same identifier */ });
test("rejects placeholder secrets without printing the value", () => { /* REPLACE-WITH-REAL-APP-PASSWORD */ });
test("rejects bot directory and id mismatch", () => { /* existing behavior */ });
test("rejects invalid URL and spacing bounds", () => { /* feedUrl and minSpacing > maxSpacing */ });
test("sorts issues deterministically by botId, path, and code", () => { /* stable output */ });
test("loads an absent-version fleet as v1 without rewriting it", () => { /* current baseline bridge */ });
test("rejects an explicit unknown fleet schema version", () => { /* no fallback */ });
```

Assert that serialized issues do not contain any secret value.

- [ ] **Step 2: Run tests and confirm failure**

Run:

```bash
yarn tsx --test shared/config/validation.test.ts fleet/validateFleet.test.ts
```

Expected: validation modules are missing.

- [ ] **Step 3: Implement schema and cross-field validation**

Use Ajv's JSON Schema 2020-12 implementation explicitly:

```ts
import Ajv2020 from "ajv/dist/2020.js";

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});
```

Register a URL format without adding another dependency:

```ts
ajv.addFormat("uri", {
  type: "string",
  validate(value: string) {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  },
});
```

Cross-field checks must include:

- duplicate bot IDs;
- duplicate enabled identifiers;
- directory/id mismatch;
- missing secret keys;
- placeholder secret values matching `/REPLACE|CHANGE-ME|YOUR[-_ ]/i`;
- `minSpacing <= maxSpacing`;
- writable data root when `checkFilesystem` is true;
- schema version equality.

- [ ] **Step 4: Make `loadFleet` normalize once and consume validated data**

Refactor `fleet/configLoader.ts` so parsing and validation are not duplicated. Parse the fleet file, call `normalizeFleetConfigForValidation`, validate and use only that in-memory copy, and return fixed compatibility notice codes alongside the validated result. Never write the normalized object back to the source. `loadFleet` may still return per-bot runtime errors, but malformed fleet-wide configuration must throw a sanitized `FleetConfigurationError` containing only `ValidationIssue[]`. Task 7A routes those fixed notices through the structured startup/configuration logger once that logger lands.

- [ ] **Step 5: Add the CLI**

`fleet/validateFleet.ts` must:

```ts
const result = validateFleetTree({
  configRoot: process.env.FLEET_CONFIG_ROOT ?? "./config.example",
  secretsFilePath: process.env.FLEET_SECRETS_PATH ?? "./config.example/secrets/bsky-fleet.json",
  dataRoot: process.env.FLEET_DATA_ROOT ?? "./data/fleet",
  checkFilesystem: process.argv.includes("--check-filesystem"),
});

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.valid ? 0 : 1;
```

The CLI prints `noticeCodes` when present. That compatibility notice contains no config path/value or serialized source; ordinary deterministic schema issue paths retain their existing validation contract. The compatibility test snapshots the config file before and after execution and proves equality.

- [ ] **Step 6: Add package scripts**

```json
{
  "fleet:validate": "NODE_NO_WARNINGS=1 tsx ./fleet/validateFleet.ts",
  "fleet:validate:filesystem": "NODE_NO_WARNINGS=1 tsx ./fleet/validateFleet.ts --check-filesystem"
}
```

- [ ] **Step 7: Verify redaction and deterministic output**

Run:

```bash
FLEET_CONFIG_ROOT=./config.example \
FLEET_SECRETS_PATH=./config.example/secrets/bsky-fleet.json \
yarn fleet:validate
```

Expected: exit 1 because example placeholders are rejected, and output contains no placeholder value.

Create a temporary valid secrets file and rerun; expected exit 0.

- [ ] **Step 8: Run full checks and commit**

```bash
yarn check
git add package.json shared/config fleet config.example
git commit -m "feat: add fleet configuration validation"
```

---

### Task 3A: Add Non-Mutating Aggregate State Compatibility Validation

**Files:**
- Create: `shared/state/stateCompatibility.ts`
- Create: `shared/state/stateCompatibility.test.ts`
- Create: `fleet/validateStateCompatibility.ts`
- Create: `fleet/validateStateCompatibility.test.ts`
- Modify: `package.json`

**Interfaces:**

```ts
export type StateCompatibilityCode =
  | "store-count-mismatch"
  | "integrity-failed"
  | "application-id-mismatch"
  | "user-version-mismatch"
  | "required-table-missing"
  | "required-column-missing"
  | "required-index-missing"
  | "queue-status-unknown"
  | "candidate-read-failed"
  | "mutation-detected";

export interface FleetStateCompatibilityResult {
  compatible: boolean;
  expectedStoreCount: number;
  discoveredStoreCount: number;
  passedStoreCount: number;
  issueCounts: Partial<Record<StateCompatibilityCode, number>>;
}

export function validateFleetStateCompatibility(options: {
  stateRoot: string;
  expectedStoreCount: number;
  expectedApplicationId: number;
  expectedUserVersion: number;
  requiredTables: Readonly<Record<string, readonly string[]>>;
  requiredIndexes: readonly string[];
  allowedQueueStatuses: readonly string[];
}): FleetStateCompatibilityResult;
```

Production comparison interface, run inside the candidate image against a stopped backup copy mounted read-only:

```bash
docker run --rm --read-only \
  -v "$STOPPED_BACKUP_DATA:/candidate-state:ro" \
  <candidate-image> \
  node --import tsx fleet/validateStateCompatibility.ts \
    --state-root /candidate-state \
    --expected-stores 59
```

- [ ] **Step 1: Write the failing 59-store compatibility matrix**

Create synthetic SQLite fixtures and cover exactly 59 valid independent stores; 58 and 60 stores; corrupt SQLite; non-`ok` `PRAGMA integrity_check`; `PRAGMA application_id` and `PRAGMA user_version` mismatch; each required table, column, and index missing; an unknown persisted queue status; candidate read/open failure; and a mutation attempt. Assert all 59 must pass for `compatible=true`.

Snapshot every fixture's SHA-256 and numeric file mode before and after validation and require exact equality. Invoke the CLI with identifiers, paths, row content, URLs, and raw-error sentinels in the fixtures; serialized output may contain only the result keys, numeric counts, booleans, and fixed `StateCompatibilityCode` values.

- [ ] **Step 2: Run tests and confirm failure**

```bash
yarn tsx --test shared/state/stateCompatibility.test.ts fleet/validateStateCompatibility.test.ts
```

- [ ] **Step 3: Implement read-only structural validation**

Enumerate SQLite stores internally and open each with read-only flags. Run `PRAGMA integrity_check`, `PRAGMA application_id`, `PRAGMA user_version`, `sqlite_schema` checks for required tables/indexes, `PRAGMA table_info` for required columns, and a distinct queue-status projection compared with an application-owned allowlist. Never select content-bearing columns; queue status codes may be compared internally but are not emitted. Catch failures at the store boundary and increment a fixed aggregate reason code; do not emit a database name, relative/absolute path, identifier, raw SQLite message, or row value.

- [ ] **Step 4: Add the exact CLI**

```json
{
  "fleet:validate-state": "NODE_NO_WARNINGS=1 tsx ./fleet/validateStateCompatibility.ts"
}
```

Require `--state-root` and `--expected-stores`; the production gate passes `59`. The CLI has no mutating mode, opens databases read-only, prints only `FleetStateCompatibilityResult`, and exits 0 only when all expected stores pass. Adoption instructions additionally require the stopped backup copy to be mounted read-only.

- [ ] **Step 5: Run checks and commit**

```bash
yarn tsx --test shared/state/stateCompatibility.test.ts fleet/validateStateCompatibility.test.ts
yarn check
git add package.json shared/state fleet/validateStateCompatibility.ts fleet/validateStateCompatibility.test.ts
git commit -m "feat: validate fleet state compatibility"
```

---

### Task 4: Add Shared Health, Readiness, and Status Server

**Files:**
- Create: `shared/health/types.ts`
- Create: `shared/health/runtimeStatus.ts`
- Create: `shared/health/httpServer.ts`
- Create: `shared/health/httpServer.test.ts`
- Modify: `app/utils/healthHandler.ts`

**Interfaces:**
- Produces:

```ts
export type RuntimeMode = "solo" | "fleet";
export type RuntimePhase = "starting" | "operational" | "degraded" | "unhealthy" | "shutting_down";
export type HealthReasonCode =
  | "partial-worker-failure"
  | "no-useful-workers"
  | "all-feeds-persistently-failing"
  | "scheduler-stalled"
  | "startup-failed"
  | "process-safety-event";

export interface RuntimeSnapshot {
  version: string;
  mode: RuntimeMode;
  phase: RuntimePhase;
  live: boolean;
  ready: boolean;
  dryRun: boolean;
  uptimeSeconds: number;
  lastActivityAt?: string;
  configuredBots?: number;
  activeBots?: number;
  usefulWorkers?: number;
  workersWithFreshSuccessfulPoll?: number;
  persistentlyFailingFeeds?: number;
  failedBots?: number;
  totalQueueDepth?: number;
  lastSuccessfulPollAt?: string;
  failureCounts?: {
    feedRetrieval: number;
    openGraphFallback: number;
    itemHandler: number;
  };
}

export interface RuntimeStatus {
  snapshot(): RuntimeSnapshot;
}

export function startHealthServer(options: {
  port: number;
  status: RuntimeStatus;
}): Promise<import("node:http").Server>;
```

- [ ] **Step 1: Write endpoint tests**

Test with an ephemeral port:

```ts
test("/live is 200 while a starting runtime is alive", async () => { /* assert body.live */ });
test("/ready is 503 until ready and 200 afterward", async () => { /* mutate status */ });
test("/health returns 200 for operational and degraded, 503 for unhealthy", async () => { /* phases */ });
test("/status excludes arbitrary internal fields", async () => { /* exact response keys */ });
test("unknown paths return 404", async () => { /* request /secret */ });
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
yarn tsx --test shared/health/httpServer.test.ts
```

Expected: shared health modules are missing.

- [ ] **Step 3: Implement immutable snapshot generation**

`runtimeStatus.ts` should expose a small mutable state holder whose public `snapshot()` returns a new plain object. It must never accept credentials, identifiers, feed content, or tokens as fields.

- [ ] **Step 4: Implement endpoint semantics**

Map endpoints as follows:

```text
/live   -> 200 when live=true, otherwise 503
/ready  -> 200 when ready=true, otherwise 503
/health -> 200 for operational or degraded; 503 for starting, unhealthy, shutting_down
/status -> 200 while the HTTP server responds; body contains snapshot
/       -> same response as /health for provider compatibility
```

Set `Cache-Control: no-store` and `Content-Type: application/json; charset=utf-8`.

- [ ] **Step 5: Convert the solo health handler into an adapter**

Keep the current default export shape temporarily so existing imports continue to compile, but implement it using the shared status/server modules. Add explicit methods:

```ts
markStarting();
markReady();
markDegraded(reasonCode: HealthReasonCode);
markUnhealthy(reasonCode: HealthReasonCode);
markShuttingDown();
updateActivity(at?: Date);
setDryRun(value: boolean);
start(): Promise<Server>;
stop(): Promise<void>;
```

Reason codes are application-owned allowlisted constants and never contain user content. Health payloads expose aggregate phase/count data, not reason text or arbitrary context.

- [ ] **Step 6: Run tests and commit**

```bash
yarn tsx --test shared/health/httpServer.test.ts
yarn check
git add shared/health app/utils/healthHandler.ts
git commit -m "feat: unify runtime health semantics"
```

---

### Task 5: Add Solo Dry-Run and Graceful Lifecycle Parity

**Files:**
- Create: `app/runtime/soloConfig.ts`
- Create: `app/runtime/soloConfig.test.ts`
- Create: `app/runtime/soloLifecycle.ts`
- Create: `app/runtime/soloLifecycle.test.ts`
- Modify: `app/index.ts`
- Modify: `app/utils/bskyHandler.ts`
- Modify: `app/utils/queueHandler.ts`

**Interfaces:**
- Produces:

```ts
export interface SoloRuntimeConfig {
  identifier: string;
  appPassword: string;
  fetchUrl: URL;
  instanceUrl: URL;
  fetchIntervalMinutes: number;
  dryRun: boolean;
  healthPort: number;
}

export function loadSoloRuntimeConfig(env: NodeJS.ProcessEnv): SoloRuntimeConfig;
```

and a publication adapter:

```ts
export interface SoloPublisher {
  post(params: SoloPostParams): Promise<unknown>;
}
```

- [ ] **Step 1: Write failing solo config tests**

Cover required variables, valid URLs, positive intervals, `DRY_RUN` defaulting to true, explicit `DRY_RUN=false`, and sanitized errors.

- [ ] **Step 2: Write a failing dry-run publication test**

Inject a fake agent whose `post` and `uploadBlob` methods throw if called. Assert that dry-run returns a successful no-op result and never calls either method.

- [ ] **Step 3: Run tests and confirm failure**

```bash
yarn tsx --test app/runtime/soloConfig.test.ts app/runtime/soloLifecycle.test.ts
```

- [ ] **Step 4: Implement typed configuration loading**

Use the solo JSON Schema through the shared validator. Do not read process environment directly from multiple modules after startup.

- [ ] **Step 5: Add dry-run to the solo publisher**

Change `bskyHandler.init()` to accept an options object:

```ts
async function init(options: { service: string; dryRun: boolean })
```

In `post()`, return before facet detection, image upload, or record creation:

```ts
if (dryRun) {
  return { ok: true, uri: "dry-run://noop" };
}
```

Do not log the post body, title, excerpt, URL, handle, identifier, or raw error. Task 7A adds the structured `post` / `dry-run-publication-suppressed` event with aggregate `suppressed` count after the shared logger exists.

- [ ] **Step 6: Implement graceful shutdown**

`soloLifecycle.ts` must register `SIGTERM` and `SIGINT`, mark health `shutting_down`, stop feed polling, stop accepting queue work, wait for a bounded queue stop, stop the HTTP server, and exit once. Use injectable callbacks so the lifecycle tests do not terminate the test process.

- [ ] **Step 7: Refactor `app/index.ts`**

`main()` must:

1. load and validate config;
2. start health as `starting`;
3. initialize/login;
4. initialize reader and queue;
5. mark `operational`;
6. register shutdown;
7. mark `unhealthy` and set non-zero exit code on unrecoverable startup failure.

A rate-limit startup failure must not silently return while health remains starting forever.

- [ ] **Step 8: Run checks and commit**

```bash
yarn tsx --test app/runtime/soloConfig.test.ts app/runtime/soloLifecycle.test.ts
yarn check
git add app shared/config schemas/solo-config.schema.json
git commit -m "feat: add safe solo runtime lifecycle"
```

---

### Task 6: Wire Fleet Runtime Status and Startup-Aware Readiness

**Files:**
- Create: `fleet/fleetRuntimeStatus.ts`
- Create: `fleet/fleetRuntimeStatus.test.ts`
- Modify: `fleet/authCoordinator.ts`
- Modify: `fleet/botWorker.ts`
- Modify: `fleet/botStore.ts`
- Modify: `fleet/runFleet.ts`
- Modify: `fleet/runFleet.test.ts`

**Interfaces:**
- Consumes: shared `RuntimeStatus`, `AuthCoordinator.activeWorkers()`, `activationFailures()`, queue/store metrics.
- Produces:

```ts
export interface FleetRuntimeMetrics {
  configuredBots: number;
  activeBots: number;
  usefulWorkers: number;
  workersWithFreshSuccessfulPoll: number;
  persistentlyFailingFeeds: number;
  failedBots: number;
  totalQueueDepth: number;
  lastSuccessfulPollAt?: Date;
  activatedAt?: Date;
  activationComplete: boolean;
  schedulerResponsive: boolean;
  failureCounts: {
    feedRetrieval: number;
    openGraphFallback: number;
    itemHandler: number;
  };
}

export function deriveFleetPhase(metrics: FleetRuntimeMetrics, options: {
  now: () => Date;
  successfulPollFreshnessMs: number;
  postActivationGraceMs: number;
}): RuntimePhase;
```

- [ ] **Step 1: Write failing phase tests**

Required cases:

```text
valid config + activation pending + zero active -> starting, ready=true
activation complete + grace elapsed + all workers fresh/useful + no failures -> operational
activation complete + grace elapsed + some useful + some failed -> degraded, ready=true
activation complete + grace elapsed + zero useful workers -> unhealthy, ready=false
activation complete + grace elapsed + all feeds persistently failing -> unhealthy, ready=false
58 fresh useful workers + one persistent HTTP 500 -> degraded, ready=true
some useful workers + any activation/poll/staleness failure -> degraded, ready=true
activation complete + before first poll + grace not elapsed -> starting, ready=true
scheduler not responsive -> unhealthy
shutdown requested -> shutting_down
```

Add an injected-clock acceptance test with exactly 59 configured worker-equivalents and a 30-second sequential stagger. Advance virtual time through the full activation window instead of sleeping for roughly 29 real minutes. Assert throughout activation that:

- phase remains `starting` until activation completes;
- liveness remains true and readiness remains true once configuration, lock, status server, and scheduler progress are valid;
- aggregate configured/active/failed counts advance deterministically;
- no bot identifier, feed URL, title, body, or raw error appears in status; and
- a stable process with a stalled scheduler becomes unhealthy even though PID 1/container evidence remains stable.
- successful-poll freshness and post-activation grace are computed from the injected clock, never wall-clock sleeps;
- after grace, active process count alone cannot prevent `unhealthy` when useful workers are zero or all feeds persistently fail; and
- the one-HTTP-500 worker plus 58 continuing fresh pollers stays useful overall, `degraded`, and ready.

- [ ] **Step 2: Run tests and confirm failure**

```bash
yarn tsx --test fleet/fleetRuntimeStatus.test.ts fleet/runFleet.test.ts
```

- [ ] **Step 3: Expose safe worker metrics**

Add methods that return numbers/timestamps only:

```ts
BotWorker.queueDepth(): number;
BotWorker.lastSuccessfulPollAt(): Date | undefined;
BotWorker.hasPersistentFeedFailure(): boolean;
```

Aggregate these into `usefulWorkers`, `workersWithFreshSuccessfulPoll`, and `persistentlyFailingFeeds` using the injected clock. Do not expose worker identities, feed URLs, queue item bodies, or per-worker timestamps.

- [ ] **Step 4: Start the shared health server before staggered activation**

In `runFleet.ts`:

1. validate config;
2. acquire lock;
3. initialize status as `starting`, `ready=true`;
4. start the health server;
5. begin coordinator activation;
6. update counts after every activation success/failure;
7. remain `starting` through the first-poll/post-activation grace boundary, then transition to operational/degraded/unhealthy according to `deriveFleetPhase`.

- [ ] **Step 5: Add scheduler heartbeat**

Update status whenever a worker completes a feed poll or queue cycle. The successful-poll freshness threshold must be configurable with `FLEET_HEALTH_STALE_AFTER_MS`, defaulting to ten minutes; the post-activation first-poll grace must be configurable with `FLEET_HEALTH_GRACE_MS` and default to at least one configured poll interval. Both use the injected clock in tests.

- [ ] **Step 6: Integrate shutdown state**

Before aborting activation, set `shutting_down` and readiness false. Stop the health server only after worker shutdown and lock release have completed, unless the overall shutdown timeout expires.

- [ ] **Step 7: Run lifecycle tests and full checks**

```bash
yarn tsx --test fleet/fleetRuntimeStatus.test.ts fleet/runFleet.test.ts
yarn check
```

- [ ] **Step 8: Commit**

```bash
git add fleet shared/health
git commit -m "feat: expose fleet health and readiness"
```

---

### Task 7: Add Controlled Feed and AT Protocol Smoke Fixtures

**Files:**
- Create: `test/fixtures/rss/basic.xml`
- Create: `test/fixtures/atom/basic.xml`
- Create: `test/fixtures/rss/persistent-500.json`
- Create: `test/support/fixtureServer.ts`
- Create: `test/support/mockAtprotoServer.ts`
- Create: `test/smoke/soloDryRun.test.ts`
- Create: `test/smoke/fleetDryRun.test.ts`
- Create: `test/smoke/persistence.test.ts`
- Create: `test/smoke/fleetFailureIsolation.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces:

```ts
export async function startFixtureServer(): Promise<{
  rssUrl: string;
  atomUrl: string;
  failingFeedUrl: string;
  close(): Promise<void>;
}>;

export async function startMockAtprotoServer(): Promise<{
  serviceUrl: string;
  requests: readonly MockRequest[];
  close(): Promise<void>;
}>;
```

- [ ] **Step 1: Write fixture-server tests**

Assert RSS and Atom fixture responses use deterministic dates, GUIDs/IDs, titles, descriptions, links, and content types.

- [ ] **Step 2: Write solo dry-run smoke test**

Start both fixture servers, launch solo mode as a child process with:

```text
DRY_RUN=true
FETCH_INTERVAL=0.01
HEALTH_CHECK_PORT=<ephemeral>
INSTANCE_URL=<mock service>
FETCH_URL=<fixture RSS URL>
```

Assert:

- readiness becomes 200;
- at least one feed item is processed;
- no create-record or upload request reaches the mock service;
- SIGTERM produces exit code 0.

- [ ] **Step 3: Write fleet dry-run and persistence smoke tests**

Use two bots, one RSS and one Atom. Assert per-bot SQLite files exist, restart resumes state, and duplicate fixture items are not re-queued.

- [ ] **Step 3a: Write the 59-worker failure-isolation smoke test**

Create 59 synthetic worker configurations using an injected/virtual clock for the 30-second authentication stagger. The fixture server returns a persistent HTTP 500 from the feed endpoint for exactly one worker. Independently inject caught Open Graph retrieval failures and an item-handler failure so classification cannot collapse the three categories.

Assert that:

- the affected worker records feed-retrieval failures without queue progress;
- the other 58 workers continue queueing and draining fixture items;
- caught Open Graph fallback failures do not increment feed-retrieval or item-handler counts;
- item-handler failures have their own count;
- aggregate readiness is degraded rather than fleet-wide unhealthy while useful workers continue; and
- status evidence contains counts and category codes only, never identifiers, URLs, titles, bodies, or raw error strings.

Task 7A reruns this smoke case after structured logging lands and applies the equivalent privacy/category assertions to captured log lines.

- [ ] **Step 4: Run tests and confirm the missing harness fails**

```bash
yarn tsx --test test/smoke/*.test.ts
```

- [ ] **Step 5: Implement minimal fixture servers**

Use native `http`; do not add an application framework. The mock AT Protocol server should implement only the lexicon paths actually called during login/session setup and record metrics for assertions.

- [ ] **Step 6: Add smoke script**

```json
{
  "test:smoke": "tsx --test test/smoke/*.test.ts",
  "check": "yarn typecheck && yarn test && yarn test:smoke"
}
```

- [ ] **Step 7: Run complete verification**

```bash
yarn check
```

Expected: all unit, lifecycle, schema, and smoke tests pass without external network access.

- [ ] **Step 8: Commit**

```bash
git add test package.json
git commit -m "test: add no-publish runtime smoke fixtures"
```

---

### Task 7A: Add Structured Sanitized Runtime Logging

**Files:**
- Create: `shared/logging/runtimeLogger.ts`
- Create: `shared/logging/runtimeLogger.test.ts`
- Create: `test/logging/runtimeCallSites.test.ts`
- Modify: startup/config/auth/feed/Open-Graph/item-handler/queue/post/rate-limit/health/shutdown/process-safety call sites under `app/`, `fleet/`, and `shared/`

**Interfaces:**

```ts
export type RuntimeLogCategory =
  | "startup"
  | "configuration"
  | "authentication"
  | "feed-retrieval"
  | "open-graph-fallback"
  | "item-handler"
  | "queue"
  | "post"
  | "rate-limit"
  | "health-transition"
  | "shutdown"
  | "process-safety";

export type RuntimeReasonCode =
  | "startup-begin"
  | "configuration-valid"
  | "configuration-invalid"
  | "authentication-failed"
  | "feed-retrieval-failed"
  | "open-graph-fallback-used"
  | "item-handler-failed"
  | "queue-cycle-complete"
  | "publication-complete"
  | "dry-run-publication-suppressed"
  | "rate-limit-deferred"
  | "health-phase-changed"
  | "shutdown-complete"
  | "unhandled-rejection"
  | "uncaught-exception";

export type RuntimeCountCode =
  | "configured"
  | "active"
  | "useful"
  | "failed"
  | "queued"
  | "processed"
  | "suppressed"
  | "occurrences";

export interface RuntimeLogEvent {
  level: "debug" | "info" | "warn" | "error";
  category: RuntimeLogCategory;
  reasonCode: RuntimeReasonCode;
  counts?: Readonly<Partial<Record<RuntimeCountCode, number>>>;
}

export interface RuntimeLogger {
  emit(event: RuntimeLogEvent): void;
}
```

The event type intentionally has no arbitrary metadata, identifier, URL, content, or `Error` field. The serializer adds a timestamp/version/mode where safe, validates category and reason-code allowlists, and emits one JSON object per line.

- [ ] **Step 1: Write failing serializer and call-site coverage tests**

Test startup, configuration, authentication, feed retrieval, Open Graph fallback, item handler, queue, post and dry-run suppression, rate limit, health transition, shutdown, and process-safety events. Each test injects sentinel IDs, handles, titles, excerpts, URLs, raw errors, secret values, session values, and content into the originating failure objects and captured legacy messages; none may appear in serialized logs.

Assert output contains only allowlisted envelope keys, category/reason codes, count keys, and aggregate non-negative integer counts. Feed retrieval, Open Graph fallback, and item-handler categories cannot collapse. Unknown categories, unknown reason/count codes, non-integer/negative counts, arbitrary context, and raw `Error` objects are rejected before serialization.

- [ ] **Step 2: Run tests and confirm failure**

```bash
yarn tsx --test shared/logging/runtimeLogger.test.ts test/logging/runtimeCallSites.test.ts
```

- [ ] **Step 3: Implement the logger and replace unsafe call sites**

Map caught errors to fixed reason codes at the boundary and increment aggregate counts. Never interpolate or spread input objects into an event. Process-safety handlers emit only `unhandled-rejection` or `uncaught-exception` plus aggregate occurrence counts and drive the documented health transition; they do not serialize the thrown value.

- [ ] **Step 4: Keep retention out of the runtime logger**

The application emits structured lines only. `journald`, bounded `json-file`, and provider-managed retention remain deployment/template responsibilities and are tested separately; this task must not select or configure a logging backend.

- [ ] **Step 5: Run full checks and commit**

```bash
yarn tsx --test shared/logging/runtimeLogger.test.ts test/logging/runtimeCallSites.test.ts
yarn check
git add app fleet shared/logging test/logging
git commit -m "feat: sanitize structured runtime logs"
```

---

### Task 8: Document the Runtime Contract

**Files:**
- Create: `documentation/architecture/runtime-contracts.md`
- Create: `documentation/deployment/runtime-environment.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: implemented schemas, validation CLI, health endpoints, and dry-run semantics.
- Produces: authoritative documentation referenced by the template and provider plans.

- [ ] **Step 1: Add deployment-document headers**

Both new documents begin with:

```text
Mode: Both
Reference deployment: Docker
Provider: Docker
Support status: Verified
State requirement: Persistent
Application version policy: Pinned
```

- [ ] **Step 2: Document exact commands**

Include:

```bash
yarn check
yarn fleet:validate
yarn fleet:validate:filesystem
node --import tsx fleet/validateStateCompatibility.ts --state-root <stopped-backup-copy> --expected-stores 59
curl -fsS http://127.0.0.1:8080/live
curl -fsS http://127.0.0.1:8080/ready
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/status
```

- [ ] **Step 3: Document status semantics and privacy boundary**

Describe each phase, endpoint status code, startup staggering behavior, post-activation grace, successful-poll freshness/useful-worker metrics, stale scheduler threshold, and excluded sensitive fields. Document that startup before the first poll remains `starting`; after grace, zero useful workers or all feeds persistently failing is unhealthy; and one persistent HTTP 500 plus 58 fresh workers is degraded and ready.

Document feed-retrieval, Open Graph fallback, and item-handler failures as distinct structured categories. Document the fixed reason-code/aggregate-count logging boundary across every runtime category and keep backend retention as a separate deployment concern. Explain that process/container stability is not readiness evidence and that the production baseline remains Production-proven rather than lifecycle-Verified.

Document the non-mutating absent-version assume-v1 bridge, the sanitized notice, explicit-version rejection, and the aggregate-only stopped-backup state validator. Existing migration/import/export assets and `documentation/fleet.md` remain untouched and are not navigation or acceptance dependencies.

- [ ] **Step 3a: Document and test optional custom CA behavior**

Define a generic optional CA bundle contract compatible with `NODE_EXTRA_CA_CERTS`. Document the absent/default-trust case, a validated read-only bundle selection, sanitized invalid-bundle errors, and provider/template mapping. Add automated tests for absent, readable-valid, missing, and invalid bundle cases without using a private path or endpoint.

- [ ] **Step 4: Remove misleading test wording**

Replace any documentation that calls `yarn typecheck` “running tests” with `yarn check` and explain the separate test/typecheck commands.

- [ ] **Step 5: Verify every documented command**

Run each local command from a clean checkout and record its exit status in the PR body.

- [ ] **Step 6: Run final checks and commit**

```bash
yarn check
git add README.md documentation
git commit -m "docs: define runtime deployment contracts"
```

## Runtime Plan Acceptance

Before opening the PR, verify:

```bash
yarn install --immutable
yarn check
FLEET_CONFIG_ROOT=./config.example FLEET_SECRETS_PATH=<valid-temp-secrets> yarn fleet:validate
docker build -t bsky-rss:runtime-contracts .
VALID_SECRETS_FILE=<path-to-temporary-valid-secrets>
docker run --rm \
  -e FLEET_CONFIG_ROOT=/build/config.example \
  -e FLEET_SECRETS_PATH=/run/secrets/bsky-fleet.json \
  -v "$VALID_SECRETS_FILE:/run/secrets/bsky-fleet.json:ro" \
  bsky-rss:runtime-contracts \
  node --import tsx fleet/validateFleet.ts

! docker run --rm \
  -e FLEET_CONFIG_ROOT=/build/config.example \
  -e FLEET_SECRETS_PATH=/build/config.example/secrets/bsky-fleet.json \
  bsky-rss:runtime-contracts \
  node --import tsx fleet/validateFleet.ts
```

The mounted temporary valid secrets file must make the first container validation exit 0. The checked-in placeholder secrets must make the separate second command exit non-zero without disclosing placeholder or secret values.

A fixture matching the current production fleet-level shape without `schemaVersion` must also validate and load as v1 through the in-memory bridge, emit only `fleet-schema-version-assumed-v1`, leave the source byte-identical, and produce the same runtime object as an otherwise identical explicit-v1 fixture. An explicit unknown version must fail.

The PR body must state that Bluesky publication was not performed and that AT Protocol behavior was tested through the controlled mock boundary.

It must also record the virtual-time 59-worker/30-second result, the isolated HTTP 500 result proving 58 unaffected synthetic workers continued, the distinct Open Graph and item-handler counts, custom-CA validation, and the explicit boundary that no production connection or deployment was performed.

It must additionally record the absent/explicit/unknown schema-version matrix with source non-mutation, the aggregate-only 59-store state fixture matrix with pre/post hash and mode equality, the successful-poll usefulness/grace matrix, and the structured-log call-site privacy matrix.
