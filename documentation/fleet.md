# Fleet deployment

"Fleet mode" runs many independent Bluesky bots out of a single Node process,
instead of one `docker-compose.yml` per bot (the original, still-supported
single-bot mode described in the main README). It's a separate entry point
under `fleet/`, started with `yarn fleet` (`tsx ./fleet/runFleet.ts`) rather
than `yarn start` (`tsx ./app/index.ts`). The two modes share the same
Dockerfile and image - only the container's `command:` differs.

## Architecture, briefly

- **`fleet/runFleet.ts`** is the entry point. It acquires a PID lock, loads
  fleet-wide and per-bot config via `fleet/configLoader.ts`
  (`loadFleet(configRoot, secretsFilePath, dataRoot)`), builds a
  `SharedLimiters` instance, and hands everything to an `AuthCoordinator`.
- **`AuthCoordinator`** (`fleet/authCoordinator.ts`) activates bots one at a
  time, waiting `staggerSeconds` (from `<configRoot>/fleet.json`) between each
  login, instead of logging every bot in at once. A bot that fails to
  activate is recorded as a failure and skipped - it does not stop the rest
  of the fleet from starting. On shutdown it aborts any in-progress stagger
  wait and shuts down all active workers in parallel, bounded by a timeout.
- **`BotStore`** (`fleet/botStore.ts`) replaces the legacy flat files
  (`last.txt` / `db.txt` / `persist.json`) with one SQLite database per bot
  (`node:sqlite`'s `DatabaseSync`), at `<dataRoot>/bots/<botId>/state.sqlite`.
  It holds four tables: `session` (the atproto session), `cursor` (last seen
  item date), `seen_items` (dedup), and `queue_items` (the post queue, with a
  `status` column).
- **`SharedLimiters`** (`fleet/sharedLimiters.ts`) is fleet-wide, not
  per-bot: a concurrency limiter for Open Graph scraping
  (`maxConcurrentOpenGraphFetches`) and image processing
  (`maxConcurrentImageJobs`), plus a shared `httpTimeoutMs` and
  `maxImageDownloadBytes`, all read from `<configRoot>/fleet.json`. This
  keeps N bots polling concurrently from each spawning unbounded scraping/
  image work.

Per-bot config lives at `<configRoot>/bots/<botId>/{bot.json,config.json}`
(see `config.example/bots/*` for the shape). App passwords are never stored
in `bot.json` - each bot's `secretKey` is looked up in a separate secrets
JSON file (`FLEET_SECRETS_PATH`, default `./config.example/secrets/bsky-fleet.json`
when running locally, keyed by bot id).

This is a summary, not the full picture - see `CLAUDE.md` in the repo root
for the rest of the fleet's conventions and per-file detail (dedup key
derivation, the scheduler/freshness policy, benchmark harness, etc.). Note
that `CLAUDE.md` is gitignored and machine-local; if you don't have one, run
Claude Code's `/init` or write your own rather than assuming this document
duplicates it.

## Legacy import

`fleet/importLegacyFleet.ts` migrates an existing per-bot legacy deployment
(one `docker-compose.yml` per bot directory, à la the original single-bot
mode) into a fleet config tree plus one `BotStore` per bot. Run it with tsx,
directly - there's no `package.json` script for it:

```bash
NODE_NO_WARNINGS=1 npx tsx fleet/importLegacyFleet.ts
```

It reads env vars (all optional, with defaults matching a `/home/skyfleet`
→ `/home/skyfleet-next` layout):

- `LEGACY_SOURCE_ROOT` - root directory holding one subdirectory per legacy
  bot, each with its own `docker-compose.yml`. Default `/home/skyfleet`.
- `FLEET_TARGET_CONFIG_ROOT` - where to write `bots/<botId>/{bot.json,config.json}`.
  Default `/home/skyfleet-next/config`.
- `FLEET_TARGET_DATA_ROOT` - where to write each bot's `state.sqlite`
  (`<root>/bots/<botId>/state.sqlite`). Default `/home/skyfleet-next/data/fleet`.
- `FLEET_TARGET_SECRETS_PATH` - the secrets JSON file to write/merge app
  passwords into. Default `/home/skyfleet-next/secrets/bsky-fleet.json`.
- `LEGACY_ONLY_BOT` - optional comma-separated allowlist of bot ids; if set,
  only those subdirectories of `LEGACY_SOURCE_ROOT` are imported.

For each legacy bot directory (any subdirectory of `LEGACY_SOURCE_ROOT`
containing a `docker-compose.yml`), the importer:

1. Parses `IDENTIFIER` / `APP_PASSWORD` / `INSTANCE_URL` / `FETCH_URL` /
   `FETCH_INTERVAL` out of the compose file's `environment:` block, and
   resolves the bot's data directory from its `volumes:` mapping to
   `/build/data` (handling both a relative `./data` mount and an absolute
   path shared between bots).
2. Writes `bot.json` and `config.json` under the target config root (the
   legacy `config.json`'s `publishDate` field is dropped - it's dead in the
   legacy app itself, never read anywhere but assigned a default).
3. Writes the app password into the secrets file, keyed by bot id.
4. Recreates that bot's `state.sqlite` from scratch (removing any existing
   one first - the import is idempotent, not additive) and seeds it from the
   legacy `last.txt` (cursor), `db.txt` (seen values) and `persist.json`
   (session), if those files exist.

The importer never logs a secret value - only bot ids, identifiers, and
error messages reach the console. The secrets file is written with mode
`0600`.

