#!/bin/bash
# Run from the deployment root (e.g. /home/skyfleet-next/), after `git pull`:
#   ./deploy/fleet/deploy.sh
#
# --project-directory keeps the compose file's relative volume paths
# (./config, ./secrets, ./data) resolving against the deployment root, not
# against this tracked file's own directory inside the git checkout.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f deploy/fleet/docker-compose.yml --project-directory . pull
docker compose -f deploy/fleet/docker-compose.yml --project-directory . up -d --force-recreate
