#!/usr/bin/env sh
# Rebuild the web app from the current checkout and restart the production service on 4242.
# Usage: deploy/redeploy.sh        (run after `git pull` or local edits)
set -eu
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile
pnpm --filter @openterminal/web build
# Until the one-time switch from the pre-rename terminal.service, there is no unit to restart.
if ! systemctl --user cat openterminal.service >/dev/null 2>&1; then
  echo "built; openterminal.service is not installed yet: follow \"Switching from terminal.service\" in deploy/README.md to start it" >&2
  exit 1
fi
systemctl --user restart openterminal.service
systemctl --user --no-pager --lines=5 status openterminal.service
