# Keeping a production instance running

Two systemd **user** units keep Open Terminal on `http://127.0.0.1:4242` and the OpenBB API on `:6900`, restarting them on crash and on boot (needs `loginctl enable-linger $USER` so user units start without a login).

```sh
loginctl enable-linger "$USER"
systemctl --user link "$PWD/deploy/systemd/openbb-api.service" "$PWD/deploy/systemd/openterminal.service"
systemctl --user daemon-reload
systemctl --user enable --now openbb-api.service openterminal.service
```

Assumptions baked into the units (edit them if yours differ): the repo at `~/terminal`, node at `~/.local/bin/node`, OpenBB in the venv `~/.venvs/openbb`, keys in `~/terminal/.env` (`ANTHROPIC_API_KEY=...`). The connector list and the finnhub key live in `~/.openterminal/config.yml`.

The server serves the built web app, so after pulling or editing run `deploy/redeploy.sh`: it reinstalls, rebuilds `packages/web/dist` and restarts the service. Logs: `journalctl --user -u openterminal.service -f`.

Both services bind loopback only. To use the UI from another machine, tunnel: `ssh -L 4242:127.0.0.1:4242 <vm>` and open `http://localhost:4242`.

## Switching from terminal.service

Before the rename to Open Terminal (2026-10-19) the unit was `deploy/systemd/terminal.service`, running `packages/cli/bin/terminal.js` with its data in `~/.terminal`. On a machine that has it, switch once after pulling the rename. `deploy/redeploy.sh` installs and builds, then stops with a pointer here because `openterminal.service` is not installed yet; then (the repo at `~/terminal`; change the link's path if yours is elsewhere):

```sh
systemctl --user disable --now terminal.service
rm ~/.config/systemd/user/terminal.service
ln -s ~/terminal/deploy/systemd/openterminal.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now openterminal.service
```

The first start of `openterminal.service` copies `~/.terminal` to `~/.openterminal` (config.yml, the SQLite store, the catalog cache, recipes), then opens the store there, running the one-time JSON → SQLite migration in the new directory when it has not run yet. `~/.terminal` is left as it was, plus a `MIGRATED.txt` saying where the data went; delete it once the new instance has your workspaces. The journal shows it as one line, `[server] copied /home/<you>/.terminal to /home/<you>/.openterminal, the config directory's new name; …` (`journalctl --user -u openterminal.service -n 20`). Later starts find `~/.openterminal` and copy nothing.

Notes:

- The pull removes `deploy/systemd/terminal.service`, so the old links point at nothing. If `disable` refuses because of that, stop the unit (still loaded until the `daemon-reload`) and remove its link by hand, then carry on from the `rm`: `systemctl --user stop terminal.service` and `rm ~/.config/systemd/user/default.target.wants/terminal.service`. Afterwards `ls ~/.config/systemd/user/default.target.wants/` should list `openterminal.service` and no `terminal.service`.
- Until the switch, the old unit keeps working: `packages/cli/bin/terminal.js` is kept as a one-line import of `bin/openterminal.js`.
- A `TERMINAL_HOME` in `~/terminal/.env` is still honoured (with a deprecation line in the journal) and skips the copy. To move off it, add `OPENTERMINAL_HOME=<new directory>` beside it: the first start copies the `TERMINAL_HOME` directory there the same way, and `TERMINAL_HOME` can then go. Or drop it to use `~/.openterminal`.

## The release workflow

`deploy/release.yml` is the GitHub Actions workflow that builds and drafts a release of the desktop app (PLAN.md section 18): on a tag `v<version>`, electron-builder on macOS, Windows and Linux (x64 and arm64), a smoke test of every build, the checks the install scripts rely on, SHA256SUMS, and a draft release; by hand (workflow_dispatch) it is a dry run that uploads everything as a workflow artifact. It belongs at `.github/workflows/release.yml`; it waits here because the token that pushed it has no `workflow` scope. Move it with a token that has that scope, or in the GitHub web editor.
