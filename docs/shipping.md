# Shipping a change

Every change, by a person or an agent, lands as a pull request on https://github.com/spovalova/openterminal. Agents work in parallel, each in its own branch and worktree, and open their own PRs. Nothing about identity or credentials belongs in a brief: the repo's git config sets the commit author, and `scripts/pr.sh` reads the token from the gitignored `.env`.

## The loop

```sh
git worktree add .worktrees/<topic> -b <topic> openterminal/main   # or let the Agent tool create the worktree
cd .worktrees/<topic>
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

"Before" is the production instance on `http://localhost:4242` (it runs `main`; never restart it from a branch). "After" is the branch's own server: copy `~/.openterminal` to a scratch directory, build the web app, run with `OPENTERMINAL_HOME=<copy> PORT=<free port>`, open the same workspace, and kill that server by PID when done. Headless Chromium through Playwright lives outside the repo; PLAN.md section 11 describes how the theme pass drove it.

## Briefing a bot

The main agent turns a list of features into one bot per feature, each in its own worktree and branch, all running at once. A brief is the task plus pointers, nothing about identity, tokens or remotes. Template:

```
Implement <feature> on its own branch and open the PR yourself.

Scope: <what to build, in the section 3 vocabulary; what is explicitly out>.
Start from: <files to read first>. Constraints: <PLAN.md sections, rules, decisions already made>.
Verify: pnpm typecheck && pnpm lint && pnpm test green; <feature-specific check>.
Screenshots: <if visual> before on production :4242, after on your own server; commit under docs/screenshots/<topic>-*.png.
Ship: commit (PLAN.md updated in the same commit when the plan was wrong), write the PR body in the scratchpad,
run scripts/pr.sh "<title>" <body.md>. Follow docs/shipping.md.
Report: branch, commits, test count, PR URL, anything left undone.
```

Bots that touch the same files (the table styles, the agent prompt) run one after the other, not in parallel; everything else fans out.

## Iterating on review

Review on GitHub as usual: approve, request changes, comment on lines. To act on it, a bot (or you) reads the feedback and pushes to the same branch; `pr.sh` finds the open PR and only pushes.

```sh
scripts/pr-feedback.sh            # current branch; or pass a PR number or branch name
# ... address each comment, commit ...
scripts/pr.sh "<same title>" pr-body.md
```

`pr-feedback.sh` prints the PR state, each review with its verdict, every line comment with its file and line, and the conversation, as Markdown. The brief for an iteration bot is "address the review on PR #N" plus the template above; it starts by running the script.

## Merging and deploying

After review, merge from the terminal so the deploy follows in the same step:

```sh
scripts/pr-merge.sh 4 5 3 --deploy    # merges in that order, fast-forwards main, runs deploy/redeploy.sh
```

A PR that conflicts is reported as not merged; hand it back to its author to merge `main` into the branch (merge, not rebase, so `pr.sh` can push without force), then run `pr-merge.sh` again for that number.

## Rules

- One topic per branch. PLAN.md changes in the same commit as the code when the plan was wrong, with the reason in the commit message.
- `pnpm typecheck && pnpm lint && pnpm test` green before `pr.sh`.
- Never commit `.env`, `config.yml`, or anything under `~/.openterminal`.
- Merging and redeploying production (`deploy/redeploy.sh`) are done from `main` by whoever reviews, not by the PR's author.