Run this on the machine where the legacy fleet actually lives, with the
legacy containers stopped first (e.g. via whatever `down.sh`/`docker compose
down` the legacy deployment uses) - nothing should be writing to
`db.txt`/`last.txt`/`persist.json` while the importer reads them.

If `LEGACY_ONLY_BOT` is unset, the importer imports every legacy bot
directory it finds and exits non-zero only if it imported none of them (a
per-bot failure is logged and skipped, not fatal to the rest of the run).

## Rollback

`fleet/exportLegacyFleet.ts` is the reverse: it writes a fleet bot's current
state (`state.sqlite`) back out to the legacy `last.txt` / `db.txt` /
`persist.json` file shapes, so you can fall back to running the old
single-bot containers if the fleet daemon needs to be abandoned. Run it the
same way, directly with tsx:

```bash
NODE_NO_WARNINGS=1 npx tsx fleet/exportLegacyFleet.ts
```

Env vars:

- `LEGACY_SOURCE_ROOT` - where the legacy bot directories (each with a
  `docker-compose.yml`) live, same meaning as for the importer. Default
  `/home/skyfleet`.
- `FLEET_TARGET_DATA_ROOT` - where the fleet's `bots/<botId>/state.sqlite`
  files live. Default `/home/skyfleet-next/data/fleet`.
- `FLEET_LOCK_PATH` - path to the fleet daemon's PID lock file. Default
  `/home/skyfleet-next/data/fleet/fleet.pid`.
- `LEGACY_ONLY_BOT` - optional comma-separated allowlist of bot ids; if
  unset, every subdirectory of `<FLEET_TARGET_DATA_ROOT>/bots` is exported.

**The PID-lock invariant:** before doing anything else, the exporter checks
whether `FLEET_LOCK_PATH` is held by a live process
(`fleet/pidLock.ts`'s `isLockedByLiveProcess`, which reads the PID from the
lock file and signals it with `process.kill(pid, 0)` to check liveness). If
the fleet daemon is still running, the exporter refuses to run and exits
non-zero with:

```
Refusing to run: fleet daemon lock at <path> is held by a live process. Stop
the fleet daemon first (never run both publishers simultaneously).
```

This matters because the fleet daemon (`runFleet.ts`) holds the same lock
file for its own lifetime (acquired at startup, released on `SIGTERM`/
`SIGINT` or process exit) - if both the daemon and the exporter ran at once,
you'd have two processes racing to publish from the same bot accounts and
mutating the same on-disk state. **Always stop the fleet daemon (`docker
compose down`, or however it's deployed) before running the exporter.**

For each bot id, the exporter writes `persist.json` (if a session exists in
that bot's store), `last.txt` (if a cursor has been recorded), and `db.txt`
(if there are any seen values) into that bot's legacy data directory
(resolved the same way as the importer, from the legacy `docker-compose.yml`'s
volume mapping). It refuses to export a bot that has no `state.sqlite` at
all, rather than fabricating an empty legacy store.

## Cutover

To move a legacy deployment to fleet mode:

1. **Stop the legacy deployment** - bring down every legacy bot's
   `docker-compose.yml` (or however they're currently run) so nothing is
   writing to `last.txt`/`db.txt`/`persist.json`.
2. **Run the importer one final time** against the now-quiescent legacy
   data, so the fleet's state is seeded from whatever the legacy bots last
   recorded:
   ```bash
   LEGACY_SOURCE_ROOT=/home/skyfleet \
   FLEET_TARGET_CONFIG_ROOT=/home/skyfleet-next/config \
   FLEET_TARGET_DATA_ROOT=/home/skyfleet-next/data/fleet \
   FLEET_TARGET_SECRETS_PATH=/home/skyfleet-next/secrets/bsky-fleet.json \
   NODE_NO_WARNINGS=1 npx tsx fleet/importLegacyFleet.ts
   ```
3. **Build the image** (shared with the legacy single-bot mode - only the
   compose `command:` differs):
   ```bash
   docker build -t bsky.rss:fleet .
   ```
4. **Start the fleet daemon.** Copy `docker-compose.fleet.example.yml` to
   `/home/skyfleet-next/docker-compose.yml` (it already sets
   `FLEET_CONFIG_ROOT`, `FLEET_SECRETS_PATH`, `FLEET_DATA_ROOT`, and
   `FLEET_LOCK_PATH` to the container-internal `/build/...` paths, matching
   the `./config`, `./secrets`, `./data` volume mounts), then:
   ```bash
   docker compose up -d
   ```
   Confirm it comes up cleanly (`docker compose logs -f` - look for
   `Fleet started: N active, 0 failed`) before decommissioning the legacy
   containers entirely.

If anything goes wrong after cutover, see **Rollback** above: stop the fleet
daemon first, then run the exporter to write the fleet's state back into the
legacy file shapes so the legacy containers can be brought back up.

## Backing up the live deployment

`/home/skyfleet-next` (or wherever your fleet's config/secrets/data lives)
holds real app passwords and live AT-Proto session tokens - it is never
committed to git. If the host it runs on isn't one you control long-term,
back it up locally on demand:

```bash
rsync -avz --delete <ssh-host>:/home/skyfleet-next/ ~/fleet-backup/
```

Run this whenever you want a fresh snapshot. It is not automated by
default - turn it into a cron job yourself if you want it to run
unattended. This is deliberately not a git-based backup: the directory holds
live secrets and session tokens that should never enter any repository's
history, including a private one.
