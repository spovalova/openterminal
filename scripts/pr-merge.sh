#!/usr/bin/env bash
# Merge reviewed pull requests on the project repo, in the order given, and
# optionally fast-forward the main checkout and redeploy production.
#
#   scripts/pr-merge.sh <number> [<number>...] [--deploy]
#
# - Uses a merge commit (keeps each PR's history). Prints one line per PR.
# - --deploy: in the main checkout, fetch, fast-forward `main` to the remote, and run
#   deploy/redeploy.sh (rebuild the web app, restart terminal.service on 4242).
# - Reads GH_PAT from the main checkout's gitignored .env; never prints it.
set -euo pipefail

repo="spovalova/openterminal"
deploy=0
numbers=()
for a in "$@"; do
  case "$a" in
    --deploy) deploy=1 ;;
    *[!0-9]*|"") echo "usage: scripts/pr-merge.sh <number> [<number>...] [--deploy]" >&2; exit 1 ;;
    *) numbers+=("$a") ;;
  esac
done
[ ${#numbers[@]} -gt 0 ] || { echo "usage: scripts/pr-merge.sh <number> [<number>...] [--deploy]" >&2; exit 1; }

common=$(git rev-parse --git-common-dir)
root="$(cd "$common/.." && pwd)"
env_file="$root/.env"
GH_PAT=$(grep -E '^GH_PAT=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"'"'")
[ -n "$GH_PAT" ] || { echo "GH_PAT missing in $env_file" >&2; exit 1; }
api="https://api.github.com/repos/${repo}"

failed=0
for n in "${numbers[@]}"; do
  out=$(curl -s -X PUT -H "Authorization: Bearer $GH_PAT" -H "Accept: application/vnd.github+json" \
    "$api/pulls/$n/merge" -d '{"merge_method":"merge"}')
  line=$(printf '%s' "$out" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(("merged " + d.get("sha","")[:7]) if d.get("merged") else ("NOT merged: " + str(d.get("message"))))')
  echo "PR #$n: $line"
  case "$line" in NOT*) failed=1 ;; esac
done

if [ "$deploy" = 1 ]; then
  echo "--- deploy from $root"
  git -C "$root" fetch -q openterminal
  branch=$(git -C "$root" branch --show-current)
  [ "$branch" = "main" ] || { echo "main checkout is on '$branch', not main; switch it first" >&2; exit 1; }
  git -C "$root" merge --ff-only openterminal/main >/dev/null
  echo "main at $(git -C "$root" log --oneline -1)"
  "$root/deploy/redeploy.sh" 2>&1 | tail -4
fi

exit $failed
