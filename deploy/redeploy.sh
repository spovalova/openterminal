#!/usr/bin/env sh
# Rebuild the web app from the current checkout and restart the production service on 4242.
# Usage: deploy/redeploy.sh        (run after `git pull` or local edits)
set -eu
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm --filter @openterminal/web build
systemctl --user restart terminal.service
systemctl --user --no-pager --lines=5 status terminal.service
