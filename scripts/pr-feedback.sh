#!/usr/bin/env bash
# Print a pull request's state and every review comment as Markdown, so whoever
# iterates on it (a person or an agent) sees exactly what the reviewer asked for.
#
#   scripts/pr-feedback.sh [<number>|<branch>]     default: the current branch
#
# Reads GH_PAT from the main checkout's gitignored .env; never prints it.
set -euo pipefail

repo="spovalova/openterminal"
ref=${1:-$(git branch --show-current)}
[ -n "$ref" ] || { echo "usage: scripts/pr-feedback.sh [<number>|<branch>]" >&2; exit 1; }

common=$(git rev-parse --git-common-dir)
env_file="$(cd "$common/.." && pwd)/.env"
GH_PAT=$(grep -E '^GH_PAT=' "$env_file" | head -1 | cut -d= -f2- | tr -d '"'"'")
[ -n "$GH_PAT" ] || { echo "GH_PAT missing in $env_file" >&2; exit 1; }

api="https://api.github.com/repos/${repo}"
get() { curl -s -H "Authorization: Bearer $GH_PAT" -H "Accept: application/vnd.github+json" "$api$1"; }

if [[ "$ref" =~ ^[0-9]+$ ]]; then
  number=$ref
else
  number=$(get "/pulls?head=${repo%%/*}:$ref&state=all" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[0]["number"] if isinstance(d,list) and d else "")')
  [ -n "$number" ] || { echo "no pull request for branch $ref" >&2; exit 1; }
fi

python3 - "$number" <<'PY' \
  "$(get "/pulls/$number")" \
  "$(get "/pulls/$number/reviews?per_page=100")" \
  "$(get "/pulls/$number/comments?per_page=100")" \
  "$(get "/issues/$number/comments?per_page=100")"
import json, sys
number, pr, reviews, line_comments, comments = sys.argv[1], *map(json.loads, sys.argv[2:])
print(f"# PR #{number}: {pr.get('title','')}")
print(f"{pr.get('html_url','')}")
print(f"state: {pr.get('state')} · merged: {pr.get('merged')} · mergeable: {pr.get('mergeable')} · head: {pr.get('head',{}).get('ref')} @ {pr.get('head',{}).get('sha','')[:7]}")
print()
if reviews:
    print("## Reviews")
    for r in reviews:
        print(f"- **{r['user']['login']}** {r['state'].lower()} ({r['submitted_at']})" + (f": {r['body'].strip()}" if r.get('body') else ""))
    print()
if line_comments:
    print("## Line comments")
    for c in line_comments:
        where = f"`{c.get('path')}`" + (f" line {c.get('line') or c.get('original_line')}" if c.get('line') or c.get('original_line') else "")
        print(f"- {where} — **{c['user']['login']}** ({c['created_at']}):")
        for ln in c['body'].strip().splitlines(): print(f"  > {ln}")
    print()
if comments:
    print("## Conversation")
    for c in comments:
        print(f"- **{c['user']['login']}** ({c['created_at']}):")
        for ln in c['body'].strip().splitlines(): print(f"  > {ln}")
    print()
if not (reviews or line_comments or comments):
    print("No review feedback yet.")
PY
