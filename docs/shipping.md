# Shipping a change

Every change, by a person or an agent, lands as a pull request on https://github.com/spovalova/openterminal. Agents work in parallel, each in its own branch and worktree, and open their own PRs. Nothing about identity or credentials belongs in a brief: the repo's git config sets the commit author, and `scripts/pr.sh` reads the token from the gitignored `.env`.

## The loop

```sh
git worktree add ../wt-<topic> -b <topic> openterminal/main   # or let the Agent tool create the worktree
cd ../wt-<topic>
# ... edit, pnpm typecheck && pnpm lint && pnpm test ...
git add -A && git commit -m "<what and why>"
scripts/pr.sh "<title>" pr-body.md                              # pushes the branch, prints the PR URL
```

`pr-body.md` is a plain Markdown file kept outside the repo. It says what changed and why, how it was verified, and shows screenshots when the change is visual.

## Screenshots in a PR

Commit them on the branch under `docs/screenshots/<topic>-before-*.png` and `<topic>-after-*.png`, then embed them in the body through `{{RAW}}`, which `pr.sh` expands to the branch's raw-content URL:

```md
| before | after |
|---|---|
| ![before]({{RAW}}/docs/screenshots/layout-before-nvda.png) | ![after]({{RAW}}/docs/screenshots/layout-after-nvda.png) |
```

"Before" is the production instance on `http://localhost:4242` (it runs `main`; never restart it from a branch). "After" is the branch's own server: copy `~/.terminal` to a scratch directory, build the web app, run with `TERMINAL_HOME=<copy> PORT=<free port>`, open the same workspace, and kill that server by PID when done. Headless Chromium through Playwright lives outside the repo; PLAN.md section 11 describes how the theme pass drove it.

## Rules

- One topic per branch. PLAN.md changes in the same commit as the code when the plan was wrong, with the reason in the commit message.
- `pnpm typecheck && pnpm lint && pnpm test` green before `pr.sh`.
- Never commit `.env`, `config.yml`, or anything under `~/.terminal`.
- Merging and redeploying production (`deploy/redeploy.sh`) are done from `main` by whoever reviews, not by the PR's author.
