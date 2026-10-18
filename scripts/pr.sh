#!/usr/bin/env bash
# Push the current branch and open (or find) its pull request on the project repo.
#
#   scripts/pr.sh "<title>" <body.md> [base]
#
# - Works from any worktree. The token is read from GH_PAT in the main checkout's .env
#   (gitignored) and never printed.
# - In the body file, {{RAW}} expands to the raw-content base URL for this branch, so a
#   screenshot committed at docs/screenshots/x.png is embedded as ![..]({{RAW}}/docs/screenshots/x.png).
# - Prints the PR URL. If a PR for the branch already exists, pushes and prints that one.
set -euo pipefail

title=${1:?usage: scripts/pr.sh "<title>" <body.md> [base]}
body_file=${2:?usage: scripts/pr.sh "<title>" <body.md> [base]}
base=${3:-main}

repo="spovalova/openterminal"
remote_url="https://github.com/${repo}.git"
branch=$(git branch --show-current)
[ -n "$branch" ] || { echo "detached HEAD; check out a branch first" >&2; exit 1; }
[ "$branch" != "$base" ] || { echo "refusing to open a PR from $base onto itself" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }

common=$(git rev-parse --git-common-dir)
env_file="$(cd "$common/.." && pwd)/.env"
[ -f "$env_file" ] || { echo "no $env_file (needs GH_PAT=...)" >&2; exit 1; }
GH_PAT=$(grep -E '^GH_PAT=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"'"'")
[ -n "$GH_PAT" ] || { echo "GH_PAT is empty in $env_file" >&2; exit 1; }
auth="Authorization: Basic $(printf 'x-access-token:%s' "$GH_PAT" | base64 -w0)"

git -c credential.helper= -c "http.https://github.com/.extraheader=$auth" push -u "$remote_url" "$branch" >/dev/null 2>&1 \
  && echo "pushed $branch"

api="https://api.github.com/repos/${repo}"
hdr=(-H "Authorization: Bearer $GH_PAT" -H "Accept: application/vnd.github+json")

existing=$(curl -s "${hdr[@]}" "$api/pulls?head=${repo%%/*}:$branch&state=open" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["html_url"] if isinstance(d,list) and d else "")')
if [ -n "$existing" ]; then echo "$existing"; exit 0; fi

raw="https://raw.githubusercontent.com/${repo}/${branch}"
payload=$(mktemp)
python3 - "$title" "$body_file" "$base" "$branch" "$raw" <<'PY' > "$payload"
import json, sys
title, body_file, base, head, raw = sys.argv[1:]
body = open(body_file).read().replace('{{RAW}}', raw)
print(json.dumps({"title": title, "head": head, "base": base, "body": body}))
PY
curl -s -X POST "${hdr[@]}" "$api/pulls" -d @"$payload" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("html_url") or ("error: " + json.dumps(d)[:400]))'
rm -f "$payload"
